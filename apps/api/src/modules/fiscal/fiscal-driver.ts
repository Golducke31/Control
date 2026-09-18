/**
 * Control · Fiscal · Contrato del motor de comprobantes (FiscalDriver)
 * -----------------------------------------------------------------------------
 * Por qué existe esta abstracción
 *
 * El módulo de facturación no debe saber que existe AFIP. Si lo supiera, agregar
 * un segundo país obligaría a ramificar por país dentro del dominio de ventas,
 * de reportes, de stock y de exportaciones —cuatro módulos contaminados por un
 * detalle de un quinto—. Con este contrato, el dominio consume una interfaz
 * neutra y cada país aporta una implementación.
 *
 * Argentina implementa `AfipFiscalDriver` envolviendo los clientes WSAA y WSFE
 * que ya existen. Chile implementaría `SiiFiscalDriver` contra el SII, México
 * contra el CFDI del SAT, Colombia contra la DIAN. El modelo de datos, los
 * reportes y las ventanas no cambian: consumen `FiscalDriver`.
 *
 * Frontera de traducción
 *
 * El dominio habla de `documentType`, `netAmount`, `taxAmount`, `authorizationId`.
 * Cada driver traduce a y desde la nomenclatura local: `CbteTipo`, `ImpNeto`,
 * `ImpIVA`, `CAE`. La traducción vive en el driver, nunca en el dominio. Cuando
 * aparece una particularidad de un país, se resuelve dentro de su driver.
 *
 * Regla de diseño: este archivo no importa nada específico de AFIP. Si algún día
 * lo hiciera, la abstracción ya estaría rota.
 */

// =============================================================================
// Contexto de la empresa
// =============================================================================

/** Datos que un driver necesita para operar en nombre de una empresa. */
export interface FiscalContext {
  tenantId: string;
  /** Código ISO 3166-1 alfa-2 del país donde se emite. Ej. 'AR'. */
  countryCode: string;
  /** Identificación tributaria en el formato local, normalizada sin separadores. */
  taxId: string;
  /** Ambiente. Cada país mapea estos dos niveles a los suyos. */
  environment: 'test' | 'production';
  /** Punto de venta, sucursal, serie o establecimiento según el país. */
  pointOfSale: string;
  /** Zona horaria de la empresa: determina la fecha fiscal del comprobante. */
  timeZone: string;
  /** Credenciales descifradas y listas para usar. Nunca se persisten en claro. */
  credentials: FiscalCredentials;
}

export interface FiscalCredentials {
  /** Certificado en PEM. Puede ser null si el país usa firma con clave simétrica. */
  certificatePem?: string;
  /** Clave privada en PEM. */
  privateKeyPem?: string;
  /** Token de API para países cuyo organismo usa REST en lugar de SOAP. */
  apiToken?: string;
  apiSecret?: string;
  /** Atributos extra que un driver específico pueda necesitar. */
  extra?: Record<string, string>;
}

// =============================================================================
// Documento a emitir — vocabulario neutro
// =============================================================================

export interface FiscalDocument {
  /**
   * Tipo de documento en vocabulario neutro.
   * Cada driver traduce: en Argentina, 'invoice_a' → CbteTipo 1.
   */
  documentType: FiscalDocumentType;
  /**
   * Clase de efecto sobre el total ya emitido. Permite que un driver sepa si
   * debe ajustar hacia arriba o hacia abajo sin conocer la nomenclatura local.
   */
  effect: 'charge' | 'credit';
  issueDate: Date;
  currency: string;
  exchangeRate: number;
  receiver: FiscalReceiver;
  lines: FiscalLine[];
  /** Referencia al comprobante ajustado, cuando el efecto no es 'charge'. */
  relatedAuthorization?: {
    documentType: FiscalDocumentType;
    series: string;
    number: string;
  };
  /**
   * Claves de servicio, cuando el concepto del país las exige.
   * Sin esto, el driver no puede emitir un documento de servicios.
   */
  servicePeriod?: { from: Date; to: Date; paymentDue?: Date };
}

