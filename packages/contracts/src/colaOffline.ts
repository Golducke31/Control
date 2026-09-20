/**
 * La cola offline de la PWA del conductor.
 *
 * El motor ya previó este caso: `logistics.tracking_events` tiene
 * `client_event_id` con un `UNIQUE (tenant_id, shipment_id, client_event_id)`
 * (`te_client_dedup`) **justamente para los reintentos de la app móvil
 * offline-first**. La cola del frontend usa la misma clave, así que un evento que se
 * mandó dos veces —porque se cortó la red justo después de enviarlo y la app no llegó
 * a enterarse de que había llegado— se aplica una sola vez.
 *
 * Dos reglas que no son obvias y que la suite vigila:
 *
 * 1. **El orden se respeta y una falla detiene la cola.** No se puede entregar antes
 *    de despachar: si se saltea la operación que falló para aplicar la siguiente, el
 *    historial del envío queda con un orden que el motor no habría aceptado.
 * 2. **Un id ya aplicado no se vuelve a encolar.** Si la app se cerró después de
 *    mandar el evento pero antes de borrarlo de la cola, al reabrir no se reenvía.
 */

export interface OperacionPendiente {
  /** El `clientEventId` del motor: la clave que hace idempotente el reenvío. */
  id: string
  envioId: string
  tipo: string
  descripcion: string
  payload: Record<string, unknown>
  creadaEn: string
  intentos: number
}

export interface EstadoCola {
  pendientes: OperacionPendiente[]
  /** Los ids que el servidor ya confirmó. */
  aplicadas: string[]
}

export const COLA_VACIA: EstadoCola = { pendientes: [], aplicadas: [] }

/** Encola una operación. Si su id ya está pendiente o aplicado, no hace nada. */
export function encolar(
  estado: EstadoCola,
  operacion: Omit<OperacionPendiente, 'intentos'>,
): EstadoCola {
  const yaPendiente = estado.pendientes.some((p) => p.id === operacion.id)
  const yaAplicada = estado.aplicadas.includes(operacion.id)
  if (yaPendiente || yaAplicada) return estado

  return { ...estado, pendientes: [...estado.pendientes, { ...operacion, intentos: 0 }] }
}

export interface ResultadoSincronizacion {
  estado: EstadoCola
  /** Los ids que esta corrida aplicó. */
  aplicadas: string[]
  /** Verdadero cuando se cortó a mitad: quedan pendientes, en su orden original. */
  incompleta: boolean
}

/**
 * Intenta aplicar la cola, en orden.
 *
 * `enviar` devuelve si la operación llegó y quedó aplicada. La primera que falle
 * detiene la corrida: las siguientes quedan pendientes **sin reordenarse**, y se
 * reintentan en la próxima sincronización.
 */
export function sincronizar(
  estado: EstadoCola,
  enviar: (operacion: OperacionPendiente) => boolean,
): ResultadoSincronizacion {
  const aplicadas: string[] = []
  const pendientes: OperacionPendiente[] = []
  let incompleta = false

  for (const operacion of estado.pendientes) {
    if (incompleta) {
      pendientes.push(operacion)
      continue
    }

    if (enviar(operacion)) {
      aplicadas.push(operacion.id)
    } else {
      incompleta = true
      pendientes.push({ ...operacion, intentos: operacion.intentos + 1 })
    }
  }

  return {
    estado: { pendientes, aplicadas: [...estado.aplicadas, ...aplicadas] },
    aplicadas,
    incompleta,
  }
}

/** Cuántas operaciones esperan. La PWA lo muestra en la barra. */
export function pendientesDe(estado: EstadoCola): number {
  return estado.pendientes.length
}

/** Verdadero cuando la cola no tiene nada por enviar. */
export function colaAlDia(estado: EstadoCola): boolean {
  return estado.pendientes.length === 0
}
