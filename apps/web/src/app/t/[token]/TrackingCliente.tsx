'use client'

import { Insignia } from '@control/ui'
import type { TrackingPublico } from '@control/contracts'
import { ETIQUETA_ESTADO_ENVIO, TONO_ESTADO_ENVIO } from '@/app/e/[slug]/logistica/LogisticaCliente'
import { formatearFecha, formatearFechaHora } from '@/datos/formato'

/**
 * La página pública de seguimiento.
 *
 * Recibe **sólo** la proyección pública: no tiene acceso al envío interno. Eso no es
 * una convención de esta pantalla, es el tipo — `TrackingPublico` no tiene los campos
 * que no se publican, así que la página no podría mostrarlos aunque quisiera. La
 * proyección se construye en el cliente de datos con `proyeccionPublica`, que es una
 * lista blanca verificada por la suite.
 *
 * Por eso acá no hay nombre del cliente, ni transportista, ni patente, ni coordenadas,
 * ni importes: el link de seguimiento lo abre el cliente final y puede reenviarlo.
 */
export function TrackingCliente({ seguimiento }: { seguimiento: TrackingPublico }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-terciario">Seguimiento de envío</p>
        <h1 className="font-mono text-2xl font-semibold text-principal">{seguimiento.numero}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Insignia tono={TONO_ESTADO_ENVIO[seguimiento.estado]} conPunto>
            {ETIQUETA_ESTADO_ENVIO[seguimiento.estado]}
          </Insignia>
          <span className="text-sm text-secundario">Destino: {seguimiento.localidadDestino}</span>
        </div>
      </header>

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
        {seguimiento.entregadoEn !== null ? (
          <p className="text-sm text-principal">
            Entregado el {formatearFechaHora(seguimiento.entregadoEn)}.
          </p>
        ) : seguimiento.ventanaHasta !== null ? (
          <p className="text-sm text-principal">
            Entrega estimada: {formatearFechaHora(seguimiento.ventanaDesde ?? seguimiento.ventanaHasta)} —{' '}
            {formatearFechaHora(seguimiento.ventanaHasta)}.
          </p>
        ) : (
          <p className="text-sm text-secundario">Todavía no hay una ventana de entrega comprometida.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-principal">Historial</h2>
        {seguimiento.eventos.length === 0 ? (
          <p className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4 text-sm text-secundario">
            Todavía no hay movimientos registrados para este envío.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {seguimiento.eventos.map((evento) => (
              <li
                key={`${evento.fecha}-${evento.descripcion}`}
                className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4"
              >
                <p className="text-sm text-principal">{evento.descripcion}</p>
                <p className="mt-1 text-xs text-terciario">
                  {formatearFechaHora(evento.fecha)} · {ETIQUETA_ESTADO_ENVIO[evento.estado]}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="text-xs text-terciario">
        Este link es de un solo envío. Si no es tuyo, cerralo: no muestra datos de otros envíos ni del vendedor.
      </p>
    </main>
  )
}

/** La página de un token inexistente. No revela si el código existe. */
export function TrackingNoEncontrado({ token }: { token: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <h1 className="text-lg font-semibold text-principal">No encontramos ese envío</h1>
      <p className="text-sm text-secundario">
        El código <span className="font-mono">{token}</span> no corresponde a ningún envío. Revisá el link que te
        enviaron.
      </p>
    </main>
  )
}
