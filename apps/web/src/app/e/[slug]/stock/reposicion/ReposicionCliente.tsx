'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Orden, Paginacion, Reposicion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearNumero } from '@/datos/formato'

/**
 * Reposición (F5 · Stock) — qué falta comprar o mover.
 *
 * Sale de `app.v_low_stock`: los niveles cuyo disponible quedó por debajo del mínimo.
 * Es la lista que alimenta la decisión de transferir desde otro depósito o de comprar.
 */
export function ReposicionCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Reposicion[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Reposicion>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['stock-reposicion', slug],
    consultar: (c, p) => c.listarReposicion(p),
    initialData,
  })

  const columnas = useMemo<Columna<Reposicion>[]>(
    () => [
      {
        id: 'sku',
        titulo: 'SKU',
        campoOrden: 'sku',
        ordenable: true,
        cuerpo: (r) => <span className="font-mono text-xs text-secundario">{r.sku}</span>,
      },
      { id: 'nombre', titulo: 'Producto', campoOrden: 'nombre', ordenable: true, cuerpo: (r) => r.nombre },
      {
        id: 'deposito',
        titulo: 'Depósito',
        cuerpo: (r) => <span className="text-secundario">{r.depositoNombre}</span>,
      },
      {
        id: 'disponible',
        titulo: 'Disponible',
        alinear: 'derecha',
        campoOrden: 'disponible',
        ordenable: true,
        cuerpo: (r) => <span className="tabular-nums text-peligro">{formatearNumero.format(r.disponible)}</span>,
      },
      {
        id: 'minimo',
        titulo: 'Mínimo',
        alinear: 'derecha',
        campoOrden: 'minimo',
        ordenable: true,
        cuerpo: (r) => <span className="text-secundario">{formatearNumero.format(r.minimo)}</span>,
      },
      {
        id: 'sugerido',
        titulo: 'Sugerido',
        alinear: 'derecha',
        campoOrden: 'sugerido',
        ordenable: true,
        cuerpo: (r) => (
          <Insignia tono="atencion" conPunto>
            {formatearNumero.format(r.sugerido)}
          </Insignia>
        ),
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: () => (
          <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/stock/transferencias`}>
            Transferir
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
        titulo="Reposición"
        descripcion="Los niveles que quedaron por debajo de su mínimo, con la cantidad sugerida para volver al doble del mínimo."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por SKU, producto o depósito…"
              aria-label="Buscar reposición"
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

      <DataTable<Reposicion>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Reposición. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay nada bajo el mínimo"
        descripcionVacia="Todo el stock está por encima de su punto de reposición."
      />
    </div>
  )
}
