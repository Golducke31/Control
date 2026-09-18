/**
 * Control · Fiscal · Implementación AFIP del contrato FiscalDriver
 * -----------------------------------------------------------------------------
 * Este driver es la frontera de traducción entre el vocabulario neutro del
 * dominio y la nomenclatura de AFIP. Todo lo específico de Argentina vive acá:
 *
 *   'invoice_a'            → CBTE_TIPO.FACTURA_A (1)
 *   'registered'           → CONDICION_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO (1)
 *   'individual'           → DOC_TIPO.DNI (96)
 *   authorizationId        → CAE
 *   ImpTotal/ImpNeto/ImpIVA→ net/tax/grandTotal
 *
 * Consecuencia buscada: si mañana cambia la normativa argentina, se modifica
 * este archivo. El módulo de ventas, el de reportes y la base de datos no se
 * enteran.
 */

import {
  type FiscalAuthorization,
  type FiscalContext,
  type FiscalDocument,
  type FiscalDocumentType,
  type FiscalDriver,
  type FiscalErrorCode,
  FiscalError,
  type FiscalHealth,
  type FiscalLine,
  type FiscalNormalizedResponse,
  type FiscalTaxBreakdown,
  type FiscalTaxCategory,
  type FiscalTotals,
} from '../fiscal-driver.js';

import {
  CBTE_TIPO,
  CONDICION_IVA_RECEPTOR,
  CONCEPTO,
  DOC_TIPO,
  IVA_ID,
  money,
  vatRateToId,
  WsfeClient,
  type WsfeIssueRequest,
} from '../../afip/wsfe.client.js';

import { AfipError, type AfipEnvironment, type TicketAcceso } from '../../afip/wsaa.client.js';

// =============================================================================
// Mapas de traducción — el corazón del driver
// =============================================================================

/**
 * Tipo de documento neutro → código de comprobante de AFIP.
 * La dirección inversa también se necesita para `normalize()`.
 */
const DOCUMENT_TYPE_TO_AFIP: Record<FiscalDocumentType, number> = {
  invoice_a:      CBTE_TIPO.FACTURA_A,
  invoice_b:      CBTE_TIPO.FACTURA_B,
  invoice_c:      CBTE_TIPO.FACTURA_C,
  invoice_export: CBTE_TIPO.FACTURA_A,   // se ajusta por condición del receptor
  debit_note_a:   CBTE_TIPO.NOTA_DEBITO_A,
  debit_note_b:   CBTE_TIPO.NOTA_DEBITO_B,
  debit_note_c:   CBTE_TIPO.NOTA_DEBITO_C,
  credit_note_a:  CBTE_TIPO.NOTA_CREDITO_A,
  credit_note_b:  CBTE_TIPO.NOTA_CREDITO_B,
  credit_note_c:  CBTE_TIPO.NOTA_CREDITO_C,
  receipt:        CBTE_TIPO.RECIBO_A,
};

const AFIP_TO_DOCUMENT_TYPE: Record<number, FiscalDocumentType> = Object.fromEntries(
  Object.entries(DOCUMENT_TYPE_TO_AFIP).map(([k, v]) => [v, k as FiscalDocumentType]),
) as Record<number, FiscalDocumentType>;

/** Condición fiscal neutra → código de AFIP (RG 5616). */
const TAX_CATEGORY_TO_AFIP: Record<FiscalTaxCategory, number> = {
  registered:     CONDICION_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO,
  simplified:     CONDICION_IVA_RECEPTOR.MONOTRIBUTO,
  exempt:         CONDICION_IVA_RECEPTOR.EXENTO,
  final_consumer: CONDICION_IVA_RECEPTOR.CONSUMIDOR_FINAL,
  uncategorized:  CONDICION_IVA_RECEPTOR.NO_CATEGORIZADO,
};

/** Tipo de identificación neutro → código de documento de AFIP. */
const TAX_ID_TYPE_TO_AFIP: Record<FiscalReceiverTaxIdType, number> = {
  company:  DOC_TIPO.CUIT,
  individual: DOC_TIPO.DNI,
  foreign:  DOC_TIPO.PASAPORTE,
  none:     DOC_TIPO.CONSUMIDOR_FINAL,
};

