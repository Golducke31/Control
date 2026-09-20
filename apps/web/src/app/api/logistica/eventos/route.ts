import { envios } from '@control/contracts/fixtures'
import {
  TOPICO_TABLERO,
  TIPO_ENVIO_ACTUALIZADO,
  codificarEvento,
  codificarLatido,
  topicDeEnvio,
} from '@/datos/eventos'

/**
 * El stream de eventos de logística (§5.6).
 *
 * **Una sola conexión por pestaña**: este endpoint se abre una vez desde el proveedor
 * de la carcasa, y el proveedor reparte los eventos por tópico entre las ventanas
 * suscritas. Ninguna ventana abre su propia conexión.
 *
 * El transporte es SSE y no WebSocket porque el flujo es servidor→cliente: no hay nada
 * que el cliente tenga que mandar por acá.
 *
 * **Lo que emite hoy es simulado.** No hay backend de eventos todavía (llega en F9), así
 * que el stream recorre los envíos de los fixtures y emite un cambio cada pocos
 * segundos, más un latido. Es deliberado que el formato, el enrutamiento por tópico y
 * el ciclo de vida de la conexión sean **reales**: lo único simulado es de dónde salen
 * los datos. El día que exista el backend, lo que cambia es el cuerpo del intervalo, no
 * el contrato ni el cliente.
 */

/** Sin caché: un stream cacheado no es un stream. */
export const dynamic = 'force-dynamic'

/** Cada cuánto se emite un cambio simulado. */
const INTERVALO_EVENTO_MS = 5000

/** Cada cuánto se manda un latido, para que un proxy no cierre la conexión ociosa. */
const INTERVALO_LATIDO_MS = 15000

export async function GET(): Promise<Response> {
  const codificador = new TextEncoder()
  let emisor: ReturnType<typeof setInterval> | undefined
  let latido: ReturnType<typeof setInterval> | undefined

  const limpiar = () => {
    if (emisor !== undefined) clearInterval(emisor)
    if (latido !== undefined) clearInterval(latido)
    emisor = undefined
    latido = undefined
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controlador) {
      let indice = 0

      // El primer latido abre el stream de inmediato: el cliente sabe que la conexión
      // está viva antes del primer evento.
      controlador.enqueue(codificador.encode(codificarLatido()))

      emisor = setInterval(() => {
        const envio = envios[indice % envios.length]
        indice += 1
        if (envio === undefined) return

        const datos = { numero: envio.numero, estado: envio.estado }

        // Dos tópicos por cambio: el del envío y el del tablero. Una tarjeta escucha el
        // suyo; el tablero escucha el común. Los dos van por la misma conexión.
        controlador.enqueue(
          codificador.encode(
            codificarEvento({ topico: topicDeEnvio(envio.id), tipo: TIPO_ENVIO_ACTUALIZADO, datos }),
          ),
        )
        controlador.enqueue(
          codificador.encode(codificarEvento({ topico: TOPICO_TABLERO, tipo: TIPO_ENVIO_ACTUALIZADO, datos })),
        )
      }, INTERVALO_EVENTO_MS)

      latido = setInterval(() => {
        controlador.enqueue(codificador.encode(codificarLatido()))
      }, INTERVALO_LATIDO_MS)
    },

    // El cliente se fue: sin esto, los intervalos siguen corriendo contra un stream
    // cerrado y el proceso acumula temporizadores que nadie va a limpiar.
    cancel() {
      limpiar()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Evita que un proxy bufferice el stream y los eventos lleguen todos juntos al
      // final — que es exactamente lo contrario de lo que un stream sirve.
      'x-accel-buffering': 'no',
    },
  })
}
