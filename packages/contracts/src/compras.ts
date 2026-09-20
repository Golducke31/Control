import { z } from 'zod'
import { coleccionSchema } from './comun.ts'

/**
 * Compras y proveedores.
 *
 * Los estados espejan los CHECK de `purchasing.supplier_orders` y
 * `purchasing.supplier_invoices`, y los medios de pago el de
 * `purchasing.supplier_payments`. Se copian **tal cual** —en inglés— porque son los
 * valores que el motor acepta: traducirlos acá obligaría a traducir de vuelta al
 * escribir, y ahí es donde se cuela un estado que la base rechaza.
 */

export const ProveedorSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  cuit: z.string(),
  email: z.string().optional(),
  /** Cuenta corriente en centavos. Negativo significa que se le debe. */
  saldo: z.number().int(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const ProveedorListadoSchema = coleccionSchema(ProveedorSchema)
export type ProveedorListado = z.infer<typeof ProveedorListadoSchema>

/** `po_status_valid`: draft | pending_approval | approved | partially_received | received | cancelled. */
export const EstadoOrdenCompraSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'cancelled',
])
export type EstadoOrdenCompra = z.infer<typeof EstadoOrdenCompraSchema>

/**
 * Orden de compra.
 *
 * `aprobadaEn` no es decorativo: el motor exige que una orden aprobada registre
 * quién y cuándo (`po_approval_recorded`). Sin eso, «aprobada» sería un estado que
 * cualquiera escribe sin haber aprobado nada.
 */
export const OrdenCompraSchema = z.object({
  id: z.string(),
  numero: z.string(),
  proveedorId: z.string(),
  proveedor: z.string(),
  estado: EstadoOrdenCompraSchema,
  total: z.number().int().nonnegative(),
  moneda: z.enum(['ARS', 'USD']),
  fecha: z.string(),
  aprobadaEn: z.string().nullable(),
  /** Verdadero cuando lo recibido cubre lo pedido: la orden deja de ofrecer recepción. */
  recibidoCompleto: z.boolean(),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export const OrdenCompraListadoSchema = coleccionSchema(OrdenCompraSchema)
export type OrdenCompraListado = z.infer<typeof OrdenCompraListadoSchema>

/**
 * Recepción de mercadería. No tiene estado: es un hecho con fecha
 * (`purchasing.goods_receipts`), y lo recibido es lo que entra al stock.
 */
export const RecepcionSchema = z.object({
  id: z.string(),
  numero: z.string(),
  ordenNumero: z.string(),
  proveedor: z.string(),
  /** Número del remito del proveedor: el documento que viaja con la mercadería. */
  documentoProveedor: z.string().nullable(),
  unidades: z.number().int().nonnegative(),
  fecha: z.string(),
})
export type Recepcion = z.infer<typeof RecepcionSchema>

export const RecepcionListadoSchema = coleccionSchema(RecepcionSchema)
export type RecepcionListado = z.infer<typeof RecepcionListadoSchema>

/** `si_status_valid`: pending | partial | paid | cancelled. */
export const EstadoFacturaCompraSchema = z.enum(['pending', 'partial', 'paid', 'cancelled'])
export type EstadoFacturaCompra = z.infer<typeof EstadoFacturaCompraSchema>

export const FacturaCompraSchema = z.object({
  id: z.string(),
  numero: z.string(),
  proveedor: z.string(),
  total: z.number().int().nonnegative(),
  pagado: z.number().int().nonnegative(),
  moneda: z.enum(['ARS', 'USD']),
  venceEn: z.string(),
  estado: EstadoFacturaCompraSchema,
  fecha: z.string(),
})
export type FacturaCompra = z.infer<typeof FacturaCompraSchema>

export const FacturaCompraListadoSchema = coleccionSchema(FacturaCompraSchema)
export type FacturaCompraListado = z.infer<typeof FacturaCompraListadoSchema>

/** `sp_method_valid`: cash | transfer | cheque | card | other. */
export const MedioDePagoSchema = z.enum(['cash', 'transfer', 'cheque', 'card', 'other'])
export type MedioDePago = z.infer<typeof MedioDePagoSchema>

export const PagoProveedorSchema = z.object({
  id: z.string(),
  numero: z.string(),
  proveedor: z.string(),
  monto: z.number().int().positive(),
  medio: MedioDePagoSchema,
  /** Número de transferencia, de cheque o de cupón. */
  referencia: z.string().nullable(),
  moneda: z.enum(['ARS', 'USD']),
  fecha: z.string(),
})
export type PagoProveedor = z.infer<typeof PagoProveedorSchema>

export const PagoProveedorListadoSchema = coleccionSchema(PagoProveedorSchema)
export type PagoProveedorListado = z.infer<typeof PagoProveedorListadoSchema>