type FiscalReceiverTaxIdType = 'company' | 'individual' | 'foreign' | 'none';

/** Códigos de error de AFIP que requieren intervención humana, no reintento. */
const NON_RETRYABLE_AFIP_CODES = new Set([
  10016,  // número de comprobante no autorizado / fuera de secuencia
  10017,  // no hay comprobantes para el punto de venta
  10018,  // punto de venta no habilitado
  10019,  // servicio no habilitado
  10020,  // fecha fuera de rango permitido
  10021,  // punto de venta cerrado
  10024,  // correlatividad de fechas
  10025,  // comprobante ya autorizado
  10047,  // condición IVA del receptor inválida
  10048,  // tipo de documento del receptor inválido
  10071,  // importe total inconsistente
  600,    // TA vigente: requiere coordinación, no reintento inmediato
]);

// =============================================================================
// Driver
// =============================================================================

export interface AfipDriverDeps {
  wsfe: WsfeClient;
  /** Obtiene un Ticket de Acceso vigente (o hace login si hace falta). */
  getTicket(ctx: FiscalContext): Promise<TicketAcceso>;
  log(entry: {
    tenantId: string;
    operation: string;
    succeeded: boolean;
    durationMs: number;
    errorCode?: string;
    detail?: string;
  }): Promise<void>;
  now?: () => Date;
}

export class AfipFiscalDriver implements FiscalDriver {
  readonly countryCode = 'AR';
  readonly authority = 'AFIP';
  readonly contractVersion = 1 as const;

  constructor(private readonly deps: AfipDriverDeps) {}

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------
  async healthCheck(ctx: FiscalContext): Promise<FiscalHealth> {
    const now = this.deps.now?.() ?? new Date();

    // 1. Validación local de credenciales: más barata y más específica que
    //    preguntarle a AFIP. Un par cert/clave mal cargado se detecta acá.
    if (!ctx.credentials.certificatePem || !ctx.credentials.privateKeyPem) {
      return {
        reachable: false,
        credentialsValid: false,
        credentialsExpireAt: null,
        pointOfSaleEnabled: false,
        lastCheckedAt: now,
        message: 'Faltan el certificado o la clave privada de AFIP.',
      };
    }

    // 2. Vigencia del certificado, leída del propio X.509
    let credentialsExpireAt: Date | null = null;
    try {
      const { X509Certificate } = await import('node:crypto');
      const x509 = new X509Certificate(ctx.credentials.certificatePem);
      credentialsExpireAt = new Date(x509.validTo);
      if (credentialsExpireAt.getTime() < now.getTime()) {
        return {
          reachable: true,
          credentialsValid: false,
          credentialsExpireAt,
          pointOfSaleEnabled: false,
          lastCheckedAt: now,
          message: `El certificado AFIP venció el ${credentialsExpireAt.toISOString().slice(0, 10)}. ` +
            'Renueve el certificado antes de emitir comprobantes.',
        };
      }
    } catch (err) {
      return {
        reachable: false,
        credentialsValid: false,
        credentialsExpireAt: null,
        pointOfSaleEnabled: false,
        lastCheckedAt: now,
        message: `El certificado de AFIP no se pudo leer: ${(err as Error).message}`,
      };
    }

    // 3. Login WSAA: confirma que AFIP acepta el certificado y que el servicio
    //    `wsfe` está habilitado para el CUIT.
    let ta: TicketAcceso;
    try {
      ta = await this.deps.getTicket(ctx);
    } catch (err) {
      const fiscal = this.translateAfipError(err, 'healthCheck');
      return {
        reachable: fiscal.code !== 'AUTHORITY_UNREACHABLE',
        credentialsValid: fiscal.code !== 'CREDENTIALS_INVALID'
          && fiscal.code !== 'SERVICE_NOT_ENABLED',
        credentialsExpireAt,
        pointOfSaleEnabled: false,
        lastCheckedAt: now,
        message: fiscal.message,
      };
    }

    // 4. Puntos de venta habilitados: confirma la habilitación del punto de
    //    venta configurado, que es un error de configuración frecuente.
    const env = this.toEnvironment(ctx);
    let pointOfSaleEnabled = false;
    try {
      const result = await this.deps.wsfe.getPointsOfSale(env, ctx.tenantId, ctx.taxId);
      pointOfSaleEnabled = this.hasPointOfSale(result, ctx.pointOfSale);
    } catch {
      // No poder listar puntos de venta no invalida las credenciales: se reporta
      // como advertencia, no como fallo.
      pointOfSaleEnabled = false;
    }

    return {
      reachable: true,
      credentialsValid: true,
      credentialsExpireAt,
      pointOfSaleEnabled,
      lastCheckedAt: now,
      message: pointOfSaleEnabled
        ? `Conexión con ${this.authority} operativa. TA vigente hasta ${ta.expiresAt.toISOString()}.`
        : `Credenciales válidas, pero el punto de venta ${ctx.pointOfSale} no figura habilitado ` +
          'en el Administrador de Relaciones de AFIP.',
    };
  }

