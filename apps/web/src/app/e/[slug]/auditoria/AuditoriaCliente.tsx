'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { AuditoriaEvento, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFechaHora } from '@/datos/formato'

const TONO_ACCION: Record<string, 'exito' | 'informacion' | 'atencion' | 'peligro' | 'neutro'> = {
  crear: 'exito',
  facturar: 'informacion',
  editar: 'informacion',
  cerrar: 'atencion',
  anular: 'peligro',
  eliminar: 'peligro',
}

/**
 * Auditoría (F9) — el registro de todo lo que pasó.
 *
 * Es la ventana que responde «quién hizo esto». El actor se muestra siempre y no se
 * colapsa: un evento sin autor es un evento que no se puede atribuir, y esa es
 * precisamente la pregunta que trae a alguien acá.
 *
 * La lista es **append-only** por construcción del motor: nada de lo que se ve se puede
 * editar ni borrar desde la interfaz, así que la ventana no ofrece ninguna acción.
 */
export function AuditoriaCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: AuditoriaEvento[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<AuditoriaEvento>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['auditoria-eventos', slug],
    consultar: (c, p) => c.listarAuditoria(p),
    initialData,
  })

  const columnas = useMemo<Columna<AuditoriaEvento>[]>(
    () => [
      {
        id: 'fecha',
        titulo: 'Cuándo',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (e) => <span className="text-secundario">{formatearFechaHora(e.fecha)}</span>,
      },
      { id: 'actor', titulo: 'Quién', campoOrden: 'actor', ordenable: true, cuerpo: (e) => e.actor },
      {
        id: 'accion',
        titulo: 'Qué',
        campoOrden: 'accion',
        ordenable: true,
        cuerpo: (e) => (
          <Insignia tono={TONO_ACCION[e.accion] ?? 'neutro'} conPunto>
            {e.accion}
          </Insignia>
        ),
      },
      {
        id: 'entidad',
        titulo: 'Sobre qué',
        campoOrden: 'entidad',
        ordenable: true,
        cuerpo: (e) => <span className="font-mono text-xs text-secundario">{e.entidad}</span>,
      },
      {
        id: 'detalle',
        titulo: 'Detalle',
        cuerpo: (e) => <span className="text-secundario">{e.detalle ?? '—'}</span>,
      },
    ],
    [],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Auditoría"
        descripcion="Todo lo que pasó, con su autor, su momento y su contexto. Es la ventana que responde «quién hizo esto», y no se puede editar: el registro es append-only."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por autor, acción o entidad…"
              aria-label="Buscar eventos de auditoría"
              className="h-9 min-w-64 flex-1 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            />
            {filtroActivo && (
              <Boton variante="fantasma" tamano="sm" onClick={() => setEstado({ texto: '', orden: null, pagina: 1 })}>
                Limpiar
              </Boton>
            )}
          </>
        }
      />

      <DataTable<AuditoriaEvento>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Auditoría. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay eventos todavía"
        descripcionVacia="Cada cambio que se haga en la empresa va a quedar registrado acá."
        caption="Eventos de auditoría, del más reciente al más antiguo"
      />
    </div>
  )
}
