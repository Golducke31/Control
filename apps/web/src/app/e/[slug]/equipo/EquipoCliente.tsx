'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Miembro, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearNumero } from '@/datos/formato'

/** El estado es `app.user_status` del motor. */
const ETIQUETA_ESTADO: Record<Miembro['estado'], string> = {
  invited: 'invitado',
  active: 'activo',
  suspended: 'suspendido',
}

const TONO_ESTADO: Record<Miembro['estado'], 'atencion' | 'exito' | 'peligro'> = {
  invited: 'atencion',
  active: 'exito',
  suspended: 'peligro',
}

/**
 * Equipo (F9).
 *
 * Los permisos se muestran **por persona** y no sólo por rol: el motor autoriza por
 * usuario, así que dos personas con el mismo rol pueden tener permisos distintos. Mostrar
 * sólo el rol escondería justo lo que hay que revisar cuando alguien tiene más de lo que
 * debería.
 */
export function EquipoCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Miembro[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Miembro>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['equipo-miembros', slug],
    consultar: (c, p) => c.listarMiembros(p),
    initialData,
  })

  const columnas = useMemo<Columna<Miembro>[]>(
    () => [
      {
        id: 'nombre',
        titulo: 'Miembro',
        campoOrden: 'nombre',
        ordenable: true,
        cuerpo: (m) => (
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sutil text-[10px] font-medium text-secundario"
            >
              {m.iniciales}
            </span>
            <span className="text-principal">{m.nombre}</span>
          </span>
        ),
      },
      { id: 'rol', titulo: 'Rol', campoOrden: 'rol', ordenable: true, cuerpo: (m) => m.rol },
      {
        id: 'permisos',
        titulo: 'Permisos',
        alinear: 'derecha',
        campoOrden: 'permisos',
        ordenable: true,
        cuerpo: (m) => (
          <span className="tabular-nums text-secundario" title={m.permisos.join(', ')}>
            {formatearNumero.format(m.permisos.length)}
          </span>
        ),
      },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (m) => (
          <Insignia tono={TONO_ESTADO[m.estado]} conPunto>
            {ETIQUETA_ESTADO[m.estado]}
          </Insignia>
        ),
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: () => (
          <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/equipo/roles`}>
            Ver roles
          </Boton>
        ),
      },
    ],
    [slug],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Equipo"
        descripcion="Quién trabaja en esta empresa, con qué rol y con qué permisos. El menú de cada persona sale de acá: los permisos se otorgan por usuario, no sólo por rol."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por nombre o rol…"
              aria-label="Buscar miembros"
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

      <DataTable<Miembro>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Equipo. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="Todavía no hay nadie en el equipo"
        descripcionVacia="Invitá a la primera persona para que pueda entrar a esta empresa."
      />
    </div>
  )
}