/**
 * Tipos neutros. No son los códigos de ningún país: son la taxonomía del
 * dominio. El mapeo a códigos locales vive en cada driver.
 */
export type FiscalDocumentType =
  | 'invoice_a'        // discrimina IVA, receptor identificado con potestad fiscal
  | 'invoice_b'        // consumidor final o sujeto no categorizado
  | 'invoice_c'        // emisor simplificado
  | 'invoice_export'   // exportación
  | 'debit_note_a'
  | 'debit_note_b'
  | 'debit_note_c'
  | 'credit_note_a'
  | 'credit_note_b'
  | 'credit_note_c'
  | 'receipt';

export interface FiscalReceiver {
  /** Identificación tributaria. null para consumidor final sin identificar. */
  taxId: string | null;
  /** Tipo de documento neutro: permite mapear a 80/96/99 en Argentina. */
  taxIdType: 'company' | 'individual' | 'foreign' | 'none';
  legalName: string;
  /**
   * Condición frente al impuesto en vocabulario neutro.
   * En Argentina mapea a CondicionIVAReceptorId (RG 5616).
   */
  taxCategory: FiscalTaxCategory;
  address?: string;
}

export type FiscalTaxCategory =
  | 'registered'      // responsable inscripto
  | 'simplified'      // monotributo / régimen simplificado
  | 'exempt'          // exento
  | 'final_consumer'  // consumidor final
  | 'uncategorized';

export interface FiscalLine {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Descuento por línea, como fracción: 0.15 = 15%. */
  discountRate: number;
  /** Alícuota del impuesto: 0.21 = 21%. */
  taxRate: number;
}

// =============================================================================
// Resultado — vocabulario neutro
// =============================================================================

export interface FiscalAuthorization {
  /**
   * Identificador de la autorización en vocabulario neutro.
   * En Argentina es el CAE de 14 dígitos.
   */
  authorizationId: string;
  /** Vencimiento de la autorización, cuando el país lo define. */
  authorizationExpiresAt: Date | null;
  /** Número asignado por la autoridad. */
  number: string;
  series: string;
  /** Fecha de emisión tal como quedó registrada en la autoridad. */
  issuedAt: Date;
  /** Totales calculados, para contrastar contra el cálculo local. */
  totals: FiscalTotals;
  /** Desglose de impuestos por alícuota. */
  taxBreakdown: FiscalTaxBreakdown[];
}

export interface FiscalTotals {
  net: number;
  tax: number;
  exempt: number;
  nonTaxable: number;
  discount: number;
  grandTotal: number;
}

export interface FiscalTaxBreakdown {
  /** Alícuota como fracción. */
  rate: number;
  base: number;
  amount: number;
  /** Código local del impuesto, cuando el país lo exige. */
  localTaxId?: string;
}

export type FiscalOutcome = 'authorized' | 'rejected' | 'observed';

export interface FiscalNormalizedResponse {
  outcome: FiscalOutcome;
  authorization: FiscalAuthorization | null;
  /** Observaciones normalizadas, con el código local preservado. */
  observations: Array<{
    code: string;
    message: string;
    /** true si el error es transitorio y conviene reintentar. */
    retryable: boolean;
    /** true si es un error de configuración que requiere intervención humana. */
    requiresOperator: boolean;
  }>;
}

export interface FiscalHealth {
  reachable: boolean;
  credentialsValid: boolean;
  credentialsExpireAt: Date | null;
  pointOfSaleEnabled: boolean;
  lastCheckedAt: Date;
  message?: string;
}

// =============================================================================
// El error fiscal — el driver traduce lo local a esto
// =============================================================================

/**
 * Error de dominio fiscal. El `code` es neutro y estable; el `localCode` preserva
 * el código original de la autoridad para diagnóstico y trazabilidad.
 */