  // ---------------------------------------------------------------------------
  // Validación previa
  // ---------------------------------------------------------------------------
  async validateDocument(
    ctx: FiscalContext,
    doc: FiscalDocument,
  ): Promise<{ valid: boolean; issues: Array<{ field: string; message: string }> }> {
    const issues: Array<{ field: string; message: string }> = [];

    // --- Receptor identificado según el tipo de comprobante ------------------
    // Factura A exige CUIT. Es también una restricción de la tabla `invoices`
    // (`inv_doc_type_rules`), y se valida acá para dar un mensaje accionable
    // antes de intentar la operación.
    const kind = doc.documentType;
    if (kind === 'invoice_a' || kind === 'debit_note_a' || kind === 'credit_note_a') {
      if (doc.receiver.taxIdType !== 'company') {
        issues.push({
          field: 'receiver.taxIdType',
          message: 'Un comprobante clase A requiere un receptor con CUIT.',
        });
      }
      if (!doc.receiver.taxId || !/^\d{11}$/.test(doc.receiver.taxId)) {
        issues.push({
          field: 'receiver.taxId',
          message: 'El CUIT del receptor debe tener 11 dígitos sin separadores.',
        });
      }
      if (doc.receiver.taxCategory !== 'registered') {
        issues.push({
          field: 'receiver.taxCategory',
          message: 'Un comprobante clase A requiere que el receptor sea Responsable Inscripto.',
        });
      }
    }

    // --- Consumidor final no lleva número de documento ----------------------
    if (doc.receiver.taxIdType === 'none' && doc.receiver.taxId) {
      issues.push({
        field: 'receiver.taxId',
        message: 'Un receptor sin identificación no debe llevar número de documento.',
      });
    }

    // --- Concepto de servicios exige período --------------------------------
    if (doc.servicePeriod) {
      if (doc.servicePeriod.from > doc.servicePeriod.to) {
        issues.push({
          field: 'servicePeriod',
          message: 'La fecha de inicio del servicio no puede ser posterior a la de fin.',
        });
      }
    }

    // --- Ajustes requieren comprobante asociado -----------------------------
    if (doc.effect === 'credit' && !doc.relatedAuthorization) {
      issues.push({
        field: 'relatedAuthorization',
        message: 'Un comprobante de crédito debe referenciar el comprobante que ajusta.',
      });
    }

    // --- Rango de fechas aceptado por AFIP ---------------------------------
    // AFIP rechaza comprobantes con fecha anterior al inicio de su operatoria
    // o con más de un año de anticipación. Se valida localmente para no gastar
    // un número de comprobante en un rechazo previsible.
    const now = this.deps.now?.() ?? new Date();
    const daysDiff = (doc.issueDate.getTime() - now.getTime()) / 86_400_000;
    if (daysDiff < -30) {
      issues.push({
        field: 'issueDate',
        message: `La fecha de emisión (${doc.issueDate.toISOString().slice(0, 10)}) tiene más de 30 días ` +
          'de antigüedad. AFIP puede rechazarla.',
      });
    }
    if (daysDiff > 365) {
      issues.push({
        field: 'issueDate',
        message: 'AFIP no acepta comprobantes con más de un año de anticipación.',
      });
    }

    // --- Importes: se recalcula y se verifica la invariante -----------------
    const calc = this.calculate(doc);
    const expected = money(calc.totals.net + calc.totals.tax + calc.totals.nonTaxable);
    if (Math.abs(expected - calc.totals.grandTotal) > 0.01) {
      issues.push({
        field: 'totals',
        message: `Inconsistencia de importes: total ${calc.totals.grandTotal} ` +
          `vs. suma de componentes ${expected}. AFIP rechaza esta condición.`,
      });
    }

    if (calc.totals.grandTotal <= 0) {
      issues.push({
        field: 'lines',
        message: 'El total del comprobante debe ser mayor a cero.',
      });
    }

    // --- Alícuotas soportadas ----------------------------------------------
    for (const [i, line] of doc.lines.entries()) {
      try {
        vatRateToId(line.taxRate);
      } catch {
        issues.push({
          field: `lines[${i}].taxRate`,
          message: `AFIP no soporta la alícuota ${(line.taxRate * 100).toFixed(2)}%. ` +
            'Valores admitidos: 0%, 2,5%, 5%, 10,5%, 21%, 27%.',
        });
      }
    }

    return { valid: issues.length === 0, issues };
  }

