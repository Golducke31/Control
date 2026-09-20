import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

/**
 * Logística: envíos, paradas, flota, incidencias y confirmación de entrega.
 *
 * Los estados usan los `pg_enum` del motor —`logistics.shipment_status`,
 * `logistics.stop_kind`, `logistics.stop_state`— que ya estaban en `ENUMS` desde F3.
 */

/** `logistics.shipment_status`: draft → preparing → ready → in_transit → out_for_delivery → delivered, con `incident` y `cancelled` como salidas. */
export const EstadoEnvioSchema = ENUMS['logistics.shipment_status']
export type EstadoEnvio = z.infer<typeof EstadoEnvioSchema>

/**
 * Envío, en su vista **interna**.
 *
 * Este esquema incluye datos que el cliente final **no** puede ver: `cliente`,
 * `transportista`, `patente` y las coordenadas. Para la vista pública existe
 * `TrackingPublicoSchema`, que es una lista blanca de campos y no una copia con
 * recortes — la diferencia importa, y está documentada ahí.
 *
 * `entregadoEn` no es decorativo: el motor lo exige con `sh_delivered_ts`
 * (`status <> 'delivered' OR delivered_at IS NOT NULL`). Un envío entregado sin fecha
 * de entrega es un envío que miente sobre cuándo se entregó.
 */
export const EnvioSchema = z.object({
  id: z.string(),
  numero: z.string(),
  /** Código público con el que el cliente sigue su envío. */
  trackingCode: z.string(),
  cliente: z.string(),
  estado: EstadoEnvioSchema,
  /** 1 = urgente … 5 = baja, como el motor. */
  prioridad: z.number().int().min(1).max(5),
  desde: z.string(),
  hasta: z.string(),
  localidadDestino: z.string(),
  ventanaDesde: z.string().nullable(),
  ventanaHasta: z.string().nullable(),
  despachadoEn: z.string().nullable(),
  entregadoEn: z.string().nullable(),
  distanciaMetros: z.number().int().nonnegative().nullable(),
  transportista: z.string().nullable(),
  patente: z.string().nullable(),
  paradas: z.number().int().nonnegative(),
  paradasCompletadas: z.number().int().nonnegative(),
})
export type Envio = z.infer<typeof EnvioSchema>

export const EnvioListadoSchema = coleccionSchema(EnvioSchema)
export type EnvioListado = z.infer<typeof EnvioListadoSchema>

export const ParadaSchema = z.object({
  id: z.string(),
  envioId: z.string(),
  orden: z.number().int().nonnegative(),
  tipo: ENUMS['logistics.stop_kind'],
  estado: ENUMS['logistics.stop_state'],
  direccion: z.string(),
  localidad: z.string(),
  ventanaDesde: z.string().nullable(),
  ventanaHasta: z.string().nullable(),
  completadaEn: z.string().nullable(),
})
export type Parada = z.infer<typeof ParadaSchema>

export const ParadaListadoSchema = coleccionSchema(ParadaSchema)
export type ParadaListado = z.infer<typeof ParadaListadoSchema>

export const VehiculoSchema = z.object({
  id: z.string(),
  patente: z.string(),
  tipo: z.string(),
  capacidadKg: z.number().int().nonnegative(),
  transportista: z.string(),
  activo: z.boolean(),
})
export type Vehiculo = z.infer<typeof VehiculoSchema>

export const VehiculoListadoSchema = coleccionSchema(VehiculoSchema)
export type VehiculoListado = z.infer<typeof VehiculoListadoSchema>

export const IncidenciaSchema = z.object({
  id: z.string(),
  envioNumero: z.string(),
  causa: z.string(),
  descripcion: z.string(),
  gravedad: z.enum(['baja', 'media', 'alta']),
  resuelta: z.boolean(),
  fecha: z.string(),
})
export type Incidencia = z.infer<typeof IncidenciaSchema>

export const IncidenciaListadoSchema = coleccionSchema(IncidenciaSchema)
export type IncidenciaListado = z.infer<typeof IncidenciaListadoSchema>