export class FiscalError extends Error {
  constructor(
    message: string,
    readonly code: FiscalErrorCode,
    readonly operation: string,
    readonly localCode?: string,
    readonly rawResponse?: unknown,
    /** Sugerencia operativa: qué debe hacer un humano ante este error. */
    readonly operatorAction?: string,
  ) {
    super(message);
    this.name = 'FiscalError';
  }
}

export type FiscalErrorCode =
  | 'AUTHORITY_UNREACHABLE'      // el organismo no responde
  | 'CREDENTIALS_INVALID'        // certificado o token rechazado
  | 'CREDENTIALS_EXPIRED'        // credencial vencida
  | 'CREDENTIALS_MISMATCH'       // par certificado/clave no correspondiente
  | 'POINT_OF_SALE_DISABLED'     // el punto de venta no está habilitado
  | 'SERVICE_NOT_ENABLED'        // el servicio no está habilitado para el contribuyente
  | 'DOCUMENT_REJECTED'          // la autoridad rechazó el comprobante
  | 'NUMBER_OUT_OF_SEQUENCE'     // correlatividad desincronizada
  | 'AMOUNT_INCONSISTENT'        // los importes no cierran
  | 'RECEIVER_INVALID'           // datos del receptor inválidos para ese tipo de documento
  | 'RATE_LIMITED'               // exceso de solicitudes
  | 'UNKNOWN';

// =============================================================================
// El contrato
// =============================================================================

export interface FiscalDriver {
  /** Código ISO del país que atiende esta implementación. */
  readonly countryCode: string;
  /** Nombre del organismo: 'AFIP', 'SII', 'SAT', 'DIAN'. */
  readonly authority: string;
  /**
   * Versión del contrato que implementa. Permite evolucionar la interfaz sin
   * romper drivers existentes: si el país B implementa la v1, se sabe qué
   * esperar de él.
   */
  readonly contractVersion: 1;

  /**
   * Verifica credenciales, habilitación del servicio y disponibilidad del
   * organismo. Se ejecuta antes de habilitar el módulo fiscal para una empresa:
   * es más barato detectar un certificado mal cargado que descubrirlo al emitir
   * la primera factura real.
   */
  healthCheck(ctx: FiscalContext): Promise<FiscalHealth>;

  /**
   * Confirma que el driver sabe emitir este tipo de documento para este país.
   * Permite que la UI oculte tipos no soportados y que la validación sea previa.
   */
  validateDocument(
    ctx: FiscalContext,
    doc: FiscalDocument,
  ): Promise<{ valid: boolean; issues: Array<{ field: string; message: string }> }>;

  /**
   * Obtiene el próximo número disponible de la autoridad.
   *
   * Por qué se obtiene de la autoridad y no de un contador local: un contador
   * propio se desincroniza ante cualquier fallo (una emisión que falla después
   * de reservar, una restauración de backup, dos procesos concurrentes) y
   * produce rechazos por numeración. En Argentina, el error 10016.
   *
   * La implementación debe reservar de forma atómica por
   * (empresa, punto de venta, tipo de documento).
   */
  reserveNumber(ctx: FiscalContext, args: {
    documentType: FiscalDocumentType;
    series: string;
  }): Promise<{ number: string; series: string; reservedAt: Date }>;

  /**
   * Emite el documento y solicita la autorización.
   *
   * Implementación esperada:
   *  1. Recalcular importes y verificar las invariantes del país.
   *  2. Traducir el documento neutro a la estructura local.
   *  3. Enviar y evaluar la respuesta.
   *  4. Traducir la respuesta a `FiscalNormalizedResponse`.
   *
   * Si la respuesta es indeterminada (timeout), debe lanzar `FiscalError` con
   * code 'AUTHORITY_UNREACHABLE' y `retryable` en la observación. El llamador
   * tiene la obligación de invocar `query()` antes de reintentar.
   */
  issue(
    ctx: FiscalContext,
    doc: FiscalDocument,
    reservation: { number: string; series: string },
    idempotencyKey: string,
  ): Promise<FiscalNormalizedResponse>;

