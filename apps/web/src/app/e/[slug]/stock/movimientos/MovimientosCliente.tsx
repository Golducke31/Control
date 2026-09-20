'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { MovimientoStock, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFecha, numeroConSigno } from '@/datos/formato'

/** El tipo del motor es `app.stock_move_kind`; acá se muestra en castellano. */
const ETIQUETA_MOVIMIENTO: Record<MovimientoStock['tipo'], string> = {
  purchase_in: 'Entrada por compra',
  sale_out: 'Salida por venta',
  transfer_out: 'Salida por transferencia',
  transfer_in: 'Entrada por transferencia',
  adjustment_pos: 'Ajuste positivo',
  adjustment_neg: 'Ajuste negativo',
  return_in: 'Entrada por devolución',
  reservation: 'Reserva',
  release: 'Liberación',
}

const TONO_MOVIMIENTO: Record<MovimientoStock['tipo'], 'exito' | 'peligro' | 'neutro'> = {
  purchase_in: 'exito',
  sale_out: 'peligro',
  transfer_out: 'peligro',
  transfer_in: 'exito',
  adjustment_pos: 'exito',
  adjustment_neg: 'peligro',
  return_in: 'exito',
  reservation: 'neutro',
  release: 'neutro',
}

/**
 * Movimientos (F5) — el libro mayor de inventario.
 *
 * Es **append-only**: nunca se edita ni se borra, y las reservas y liberaciones
 * escriben su fila aunque no muevan la cantidad física (por eso aparecen con neto 0).
 * La columna de neto es la que después suma la conciliación.
 */
export function MovimientosCliente({
  slug,
  initialData,
  depositos,
}: {
  slug: string
  initialData: { items: MovimientoStock[]; paginacion: Paginacion }
  depositos: Record<string, string>
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<MovimientoStock>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['stock-movimientos', slug],
    consultar: (c, p) => c.listarMovimientos(p),
    initialData,
  })

  const columnas = useMemo<Columna<MovimientoStock>[]>(
    () => [
      {
        id: 'fecha',
        titulo: 'Fecha',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (m) => <span className="text-secundario">{formatearFecha(m.fecha)}</span>,
      },
      {
        id: 'sku',
        titulo: 'SKU',
        campoOrden: 'sku',
        ordenable: true,
        cuerpo: (m) => <span className="font-mono text-xs text-secundario">{m.sku}</span>,
      },
      {
        id: 'tipo',
        titulo: 'Tipo',
        campoOrden: 'tipo',
        ordenable: true,
        cuerpo: (m) => (
          <Insignia tono={TONO_MOVIMIENTO[m.tipo]} conPunto>
            {ETIQUETA_MOVIMIENTO[m.tipo]}
          </Insignia>
        ),
      },
      {
        id: 'deposito',
        titulo: 'Depósito',
        cuerpo: (m) => <span className="text-secundario">{depositos[m.depositoId] ?? m.depositoId}</span>,
      },
      {
        id: 'neto',
        titulo: 'Neto',
        alinear: 'derecha',
        campoOrden: 'cantidad',
        ordenable: true,
        cuerpo: (m) => (
          <span className={m.cantidad < 0 ? 'tabular-nums text-peligro' : 'tabular-nums text-exito'}>
            {numeroConSigno(m.cantidad)}
          </span>
        ),
      },
      {
        id: 'motivo',
        titulo: 'Motivo',
        cuerpo: (m) => <span className="text-secundario">{m.motivo ?? '—'}</span>,
      },
      {
        id: 'documento',
        titulo: 'Documento',
        cuerpo: (m) =>
          m.documento === undefined ? (
            <span className="text-xs text-terciario">—</span>
          ) : (
            <span className="font-mono text-xs text-secundario">{m.documento}</span>
          ),
      },
    ],
    [depositos],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Movimientos"
        descripcion="El libro mayor de inventario. Es append-only: las reservas escriben su fila aunque no muevan la cantidad física."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por SKU, producto, tipo o motivo…"
              aria-label="Buscar movimientos"
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

      <DataTable<MovimientoStock>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Movimientos. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="El libro está vacío"
        descripcionVacia="Cada entrada o salida de mercadería deja su fila acá, y no se borra nunca."
      />
    </div>
  )
}