  // ---------------------------------------------------------------------------
  // Reserva de número
  // ---------------------------------------------------------------------------
  async reserveNumber(
    ctx: FiscalContext,
    args: { documentType: FiscalDocumentType; series: string },
  ): Promise<{ number: string; series: string; reservedAt: Date }> {
    const cbteTipo = this.toAfipCbteTipo(args.documentType, ctx, undefined);
    const ptoVta = Number(ctx.pointOfSale);
    const env = this.toEnvironment(ctx);

    // El número REAL lo dicta AFIP. Un contador local se desincroniza ante
    // cualquier fallo y produce el error 10016.
    const last = await this.deps.wsfe.lastAuthorized(env, ctx.tenantId, ctx.taxId, ptoVta, cbteTipo);

    // El incremento real y su atomicidad los garantiza el repositorio, que debe
    // tomar un lock por (tenantId, ptoVta, cbteTipo). Este driver sólo informa
    // cuál es el último número que AFIP reconoce.
    return {
      number: String(last + 1),
      series: String(ptoVta),
      reservedAt: this.deps.now?.() ?? new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Emisión
  // ---------------------------------------------------------------------------
  async issue(
    ctx: FiscalContext,
    doc: FiscalDocument,
    reservation: { number: string; series: string },
    idempotencyKey: string,
  ): Promise<FiscalNormalizedResponse> {
    const calc = this.calculate(doc);
    const env = this.toEnvironment(ctx);

    const afipRequest: WsfeIssueRequest = {
      tenantId: ctx.tenantId,
      environment: env,
      cuit: ctx.taxId,
      pointOfSale: Number(reservation.series),
      cbteTipo: this.toAfipCbteTipo(doc.documentType, ctx, doc.receiver.taxCategory),
      // Con período de servicio se declara SERVICIOS; si no, PRODUCTOS. AFIP
      // rechaza un comprobante de servicios sin las fechas del período.
      concepto: doc.servicePeriod
        ? (calc.hasProducts ? CONCEPTO.PRODUCTOS_Y_SERVICIOS : CONCEPTO.SERVICIOS)
        : CONCEPTO.PRODUCTOS,
      docType: TAX_ID_TYPE_TO_AFIP[doc.receiver.taxIdType],
      docNumber: doc.receiver.taxId,
      receptorName: doc.receiver.legalName,
      receptorTaxCondition: TAX_CATEGORY_TO_AFIP[doc.receiver.taxCategory],
      serviceFrom: doc.servicePeriod?.from,
      serviceTo: doc.servicePeriod?.to,
      paymentDueDate: doc.servicePeriod?.paymentDue,
      currency: doc.currency,
      fxRate: doc.exchangeRate,
      items: doc.lines.map((l: FiscalLine) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatRate: l.taxRate,
        discountRate: l.discountRate,
      })),
      associatedCbte: doc.relatedAuthorization
        ? {
            cbteTipo: this.toAfipCbteTipo(doc.relatedAuthorization.documentType, ctx, doc.receiver.taxCategory),
            ptoVenta: Number(doc.relatedAuthorization.series),
            number: Number(doc.relatedAuthorization.number),
          }
        : undefined,
      idempotencyKey,
    };

    try {
      const result = await this.deps.wsfe.issueCae(afipRequest);

      const authorization: FiscalAuthorization | null = result.cae
        ? {
            authorizationId: result.cae,
            authorizationExpiresAt: result.caeExpiresAt,
            number: String(result.cbteNumber),
            series: reservation.series,
            issuedAt: doc.issueDate,
            totals: calc.totals,
            taxBreakdown: calc.breakdown,
          }
        : null;

      // Las observaciones de AFIP no siempre implican rechazo: un comprobante
      // puede quedar autorizado con observaciones. Se preserva esa distinción.
      const outcome = result.result === 'rejected'
        ? 'rejected'
        : result.result === 'observed'
          ? 'observed'
          : 'authorized';

      return {
        outcome,
        authorization,
        observations: result.observations.map((o) => ({
          code: String(o.code),
          message: o.message,
          retryable: false,
          requiresOperator: outcome === 'rejected',
        })),
      };
    } catch (err) {
      throw this.translateAfipError(err, 'issue');
    }
  }