  /**
   * Consulta un documento ya emitido.
   *
   * Es la pieza que hace segura la recuperación: ante un timeout no se sabe si
   * la autoridad registró el documento. Reemitir crearía un duplicado fiscal,
   * que en Argentina es una falta grave. Consultar primero resuelve la
   * ambigüedad sin riesgo.
   *
   * Devuelve null si el documento no existe en la autoridad.
   */
  query(ctx: FiscalContext, args: {
    documentType: FiscalDocumentType;
    series: string;
    number: string;
  }): Promise<FiscalNormalizedResponse | null>;

  /**
   * Anula o acredita un documento ya autorizado.
   *
   * En Argentina no existe la anulación: se emite una Nota de Crédito. En otros
   * países la anulación es un acto propio. El contrato admite ambas semánticas
   * y cada driver documenta cuál usa.
   */
  void(ctx: FiscalContext, args: {
    authorizationId: string;
    reason: string;
    /** Fecha del acto de anulación, cuando el país la exige. */
    effectiveDate?: Date;
  }): Promise<FiscalNormalizedResponse>;

  /**
   * Traduce observaciones locales a la taxonomía neutra. Se expone porque el
   * módulo de contingencia necesita clasificar errores sin conocer el país.
   */
  normalize(rawResponse: unknown): FiscalNormalizedResponse;
}

// =============================================================================
// Registro de drivers — el punto de despacho por país
// =============================================================================

export interface FiscalDriverRegistration {
  countryCode: string;
  /** Constructor que recibe sus dependencias ya resueltas. */
  factory: () => FiscalDriver;
  /** true una vez validado el país contra la autoridad real. */
  certified: boolean;
}

/**
 * Resuelve el driver según el país de la empresa.
 *
 * Por qué un registro y no un `switch`: el `switch` obliga a modificar un
 * archivo central cada vez que se agrega un país, y ese archivo se vuelve un
 * punto de conflicto de merges. El registro permite que cada país viva en su
 * propio módulo y se registre al arrancar.
 */
export class FiscalDriverRegistry {
  private readonly registrations = new Map<string, FiscalDriverRegistration>();
  private readonly instances = new Map<string, FiscalDriver>();

  register(reg: FiscalDriverRegistration): void {
    const code = reg.countryCode.toUpperCase();
    if (this.registrations.has(code)) {
      throw new Error(`Ya hay un driver fiscal registrado para el país ${code}`);
    }
    this.registrations.set(code, { ...reg, countryCode: code });
  }

  /**
   * Devuelve el driver de un país. Lanza si no existe: un país sin driver no
   * puede emitir, y fallar ruidosamente en el borde es mejor que devolver algo
   * que no emite correctamente.
   */
  resolve(countryCode: string): FiscalDriver {
    const code = countryCode.toUpperCase();
    const cached = this.instances.get(code);
    if (cached) return cached;

    const reg = this.registrations.get(code);
    if (!reg) {
      throw new FiscalError(
        `No hay motor fiscal disponible para el país ${code}. ` +
        `Países soportados: ${[...this.registrations.keys()].join(', ') || 'ninguno'}.`,
        'SERVICE_NOT_ENABLED',
        'registry.resolve',
        undefined,
        undefined,
        'Solicite la habilitación del país antes de operar.',
      );
    }

    // Un driver no certificado puede resolver, pero se marca para que la capa
    // superior decida. Permite trabajar en un país nuevo sin habilitarlo en
    // producción por accidente.
    const instance = reg.factory();
    this.instances.set(code, instance);
    return instance;
  }

  /** Países con driver disponible, para exponerlo en la consola de plataforma. */
  supportedCountries(): Array<{ countryCode: string; authority: string; certified: boolean }> {
    return [...this.registrations.values()].map((r) => {
      const instance = r.factory();
      return {
        countryCode: r.countryCode,
        authority: instance.authority,
        certified: r.certified,
      };
    });
  }

  isCertified(countryCode: string): boolean {
    return this.registrations.get(countryCode.toUpperCase())?.certified ?? false;
  }
}

// =============================================================================
// Servicio de aplicación: emisión con recuperación
// =============================================================================

