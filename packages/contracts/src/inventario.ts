import type {
  EstadoTransferencia,
  ItemTransferencia,
  MovimientoStock,
  NivelStock,
  Transferencia,
} from './stock.ts'

/**
 * Lógica pura de inventario, espejo de `app.apply_stock_movement` y de
 * `app.stock_transfers`.
 *
 * Es lógica **de dominio**, no de presentación: vive en `packages/contracts` y no en
 * un componente porque las dos reglas de la puerta de F5 tienen que poder probarse en
 * negativo sin renderizar nada, igual que las de F4 en `cadenas.ts`.
 *
 * Todas las funciones reciben el «hoy»/la fecha y las marcas de versión **como
 * parámetros**: nada lee `new Date()` ni el estado global. Un bloqueo optimista que
 * consultara la hora por su cuenta no sería probable.
 */

/**
 * El signo con que cada tipo de movimiento afecta la **cantidad física**.
 *
 * Es el `CASE p_kind` de `app.apply_stock_movement`, traducido literalmente:
 * `purchase_in`, `transfer_in`, `adjustment_pos` y `return_in` suman; `sale_out`,
 * `transfer_out` y `adjustment_neg` restan; `reservation` y `release` **no mueven la
 * cantidad** (sólo afectan lo reservado, y por eso el motor les asigna delta 0 aunque
 * escriba igual la fila del libro).
 */
export const SIGNO_DEL_MOVIMIENTO: Record<MovimientoStock['tipo'], -1 | 0 | 1> = {
  purchase_in: 1,
  transfer_in: 1,
  adjustment_pos: 1,
  return_in: 1,
  release: 0,
  reservation: 0,
  sale_out: -1,
  transfer_out: -1,
  adjustment_neg: -1,
}

/**
 * El efecto neto de un movimiento sobre la cantidad física.
 *
 * Usa `Math.abs` a propósito: el motor guarda la cantidad **siempre positiva** y
 * deriva el signo del tipo (`IF p_quantity <= 0 THEN RAISE`), mientras que el
 * contrato la presenta con signo para que el libro se lea como una columna de netos.
 * Tomar el valor absoluto y el signo del tipo hace que el cálculo sea correcto con
 * las dos convenciones, y no dependa de cuál eligió quien escribió la fila.
 */
export function deltaDeMovimiento(movimiento: MovimientoStock): number {
  return SIGNO_DEL_MOVIMIENTO[movimiento.tipo] * Math.abs(movimiento.cantidad)
}

// ---------------------------------------------------------------------------
// Recuento
// ---------------------------------------------------------------------------

export type MotivoRecuentoRechazado = 'contado_por_debajo_de_lo_reservado'

export interface AjusteDeRecuento {
  /** El saldo ya ajustado. */
  nivel: NivelStock
  /**
   * La fila que hay que escribir en el libro mayor.
   *
   * Es `null` cuando el recuento coincide con el sistema: no hay nada que registrar,
   * y el motor tampoco llamaría a `apply_stock_movement`.
   */
  movimiento: MovimientoStock | null
}

export type ResultadoRecuento =
  | { ok: true; ajuste: AjusteDeRecuento }
  | { ok: false; motivo: MotivoRecuentoRechazado; reservada: number }

/**
 * Aplica un recuento físico sobre un nivel de stock.
 *
 * **Regla de la puerta de F5 (1):** el recuento ajusta el saldo **y** deja su fila en
 * el libro mayor — las dos cosas salen de acá juntas, no de dos llamadas que podrían
 * quedar desincronizadas.
 *
 * El caso rechazado espeja el CHECK `reserved <= on_hand` de `app.stock_levels`
 * (constraint `sl_reserved_le_on_hand`): contar menos de lo que ya está reservado
 * dejaría el saldo por debajo de la reserva, y el motor aborta esa escritura. Acá se
 * rechaza antes, con el motivo, en vez de producir un nivel inválido.
 */