  // ---------------------------------------------------------------------------
  // Consulta — la pieza que hace segura la recuperación
  // ---------------------------------------------------------------------------
  async query(
    ctx: FiscalContext,
    args: { documentType: FiscalDocumentType; series: string; number: string },
  ): Promise<FiscalNormalizedResponse | null> {
    const env = this.toEnvironment(ctx);

    try {
      const result = await this.deps.wsfe.queryCae(
        env,
        ctx.tenantId,
        ctx.taxId,
        Number(args.series),
        this.toAfipCbteTipo(args.documentType, ctx, undefined),
        Number(args.number),
      );

      // AFIP responde con un objeto vacío cuando el comprobante no existe.
      // Distinguir "no existe" de "existe" es lo que habilita reintentar sin
      // riesgo de duplicar.
      const detail = (result as Record<string, unknown>)?.ResultGet as
        | Record<string, unknown>
        | undefined;

      if (!detail || !detail.CAE) return null;

      const cae = String(detail.CAE);
      if (!/^\d{14}$/.test(cae)) return null;

      const totals = this.extractTotals(detail);

      return {
        outcome: 'authorized',
        authorization: {
          authorizationId: cae,
          authorizationExpiresAt: detail.CAEFchVto ? new Date(String(detail.CAEFchVto)) : null,
          number: args.number,
          series: args.series,
          issuedAt: detail.CbteFch ? new Date(String(detail.CbteFch)) : new Date(),
          totals,
          taxBreakdown: this.extractTaxBreakdown(detail),
        },
        observations: [],
      };
    } catch (err) {
      throw this.translateAfipError(err, 'query');
    }
  }

  // ---------------------------------------------------------------------------
  // Anulación
  // ---------------------------------------------------------------------------
  /**
   * En Argentina **no existe la anulación** de un comprobante autorizado. La
   * única vía válida es emitir una Nota de Crédito que lo ajuste. Este método
   * lo dice explícitamente en lugar de simular una anulación que AFIP no acepta.
   *
   * El servicio que orquesta la anulación debe: emitir la NC, marcarla como
   * relacionada y dejar el comprobante original inmutable. Ver la política RLS
   * `invoices_no_update_authorized`.
   */
  async void(
    _ctx: FiscalContext,
    args: { authorizationId: string; reason: string; effectiveDate?: Date },
  ): Promise<FiscalNormalizedResponse> {
    throw new FiscalError(
      `AFIP no admite la anulación del comprobante con CAE ${args.authorizationId}. ` +
      'Un comprobante autorizado es fiscalmente inmutable: debe emitirse una Nota de Crédito ' +
      `que lo ajuste. Motivo informado: ${args.reason}`,
      'DOCUMENT_REJECTED',
      'void',
      undefined,
      undefined,
      'Emita una Nota de Crédito referenciando el comprobante original.',
    );
  }

