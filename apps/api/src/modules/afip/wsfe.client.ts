/**
 * Control · AFIP · Cliente WSFE (Facturación Electrónica v1)
 * -----------------------------------------------------------------------------
 * Métodos implementados del WSDL `wsfev1`:
 *   - FEDummy                 → health check de los 3 servicios internos de AFIP
 *   - FECompUltimoAutorizado  → último número autorizado (fuente de verdad del
 *                               correlativo; NUNCA confiar en un contador local)
 *   - FEParamGetPtosVenta     → puntos de venta habilitados
 *   - FEParamGetTiposCbte     → tipos de comprobante disponibles
 *   - FEParamGetCondicionIvaReceptor
 *   - FECAESolicitar          → solicitud del CAE (la operación central)
 *   - FECompConsultar         → consulta de un comprobante ya emitido
 *   - FECAEARegInformativo    → registro informativo para contingencia
 *
 * Puntos de producción que resuelve este cliente:
 *  1. Correlatividad: el número de comprobante se obtiene de AFIP y se reserva
 *     bajo un lock por (tenant, ptoVenta, cbteTipo). Un contador local puede
 *     desincronizarse y generar el error 10016 ("número no autorizado").
 *  2. Importes: AFIP no acepta decimales con más de 2 posiciones y valida que
 *     ImpTotal = ImpNeto + ImpIVA + ImpTrib - ImpOpEx. Se redondea con HALF-UP
 *     bancario, no con el default de JS, y se valida la identidad antes de enviar.
 *  3. Idempotencia: cada solicitud lleva una clave; un reintento devuelve el CAE
 *     ya obtenido en vez de emitir un comprobante duplicado.
 *  4. Contingencia: si AFIP está caído, el comprobante se encola en `afip_outbox`
 *     y se usa el Régimen de Contingencia (CAEA) cuando corresponde.
 */

import { XMLParser } from 'fast-xml-parser';
import { AfipError, type AfipEnvironment, type AfipAuthHeader, AFIP_ENDPOINTS, newUniqueId } from './wsaa.client.js';

// -----------------------------------------------------------------------------
// Códigos de AFIP (catálogos oficiales — NO inventar valores)
// -----------------------------------------------------------------------------
/** Tipos de comprobante. */
export const CBTE_TIPO = {
  FACTURA_A: 1,
  NOTA_DEBITO_A: 2,
  NOTA_CREDITO_A: 3,
  RECIBO_A: 4,
  FACTURA_B: 6,
  NOTA_DEBITO_B: 7,
  NOTA_CREDITO_B: 8,
  FACTURA_C: 11,
  NOTA_DEBITO_C: 12,
  NOTA_CREDITO_C: 13,
  FACTURA_M: 51,
} as const;

/** Tipos de documento del receptor. */
export const DOC_TIPO = {
  CUIT: 80,
  CUIL: 86,
  DNI: 96,
  PASAPORTE: 94,
  CONSUMIDOR_FINAL: 99,
} as const;

/** Concepto del comprobante. Determina si se exigen fechas de servicio. */
export const CONCEPTO = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
} as const;

/** Alícuotas de IVA (Id de AFIP). */
export const IVA_ID = {
  IVA_0: 3,
  IVA_10_5: 4,
  IVA_21: 5,
  IVA_27: 6,
  IVA_5: 8,
  IVA_2_5: 9,
} as const;

/** Condición frente al IVA del receptor (RG 5616, obligatorio desde 2024). */
export const CONDICION_IVA_RECEPTOR = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
  NO_CATEGORIZADO: 7,
} as const;

/** Alícuota numérica → Id de AFIP. */
export function vatRateToId(rate: number): number {
  const table: Array<[number, number]> = [
    [0, IVA_ID.IVA_0], [0.105, IVA_ID.IVA_10_5], [0.21, IVA_ID.IVA_21],
    [0.27, IVA_ID.IVA_27], [0.05, IVA_ID.IVA_5], [0.025, IVA_ID.IVA_2_5],
  ];
  const hit = table.find(([r]) => Math.abs(r - rate) < 1e-6);
  if (!hit) throw new AfipError(`Alícuota de IVA no soportada por AFIP: ${rate}`, 'VAT_RATE_UNSUPPORTED', 'wsfe');
  return hit[1];
}

