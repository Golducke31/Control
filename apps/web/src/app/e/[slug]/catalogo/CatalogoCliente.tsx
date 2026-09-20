'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Producto, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'

const formatearPesos = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

const TONO_ESTADO = {
  activo: 'exito',
  inactivo: 'informacion',
  descontinuado: 'peligro',
} as const

/**
 * Catálogo cableado de punta a punta en F3.
 *
 * La cadena completa: `useUrlState` (filtros/página/orden en la URL, A12) →
 * `useColeccion` (React Query sobre `ApiClient`, con `initialData` del Server
 * Component) → `DataTable` (los cinco estados). El componente no sabe si el cliente
 * es simulado o real: cambiar `NEXT_PUBLIC_API_MODE` conecta al backend sin tocar
 * esto.
 */
export function CatalogoCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Producto[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Producto>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['productos', slug],
    consultar: (c, p) => c.listarProductos(p),
    initialData,
  })

  const columnas = useMemo<Columna<Producto>[]>(
    () => [
      { id: 'sku', titulo: 'SKU', campoOrden: 'sku', ordenable: true, cuerpo: (p) => <span className="font-mono text-xs text-secundario">{p.sku}</span> },
      { id: 'nombre', titulo: 'Producto', campoOrden: 'nombre', ordenable: true, cuerpo: (p) => p.nombre },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (p) => (
          <Insignia tono={TONO_ESTADO[p.estado]} conPunto>
            {p.estado}
          </Insignia>
        ),
      },
      {
        id: 'precio',
        titulo: 'Precio',
        alinear: 'derecha',
        campoOrden: 'precio',
        ordenable: true,
        cuerpo: (p) => formatearPesos.format(p.precio / 100),
      },
      {
        id: 'stock',
        titulo: 'Stock',
        alinear: 'derecha',
        campoOrden: 'stock',
        ordenable: true,
        cuerpo: (p) => p.stock,
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
        titulo="Catálogo"
        descripcion="Productos de la empresa. El stock y el precio se validan contra el contrato en la frontera del cliente."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por SKU o nombre…"
              aria-label="Buscar productos"
              className="h-9 min-w-64 flex-1 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            />
            {filtroActivo && (
              <Boton
                variante="fantasma"
                tamano="sm"
                onClick={() => setEstado({ texto: '', orden: null, pagina: 1 })}
              >
                Limpiar
              </Boton>
            )}
          </>
        }
      />

      <DataTable<Producto>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar al catálogo. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="Tu catálogo está vacío"
        descripcionVacia="Cuando cargues productos, aparecerán listados acá. Por ahora servimos datos de demostración."
      />
    </div>
  )
}