export function aplicarRecuento(
  nivel: NivelStock,
  contado: number,
  opciones: { idMovimiento: string; fecha: string },
): ResultadoRecuento {
  if (contado < nivel.reservada) {
    return { ok: false, motivo: 'contado_por_debajo_de_lo_reservado', reservada: nivel.reservada }
  }

  const delta = contado - nivel.cantidad

  const actualizado: NivelStock = {
    ...nivel,
    cantidad: contado,
    disponible: contado - nivel.reservada,
  }

  if (delta === 0) {
    return { ok: true, ajuste: { nivel: actualizado, movimiento: null } }
  }

  const movimiento: MovimientoStock = {
    id: opciones.idMovimiento,
    productoId: nivel.productoId,
    sku: nivel.sku,
    nombre: nivel.nombre,
    tipo: delta > 0 ? 'adjustment_pos' : 'adjustment_neg',
    cantidad: delta,
    depositoId: nivel.depositoId,
    motivo: `Recuento: sistema ${nivel.cantidad}, contado ${contado}`,
    fecha: opciones.fecha,
  }

  return { ok: true, ajuste: { nivel: actualizado, movimiento } }
}

// ---------------------------------------------------------------------------
// Transferencias
// ---------------------------------------------------------------------------

export type AccionTransferencia = 'despachar' | 'recibir' | 'cancelar'

export const ETIQUETA_TRANSFERENCIA: Record<AccionTransferencia, string> = {
  despachar: 'Despachar',
  recibir: 'Recibir',
  cancelar: 'Cancelar',
}

/**
 * Etiqueta en castellano de cada estado.
 *
 * Vive acá y no en cada ventana porque el listado y el detalle tienen que decir lo
 * mismo: dos mapas paralelos divergen en cuanto alguien agrega un estado.
 */
export const ETIQUETA_ESTADO_TRANSFERENCIA: Record<EstadoTransferencia, string> = {
  draft: 'borrador',
  dispatched: 'despachada',
  received: 'recibida',
  cancelled: 'cancelada',
}

/** Las transiciones válidas de una transferencia, por estado. */
export function accionesTransferencia(estado: EstadoTransferencia): AccionTransferencia[] {
  switch (estado) {
    case 'draft':
      return ['despachar', 'cancelar']
    case 'dispatched':
      return ['recibir', 'cancelar']
    case 'received':
      return []
    case 'cancelled':
      return []
  }
}

export type MotivoTransferenciaRechazada =
  | 'depositos_iguales'
  | 'conflicto_de_version'
  | 'transicion_invalida'

export type ResultadoTransferencia =
  | { ok: true; transferencia: Transferencia; movimientos: MovimientoStock[] }
  | { ok: false; motivo: 'depositos_iguales' }
  | { ok: false; motivo: 'conflicto_de_version'; versionActual: string }
  | { ok: false; motivo: 'transicion_invalida'; estado: EstadoTransferencia }

/**
 * Los movimientos que implica el estado de una transferencia.
 *
 * `draft` y `cancelled` no mueven nada. `dispatched` registra la **salida** en el
 * depósito de origen; `received` registra además la **entrada** en el destino, con la
 * cantidad efectivamente recibida (que puede ser menor que la enviada: la diferencia
 * es la merma del traslado, y así lo modela `qty_received` en `stock_transfer_items`).
 */
export function movimientosDeTransferencia(
  transferencia: Transferencia,
  fecha: string,
  prefijo: string,
): MovimientoStock[] {
  if (transferencia.estado === 'draft' || transferencia.estado === 'cancelled') return []

  const movimientos: MovimientoStock[] = []

  transferencia.items.forEach((item, i) => {
    movimientos.push({
      id: `${prefijo}-out-${i}`,
      productoId: item.productoId,
      sku: item.sku,
      nombre: item.nombre,
      tipo: 'transfer_out',
      cantidad: -item.cantidadEnviada,
      depositoId: transferencia.desdeId,
      motivo: `Transferencia ${transferencia.codigo} a ${transferencia.hastaNombre}`,
      fecha,
      documento: transferencia.codigo,
    })

    if (transferencia.estado === 'received') {
      const recibida = item.cantidadRecibida ?? item.cantidadEnviada
      movimientos.push({
        id: `${prefijo}-in-${i}`,
        productoId: item.productoId,
        sku: item.sku,
        nombre: item.nombre,
        tipo: 'transfer_in',
        cantidad: recibida,
        depositoId: transferencia.hastaId,
        motivo: `Transferencia ${transferencia.codigo} desde ${transferencia.desdeNombre}`,
        fecha,
        documento: transferencia.codigo,
      })
    }
  })

  return movimientos
}

