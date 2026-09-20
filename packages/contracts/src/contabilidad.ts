import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

/**
 * Contabilidad: plan de cuentas, libro diario y períodos.
 *
 * El estado del período usa el `pg_enum` `accounting.period_status` del motor, con
 * sus tres valores y su significado:
 *
 * - `open`    — acepta asientos.
 * - `closing` — **también acepta**: es el estado en el que se cargan los ajustes de
 *               cierre, que por definición ocurren después del último asiento del
 *               mes. Tratarlo como cerrado rompería el cierre.
 * - `closed`  — inmutable. Corregir exige reabrir, que queda auditado.
 */

export const CuentaContableSchema = z.object({
  id: z.string(),
  codigo: z.string(),
  nombre: z.string(),
  tipo: ENUMS['accounting.account_kind'],
  /** Sólo las cuentas imputables reciben asientos; las de agrupación suman. */
  imputable: z.boolean(),
})
export type CuentaContable = z.infer<typeof CuentaContableSchema>

export const CuentaContableListadoSchema = coleccionSchema(CuentaContableSchema)
export type CuentaContableListado = z.infer<typeof CuentaContableListadoSchema>

/**
 * Asiento del libro diario.
 *
 * `debito` y `credito` se exponen por separado porque el balance de sumas y saldos
 * es exactamente la comparación entre los dos totales: si el contrato los
 * colapsara en un «monto con signo», la comprobación de partida doble dejaría de
 * ser visible desde la ventana.
 */
export const AsientoSchema = z.object({
  id: z.string(),
  numero: z.string(),
  fecha: z.string(),
  descripcion: z.string(),
  origen: ENUMS['accounting.entry_source'],
  debito: z.number().int().nonnegative(),
  credito: z.number().int().nonnegative(),
  periodoId: z.string(),
  periodoNombre: z.string(),
})
export type Asiento = z.infer<typeof AsientoSchema>

export const AsientoListadoSchema = coleccionSchema(AsientoSchema)
export type AsientoListado = z.infer<typeof AsientoListadoSchema>

/**
 * Período contable.
 *
 * Los campos de cierre y reapertura espejan los CHECK del motor:
 * `periods_closed_coherent` exige que `closed` y `cerradoEn` vayan juntos, y
 * `periods_reopen_coherent` exige que una reapertura tenga **motivo y autor**. Un
 * período reabierto sin registro es exactamente lo que el ADR quiere impedir, así
 * que el contrato no permite representarlo.
 */
export const PeriodoSchema = z.object({
  id: z.string(),
  numero: z.number().int().min(1).max(12),
  nombre: z.string(),
  ejercicio: z.number().int(),
  desde: z.string(),
  hasta: z.string(),
  estado: ENUMS['accounting.period_status'],
  cerradoEn: z.string().nullable(),
  cerradoPor: z.string().nullable(),
  reabiertoEn: z.string().nullable(),
  reabiertoPor: z.string().nullable(),
  motivoReapertura: z.string().nullable(),
  /** Asientos en borrador del período: lo que impide cerrarlo. */
  asientosPendientes: z.number().int().nonnegative(),
})
export type Periodo = z.infer<typeof PeriodoSchema>

export const PeriodoListadoSchema = coleccionSchema(PeriodoSchema)
export type PeriodoListado = z.infer<typeof PeriodoListadoSchema>