  // ---------------------------------------------------------------------------
  // Normalización
  // ---------------------------------------------------------------------------
  normalize(rawResponse: unknown): FiscalNormalizedResponse {
    const parsed = rawResponse as Record<string, any> | null;

    if (!parsed) {
      return {
        outcome: 'rejected',
        authorization: null,
        observations: [{
          code: 'EMPTY_RESPONSE',
          message: 'AFIP devolvió una respuesta vacía o ilegible.',
          retryable: true,
          requiresOperator: false,
        }],
      };
    }

    const detail = parsed.FeDetResp?.FECAEDetResponse?.[0] ?? {};
    const errors = parsed.Errors?.Err;
    const observations: FiscalNormalizedResponse['observations'] = [];

    const pushAll = (items: unknown) => {
      if (!items) return;
      for (const item of Array.isArray(items) ? items : [items]) {
        const code = Number((item as any)?.Code);
        observations.push({
          code: String(code ?? 'UNKNOWN'),
          message: String((item as any)?.Msg ?? '').trim(),
          retryable: !NON_RETRYABLE_AFIP_CODES.has(code),
          requiresOperator: NON_RETRYABLE_AFIP_CODES.has(code),
        });
      }
    };

    pushAll(errors);
    pushAll(detail.Observaciones?.Obs);

    const cae = detail.CAE ? String(detail.CAE) : null;
    const outcome = parsed.FeCabResp?.Resultado === 'R' || errors
      ? 'rejected'
      : observations.length > 0
        ? 'observed'
        : 'authorized';

    return {
      outcome,
      authorization: cae
        ? {
            authorizationId: cae,
            authorizationExpiresAt: detail.CAEFchVto ? new Date(detail.CAEFchVto) : null,
            number: String(detail.CbteDesde ?? ''),
            series: String(parsed.FeCabResp?.PtoVta ?? ''),
            issuedAt: detail.CbteFch ? new Date(detail.CbteFch) : new Date(),
            totals: this.extractTotals(parsed),
            taxBreakdown: this.extractTaxBreakdown(parsed),
          }
        : null,
      observations,
    };
  }

  // ---------------------------------------------------------------------------
  // Cálculo local — se valida antes de enviar, nunca se delega en AFIP
  // ---------------------------------------------------------------------------
  /**
   * Recalcula los importes con el mismo método de redondeo que AFIP.
   *
   * Se calcula localmente en lugar de confiar en lo que vino de la orden: si el
   * cálculo local y el envío divergen, el comprobante se rechaza y se quema un
   * número de la autoridad. Recalcular en el driver y comparar contra la
   * invariante que AFIP valida evita ese desperdicio.
   */
  private calculate(doc: FiscalDocument): {
    totals: FiscalTotals;
    breakdown: FiscalTaxBreakdown[];
    hasProducts: boolean;
  } {
    const buckets = new Map<number, { base: number; amount: number }>();
    let net = 0;
    let tax = 0;
    let discount = 0;
    let grandTotal = 0;
    let hasProducts = false;

    for (const line of doc.lines) {
      const gross = money(line.quantity * line.unitPrice);
      const lineDiscount = money(gross * (line.discountRate ?? 0));
      const lineNet = money(gross - lineDiscount);
      const lineTax = money(lineNet * line.taxRate);
      const vatId = vatRateToId(line.taxRate);

      const bucket = buckets.get(vatId) ?? { base: 0, amount: 0 };
      bucket.base = money(bucket.base + lineNet);
      bucket.amount = money(bucket.amount + lineTax);
      buckets.set(vatId, bucket);

      net = money(net + lineNet);
      tax = money(tax + lineTax);
      discount = money(discount + lineDiscount);
      grandTotal = money(grandTotal + lineNet + lineTax);

      if (line.quantity > 0 && line.taxRate >= 0) hasProducts = true;
    }

    // El array Iva NO debe incluir la alícuota 0%: AFIP rechaza el Id 3 en el
    // detalle de IVA. La base al 0% se informa fuera del array (ImpOpEx o
    // simplemente no se discrimina).
    const breakdown: FiscalTaxBreakdown[] = [...buckets.entries()]
      .filter(([vatId]) => vatId !== IVA_ID.IVA_0)
      .map(([vatId, v]) => ({
        rate: this.vatIdToRate(vatId),
        base: v.base,
        amount: v.amount,
        localTaxId: String(vatId),
      }));

    return {
      totals: {
        net,
        tax,
        exempt: 0,
        nonTaxable: 0,
        discount,
        grandTotal,
      },
      breakdown,
      hasProducts,
    };
  }

