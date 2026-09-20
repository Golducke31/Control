import { z } from 'zod'
import { coleccionSchema } from './comun.ts'

/**
 * Fiscal: posición de IVA, alícuotas y retenciones.
 *
 * **Una alícuota es una norma con fecha.** En el motor no hay «la alícuota de IVA»:
 * `fiscal.tax_rates` guarda alícuotas con vigencia temporal y `rates_on(fecha)`
 * devuelve las vigentes **a esa fecha**. Por eso `AlicuotaSchema` tiene `desde` y
 * `hasta` y no un único valor: una determinación de marzo tiene que calcularse con
 * la alícuota de marzo, no con la de hoy. El motor además impide que dos alícuotas
 * del mismo impuesto se solapen, porque si se solaparan `rates_on()` devolvería dos
 * filas para la misma fecha.
 */

export const AlicuotaSchema = z.object({
  id: z.string(),
  impuesto: z.string(),
  codigo: z.string(),
  /** Porcentaje, no fracción: 21 significa 21 %. */
  porcentaje: z.number().nonnegative(),
  desde: z.string(),
  /** `null` mientras sigue vigente. */
  hasta: z.string().nullable(),
})
export type Alicuota = z.infer<typeof AlicuotaSchema>

export const AlicuotaListadoSchema = coleccionSchema(AlicuotaSchema)
export type AlicuotaListado = z.infer<typeof AlicuotaListadoSchema>

/** Estado de la determinación: el saldo técnico cae a favor del fisco o del contribuyente. */
export const EstadoDeterminacionSchema = z.enum(['a_favor', 'a_pagar', 'sin_movimiento'])
export type EstadoDeterminacion = z.infer<typeof EstadoDeterminacionSchema>

/**
 * Determinación de IVA de un período.
 *
 * `saldoTecnico` es `ivaDebito - ivaCredito`. Se expone el saldo **y** los dos
 * componentes porque la ventana tiene que poder mostrar de dónde sale: un número
 * solo no se audita.
 */
export const DeterminacionIvaSchema = z.object({
  periodo: z.string(),
  ventasNetas: z.number().int(),
  ivaDebito: z.number().int().nonnegative(),
  comprasNetas: z.number().int(),
  ivaCredito: z.number().int().nonnegative(),
  saldoTecnico: z.number().int(),
  estado: EstadoDeterminacionSchema,
  calculadaEn: z.string(),
})
export type DeterminacionIva = z.infer<typeof DeterminacionIvaSchema>

export const RetencionSchema = z.object({
  id: z.string(),
  regimen: z.string(),
  sujeto: z.string(),
  base: z.number().int().nonnegative(),
  /** Porcentaje, no fracción. */
  alicuota: z.number().nonnegative(),
  monto: z.number().int().nonnegative(),
  fecha: z.string(),
})
export type Retencion = z.infer<typeof RetencionSchema>

export const RetencionListadoSchema = coleccionSchema(RetencionSchema)
export type RetencionListado = z.infer<typeof RetencionListadoSchema>