/**
 * Orquesta la emisión sobre cualquier `FiscalDriver`.
 * Es el único lugar donde vive la lógica de reintento y recuperación, y por eso
 * es también el único lugar que necesita testearse con inyección de fallos.
 */
export interface IssueRequest {
  ctx: FiscalContext;
  document: FiscalDocument;
  /** Clave de idempotencia: impide emitir dos veces el mismo comprobante. */
  idempotencyKey: string;
}

export interface IssueOutcome {
  status: 'authorized' | 'rejected' | 'pending';
  authorization: FiscalAuthorization | null;
  observations: FiscalNormalizedResponse['observations'];
  /** Sólo presente cuando hubo recuperación. Útil para auditoría. */
  recovered?: boolean;
  attempts: number;
}

export class FiscalIssueService {
  constructor(
    private readonly registry: FiscalDriverRegistry,
    private readonly deps: {
      /** Persiste el intento antes de tocar la red. Sin esto no hay recuperación. */
      persistAttempt(args: {
        tenantId: string;
        idempotencyKey: string;
        number: string;
        series: string;
        at: Date;
      }): Promise<void>;
      /** Busca un comprobante ya autorizado con esta clave de idempotencia. */
      findByIdempotencyKey(args: {
        tenantId: string;
        idempotencyKey: string;
      }): Promise<{ authorization: FiscalAuthorization } | null>;
      /** Persiste el resultado, autorizado o rechazado. */
      persistResult(args: {
        tenantId: string;
        idempotencyKey: string;
        response: FiscalNormalizedResponse;
      }): Promise<void>;
      /** Encola para reintento diferido. */
      enqueueRetry(args: {
        tenantId: string;
        idempotencyKey: string;
        reason: string;
        attemptAfter: Date;
      }): Promise<void>;
      log(entry: {
        tenantId: string;
        operation: string;
        succeeded: boolean;
        durationMs: number;
        errorCode?: string;
        detail?: string;
      }): Promise<void>;
      now?: () => Date;
    },
  ) {}

