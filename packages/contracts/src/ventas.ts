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
})
export type DocumentoVenta = z.infer<typeof DocumentoVentaSchema>

export const DocumentoVentaListadoSchema = coleccionSchema(DocumentoVentaSchema)
export type DocumentoVentaListado = z.infer<typeof DocumentoVentaListadoSchema>
