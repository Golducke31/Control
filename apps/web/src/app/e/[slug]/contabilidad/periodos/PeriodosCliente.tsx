'use client'

import { useState } from 'react'
import { EncabezadoDeVentana, Boton, Insignia } from '@control/ui'
import type { Periodo } from '@control/contracts'
import { cerrarPeriodo, fueReabierto, reabrirPeriodo } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { formatearFecha, formatearFechaHora, formatearNumero } from '@/datos/formato'

const ETIQUETA_ESTADO: Record<Periodo['estado'], string> = {
  open: 'abierto',
  closing: 'en cierre',
  closed: 'cerrado',
}

const TONO_ESTADO: Record<Periodo['estado'], 'exito' | 'atencion' | 'neutro'> = {
  open: 'exito',
  closing: 'atencion',
  closed: 'neutro',
}

type Aviso = { clase: 'ok' | 'error'; texto: string }

/**
 * Períodos (F6 · Contabilidad) — donde **el cierre se ve reflejado**.
 *
 * Es la puerta de F6 hecha pantalla. Antes de cerrar, la ventana anticipa el rechazo
 * con la misma función pura que decide después —`cerrarPeriodo`—, así que el botón
 * está deshabilitado exactamente cuando la operación va a fallar: un período con
 * asientos en borrador no se cierra, y la ventana dice cuántos son antes de intentar.
 *
 * Reabrir exige motivo: el motor lo impone con `periods_reopen_coherent`, porque
 * reabrir invalida cualquier balance ya presentado y una reapertura sin registro es
 * justo lo que el ADR quiere impedir.
 */
export function PeriodosCliente({
  slug,
  inicial,
  autor,
}: {
  slug: string
  inicial: Periodo[]
  autor: string
}) {
  const [periodos, setPeriodos] = useState(inicial)
  const [motivos, setMotivos] = useState<Record<string, string>>({})
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [enviando, setEnviando] = useState<string | null>(null)

  function reemplazar(periodo: Periodo) {
    setPeriodos((previos) => previos.map((p) => (p.id === periodo.id ? periodo : p)))
  }

  async function cerrar(periodo: Periodo) {
    setEnviando(periodo.id)
    setAviso(null)
    try {
      const r = await getCliente().cerrarPeriodo({ empresaSlug: slug, periodo, autor })
      if (r.ok) {
        reemplazar(r.periodo)
        setAviso({ clase: 'ok', texto: `${periodo.nombre} quedó cerrado. Ya no acepta asientos.` })
      } else if (r.motivo === 'asientos_pendientes') {
        setAviso({
          clase: 'error',
          texto: `${periodo.nombre} tiene ${formatearNumero.format(r.cantidad)} asiento(s) en borrador: hay que contabilizarlos o descartarlos antes de cerrar.`,
        })
      } else {
        setAviso({ clase: 'error', texto: `${periodo.nombre} ya estaba cerrado.` })
      }
    } finally {
      setEnviando(null)
    }
  }

  async function reabrir(periodo: Periodo) {
    setEnviando(periodo.id)
    setAviso(null)
    try {
      const r = await getCliente().reabrirPeriodo({
        empresaSlug: slug,
        periodo,
        autor,
        motivo: motivos[periodo.id] ?? '',
      })
      if (r.ok) {
        reemplazar(r.periodo)
        setMotivos((previos) => ({ ...previos, [periodo.id]: '' }))
        setAviso({
          clase: 'ok',
          texto: `${periodo.nombre} quedó reabierto por ${autor}, con el motivo registrado.`,
        })
      } else if (r.motivo === 'motivo_requerido') {
        setAviso({ clase: 'error', texto: 'Para reabrir hay que escribir el motivo: queda auditado.' })
      } else {
        setAviso({ clase: 'error', texto: `${periodo.nombre} no está cerrado.` })
      }
    } finally {
      setEnviando(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Períodos"
        descripcion="El cierre del mes. Un período cerrado no acepta asientos; para corregirlo hay que reabrirlo, con motivo y autor, porque invalida cualquier balance ya presentado."
        barra={
          <>
            <span className="text-xs text-terciario">
              cerrás y reabrís como <span className="text-secundario">{autor}</span>
            </span>
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/contabilidad`}>
              Volver al libro diario
            </Boton>
          </>
        }
      />

      {aviso !== null && (
        <p
          className={
            aviso.clase === 'ok'
              ? 'rounded-[var(--control-radio)] bg-exito-suave px-3 py-2 text-sm text-exito'
              : 'rounded-[var(--control-radio)] bg-peligro-suave px-3 py-2 text-sm text-peligro'
          }
        >
          {aviso.texto}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {periodos.map((periodo) => {
          // La misma función pura que decide el cierre: la ventana anticipa el
          // rechazo en vez de ofrecer un botón que va a fallar.
          const intento = cerrarPeriodo(periodo, {
            fecha: periodo.cerradoEn ?? '',
            autor,
            asientosPendientes: periodo.asientosPendientes,
          })
          const puedeCerrar = intento.ok
          const abierto = periodo.estado !== 'closed'
          const motivo = motivos[periodo.id] ?? ''
          const intentoReapertura = reabrirPeriodo(periodo, { fecha: '', autor, motivo })
          const puedeReabrir = intentoReapertura.ok

          return (
            <section
              key={periodo.id}
              className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-medium text-principal">{periodo.nombre}</h2>
                    <Insignia tono={TONO_ESTADO[periodo.estado]} conPunto>
                      {ETIQUETA_ESTADO[periodo.estado]}
                    </Insignia>
                    {fueReabierto(periodo) && (
                      <Insignia tono="atencion" conPunto>
                        reabierto
                      </Insignia>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-secundario">
                    {formatearFecha(periodo.desde)} — {formatearFecha(periodo.hasta)} · ejercicio {periodo.ejercicio}
                  </p>
                  {periodo.asientosPendientes > 0 && (
                    <p className="mt-1 text-xs text-peligro">
                      {formatearNumero.format(periodo.asientosPendientes)} asiento(s) en borrador
                    </p>
                  )}
                  {periodo.cerradoEn !== null && (
                    <p className="mt-1 text-xs text-terciario">
                      cerrado {formatearFechaHora(periodo.cerradoEn)} por {periodo.cerradoPor}
                    </p>
                  )}
                  {fueReabierto(periodo) && (
                    <p className="mt-1 text-xs text-terciario">
                      reabierto {formatearFechaHora(periodo.reabiertoEn ?? '')} por {periodo.reabiertoPor}:{' '}
                      {periodo.motivoReapertura}
                    </p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  {abierto ? (
                    <Boton
                      variante="primario"
                      tamano="sm"
                      disabled={!puedeCerrar || enviando === periodo.id}
                      onClick={() => void cerrar(periodo)}
                    >
                      {puedeCerrar ? 'Cerrar período' : 'No se puede cerrar'}
                    </Boton>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={motivo}
                        onChange={(e) => setMotivos((previos) => ({ ...previos, [periodo.id]: e.target.value }))}
                        placeholder="Motivo de la reapertura…"
                        aria-label={`Motivo para reabrir ${periodo.nombre}`}
                        className="h-9 w-64 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
                      />
                      <Boton
                        variante="secundario"
                        tamano="sm"
                        disabled={!puedeReabrir || enviando === periodo.id}
                        onClick={() => void reabrir(periodo)}
                      >
                        Reabrir
                      </Boton>
                    </>
                  )}
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
