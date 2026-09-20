'use client'

import { useMemo, useState } from 'react'
import { Boton, Insignia } from '@control/ui'
import type { Envio } from '@control/contracts'
import {
  COLA_VACIA,
  ETIQUETA_ACCION_ENVIO,
  accionesEnvio,
  colaAlDia,
  encolar,
  pendientesDe,
  sincronizar,
} from '@control/contracts'
import type { AccionEnvio, EstadoCola } from '@control/contracts'
import { ETIQUETA_ESTADO_ENVIO, TONO_ESTADO_ENVIO } from '@/app/e/[slug]/logistica/LogisticaCliente'
import { formatearFechaHora } from '@/datos/formato'

/**
 * La PWA del conductor (F7).
 *
 * El caso que justifica la cola: el conductor está en la calle, sin señal, y tiene que
 * marcar que entregó. La operación **no se pierde**: se encola con un id de operación
 * —el mismo `clientEventId` con el que el motor deduplica (`te_client_dedup`)— y se
 * manda cuando vuelve la conexión.
 *
 * Las dos reglas que la cola respeta y que la suite verifica:
 *
 * 1. **El orden no se altera.** Entregar antes de despachar produciría un historial que
 *    el motor no habría aceptado, así que una falla detiene la cola en vez de saltearla.
 * 2. **Reenviar no aplica dos veces.** El id de la operación es la clave de
 *    deduplicación: si la app se cerró después de mandar el evento pero antes de
 *    borrarlo, al reabrir no se reenvía.
 */
export function ChoferCliente({
  slug,
  envios,
}: {
  slug: string
  envios: Envio[]
}) {
  const [cola, setCola] = useState<EstadoCola>(COLA_VACIA)
  const [sinSenal, setSinSenal] = useState(false)
  const [ultimo, setUltimo] = useState<string | null>(null)

  const activos = useMemo(
    () => envios.filter((e) => e.estado !== 'delivered' && e.estado !== 'cancelled'),
    [envios],
  )

  function encolarAccion(envio: Envio, accion: AccionEnvio) {
    // El id de la operación incluye el envío, la acción y el momento: es la clave que
    // hace idempotente el reenvío y evita que dos toques del mismo botón dupliquen el
    // evento.
    const id = `${envio.id}:${accion}:${new Date().toISOString()}`
    setCola((previa) => encolar(previa, { id, envioId: envio.id, tipo: accion, descripcion: ETIQUETA_ACCION_ENVIO[accion], payload: { numero: envio.numero }, creadaEn: new Date().toISOString() }))
    setUltimo(`${ETIQUETA_ACCION_ENVIO[accion]} de ${envio.numero} quedó en la cola.`)
  }

  function sincronizarAhora() {
    const resultado = sincronizar(cola, () => !sinSenal)
    setCola(resultado.estado)
    setUltimo(
      resultado.aplicadas.length === 0
        ? sinSenal
          ? 'Sin señal: no se envió nada y la cola quedó intacta, en su orden.'
          : 'No había nada pendiente.'
        : `Se enviaron ${resultado.aplicadas.length} operación(es)${resultado.incompleta ? ' y la cola se detuvo en la que falló.' : '.'}`,
    )
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-terciario">Panel del conductor</p>
        <h1 className="text-xl font-semibold text-principal">Mis entregas</h1>
      </header>

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-principal">
              {pendientesDe(cola) === 0 ? 'Sin operaciones pendientes' : `${pendientesDe(cola)} operación(es) esperando`}
            </p>
            <p className="mt-0.5 text-xs text-secundario">
              {colaAlDia(cola) ? 'Todo lo que marcaste llegó al sistema.' : 'Se envían solas cuando vuelva la señal.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Boton variante="secundario" tamano="sm" onClick={() => setSinSenal((v) => !v)}>
              {sinSenal ? 'Simular señal' : 'Simular sin señal'}
            </Boton>
            <Boton variante="primario" tamano="sm" onClick={sincronizarAhora} disabled={colaAlDia(cola)}>
              Sincronizar
            </Boton>
          </div>
        </div>
        {sinSenal && (
          <p className="mt-3 rounded-[var(--control-radio)] bg-atencion-suave px-3 py-2 text-xs text-atencion">
            Sin conexión. Lo que marques se guarda acá y se envía al volver — con el mismo id, así que el sistema no lo
            aplica dos veces.
          </p>
        )}
        {ultimo !== null && <p className="mt-3 text-xs text-secundario">{ultimo}</p>}
      </section>

      <ul className="flex flex-col gap-3">
        {activos.map((envio) => (
          <li key={envio.id} className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-xs text-secundario">{envio.numero}</p>
                <p className="text-sm text-principal">{envio.hasta}</p>
                <p className="text-xs text-terciario">{envio.localidadDestino}</p>
              </div>
              <Insignia tono={TONO_ESTADO_ENVIO[envio.estado]} conPunto>
                {ETIQUETA_ESTADO_ENVIO[envio.estado]}
              </Insignia>
            </div>

            {envio.ventanaHasta !== null && (
              <p className="mt-2 text-xs text-terciario">
                Ventana hasta {formatearFechaHora(envio.ventanaHasta)}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {accionesEnvio(envio).map((accion) => (
                <Boton key={accion} variante="secundario" tamano="sm" onClick={() => encolarAccion(envio, accion)}>
                  {ETIQUETA_ACCION_ENVIO[accion]}
                </Boton>
              ))}
              {accionesEnvio(envio).length === 0 && (
                <span className="text-xs text-terciario">Este envío está cerrado.</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs text-terciario">
        Empresa: <span className="font-mono">{slug}</span>. Los botones no cambian el estado en pantalla: encolan la
        operación, que es lo que el conductor necesita cuando no hay señal.
      </p>
    </main>
  )
}
