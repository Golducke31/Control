'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { NivelStock, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearNumero } from '@/datos/formato'

export interface ResumenDeStock {
  niveles: number
  unidades: number
  reservadas: number
  depositos: number
  bajoMinimo: number
}

function Indicador({ etiqueta, valor, nota }: { etiqueta: string; valor: string; nota?: string }) {
  return (
    <div className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
      <p className="text-xs text-terciario">{etiqueta}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-principal">{valor}</p>
      {nota !== undefined && <p className="mt-0.5 text-xs text-secundario">{nota}</p>}
    </div>
  )
}

/**
 * Stock (F5) — niveles por depósito.
 *
 * Es la puerta de entrada del inventario: el saldo materializado, que es contra lo que
 * se compara el libro mayor en la conciliación. Las sub-rutas del módulo (movimientos,
 * transferencias, recuento, conciliación, reposición) cuelgan de acá.
 *
 * Filtros, página y orden viven en la URL (A12) y la consulta va por `useColeccion`.
 */
export function StockCliente({
  slug,
  initialData,
  resumen,
}: {
  slug: string
  initialData: { items: NivelStock[]; paginacion: Paginacion }
  resumen: ResumenDeStock
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<NivelStock>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['stock-niveles', slug],
    consultar: (c, p) => c.listarNiveles(p),
    initialData,
  })

  const columnas = useMemo<Columna<NivelStock>[]>(
    () => [
      {
        id: 'sku',
        titulo: 'SKU',
        campoOrden: 'sku',
        ordenable: true,
        cuerpo: (n) => <span className="font-mono text-xs text-secundario">{n.sku}</span>,
      },
      { id: 'nombre', titulo: 'Producto', campoOrden: 'nombre', ordenable: true, cuerpo: (n) => n.nombre },
      {
        id: 'deposito',
        titulo: 'Depósito',
        campoOrden: 'depositoNombre',
        ordenable: true,
        cuerpo: (n) => <span className="text-secundario">{n.depositoNombre}</span>,
      },
      {
        id: 'cantidad',
        titulo: 'Cantidad',
        alinear: 'derecha',
        campoOrden: 'cantidad',
        ordenable: true,
        cuerpo: (n) => formatearNumero.format(n.cantidad),
      },
      {
        id: 'reservada',
        titulo: 'Reservada',
        alinear: 'derecha',
        campoOrden: 'reservada',
        ordenable: true,
        cuerpo: (n) => <span className="text-secundario">{formatearNumero.format(n.reservada)}</span>,
      },
      {
        id: 'disponible',
        titulo: 'Disponible',
        alinear: 'derecha',
        campoOrden: 'disponible',
        ordenable: true,
        cuerpo: (n) =>
          n.disponible === 0 ? (
            <Insignia tono="peligro" conPunto>
              sin disponible
            </Insignia>
          ) : (
            <span className="font-medium tabular-nums">{formatearNumero.format(n.disponible)}</span>
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
        titulo="Stock"
        descripcion="Niveles por depósito. El saldo y el libro mayor se escriben en la misma transacción; la conciliación verifica que sigan de acuerdo."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por SKU, producto o depósito…"
              aria-label="Buscar niveles de stock"
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Indicador etiqueta="Niveles con saldo" valor={formatearNumero.format(resumen.niveles)} />
        <Indicador etiqueta="Unidades" valor={formatearNumero.format(resumen.unidades)} />
        <Indicador etiqueta="Reservadas" valor={formatearNumero.format(resumen.reservadas)} />
        <Indicador etiqueta="Depósitos" valor={formatearNumero.format(resumen.depositos)} />
        <Indicador
          etiqueta="Bajo mínimo"
          valor={formatearNumero.format(resumen.bajoMinimo)}
          nota={resumen.bajoMinimo > 0 ? 'ver Reposición' : 'todo por encima del mínimo'}
        />
      </div>

      <DataTable<NivelStock>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Stock. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay niveles de stock todavía"
        descripcionVacia="Cuando entre mercadería, los niveles por depósito aparecerán acá."
      />
    </div>
  )
}