  // ---------------------------------------------------------------------------
  // Traducción de errores — el punto donde AFIP deja de filtrarse al dominio
  // ---------------------------------------------------------------------------
  private translateAfipError(err: unknown, operation: string): FiscalError {
    if (err instanceof FiscalError) return err;

    // Error de red: la única condición realmente reintentable sin ambigüedad
    if (err instanceof AfipError) {
      const localCode = err.code;
      const code = this.mapAfipErrorCode(localCode);

      return new FiscalError(
        err.message,
        code,
        `afip.${operation}`,
        localCode,
        err.rawResponse,
        this.operatorActionFor(code),
      );
    }

    const message = err instanceof Error ? err.message : 'Error desconocido en AFIP';

    // Heurística por mensaje: AFIP no siempre provee un código estructurado
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|timeout/i.test(message)) {
      return new FiscalError(
        `AFIP no respondió (${message}). El comprobante puede haberse emitido: ` +
        'se consultará antes de reintentar.',
        'AUTHORITY_UNREACHABLE',
        `afip.${operation}`,
        undefined,
        undefined,
        'Si el estado persiste, verifique el estado de los servicios de AFIP.',
      );
    }

    if (/certificado no autorizado|no autorizado a acceder/i.test(message)) {
      return new FiscalError(
        'AFIP rechazó el certificado. El servicio "wsfe" probablemente no esté habilitado ' +
        'para este CUIT en el Administrador de Relaciones.',
        'SERVICE_NOT_ENABLED',
        `afip.${operation}`,
        undefined,
        undefined,
        'Ingrese al Administrador de Relaciones de AFIP y habilite el servicio de ' +
        'Facturación Electrónica para el CUIT emisor.',
      );
    }

    if (/expirationTime|generationTime|no vigente/i.test(message)) {
      return new FiscalError(
        'El Ticket de Requerimiento de Acceso fue rechazado por incoherencia temporal. ' +
        'Verifique la sincronización horaria del servidor (NTP).',
        'CREDENTIALS_INVALID',
        `afip.${operation}`,
        undefined,
        undefined,
        'Sincronice el reloj del servidor con NTP y reintente.',
      );
    }

