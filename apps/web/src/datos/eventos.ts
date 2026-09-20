import type { EstadoConexion } from '@control/contracts'

/**
 * El codificador de eventos SSE.
 *
 * Está aparte del route handler porque es la parte que puede estar mal de una forma
 * que no se ve: el formato de SSE es **delimitado por líneas**, así que un salto de
 * línea sin escapar dentro de un campo parte el marco en dos y el cliente recibe un
 * evento incompleto o un campo inventado. No es hipotético —una descripción de
 * incidencia con un salto de línea alcanza—, y por eso el codificador es una función
 * pura con su prueba, en vez de un `controller.enqueue` escrito a mano en el handler.
 *
 * `JSON.stringify` escapa los saltos de línea, así que el `data:` siempre ocupa una
 * sola línea; el nombre del evento se sanea igual, porque `event:` no admite ninguno.
 */

export interface EventoVivo {
  /** El tópico al que pertenece, con alcance de empresa: `envio:<id>`, `tablero`. */
  topico: string
  /** El nombre del evento, tal como lo escucha el `EventSource` del cliente. */
  tipo: string
  datos: unknown
}

/** El nombre que el cliente escucha. Un cambio acá rompe la suscripción en silencio. */
export const TIPO_ENVIO_ACTUALIZADO = 'envio.actualizado'

/** Codifica un evento en el formato de SSE: `event:`, `data:`, y una línea vacía. */
export function codificarEvento(evento: EventoVivo): string {
  const tipo = evento.tipo.replace(/[\r\n]/g, '')
  const datos = JSON.stringify({ topico: evento.topico, datos: evento.datos })
  return `event: ${tipo}\ndata: ${datos}\n\n`
}

/**
 * Un comentario de latido.
 *
 * SSE no tiene `ping`: el latido es una línea que empieza con `:` y el cliente la
 * ignora. Sirve para que los proxies no cierren una conexión que no está mandando
 * nada, y para que el navegador note que el servidor sigue vivo.
 */
export function codificarLatido(): string {
  return ': latido\n\n'
}

/** Lo que el cliente ve en el encabezado. */
export const ETIQUETA_CONEXION: Record<EstadoConexion, string> = {
  en_vivo: 'En vivo',
  reconectando: 'Reconectando',
  sin_conexion: 'Sin conexión',
}

/** El tópico de un envío. Centralizado para que el emisor y el suscriptor no divergan. */
export function topicDeEnvio(envioId: string): string {
  return `envio:${envioId}`
}

/** El tópico del tablero: lo que cambia cuando cambia cualquier envío. */
export const TOPICO_TABLERO = 'tablero'