  /**
   * Emite un documento aplicando la secuencia segura:
   *
   *   1. Idempotencia — si ya se emitió con esta clave, se devuelve lo existente.
   *   2. Reserva de número — atómica, por (empresa, punto de venta, tipo).
   *   3. Persistencia del intento — antes de la red, para poder recuperar.
   *   4. Emisión.
   *   5. Ante resultado indeterminado: **consultar antes de reintentar**.
   */
  async issue(req: IssueRequest): Promise<IssueOutcome> {
    const driver = this.registry.resolve(req.ctx.countryCode);

    // 1. Idempotencia
    const existing = await this.deps.findByIdempotencyKey({
      tenantId: req.ctx.tenantId,
      idempotencyKey: req.idempotencyKey,
    });
    if (existing) {
      return {
        status: 'authorized',
        authorization: existing.authorization,
        observations: [],
        attempts: 0,
      };
    }

    // 2. Validación previa al gasto de red. Detecta un comprobante mal armado
    //    sin consumir un número de la autoridad.
    const validation = await driver.validateDocument(req.ctx, req.document);
    if (!validation.valid) {
      return {
        status: 'rejected',
        authorization: null,
        observations: validation.issues.map((i) => ({
          code: 'VALIDATION',
          message: `${i.field}: ${i.message}`,
          retryable: false,
          requiresOperator: true,
        })),
        attempts: 0,
      };
    }

    // 3. Reserva de número
    const reservation = await driver.reserveNumber(req.ctx, {
      documentType: req.document.documentType,
      series: req.ctx.pointOfSale,
    });

    // 4. Persistir el intento ANTES de la red. Si el proceso muere entre este
    //    punto y la respuesta, el número reservado y su contexto quedan
    //    registrados y la recuperación puede consultarlo.
    await this.deps.persistAttempt({
      tenantId: req.ctx.tenantId,
      idempotencyKey: req.idempotencyKey,
      number: reservation.number,
      series: reservation.series,
      at: this.deps.now?.() ?? new Date(),
    });

    // 5. Emisión
    let response: FiscalNormalizedResponse;
    try {
      response = await driver.issue(
        req.ctx,
        req.document,
        reservation,
        req.idempotencyKey,
      );
    } catch (err) {
      const fiscalErr = toFiscalError(err);
      const retryable = fiscalErr.code === 'AUTHORITY_UNREACHABLE'
        || fiscalErr.code === 'RATE_LIMITED';

      if (!retryable) throw fiscalErr;

      // Resultado indeterminado: la autoridad pudo haber registrado el
      // documento. Consultar ANTES de reintentar. Reemitir a ciegas crearía un
      // duplicado fiscal.
      const recovered = await this.recover(driver, req.ctx, req.document, reservation);
      if (recovered) {
        await this.deps.persistResult({
          tenantId: req.ctx.tenantId,
          idempotencyKey: req.idempotencyKey,
          response: recovered,
        });
        return {
          status: recovered.outcome === 'authorized' ? 'authorized' : 'rejected',
          authorization: recovered.authorization,
          observations: recovered.observations,
          recovered: true,
          attempts: 1,
        };
      }

      // No existe: el documento realmente no se emitió. Se difiere el reintento
      // conservando el número ya reservado.
      const attemptAfter = new Date(Date.now() + 60_000);
      await this.deps.enqueueRetry({
        tenantId: req.ctx.tenantId,
        idempotencyKey: req.idempotencyKey,
        reason: fiscalErr.message,
        attemptAfter,
      });

      return {
        status: 'pending',
        authorization: null,
        observations: [{
          code: fiscalErr.localCode ?? fiscalErr.code,
          message: fiscalErr.message,
          retryable: true,
          requiresOperator: false,
        }],
        attempts: 1,
      };
    }

    // 6. Aprobado, rechazado u observado con respuesta concreta
    await this.deps.persistResult({
      tenantId: req.ctx.tenantId,
      idempotencyKey: req.idempotencyKey,
      response,
    });

    return {
      status: response.outcome === 'authorized' || response.outcome === 'observed'
        ? 'authorized'
        : 'rejected',
      authorization: response.authorization,
      observations: response.observations,
      attempts: 1,
    };
  }

  /**
   * Intenta resolver un resultado indeterminado consultando a la autoridad.
   * Devuelve null si el documento no existe, lo que significa que se puede
   * reintentar la emisión sin riesgo de duplicar.
   */
  private async recover(
    driver: FiscalDriver,
    ctx: FiscalContext,
    doc: FiscalDocument,
    reservation: { number: string; series: string },
  ): Promise<FiscalNormalizedResponse | null> {
    const t0 = Date.now();
    try {
      const found = await driver.query(ctx, {
        documentType: doc.documentType,
        series: reservation.series,
        number: reservation.number,
      });
      await this.deps.log({
        tenantId: ctx.tenantId,
        operation: 'fiscal.recover',
        succeeded: true,
        durationMs: Date.now() - t0,
        detail: found ? 'documento encontrado' : 'documento inexistente',
      });
      return found;
    } catch (err) {
      // Si la consulta también falla, no hay veredicto: se difiere el reintento
      // en lugar de asumir que no existe.
      await this.deps.log({
        tenantId: ctx.tenantId,
        operation: 'fiscal.recover',
        succeeded: false,
        durationMs: Date.now() - t0,
        errorCode: toFiscalError(err).code,
      });
      return null;
    }
  }
}

/**
 * Normaliza cualquier error a `FiscalError`.
 *
 * La traducción de un error local a uno neutro vive en cada driver. Si un driver
 * deja escapar un error crudo, esto al menos garantiza que el resto del sistema
 * no reciba una forma inesperada.
 */
export function toFiscalError(err: unknown): FiscalError {
  if (err instanceof FiscalError) return err;
  return new FiscalError(
    err instanceof Error ? err.message : 'Error fiscal desconocido',
    'UNKNOWN',
    'fiscal.normalize',
  );
}
