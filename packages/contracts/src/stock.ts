import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

export const DepositoSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  empresaSlug: z.string(),
})
export type Deposito = z.infer<typeof DepositoSchema>

/**
 * Nivel de stock de un producto en un depósito.
 *
 * `disponible` es derivado (`cantidad - reservada`); el servidor lo garantiza, y
 * `mock.test.ts` lo verifica en los datos simulados.
 */
export const NivelStockSchema = z.object({
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  depositoId: z.string(),
  depositoNombre: z.string(),
  cantidad: z.number().int().nonnegative(),
  reservada: z.number().int().nonnegative(),
  disponible: z.number().int().nonnegative(),
})
export type NivelStock = z.infer<typeof NivelStockSchema>

export const NivelStockListadoSchema = coleccionSchema(NivelStockSchema)
export type NivelStockListado = z.infer<typeof NivelStockListadoSchema>

/** Movimiento de stock; `tipo` es `app.stock_move_kind`. */
export const MovimientoStockSchema = z.object({
  id: z.string(),
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  tipo: ENUMS['app.stock_move_kind'],
  cantidad: z.number().int(),
  depositoId: z.string(),
  motivo: z.string().optional(),
  fecha: z.string(),
  documento: z.string().optional(),
})
export type MovimientoStock = z.infer<typeof MovimientoStockSchema>

export const MovimientoStockListadoSchema = coleccionSchema(MovimientoStockSchema)
export type MovimientoStockListado = z.infer<typeof MovimientoStockListadoSchema>
