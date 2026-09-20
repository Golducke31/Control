import { z } from 'zod'
import { coleccionSchema } from './comun.ts'

/**
 * Tipo de documento de la cadena de ventas. La secuencia válida (cotización →
 * pedido → remito → factura → devolución) se valida en F4; acá sólo se declara
 * el valor discriminante.
 */
export const DocumentoVentaTipo = z.enum([
  'cotizacion',
  'pedido',
  'remito',
  'factura',
  'devolucion',
])
export type DocumentoVentaTipo = z.infer<typeof DocumentoVentaTipo>

/**
 * Estado derivado de un documento de venta. En F4 estas transiciones se vuelven
 * acciones en la barra; por ahora el contrato fija el conjunto de valores.
 */
export const DocumentoVentaEstado = z.enum([
  'borrador',
  'pendiente',
  'aceptado',
  'rechazado',
  'vencido',
  'facturado',
])
export type DocumentoVentaEstado = z.infer<typeof DocumentoVentaEstado>

export const DocumentoVentaSchema = z.object({
  id: z.string(),
  tipo: DocumentoVentaTipo,
  numero: z.string(),
  cliente: z.string(),
  estado: DocumentoVentaEstado,
  total: z.number().int().nonnegative(),
  moneda: z.enum(['ARS', 'USD']),
  fecha: z.string(),
  /**
   * Para cotizaciones: fecha de vencimiento de la validez. La cadena de F4 deriva
   * el estado «vencida» de esta fecha contra el día que recibe `accionesDisponibles`,
   * nunca de `now()` (una decisión no debe depender de `now()`, §ADR 0004).
   */
  venceEn: z.string().nullable().optional(),
  /**
   * Para remitos: verdadero cuando la facturación ya cubrió el remito entero.
   * La cadena de F4 usa esto para no ofrecer «facturar» de nuevo (puerta de F4).
   */
  facturadoCompleto: z.boolean().optional(),
})
export type DocumentoVenta = z.infer<typeof DocumentoVentaSchema>

export const DocumentoVentaListadoSchema = coleccionSchema(DocumentoVentaSchema)
export type DocumentoVentaListado = z.infer<typeof DocumentoVentaListadoSchema>

/**
 * Resumen del panel de operación diaria. No es una colección: es un objeto único
 * con los indicadores del período. La ventana lo pinta como tarjetas, no como tabla.
 */
export const PanelResumenSchema = z.object({
  empresa: z.string(),
  periodo: z.string(),
  kpis: z.array(
    z.object({
      id: z.string(),
      etiqueta: z.string(),
      valor: z.number(),
      moneda: z.enum(['ARS', 'USD']).nullable(),
      tendencia: z.enum(['sube', 'baja', 'plana']).nullable(),
    }),
  ),
})
export type PanelResumen = z.infer<typeof PanelResumenSchema>

/**
 * Comprobante fiscal de la ventana Facturación (factura o nota de crédito ya
 * autorizada por AFIP, o en borrador). `resultado` es el código de AFIP
 * (`A`probado / `R`echazado / `P`endiente); `payment_status` es nuestro dominio.
 */
export const ComprobanteFiscalSchema = z.object({
  id: z.string(),
  numero: z.string(),
  tipo: z.enum(['factura', 'nota_credito']),
  cliente: z.string(),
  total: z.number().int().nonnegative(),
  moneda: z.enum(['ARS', 'USD']),
  autorizacion: z.string().nullable(),
  resultado: z.enum(['A', 'R', 'P']),
  estado: z.enum(['borrador', 'autorizada', 'anulada']),
  pagado: z.number().int().nonnegative(),
  payment_status: z.enum(['pendiente', 'parcial', 'pagado']),
  fecha: z.string(),
})
export type ComprobanteFiscal = z.infer<typeof ComprobanteFiscalSchema>

export const FacturacionListadoSchema = coleccionSchema(ComprobanteFiscalSchema)
export type FacturacionListado = z.infer<typeof FacturacionListadoSchema>