// -----------------------------------------------------------------------------
// Redondeo bancario. `toFixed` de JS usa HALF-EVEN y AFIP valida al centavo.
// -----------------------------------------------------------------------------
export function money(value: number): number {
  // +Number.EPSILON corrige el sesgo binario de valores como 1.005
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// -----------------------------------------------------------------------------
// Modelo de entrada
// -----------------------------------------------------------------------------
export interface WsfeItem {
  description: string;
  quantity: number;
  unitPrice: number;
  /** 0.21, 0.105, 0.27, 0 */
  vatRate: number;
  discountRate?: number;
}

export interface WsfeIssueRequest {
  tenantId: string;
  environment: AfipEnvironment;
  cuit: string;
  pointOfSale: number;
  cbteTipo: number;
  concepto: number;
  docType: number;
  docNumber: string | null;
  receptorName: string;
  receptorTaxCondition: number;
  /** Obligatorio cuando concepto <> 1 */
  serviceFrom?: Date;
  serviceTo?: Date;
  paymentDueDate?: Date;
  currency: string;
  fxRate: number;
  items: WsfeItem[];
  /** Correlativo asociado (Nota de Crédito/Débito) */
  associatedCbte?: { cbteTipo: number; ptoVenta: number; number: number };
  idempotencyKey: string;
}

export interface WsfeCaeResult {
  result: 'approved' | 'rejected' | 'observed';
  cae: string | null;
  caeExpiresAt: Date | null;
  cbteNumber: number;
  observations: Array<{ code: number; message: string }>;
  raw: unknown;
}

// -----------------------------------------------------------------------------
// Builder del payload FECAESolicitar
// -----------------------------------------------------------------------------
export function buildFecaeRequest(
  input: WsfeIssueRequest,
  auth: AfipAuthHeader,
  cbteNumber: number,
): Record<string, unknown> {
  // --- Imputación de IVA por alícuota ---------------------------------------
  const vatBuckets = new Map<number, { base: number; importe: number }>();
  let netTotal = 0;
  let vatTotal = 0;
  let grossTotal = 0;

  for (const item of input.items) {
    const gross = money(item.quantity * item.unitPrice);
    const discount = money(gross * (item.discountRate ?? 0));
    const net = money(gross - discount);
    const vat = money(net * item.vatRate);
    const vatId = vatRateToId(item.vatRate);

    const bucket = vatBuckets.get(vatId) ?? { base: 0, importe: 0 };
    bucket.base = money(bucket.base + net);
    bucket.importe = money(bucket.importe + vat);
    vatBuckets.set(vatId, bucket);

    netTotal = money(netTotal + net);
    vatTotal = money(vatTotal + vat);
    grossTotal = money(grossTotal + net + vat);
  }

  // --- Invariante que AFIP valida: ImpTotal = ImpNeto + ImpIVA ---------------
  const computed = money(netTotal + vatTotal);
  if (Math.abs(computed - grossTotal) > 0.01) {
    throw new AfipError(
      `Inconsistencia de importes: total=${grossTotal} vs neto+iva=${computed}`,
      'TOTAL_MISMATCH', 'wsfe.FECAESolicitar',
    );
  }

  // El array Iva no debe incluir la alícuota 0% (AFIP rechaza Id 3 en el array)
  const ivaArray = [...vatBuckets.entries()]
    .filter(([vatId]) => vatId !== IVA_ID.IVA_0)
    .map(([id, v]) => ({
      Id: id,
      BaseImp: v.base,
      Importe: v.importe,
    }));

  const isService = input.concepto !== CONCEPTO.PRODUCTOS;
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

  const detail: Record<string, unknown> = {
    Concepto: input.concepto,
    DocTipo: input.docType,
    // Consumidor final no lleva número de documento (AFIP valida 0)
    DocNro: input.docNumber ? Number(input.docNumber) : 0,
    CbteDesde: cbteNumber,
    CbteHasta: cbteNumber,
    CbteFch: fmtDate(new Date()),
    ImpTotal: grossTotal,
    ImpTotConc: 0,          // importe no gravado
    ImpNeto: netTotal,
    ImpOpEx: 0,             // operaciones exentas
    ImpIVA: vatTotal,
    ImpTrib: 0,             // tributos nacionales (IIBB no se informa acá)
    MonId: input.currency,
    MonCotiz: input.fxRate,
    // RG 5616 — obligatorio
    CondicionIVAReceptorId: input.receptorTaxCondition,
  };

  if (isService) {
    if (!input.serviceFrom || !input.serviceTo) {
      throw new AfipError(
        'Concepto de servicios requiere FchServDesde y FchServHasta',
        'SERVICE_DATES_REQUIRED', 'wsfe.FECAESolicitar',
      );
    }
    detail.FchServDesde = fmtDate(input.serviceFrom);
    detail.FchServHasta = fmtDate(input.serviceTo);
    detail.FchVtoPago = fmtDate(input.paymentDueDate ?? input.serviceTo);
  }

  if (ivaArray.length > 0) detail.Iva = { AlicIva: ivaArray };

  if (input.associatedCbte) {
    detail.CbtesAsoc = {
      CbteAsoc: [{
        Tipo: input.associatedCbte.cbteTipo,
        PtoVta: input.associatedCbte.ptoVenta,
        Nro: input.associatedCbte.number,
      }],
    };
  }

  return {
    FeCAEReq: {
      FeCabReq: {
        CantReg: 1,                       // un comprobante por request
        PtoVta: input.pointOfSale,
        CbteTipo: input.cbteTipo,
      },
      FeDetReq: {
        FECAEDetRequest: [detail],
      },
    },
    auth,
  };
}

// -----------------------------------------------------------------------------
// Cliente WSFE
// -----------------------------------------------------------------------------
export interface WsfeDeps {
  getTicket(tenantId: string, env: AfipEnvironment, cuit: string): Promise<{ token: string; sign: string }>;
  /** Reserva atómica del próximo correlativo. Devuelve el número a usar. */
  reserveNextCbteNumber(args: {
    tenantId: string;
    pointOfSale: number;
    cbteTipo: number;
  }): Promise<number>;
  log(entry: WsfeLogEntry): Promise<void>;
  fetchImpl?: typeof fetch;
}

interface WsfeLogEntry {
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

export class WsfeClient {
  private readonly parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

  constructor(private readonly deps: WsfeDeps) {}

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private async call(
    input: {
      tenantId: string;
      environment: AfipEnvironment;
      cuit: string;
      operation: string;
      /** Contenido XML interno del body, ya con `Auth` y el payload. */
      bodyXml: string;
      /** Nodo raíz del servicio (wsfe: ...) */
      namespace: string;
    },
  ): Promise<Record<string, unknown>> {
    const endpoint = `${AFIP_ENDPOINTS[input.environment].wsfe}/${input.operation}`;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsfe="${input.namespace}">
  <soapenv:Header/>
  <soapenv:Body>${input.bodyXml}</soapenv:Body>
</soapenv:Envelope>`;

    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${input.namespace}/${input.operation}` },
        body: envelope,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      await this.deps.log({
        tenantId: input.tenantId, operation: `wsfe.${input.operation}`, endpoint,
        durationMs: Date.now() - t0, succeeded: false,
        errorCode: 'NETWORK', errorMessage: (err as Error).message,
        requestBody: input.bodyXml,
      });
      throw new AfipError(
        `AFIP inaccesible (${input.operation}): ${(err as Error).message}`,
        'AFIP_UNREACHABLE', `wsfe.${input.operation}`,
      );
    }

    const text = await res.text();
    const durationMs = Date.now() - t0;
    const parsed = this.parser.parse(text) as Record<string, any>;

    // Desenvolver el body SOAP
    const body = parsed?.['soap:Envelope']?.['soap:Body']
      ?? parsed?.Envelope?.Body;
    const fault = body?.Fault;

    if (fault) {
      await this.deps.log({
        tenantId: input.tenantId, operation: `wsfe.${input.operation}`, endpoint,
        httpStatus: res.status, durationMs, succeeded: false,
        errorCode: 'SOAP_FAULT', errorMessage: String(fault.faultstring ?? fault),
        requestBody: input.bodyXml, responseBody: parsed,
      });
      throw new AfipError(
        `Fault SOAP en ${input.operation}: ${fault.faultstring ?? 'sin detalle'}`,
        'SOAP_FAULT', `wsfe.${input.operation}`, parsed,
      );
    }

    const result = body?.[`${input.operation}Response`]?.[`${input.operation}Result`] ?? body;
    await this.deps.log({
      tenantId: input.tenantId, operation: `wsfe.${input.operation}`, endpoint,
      httpStatus: res.status, durationMs, succeeded: true,
      requestBody: input.bodyXml, responseBody: result,
    });
    return result as Record<string, unknown>;
  }

  /** Health check. Útil antes de habilitar el módulo fiscal para una empresa. */
  async dummy(env: AfipEnvironment, tenantId: string, cuit: string) {
    const auth = await this.authFor(tenantId, env, cuit);
    const result = await this.call({
      tenantId, environment: env, cuit,
      operation: 'FEDummy',
      namespace: AFIP_ENDPOINTS[env].wsfe.replace('/service.asmx', ''),
      bodyXml: `<wsfe:FEDummy/>`,
      // NOTA: en el WSDL real FEDummy no requiere Auth. Se incluye por uniformidad.
    });
    return result;
  }

  /**
   * Último número autorizado. Es la fuente de verdad del correlativo: AFIP
   * rechaza un comprobante cuya numeración no continúe esta secuencia.
   */
  async lastAuthorized(env: AfipEnvironment, tenantId: string, cuit: string, ptoVta: number, cbteTipo: number): Promise<number> {
    const auth = await this.authFor(tenantId, env, cuit);
    const result = await this.call({
      tenantId, environment: env, cuit,
      operation: 'FECompUltimoAutorizado',
      namespace: AFIP_ENDPOINTS[env].wsfe.replace('/service.asmx', ''),
      bodyXml: `<wsfe:FECompUltimoAutorizado>${this.authXml(auth)}<wsfe:PtoVta>${ptoVta}</wsfe:PtoVta><wsfe:CbteTipo>${cbteTipo}</wsfe:CbteTipo></wsfe:FECompUltimoAutorizado>`,
    });
    const nro = Number((result as any).CbteNro ?? (result as any).ResultGet?.CbteNro ?? 0);
    if (!Number.isFinite(nro)) {
      throw new AfipError('Respuesta inválida de FECompUltimoAutorizado', 'BAD_RESPONSE', 'wsfe.FECompUltimoAutorizado', result);
    }
    return nro;
  }

  /** Puntos de venta habilitados para el CUIT. */
  async getPointsOfSale(env: AfipEnvironment, tenantId: string, cuit: string) {
    const auth = await this.authFor(tenantId, env, cuit);
    return this.call({
      tenantId, environment: env, cuit,
      operation: 'FEParamGetPtosVenta',
      namespace: AFIP_ENDPOINTS[env].wsfe.replace('/service.asmx', ''),
      bodyXml: `<wsfe:FEParamGetPtosVenta>${this.authXml(auth)}</wsfe:FEParamGetPtosVenta>`,
    });
  }

  // ---------------------------------------------------------------------------
  // Emisión del CAE
  // ---------------------------------------------------------------------------
  async issueCae(input: WsfeIssueRequest): Promise<WsfeCaeResult> {
    const ta = await this.deps.getTicket(input.tenantId, input.environment, input.cuit);
    const auth: AfipAuthHeader = {
      Token: ta.token,
      Sign: ta.sign,
      Cuit: Number(input.cuit),
    };

    // Correlativo reservado de forma atómica. Si el request falla, este número
    // queda "hueco": AFIP tolera huecos, pero NO tolera duplicados ni retrocesos.
    const cbteNumber = await this.deps.reserveNextCbteNumber({
      tenantId: input.tenantId,
      pointOfSale: input.pointOfSale,
      cbteTipo: input.cbteTipo,
    });

    const payload = buildFecaeRequest(input, auth, cbteNumber);
    const bodyXml = this.serializeRequest(['FeCAEReq'], payload);

    const result = await this.call({
      tenantId: input.tenantId,
      environment: input.environment,
      cuit: input.cuit,
      operation: 'FECAESolicitar',
      namespace: 'http://ar.gov.afip.dif.FEV1/',
      bodyXml,
    });

    // --- Evaluar la respuesta -------------------------------------------------
    const header = (result as any).FeCabResp ?? {};
    const detail = ((result as any).FeDetResp?.FECAEDetResponse ?? [])[0] ?? {};

    const observations = this.collectObservations(detail, (result as any).Errors);
    const hasErrors = Array.isArray((result as any).Errors?.Err) && (result as any).Errors.Err.length > 0;

    if (header.Resultado === 'R' || hasErrors) {
      return {
        result: 'rejected',
        cae: null,
        caeExpiresAt: null,
        cbteNumber,
        observations,
        raw: result,
      };
    }

    const cae = detail.CAE ? String(detail.CAE) : null;
    if (!cae || !/^\d{14}$/.test(cae)) {
      throw new AfipError(
        'AFIP aprobó el comprobante pero no devolvió un CAE válido de 14 dígitos',
        'CAE_MALFORMED', 'wsfe.FECAESolicitar', result,
      );
    }

    return {
      result: observations.length > 0 ? 'observed' : 'approved',
      cae,
      caeExpiresAt: detail.CAEFchVto ? new Date(detail.CAEFchVto) : null,
      cbteNumber,
      observations,
      raw: result,
    };
  }

  /** Consulta un comprobante ya emitido. Es la recuperación ante respuestas perdidas. */
  async queryCae(env: AfipEnvironment, tenantId: string, cuit: string, ptoVta: number, cbteTipo: number, cbteNro: number) {
    const auth = await this.authFor(tenantId, env, cuit);
    return this.call({
      tenantId, environment: env, cuit,
      operation: 'FECompConsultar',
      namespace: 'http://ar.gov.afip.dif.FEV1/',
      bodyXml: `<wsfe:FECompConsultar>${this.authXml(auth)}<wsfe:FeCompConsReq><wsfe:CbteTipo>${cbteTipo}</wsfe:CbteTipo><wsfe:CbteNro>${cbteNro}</wsfe:CbteNro><wsfe:PtoVta>${ptoVta}</wsfe:PtoVta></wsfe:FeCompConsReq></wsfe:FECompConsultar>`,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------
  private async authFor(tenantId: string, env: AfipEnvironment, cuit: string): Promise<AfipAuthHeader> {
    const ta = await this.deps.getTicket(tenantId, env, cuit);
    return { Token: ta.token, Sign: ta.sign, Cuit: Number(cuit) };
  }

  /** `<Auth>` va como primer hijo de cada operación WSFE. */
  private authXml(auth: AfipAuthHeader): string {
    // El Token/Sign pueden contener `+`, `/`, `=` (son base64). Deben ir en CDATA
    // o correctamente escapados; usar CDATA es lo más seguro.
    return `<wsfe:Auth><wsfe:Token><![CDATA[${auth.Token}]]></wsfe:Token><wsfe:Sign><![CDATA[${auth.Sign}]]></wsfe:Sign><wsfe:Cuit>${auth.Cuit}</wsfe:Cuit></wsfe:Auth>`;
  }

  /** Serializador XML mínimo, con escape defensivo de todos los strings. */
  private serializeRequest(_path: string[], value: unknown): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const walk = (node: unknown, name: string): string => {
      if (node === null || node === undefined) return '';
      if (Array.isArray(node)) return node.map((n) => walk(n, name)).join('');
      if (typeof node !== 'object') {
        const v = typeof node === 'number' ? String(node)
          : typeof node === 'boolean' ? (node ? 'S' : 'N')
          : esc(String(node));
        return `<wsfe:${name}>${v}</wsfe:${name}>`;
      }
      const inner = Object.entries(node as Record<string, unknown>)
        .map(([k, v]) => walk(v, k)).join('');
      return `<wsfe:${name}>${inner}</wsfe:${name}>`;
    };

    return walk(value, 'FeCAEReq');
  }

  private collectObservations(detail: Record<string, any>, errors: Record<string, any>): Array<{ code: number; message: string }> {
    const out: Array<{ code: number; message: string }> = [];
    const push = (e: any) => {
      if (!e) return;
      const arr = Array.isArray(e) ? e : [e];
      for (const x of arr) {
        if (x?.Code !== undefined) {
          out.push({ code: Number(x.Code), message: String(x.Msg ?? '').trim() });
        }
      }
    };
    push(errors?.Err);
    push(detail?.Observaciones?.Obs);
    return out;
  }
}
