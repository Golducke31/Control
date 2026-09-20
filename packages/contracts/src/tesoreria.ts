import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

/**
 * Tesorería: caja, bancos, movimientos y cartera de cheques.
 *
 * Los tipos usan los `pg_enum` del motor (`treasury.account_kind`,
 * `treasury.movement_kind`, `treasury.movement_direction`, `treasury.check_state`,
 * `treasury.reconciliation_status`) en vez de listas escritas a mano: así el
 * contrato no puede aceptar un valor que la base rechace, y el test de sincronía de
 * enums lo vigila.
 */

export const CuentaTesoreriaSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  tipo: ENUMS['treasury.account_kind'],
  moneda: z.enum(['ARS', 'USD']),
  /** Saldo en centavos, tal como lo declara el motor. */
  saldo: z.number().int(),
  activa: z.boolean(),
})
export type CuentaTesoreria = z.infer<typeof CuentaTesoreriaSchema>

export const CuentaTesoreriaListadoSchema = coleccionSchema(CuentaTesoreriaSchema)
export type CuentaTesoreriaListado = z.infer<typeof CuentaTesoreriaListadoSchema>

/**
 * Movimiento de tesorería.
 *
 * `conciliado` es lo que hace útil a la ventana de conciliación bancaria: un
 * movimiento sin conciliar es la diferencia entre lo que dice el banco y lo que
 * dice el sistema.
 */
export const MovimientoTesoreriaSchema = z.object({
  id: z.string(),
  fecha: z.string(),
  cuentaId: z.string(),
  cuentaNombre: z.string(),
  tipo: ENUMS['treasury.movement_kind'],
  direccion: ENUMS['treasury.movement_direction'],
  monto: z.number().int().positive(),
  descripcion: z.string(),
  conciliado: z.boolean(),
})
export type MovimientoTesoreria = z.infer<typeof MovimientoTesoreriaSchema>

export const MovimientoTesoreriaListadoSchema = coleccionSchema(MovimientoTesoreriaSchema)
export type MovimientoTesoreriaListado = z.infer<typeof MovimientoTesoreriaListadoSchema>

export const ChequeSchema = z.object({
  id: z.string(),
  numero: z.string(),
  estado: ENUMS['treasury.check_state'],
  librador: z.string(),
  monto: z.number().int().positive(),
  moneda: z.enum(['ARS', 'USD']),
  venceEn: z.string(),
  /** Verdadero para los cheques propios: son los que hay que cubrir. */
  propio: z.boolean(),
})
export type Cheque = z.infer<typeof ChequeSchema>

export const ChequeListadoSchema = coleccionSchema(ChequeSchema)
export type ChequeListado = z.infer<typeof ChequeListadoSchema>

export const ConciliacionBancariaSchema = z.object({
  id: z.string(),
  cuentaId: z.string(),
  cuentaNombre: z.string(),
  desde: z.string(),
  hasta: z.string(),
  estado: ENUMS['treasury.reconciliation_status'],
  /** Diferencia en centavos entre el extracto y el sistema. Cero es conciliado. */
  diferencia: z.number().int(),
})
export type ConciliacionBancaria = z.infer<typeof ConciliacionBancariaSchema>

export const ConciliacionBancariaListadoSchema = coleccionSchema(ConciliacionBancariaSchema)
export type ConciliacionBancariaListado = z.infer<typeof ConciliacionBancariaListadoSchema>
