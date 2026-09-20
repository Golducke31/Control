import type { Envio, EstadoEnvio } from './logistica.ts'

/**
 * Máquina de estados del envío, espejo de `logistics.shipment_status`.
 *
 * Función pura: la fecha entra por parámetro y nada lee el reloj, así que las
 * reglas son reproducibles y las pruebas negativas pueden forzarlas — el mismo
 * criterio que `cadenas.ts` (F4), `inventario.ts` (F5) y `periodos.ts` (F6).
 *
 * El camino es lineal y tiene dos salidas laterales:
 *
 *   draft → preparing → ready → in_transit → out_for_delivery → delivered
 *     └──────────┴─────────┴──────────┘            ↑
 *              cancelar                      incident ⇄ (resolver)
 */

export type AccionEnvio =
  | 'preparar'
  | 'marcar_listo'
  | 'despachar'
  | 'salir_a_reparto'
  | 'entregar'
  | 'reportar_incidencia'
  | 'resolver_incidencia'
  | 'cancelar'

export const ETIQUETA_ACCION_ENVIO: Record<AccionEnvio, string> = {
  preparar: 'Preparar',
  marcar_listo: 'Marcar listo',
  despachar: 'Despachar',
  salir_a_reparto: 'Salir a reparto',
  entregar: 'Entregar',
  reportar_incidencia: 'Reportar incidencia',
  resolver_incidencia: 'Resolver incidencia',
  cancelar: 'Cancelar',
}

/** A qué estado lleva cada acción. `reportar_incidencia` es el único que no es lineal. */
const ESTADO_DESTINO: Record<AccionEnvio, EstadoEnvio> = {
  preparar: 'preparing',
  marcar_listo: 'ready',
  despachar: 'in_transit',
  salir_a_reparto: 'out_for_delivery',
  entregar: 'delivered',
  reportar_incidencia: 'incident',
  resolver_incidencia: 'in_transit',
  cancelar: 'cancelled',
}

/** Las transiciones válidas de un envío, por estado. */
export function accionesEnvio(envio: Envio): AccionEnvio[] {
  switch (envio.estado) {
    case 'draft':
      return ['preparar', 'cancelar']
    case 'preparing':
      return ['marcar_listo', 'cancelar']
    case 'ready':
      return ['despachar', 'cancelar']
    case 'in_transit':
      return ['salir_a_reparto', 'reportar_incidencia']
    case 'out_for_delivery':
      return ['entregar', 'reportar_incidencia']
    case 'incident':
      // Una incidencia no se cancela sola: se resuelve, y el envío vuelve a tránsito.
      return ['resolver_incidencia', 'cancelar']
    case 'delivered':
      return []
    case 'cancelled':
      return []
  }
}

/**
 * Coherencia del envío, espejo de los dos CHECK del motor.
 *
 * - `sh_delivered_ts`: `delivered` ⟹ `entregadoEn` no nulo. Un envío entregado sin
 *   fecha de entrega miente sobre cuándo se entregó, y el motor no lo acepta.
 * - `sh_window_valid`: la ventana comprometida no puede terminar antes de empezar.
 */
export function envioCoherente(envio: Envio): boolean {
  if (envio.estado === 'delivered' && envio.entregadoEn === null) return false
  if (envio.ventanaDesde !== null && envio.ventanaHasta !== null && envio.ventanaHasta < envio.ventanaDesde) {
    return false
  }
  if (envio.paradasCompletadas > envio.paradas) return false
  return true
}

export type ResultadoEnvio =
  | { ok: true; envio: Envio }
  | { ok: false; motivo: 'accion_invalida'; estado: EstadoEnvio }

/**
 * Aplica una transición sobre un envío.
 *
 * El rechazo informa el estado actual, para que la ventana pueda decir por qué la
 * acción no está disponible en vez de ofrecer un botón que va a fallar.
 */
export function aplicarAccionEnvio(
  envio: Envio,
  accion: AccionEnvio,
  opciones: { fecha: string },
): ResultadoEnvio {
  if (!accionesEnvio(envio).includes(accion)) {
    return { ok: false, motivo: 'accion_invalida', estado: envio.estado }
  }

  const destino = ESTADO_DESTINO[accion]

  // `despachar` y `entregar` son los dos momentos que el motor registra con fecha
  // propia; `entregar` además cierra la coherencia de `sh_delivered_ts`.
  const despachadoEn = accion === 'despachar' ? opciones.fecha : envio.despachadoEn
  const entregadoEn = accion === 'entregar' ? opciones.fecha : envio.entregadoEn

  return {
    ok: true,
    envio: {
      ...envio,
      estado: destino,
      despachadoEn,
      entregadoEn,
      paradasCompletadas:
        accion === 'entregar' && envio.paradasCompletadas < envio.paradas
          ? envio.paradas
          : envio.paradasCompletadas,
    },
  }
}

/** Verdadero cuando el envío no ofrece ninguna transición (está quieto). */
export function envioQuieto(envio: Envio): boolean {
  return accionesEnvio(envio).length === 0
}

/**
 * Los envíos que el tablero considera **activos**.
 *
 * Espeja el índice parcial `idx_sh_active_board` del motor: entregados y cancelados
 * quedan afuera del tablero operativo.
 */
export function envioActivo(envio: Envio): boolean {
  return envio.estado !== 'delivered' && envio.estado !== 'cancelled'
}

/** Orden del tablero: primero lo urgente, y a igual prioridad lo más antiguo. */
export function ordenarTablero(envios: readonly Envio[]): Envio[] {
  return [...envios]
    .filter(envioActivo)
    .sort((a, b) => a.prioridad - b.prioridad || a.numero.localeCompare(b.numero))
}
