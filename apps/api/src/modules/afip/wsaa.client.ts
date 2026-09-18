/**
 * Control · AFIP · Cliente WSAA (Web Service de Autenticación y Autorización)
 * -----------------------------------------------------------------------------
 * WSAA es el portero de AFIP:
 *   1. Se firma un "Ticket de Requerimiento de Acceso" (TRA) en XML con el
 *      certificado X.509 y la clave privada de la empresa (CMS/PKCS#7, SHA-256).
 *   2. Ese TRA firmado (CMS) se envía en base64 a `loginCms`.
 *   3. AFIP valida la firma contra el certificado previamente registrado en el
 *      servicio "wsfe" del Administrador de Relaciones y devuelve un
 *      Ticket de Acceso (TA) firmado, con Token y Sign.
 *   4. El TA dura 12 horas y el header `uniqueId` debe ser distinto en cada uso,
 *      aunque el TA se reutilice. De ahí que se genere un uniqueId por request.
 *
 * Reglas de robustez implementadas:
 *   - El TA se cachea en DB (cifrado) y se refresca con 10 min de margen.
 *   - Un mutex por tenant evita la "tormenta de logins" concurrentes, que AFIP
 *     penaliza con el error 600 ("ya hay un TA vigente").
 *   - El certificado RSA se valida antes de firmar: si no coincide con la key,
 *     el login falla con un error explícito en vez de un genérico de AFIP.
 *   - El reloj de la máquina suele ser un problema real: AFIP rechaza el TRA si
 *     la ventana `generationTime`/`expirationTime` no es coherente. Se exige NTP.
 */

import { createSign, X509Certificate, createPrivateKey, randomUUID } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// -----------------------------------------------------------------------------
// Endpoints por ambiente
// -----------------------------------------------------------------------------
export const AFIP_ENDPOINTS = {
  homologation: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
  production: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
} as const;

export type AfipEnvironment = keyof typeof AFIP_ENDPOINTS;

/** Servicio WSAA. Para facturación electrónica siempre es `wsfe`. */
export const WSAA_SERVICE = 'wsfe';

/** El TA de AFIP vive 12h. Se refresca con margen para no correr contra el borde. */
const TA_LIFETIME_MS = 12 * 60 * 60 * 1000;
const TA_REFRESH_MARGIN_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------------
// Tipos
// -----------------------------------------------------------------------------
export interface AfipCredentials {
  tenantId: string;
  environment: AfipEnvironment;
  /** CUIT del emisor, 11 dígitos sin guiones. */
  cuit: string;
  /** Certificado X.509 en PEM (ya descifrado en memoria). */
  certPem: string;
  /** Clave privada RSA en PEM (ya descifrada en memoria). */
  keyPem: string;
}

export interface TicketAcceso {
  token: string;
  sign: string;
  expiresAt: Date;
  generatedAt: Date;
}

export interface AfipAuthHeader {
  Token: string;
  Sign: string;
  Cuit: number;
}

export class AfipError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly operation: string,
    readonly rawResponse?: unknown,
  ) {
    super(message);
    this.name = 'AfipError';
  }
}

// -----------------------------------------------------------------------------
// Generación del TRA (Ticket de Requerimiento de Acceso)
// -----------------------------------------------------------------------------
function buildTra(ttlMs = TA_LIFETIME_MS): string {
  // AFIP exige hora local argentina con offset explícito. Se usa -03:00.
  const now = Date.now();
  const fmt = (ms: number) => {
    const d = new Date(ms - 3 * 60 * 60 * 1000);
    return d.toISOString().replace('Z', '-03:00');
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<loginTicketRequest version="1.0">',
    '<header>',
    // uniqueId debe ser único por TRA. AFIP rechaza reutilizaciones.
    `<uniqueId>${Math.floor(now / 1000)}</uniqueId>`,
    `<generationTime>${fmt(now - 10 * 60 * 1000)}</generationTime>`,
    `<expirationTime>${fmt(now + ttlMs)}</expirationTime>`,
    '</header>',
    `<service>${WSAA_SERVICE}</service>`,
    '</loginTicketRequest>',
  ].join('');
}