/**
 * Evento del historial de tracking.
 *
 * `clientEventId` es la **clave de deduplicación** que el motor usa para los
 * reintentos de la app móvil offline-first (`te_client_dedup`): la PWA puede mandar
 * el mismo evento dos veces —porque se cortó la red justo después de enviarlo— y el
 * motor lo ignora la segunda. La cola offline del frontend usa la misma clave.
 */
export const EventoTrackingSchema = z.object({
  id: z.string(),
  envioId: z.string(),
  estado: EstadoEnvioSchema,
  codigo: z.string(),
  descripcion: z.string(),
  fecha: z.string(),
  actor: z.enum(['system', 'user', 'driver', 'customer', 'webhook']),
  requiereConfirmacion: z.boolean(),
  confirmadoEn: z.string().nullable(),
  clientEventId: z.string().nullable(),
})
export type EventoTracking = z.infer<typeof EventoTrackingSchema>

export const EventoTrackingListadoSchema = coleccionSchema(EventoTrackingSchema)
export type EventoTrackingListado = z.infer<typeof EventoTrackingListadoSchema>

/**
 * Confirmación de entrega (POD).
 *
 * El motor la asocia a un **token efímero de un solo uso** (`access_token_hash` con
 * vencimiento): el link público de confirmación no es adivinable ni reutilizable.
 * `conforme` es `null` mientras nadie firmó, y `false` significa recibido **con
 * reservas** — que es información distinta de «no conforme» y por eso no se colapsa.
 */
export const ConfirmacionEntregaSchema = z.object({
  id: z.string(),
  envioId: z.string(),
  envioNumero: z.string(),
  receptor: z.string().nullable(),
  documento: z.string().nullable(),
  firmaUrl: z.string().nullable(),
  fotos: z.array(z.string()),
  conforme: z.boolean().nullable(),
  observaciones: z.string().nullable(),
  confirmadaEn: z.string().nullable(),
})
export type ConfirmacionEntrega = z.infer<typeof ConfirmacionEntregaSchema>

export const ConfirmacionEntregaListadoSchema = coleccionSchema(ConfirmacionEntregaSchema)
export type ConfirmacionEntregaListado = z.infer<typeof ConfirmacionEntregaListadoSchema>

// ---------------------------------------------------------------------------
// La proyección pública
// ---------------------------------------------------------------------------

/**
 * Un evento tal como lo ve el cliente final.
 *
 * Sólo el estado, una descripción y cuándo. **No** lleva el actor (el nombre del
 * conductor es un dato de un tercero), ni la posición GPS, ni el `clientEventId`
 * interno, ni el id del envío.
 */
export const EventoPublicoSchema = z.object({
  estado: EstadoEnvioSchema,
  descripcion: z.string(),
  fecha: z.string(),
})
export type EventoPublico = z.infer<typeof EventoPublicoSchema>

/**
 * Lo que ve quien abre el link de seguimiento.
 *
 * **Es una lista blanca, no un recorte.** El motor tiene el envío entero —cliente,
 * transportista, patente, coordenadas, importes de la factura asociada—, y esta
 * proyección declara explícitamente los siete campos que se publican. La diferencia
 * con «copiar y borrar algunos campos» no es estética: un campo nuevo que mañana se
 * agregue al envío **no** aparece acá, mientras que con un recorte aparecería solo.
 * `tracking.test.ts` lo verifica comparando las claves exactas del resultado.
 *
 * Tampoco expone **otros envíos**: el token resuelve a un envío y sólo a uno, y el
 * `numero` que se publica es el del envío, no un listado. Es la tercera cláusula de
 * la puerta de F7.
 */
export const TrackingPublicoSchema = z.object({
  numero: z.string(),
  estado: EstadoEnvioSchema,
  localidadDestino: z.string(),
  ventanaDesde: z.string().nullable(),
  ventanaHasta: z.string().nullable(),
  entregadoEn: z.string().nullable(),
  eventos: z.array(EventoPublicoSchema),
})
export type TrackingPublico = z.infer<typeof TrackingPublicoSchema>

/** Las claves exactas que la proyección pública puede tener. La suite lo compara. */
export const CLAVES_PUBLICAS = [
  'numero',
  'estado',
  'localidadDestino',
  'ventanaDesde',
  'ventanaHasta',
  'entregadoEn',
  'eventos',
] as const
