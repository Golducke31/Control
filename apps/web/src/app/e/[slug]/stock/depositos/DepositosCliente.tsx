'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Deposito, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'

/**
 * Depósitos (F5 · Stock).
 *
 * Los depósitos no se borran: se desactivan. Un depósito con historia no puede
 * desaparecer sin dejar huérfano su libro mayor.
 */
export function DepositosCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Deposito[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Deposito>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['stock-depositos', slug],
    consultar: (c, p) => c.listarDepositos(p),
    initialData,
  })

  const columnas = useMemo<Columna<Deposito>[]>(
    () => [
      { id: 'nombre', titulo: 'Depósito', campoOrden: 'nombre', ordenable: true, cuerpo: (d) => d.nombre },
      {
        id: 'direccion',
        titulo: 'Dirección',
        cuerpo: (d) => <span className="text-secundario">{d.direccion ?? '—'}</span>,
      },
      {
        id: 'estado',
        titulo: 'Estado',
        cuerpo: (d) =>
          d.activo === true ? (
            <Insignia tono="exito" conPunto>
              activo
            </Insignia>
          ) : (
            <Insignia tono="neutro" conPunto>
              inactivo
            </Insignia>
          ),
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
        titulo="Depósitos"
        descripcion="Los lugares donde hay mercadería. Un depósito inactivo conserva su historia: no se borra, se desactiva."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por nombre o dirección…"
              aria-label="Buscar depósitos"
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

      <DataTable<Deposito>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Depósitos. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay depósitos"
        descripcionVacia="Cargá al menos un depósito para poder recibir mercadería."
      />
    </div>
  )
}