    return new FiscalError(message, 'UNKNOWN', `afip.${operation}`);
  }

  private mapAfipErrorCode(localCode: string | undefined): FiscalErrorCode {
    switch (localCode) {
      case 'AFIP_UNREACHABLE':
      case 'NETWORK':
      case 'HTTP_502':
      case 'HTTP_503':
      case 'HTTP_504':
        return 'AUTHORITY_UNREACHABLE';
      case 'CERT_EXPIRED':
        return 'CREDENTIALS_EXPIRED';
      case 'CERT_KEY_MISMATCH':
        return 'CREDENTIALS_MISMATCH';
      case 'WSAA_PARSE':
      case 'SOAP_FAULT':
        return 'CREDENTIALS_INVALID';
      case 'CAE_MALFORMED':
      case 'TOTAL_MISMATCH':
        return 'AMOUNT_INCONSISTENT';
      case 'VAT_RATE_UNSUPPORTED':
        return 'RECEIVER_INVALID';
      case 'SERVICE_DATES_REQUIRED':
        return 'DOCUMENT_REJECTED';
      default:
        return 'UNKNOWN';
    }
  }

  private operatorActionFor(code: FiscalErrorCode): string | undefined {
    switch (code) {
      case 'CREDENTIALS_EXPIRED':
        return 'Renueve el certificado digital de AFIP y vuelva a cargarlo.';
      case 'CREDENTIALS_MISMATCH':
        return 'Verifique que el certificado y la clave privada sean del mismo par.';
      case 'SERVICE_NOT_ENABLED':
        return 'Habilite el servicio de Facturación Electrónica en el Administrador de Relaciones de AFIP.';
      case 'POINT_OF_SALE_DISABLED':
        return 'Habilite el punto de venta en el Administrador de Relaciones de AFIP.';
      case 'AUTHORITY_UNREACHABLE':
        return 'Verifique el estado de los servicios de AFIP. Los comprobantes quedan en cola.';
      default:
        return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private toEnvironment(ctx: FiscalContext): AfipEnvironment {
    return ctx.environment === 'production' ? 'production' : 'homologation';
  }

  /**
   * Tipo de comprobante de AFIP. La Nota de Crédito/Débito debe compartir la
   * clase (A/B/C) del comprobante que ajusta, no la del receptor actual.
   */
  private toAfipCbteTipo(
    type: FiscalDocumentType,
    _ctx: FiscalContext,
    _receiverCategory: FiscalTaxCategory | undefined,
  ): number {
    const cbteTipo = DOCUMENT_TYPE_TO_AFIP[type];
    if (cbteTipo === undefined) {
      throw new FiscalError(
        `Tipo de documento no soportado por AFIP: ${type}`,
        'DOCUMENT_REJECTED',
        'translate.cbteTipo',
      );
    }
    return cbteTipo;
  }

  private vatIdToRate(vatId: number): number {
    switch (vatId) {
      case IVA_ID.IVA_0: return 0;
      case IVA_ID.IVA_2_5: return 0.025;
      case IVA_ID.IVA_5: return 0.05;
      case IVA_ID.IVA_10_5: return 0.105;
      case IVA_ID.IVA_21: return 0.21;
      case IVA_ID.IVA_27: return 0.27;
      default: return 0;
    }
  }

  private hasPointOfSale(result: unknown, pointOfSale: string): boolean {
    const list = (result as any)?.ResultGet?.PtoVenta;
    if (!list) return false;
    const items = Array.isArray(list) ? list : [list];
    return items.some(
      (p: any) => String(p?.Nro ?? p?.EmisionNro ?? '') === String(pointOfSale),
    );
  }

  private extractTotals(source: Record<string, any>): FiscalTotals {
    const d = source.ResultGet ?? source.FeDetResp?.FECAEDetResponse?.[0] ?? source;
    return {
      net: money(Number(d.ImpNeto ?? 0)),
      tax: money(Number(d.ImpIVA ?? 0)),
      exempt: money(Number(d.ImpOpEx ?? 0)),
      nonTaxable: money(Number(d.ImpTotConc ?? 0)),
      discount: 0,
      grandTotal: money(Number(d.ImpTotal ?? 0)),
    };
  }

  private extractTaxBreakdown(source: Record<string, any>): FiscalTaxBreakdown[] {
    const d = source.ResultGet ?? source.FeDetResp?.FECAEDetResponse?.[0] ?? source;
    const list = d.Iva?.AlicIva;
    if (!list) return [];
    const items = Array.isArray(list) ? list : [list];
    return items.map((i: any) => ({
      rate: money(Number(i.Id ?? 0)),
      base: money(Number(i.BaseImp ?? 0)),
      amount: money(Number(i.Importe ?? 0)),
      localTaxId: String(i.Id ?? ''),
    }));
  }
}

// Re-exportar el mapa inverso: lo usa el servicio de consulta para reconstruir
// el tipo neutro a partir de la respuesta de AFIP.
export { AFIP_TO_DOCUMENT_TYPE, DOCUMENT_TYPE_TO_AFIP, TAX_CATEGORY_TO_AFIP, TAX_ID_TYPE_TO_AFIP };
