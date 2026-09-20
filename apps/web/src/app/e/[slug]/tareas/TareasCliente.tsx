'use client'

import { useMemo, useState } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Orden, Paginacion, Trabajo } from '@control/contracts'
import { duracionDeCorrida, estadoDeTrabajo, ordenarTrabajos, trabajosQuePreocupan } from '@control/contracts'
import type { EstadoDeTrabajo } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFechaHora } from '@/datos/formato'

const ETIQUETA_ESTADO: Record<EstadoDeTrabajo, string> = {
  fallando: 'fallando',
  atrasado: 'atrasado',
  sin_correr: 'nunca corrió',
  corriendo: 'corriendo',
  al_dia: 'al día',
  inactivo: 'inactivo',
}

const TONO_ESTADO: Record<EstadoDeTrabajo, 'peligro' | 'atencion' | 'neutro' | 'informacion' | 'exito'> = {
  fallando: 'peligro',
  atrasado: 'atencion',
  sin_correr: 'neutro',
  corriendo: 'informacion',
  al_dia: 'exito',
  inactivo: 'neutro',
}

/** Una cadencia en milisegundos, en palabras. */
function formatearCadencia(ms: number): string {
  const dias = Math.round(ms / 86_400_000)
  if (dias >= 1) return dias === 1 ? 'cada día' : `cada ${dias} días`
  const horas = Math.round(ms / 3_600_000)
  return horas === 1 ? 'cada hora' : `cada ${horas} horas`
}

/** Una duración en milisegundos, en palabras. */
function formatearDuracion(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutos = ms / 60_000
  return minutos < 60 ? `${minutos.toFixed(1)} min` : `${(minutos / 60).toFixed(1)} h`
}

function Indicador({ etiqueta, valor, alerta }: { etiqueta: string; valor: number; alerta?: boolean }) {
  return (
    <div className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
      <p className="text-xs text-terciario">{etiqueta}</p>
      <p
        className={
          alerta === true && valor > 0
            ? 'mt-1 text-2xl font-semibold tabular-nums text-peligro'
            : 'mt-1 text-2xl font-semibold tabular-nums text-principal'
        }
      >
        {valor}
      </p>
    </div>
  )
}

/**
 * Tareas programadas (F9).
 *
 * **Por qué esta ventana existe.** Un job que falla deja un error y alguien lo ve. Un job
 * que **dejó de correr** no deja nada: el hueco se descubre cuando falta un dato —una
 * partición que no se creó, una retención que no purgó—. Por eso el estado se deriva de
 * dos cosas: del resultado de la última corrida **y** de cuánto hace que arrancó.
 *
 * El estado lo calcula `estadoDeTrabajo`, la misma función pura que prueba la suite: la
 * ventana no tiene su propia versión de la regla. `ahoraMs` llega del servidor como prop
 * y no se lee en el render, para que el HTML del servidor y el del cliente coincidan y no
 * haya un desajuste de hidratación en las duraciones.
 */
export function TareasCliente({
  slug,
  initialData,
  ahoraMs,
}: {
  slug: string
  initialData: { items: Trabajo[]; paginacion: Paginacion }
  ahoraMs: number
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()
  const [referencia, setReferencia] = useState(ahoraMs)

  const consulta = useColeccion<Trabajo>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['tareas-trabajos', slug],
    consultar: (c, p) => c.listarTrabajos({ ...p, ahoraMs: referencia }),
    initialData,
  })

  const items = consulta.data?.items ?? []
  const enRiesgo = useMemo(() => trabajosQuePreocupan(items, referencia).length, [items, referencia])

  const columnas = useMemo<Columna<Trabajo>[]>(
    () => [
      {
        id: 'codigo',
        titulo: 'Tarea',
        campoOrden: 'codigo',
        ordenable: true,
        cuerpo: (t) => <span className="font-mono text-xs text-secundario">{t.codigo}</span>,
      },
      { id: 'descripcion', titulo: 'Qué hace', campoOrden: 'descripcion', ordenable: true, cuerpo: (t) => t.descripcion },
      {
        id: 'cadencia',
        titulo: 'Cadencia',
        alinear: 'derecha',
        cuerpo: (t) => <span className="text-secundario">{formatearCadencia(t.cadenciaMs)}</span>,
      },
      {
        id: 'ultima',
        titulo: 'Última corrida',
        alinear: 'derecha',
        cuerpo: (t) =>
          t.ultimaCorrida === null ? (
            <span className="text-xs text-terciario">nunca</span>
          ) : (
            <span className="text-secundario">{formatearFechaHora(t.ultimaCorrida.iniciadaEn)}</span>
          ),
      },
      {
        id: 'duracion',
        titulo: 'Duración',
        alinear: 'derecha',
        cuerpo: (t) =>
          t.ultimaCorrida === null ? (
            <span className="text-xs text-terciario">—</span>
          ) : (
            <span className="tabular-nums text-secundario">{formatearDuracion(duracionDeCorrida(t.ultimaCorrida))}</span>
          ),
      },
      {
        id: 'estado',
        titulo: 'Estado',
        cuerpo: (t) => {
          const estado = estadoDeTrabajo(t, referencia)
          return (
            <div className="flex flex-wrap items-center gap-2">
              <Insignia tono={TONO_ESTADO[estado]} conPunto>
                {ETIQUETA_ESTADO[estado]}
              </Insignia>
              {t.critico && (
                <Insignia tono="peligro" conPunto>
                  crítica
                </Insignia>
              )}
            </div>
          )
        },
      },
      {
        id: 'error',
        titulo: 'Último error',
        cuerpo: (t) =>
          t.ultimaCorrida?.error == null ? (
            <span className="text-xs text-terciario">—</span>
          ) : (
            <span className="text-xs text-peligro">{t.ultimaCorrida.error}</span>
          ),
      },
    ],
    [referencia],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Tareas programadas"
        descripcion="Los jobs con su cadencia, su última corrida y su atraso. Un job que dejó de correr no deja error: se nota cuando falta un dato."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por código o descripción…"
              aria-label="Buscar tareas programadas"
              className="h-9 min-w-64 flex-1 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            />
            {filtroActivo && (
              <Boton variante="fantasma" tamano="sm" onClick={() => setEstado({ texto: '', orden: null, pagina: 1 })}>
                Limpiar
              </Boton>
            )}
            <Boton
              variante="secundario"
              tamano="sm"
              onClick={() => setReferencia(Date.now())}
            >
              Recalcular atrasos
            </Boton>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Indicador etiqueta="Tareas" valor={items.length} />
        <Indicador etiqueta="Requieren atención" valor={enRiesgo} alerta />
        <Indicador etiqueta="Críticas" valor={items.filter((t) => t.critico).length} />
      </div>

      <DataTable<Trabajo>
        columnas={columnas}
        datos={ordenarTrabajos(items, referencia)}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a las tareas programadas. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay tareas programadas"
        descripcionVacia="El catálogo de jobs del motor aparecerá acá con su última corrida."
        caption="Tareas programadas ordenadas por estado y criticidad"
      />
    </div>
  )
}
