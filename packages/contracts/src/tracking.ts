import type { Envio, EventoTracking, TrackingPublico } from './logistica.ts'

/**
 * La proyección pública del tracking.
 *
 * **Es una lista blanca, no un recorte.** El envío en el motor tiene el cliente, el
 * transportista, la patente, las coordenadas, la distancia y los vínculos a la orden
 * y a la factura. Esta función construye un objeto nuevo con los siete campos que se
 * publican, y ninguno más.
 *
 * La diferencia entre lista blanca y recorte no es estética: un campo que mañana se
 * agregue al envío **no** aparece acá, mientras que con un «copiar y borrar algunos
 * campos» aparecería solo, en producción, sin que nadie lo note. `tracking.test.ts`
 * compara las claves exactas del resultado contra `CLAVES_PUBLICAS`.
 *
 * Las otras dos cláusulas de la puerta de F7 también caen de acá:
 *
 * - **No expone otros envíos.** El `filter` por `envioId` no es defensivo: los eventos
 *   se piden por envío, y el token resuelve a uno solo. La proyección no acepta una
 *   lista de envíos ni devuelve un arreglo de envíos, así que no hay forma de que la
 *   respuesta crezca a los de otro.
 * - **No expone el actor.** El nombre del conductor y quién cargó cada evento son
 *   datos de un tercero, y no hacen falta para seguir un paquete.
 */
export function proyeccionPublica(
  envio: Envio,
  eventos: readonly EventoTracking[],
): TrackingPublico {
  const publicos = eventos
    // Sólo los de este envío. El token público resuelve a uno, pero la proyección no
    // depende de que quien la llame se acuerde de filtrar.
    .filter((evento) => evento.envioId === envio.id)
    .slice()
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    // Sólo el estado, la descripción y cuándo: ni actor, ni posición, ni el
    // `clientEventId` interno.
    .map((evento) => ({
      estado: evento.estado,
      descripcion: evento.descripcion,
      fecha: evento.fecha,
    }))

  return {
    numero: envio.numero,
    estado: envio.estado,
    localidadDestino: envio.localidadDestino,
    ventanaDesde: envio.ventanaDesde,
    ventanaHasta: envio.ventanaHasta,
    entregadoEn: envio.entregadoEn,
    eventos: publicos,
  }
}

/**
 * Busca el envío de un token de tracking.
 *
 * El token es el `tracking_code` del motor, que es único por empresa
 * (`sh_tracking_unique`). Devolver `null` en vez de un envío vacío es deliberado: la
 * página pública tiene que poder distinguir «no existe» de «existe y no tiene
 * eventos», y un envío inventado para un token inexistente filtraría la existencia de
 * otros códigos por diferencia.
 */
export function envioPorTracking(
  envios: readonly Envio[],
  token: string,
): Envio | null {
  return envios.find((envio) => envio.trackingCode === token) ?? null
}