/**
 * Aplica una transición sobre una transferencia con **bloqueo optimista**.
 *
 * **Regla de la puerta de F5 (2):** si la transferencia cambió en el servidor desde
 * que el cliente la leyó —`versionEsperada` ya no coincide con `actualizadaEn`— la
 * operación se rechaza con `conflicto_de_version` y **no se devuelve ninguna
 * transferencia modificada**. Quien llama no tiene forma de pisar el cambio ajeno
 * por accidente: el único camino a `ok: true` es haber leído la versión vigente.
 *
 * El orden de los controles es deliberado: primero la invariante estructural (que el
 * motor garantiza con `st_distinct_wr`), después la versión, y sólo entonces la
 * transición. Así un conflicto de versión nunca se confunde con un estado inválido.
 */
export function aplicarTransferencia(
  transferencia: Transferencia,
  accion: AccionTransferencia,
  versionEsperada: string,
  opciones: { fecha: string; prefijo: string },
): ResultadoTransferencia {
  if (transferencia.desdeId === transferencia.hastaId) {
    return { ok: false, motivo: 'depositos_iguales' }
  }

  if (transferencia.actualizadaEn !== versionEsperada) {
    return { ok: false, motivo: 'conflicto_de_version', versionActual: transferencia.actualizadaEn }
  }

  if (!accionesTransferencia(transferencia.estado).includes(accion)) {
    return { ok: false, motivo: 'transicion_invalida', estado: transferencia.estado }
  }

  const nuevoEstado: EstadoTransferencia =
    accion === 'despachar' ? 'dispatched' : accion === 'recibir' ? 'received' : 'cancelled'

  const actualizada: Transferencia = {
    ...transferencia,
    estado: nuevoEstado,
    actualizadaEn: opciones.fecha,
  }

  return {
    ok: true,
    transferencia: actualizada,
    movimientos: movimientosDeTransferencia(actualizada, opciones.fecha, opciones.prefijo),
  }
}

/** Total de unidades de una transferencia, sumando sus renglones. */
export function unidadesDeTransferencia(items: readonly ItemTransferencia[]): number {
  return items.reduce((suma, item) => suma + item.cantidadEnviada, 0)
}

// ---------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------

export interface FilaConciliacion {
  productoId: string
  sku: string
  nombre: string
  depositoId: string
  depositoNombre: string
  /** El saldo materializado (`app.stock_levels.on_hand`). */
  saldo: number
  /** La suma del libro mayor para ese producto y depósito. */
  libro: number
  /** `saldo - libro`. Cero significa que el libro explica el saldo. */
  diferencia: number
}

export interface ResultadoConciliacion {
  filas: FilaConciliacion[]
  diferencias: FilaConciliacion[]
  cuadra: boolean
}

/**
 * Compara el saldo materializado contra la suma del libro mayor, por producto y
 * depósito. Es lo que hace el job `stock.reconciliation`, que **reporta sin
 * corregir**: la corrección es un recuento, y un recuento lo firma una persona.
 *
 * Sólo entran los niveles que existen como saldo: un movimiento sin nivel es otra
 * clase de problema (el libro tiene algo que el saldo no conoce) y lo reporta el
 * motor, no esta función.
 */
export function conciliar(
  niveles: readonly NivelStock[],
  movimientos: readonly MovimientoStock[],
): ResultadoConciliacion {
  const libro = new Map<string, number>()
  for (const movimiento of movimientos) {
    const clave = `${movimiento.productoId}|${movimiento.depositoId}`
    libro.set(clave, (libro.get(clave) ?? 0) + deltaDeMovimiento(movimiento))
  }

  const filas: FilaConciliacion[] = niveles.map((nivel) => {
    const suma = libro.get(`${nivel.productoId}|${nivel.depositoId}`) ?? 0
    return {
      productoId: nivel.productoId,
      sku: nivel.sku,
      nombre: nivel.nombre,
      depositoId: nivel.depositoId,
      depositoNombre: nivel.depositoNombre,
      saldo: nivel.cantidad,
      libro: suma,
      diferencia: nivel.cantidad - suma,
    }
  })

  const diferencias = filas.filter((fila) => fila.diferencia !== 0)
  return { filas, diferencias, cuadra: diferencias.length === 0 }
}