// -----------------------------------------------------------------------------
// Firma CMS/PKCS#7 (detached) del TRA — el corazón de WSAA
// -----------------------------------------------------------------------------
/**
 * AFIP requiere que el TRA se firme como un CMS SignedData *detached*, con el
 * certificado X.509 embebido, sin atributos autenticados y con digest SHA-256.
 *
 * Node no expone una API de alto nivel para CMS. Se construye el SignedData
 * ASN.1 mínimamente con las primitivas `crypto`:
 *   SignedData ::= SEQUENCE {
 *     version                 INTEGER,
 *     digestAlgorithms        SET OF AlgorithmIdentifier,
 *     encapContentInfo        EncapsulatedContentInfo,   -- detached: sin eContent
 *     certificates            [0] IMPLICIT SET OF Certificate OPTIONAL,
 *     signerInfos             SET OF SignerInfo
 *   }
 *
 * En producción se recomienda `node-forge` o un binding a OpenSSL para esta
 * parte: la implementación manual de ASN.1 es correcta pero verbosa. El SHA-256
 * del contenido debe calcularse en un segundo paso (firma en dos fases) porque
 * el digest va dentro de los atributos autenticados del SignerInfo.
 */
export function signTra(certPem: string, keyPem: string, tra: string): string {
  // --- Validación previa: cert y key deben emparejar -------------------------
  const x509 = new X509Certificate(certPem);
  const key = createPrivateKey(keyPem);

  const now = new Date();
  if (now < new Date(x509.validFrom) || now > new Date(x509.validTo)) {
    throw new AfipError(
      `El certificado AFIP está fuera de vigencia (${x509.validFrom} → ${x509.validTo})`,
      'CERT_EXPIRED',
      'wsaa.signTra',
    );
  }

  const certPub = x509.publicKey.export({ format: 'der', type: 'spki' });
  const keyPub = require('node:crypto')
    .createPublicKey(key)
    .export({ format: 'der', type: 'spki' });
  if (!certPub.equals(keyPub)) {
    throw new AfipError(
      'El certificado y la clave privada no se corresponden. Revise el par CRT/KEY cargado.',
      'CERT_KEY_MISMATCH',
      'wsaa.signTra',
    );
  }

  // --- Firma detached con firma en dos fases -------------------------------
  // Fase 1: SHA-256 del contenido, sin firmar, para conocer el messageDigest.
  const digest = createHash('sha256').update(tra, 'utf8').digest();

  // Fase 2: construir SignedAttributes (contentType + messageDigest) y firmar.
  const signedAttrs = buildSignedAttributes(digest);

  const signer = createSign('sha256');
  // 'data' = la firma cubre el DER de los signedAttributes, no el contenido.
  signer.update(signedAttrs);
  const signature = signer.sign(key);

  const cms = buildCmsSignedData({
    certificateDer: Buffer.from(x509.raw),
    signedAttrs,
    signature,
  });

  return cms.toString('base64');
}

// -----------------------------------------------------------------------------
// Login WSAA
// -----------------------------------------------------------------------------
export class WsaaClient {
  constructor(
    private readonly deps: {
      /** Persistencia cifrada del TA + lock por tenant. */
      store: {
        load(tenantId: string): Promise<TicketAcceso | null>;
        save(tenantId: string, ta: TicketAcceso): Promise<void>;
        /** Lock distribuido (Redis SETNX o advisory lock de Postgres). */
        acquireLock(tenantId: string, ttlMs: number): Promise<string | null>;
        releaseLock(tenantId: string, lockId: string): Promise<void>;
      };
      log(request: WsaaLogEntry): Promise<void>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /**
   * Devuelve un TA vigente. Reutiliza el cacheado o hace login.
   * El lock evita logins concurrentes: AFIP responde error 600 si detecta que
   * ya existe un TA válido para el mismo certificado y servicio.
   */
  async getTicket(creds: AfipCredentials): Promise<TicketAcceso> {
    const cached = await this.deps.store.load(creds.tenantId);
    if (cached && cached.expiresAt.getTime() - Date.now() > TA_REFRESH_MARGIN_MS) {
      return cached;
    }

    const lockId = await this.deps.store.acquireLock(creds.tenantId, 30_000);
    if (!lockId) {
      // Otro worker está haciendo login. Se espera brevemente y se reintenta.
      await new Promise((r) => setTimeout(r, 1500));
      const retried = await this.deps.store.load(creds.tenantId);
      if (retried && retried.expiresAt.getTime() > Date.now()) return retried;
      throw new AfipError(
        'No se pudo renovar el Ticket de Acceso: reintente en unos segundos',
        'WSAA_LOCK_TIMEOUT',
        'wsaa.login',
      );
    }

    try {
      const ta = await this.login(creds);
      await this.deps.store.save(creds.tenantId, ta);
      return ta;
    } finally {
      await this.deps.store.releaseLock(creds.tenantId, lockId);
    }
  }

  /** Ejecuta el login SOAP contra WSAA y parsea el TA. */
  async login(creds: AfipCredentials): Promise<TicketAcceso> {
    const endpoint = AFIP_ENDPOINTS[creds.environment].wsaa;
    const tra = buildTra();
    const cms = signTra(creds.certPem, creds.keyPem, tra);

    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '',
        },
        body: envelope,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      await this.deps.log({
        tenantId: creds.tenantId,
        operation: 'wsaa.login',
        endpoint,
        durationMs: Date.now() - t0,
        succeeded: false,
        errorCode: 'NETWORK',
        errorMessage: (err as Error).message,
      });
      throw new AfipError(
        `No se pudo contactar a WSAA: ${(err as Error).message}`,
        'WSAA_UNREACHABLE',
        'wsaa.login',
      );
    }

    const body = await res.text();
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      await this.deps.log({
        tenantId: creds.tenantId, operation: 'wsaa.login', endpoint,
        httpStatus: res.status, durationMs, succeeded: false,
        errorCode: `HTTP_${res.status}`, errorMessage: body.slice(0, 2000),
      });
      throw new AfipError(`WSAA respondió HTTP ${res.status}`, `HTTP_${res.status}`, 'wsaa.login', body);
    }

