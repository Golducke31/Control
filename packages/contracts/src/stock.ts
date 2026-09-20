import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

export const DepositoSchema = z.object({
  id: z.string(),
  nombre: z.string(),
  empresaSlug: z.string(),
  direccion: z.string().optional(),
  activo: z.boolean().optional(),
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

/** Depósitos de la empresa. `direccion` y `activo` son opcionales: el listado los trae, el selector no los necesita. */
export const DepositoListadoSchema = coleccionSchema(DepositoSchema)
export type DepositoListado = z.infer<typeof DepositoListadoSchema>

/**
 * Estado de una transferencia entre depósitos.
 *
 * Espeja el `CHECK st_status_valid` de `app.stock_transfers`, que en el motor es un
 * CHECK y no un tipo enumerado: por eso **no** vive en `ENUMS` (el test de sincronía
 * compara `ENUMS` contra los `CREATE TYPE … AS ENUM` de las migraciones, y agregar
 * acá una clave que no es un tipo del motor haría fallar esa comparación).
 */
export const EstadoTransferenciaSchema = z.enum(['draft', 'dispatched', 'received', 'cancelled'])
export type EstadoTransferencia = z.infer<typeof EstadoTransferenciaSchema>

/** Un renglón de la transferencia; `cantidadRecibida` se completa al recibir. */
export const ItemTransferenciaSchema = z.object({
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  cantidadEnviada: z.number().int().positive(),
  cantidadRecibida: z.number().int().nonnegative().nullable(),
})
export type ItemTransferencia = z.infer<typeof ItemTransferenciaSchema>

/**
 * Transferencia entre depósitos.
 *
 * `actualizadaEn` es la marca del **bloqueo optimista**: el cliente la conserva desde
 * que leyó la transferencia y la devuelve al escribir; si en el servidor cambió, la
 * escritura se rechaza en vez de pisar el cambio ajeno. Es el `updated_at` de
 * `app.stock_transfers`, que el trigger `trg_stock_transfers_touch` mantiene al día.
 */
export const TransferenciaSchema = z.object({
  id: z.string(),
  codigo: z.string(),
  desdeId: z.string(),
  desdeNombre: z.string(),
  hastaId: z.string(),
  hastaNombre: z.string(),
  estado: EstadoTransferenciaSchema,
  items: z.array(ItemTransferenciaSchema),
  notas: z.string().optional(),
  creadaEn: z.string(),
  actualizadaEn: z.string(),
})
export type Transferencia = z.infer<typeof TransferenciaSchema>

export const TransferenciaListadoSchema = coleccionSchema(TransferenciaSchema)
export type TransferenciaListado = z.infer<typeof TransferenciaListadoSchema>

/**
 * Un renglón de la planilla de recuento. `cantidadContada` es `null` mientras no se contó.
 *
 * **No existe un documento de recuento** y por eso no hay un `RecuentoSchema`: en este
 * motor un recuento no es una entidad, es un conjunto de movimientos de ajuste que
 * entran por `app.apply_stock_movement` —«único punto de mutación de stock»—. La
 * planilla vive en la pantalla mientras se cuenta; lo que queda escrito es el libro.
 * Modelarla como documento habría inventado una tabla que el backend no tiene.
 */
export const LineaRecuentoSchema = z.object({
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  depositoId: z.string(),
  depositoNombre: z.string(),
  cantidadSistema: z.number().int().nonnegative(),
  reservada: z.number().int().nonnegative(),
  cantidadContada: z.number().int().nonnegative().nullable(),
})
export type LineaRecuento = z.infer<typeof LineaRecuentoSchema>

/**
 * Una diferencia entre el saldo materializado y la suma del libro mayor.
 *
 * `diferencia` es `saldo - libro`: positiva significa que el saldo declara más de lo
 * que el libro explica.
 */
export const DiferenciaConciliacionSchema = z.object({
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  depositoId: z.string(),
  depositoNombre: z.string(),
  saldo: z.number().int(),
  libro: z.number().int(),
  diferencia: z.number().int(),
})
export type DiferenciaConciliacion = z.infer<typeof DiferenciaConciliacionSchema>

/**
 * Resultado del job `stock.reconciliation`, que compara `stock_levels` contra la suma
 * de `stock_movements` y **reporta sin corregir**.
 */
export const ConciliacionSchema = z.object({
  empresa: z.string(),
  ejecutadaEn: z.string(),
  nivelesRevisados: z.number().int().nonnegative(),
  diferencias: z.array(DiferenciaConciliacionSchema),
  cuadra: z.boolean(),
})
export type Conciliacion = z.infer<typeof ConciliacionSchema>

/** Renglón de reposición, derivado de `app.v_low_stock`. */
export const ReposicionSchema = z.object({
  productoId: z.string(),
  sku: z.string(),
  nombre: z.string(),
  depositoId: z.string(),
  depositoNombre: z.string(),
  disponible: z.number().int(),
  minimo: z.number().int().nonnegative(),
  sugerido: z.number().int().nonnegative(),
})
export type Reposicion = z.infer<typeof ReposicionSchema>

export const ReposicionListadoSchema = coleccionSchema(ReposicionSchema)
export type ReposicionListado = z.infer<typeof ReposicionListadoSchema>