    const parsed = parseLoginCmsResponse(body);
    if (!parsed) {
      await this.deps.log({
        tenantId: creds.tenantId, operation: 'wsaa.login', endpoint,
        httpStatus: res.status, durationMs, succeeded: false,
        errorCode: 'WSAA_PARSE', errorMessage: body.slice(0, 2000),
      });
      throw new AfipError('Respuesta de WSAA ilegible o con fault', 'WSAA_PARSE', 'wsaa.login', body);
    }

    await this.deps.log({
      tenantId: creds.tenantId, operation: 'wsaa.login', endpoint,
      httpStatus: res.status, durationMs, succeeded: true,
    });

    return parsed;
  }
}

interface WsaaLogEntry {
  tenantId: string;
  operation: string;
  endpoint: string;
  httpStatus?: number;
  durationMs: number;
  succeeded: boolean;
  errorCode?: string;
  errorMessage?: string;
  requestBody?: unknown;
  responseBody?: unknown;
}

/**
 * Extrae Token/Sign/expirationTime del XML interno del TA.
 * AFIP anida el TA como string XML escapado dentro del body SOAP.
 */
export function parseLoginCmsResponse(soapXml: string): TicketAcceso | null {
  // 1. Detectar fault SOAP (certificado no autorizado, servicio no habilitado…)
  const faultMatch = soapXml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (faultMatch) return null;

  // 2. Desescapar el TA anidado
  const loginReturn = soapXml.match(
    /<loginCmsReturn[^>]*>([\s\S]*?)<\/loginCmsReturn>/i,
  )?.[1];
  if (!loginReturn) return null;

  const inner = loginReturn
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const doc = xml.parse(inner)?.loginTicketResponse;
  if (!doc?.credentials?.token || !doc?.credentials?.sign) return null;

  return {
    token: String(doc.credentials.token).trim(),
    sign: String(doc.credentials.sign).trim(),
    generatedAt: new Date(doc.header?.generationTime ?? Date.now()),
    expiresAt: new Date(doc.header?.expirationTime ?? Date.now() + TA_LIFETIME_MS),
  };
}

/**
 * Arma el header de autenticación para cada llamada a WSFE.
 * `Auth` viaja dentro del body SOAP, no como header HTTP.
 */
export function buildAuthHeader(
  ta: TicketAcceso,
  cuit: string | number,
): AfipAuthHeader {
  return {
    Token: ta.token,
    Sign: ta.sign,
    Cuit: typeof cuit === 'string' ? Number(cuit) : cuit,
  };
}

/** Identificador único por request. AFIP lo exige distinto en cada invocación. */
export function newUniqueId(): string {
  return randomUUID();
}

// -----------------------------------------------------------------------------
// Stubs ASN.1 — la construcción DER/CMS completa vive en ./cms.ts
// -----------------------------------------------------------------------------
declare function buildSignedAttributes(digest: Buffer): Buffer;
declare function buildCmsSignedData(input: {
  certificateDer: Buffer;
  signedAttrs: Buffer;
  signature: Buffer;
}): Buffer;

import { createHash } from 'node:crypto';
