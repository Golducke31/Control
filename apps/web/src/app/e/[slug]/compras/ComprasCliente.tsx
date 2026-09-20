'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Orden, OrdenCompra, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFecha, pesos } from '@/datos/formato'

/** Los estados son los del CHECK `po_status_valid` del motor; acá se muestran en castellano. */
const ETIQUETA_ESTADO: Record<OrdenCompra['estado'], string> = {
  draft: 'borrador',
  pending_approval: 'esperando aprobación',
  approved: 'aprobada',
  partially_received: 'recibida en parte',
  received: 'recibida',
  cancelled: 'cancelada',
}

const TONO_ESTADO: Record<OrdenCompra['estado'], 'neutro' | 'atencion' | 'informacion' | 'exito' | 'peligro'> = {
  draft: 'neutro',
  pending_approval: 'atencion',
  approved: 'informacion',
  partially_received: 'atencion',
  received: 'exito',
  cancelled: 'peligro',
}

/**
 * Compras (F6) — órdenes a proveedores.
 *
 * Una orden aprobada siempre registra quién y cuándo aprobó: el motor lo exige con
 * `po_approval_recorded`, porque sin eso «aprobada» es un estado que cualquiera
 * escribe sin haber aprobado nada y la aprobación por monto deja de ser un control.
 * La columna «Aprobación» muestra ese registro.
 *
 * Lo recibido es lo que entra al stock, así que la orden deja de ofrecer recepción
 * cuando `recibidoCompleto` es verdadero.
 */
export function ComprasCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: OrdenCompra[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<OrdenCompra>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['compras-ordenes', slug],
    consultar: (c, p) => c.listarOrdenesCompra(p),
    initialData,
  })

  const columnas = useMemo<Columna<OrdenCompra>[]>(
    () => [
      {
        id: 'numero',
        titulo: 'Número',
        campoOrden: 'numero',
        ordenable: true,
        cuerpo: (o) => <span className="font-mono text-xs text-secundario">{o.numero}</span>,
      },
      { id: 'proveedor', titulo: 'Proveedor', campoOrden: 'proveedor', ordenable: true, cuerpo: (o) => o.proveedor },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (o) => (
          <Insignia tono={TONO_ESTADO[o.estado]} conPunto>
            {ETIQUETA_ESTADO[o.estado]}
          </Insignia>
        ),
      },
      {
        id: 'total',
        titulo: 'Total',
        alinear: 'derecha',
        campoOrden: 'total',
        ordenable: true,
        cuerpo: (o) => pesos(o.total),
      },
      {
        id: 'aprobacion',
        titulo: 'Aprobación',
        alinear: 'derecha',
        cuerpo: (o) =>
          o.aprobadaEn === null ? (
            <span className="text-xs text-terciario">sin aprobar</span>
          ) : (
            <span className="text-secundario">{formatearFecha(o.aprobadaEn)}</span>
          ),
      },
      {
        id: 'recepcion',
        titulo: 'Recepción',
        cuerpo: (o) =>
          o.recibidoCompleto ? (
            <Insignia tono="exito" conPunto>
              completa
            </Insignia>
          ) : (
            <span className="text-xs text-terciario">pendiente</span>
          ),
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: () => (
          <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/compras/ordenes`}>
            Abrir
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
        titulo="Compras"
        descripcion="Órdenes a proveedores y lo que se recibe contra ellas. Lo recibido es lo que entra al stock, y una orden aprobada registra quién la aprobó."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por número, proveedor o estado…"
              aria-label="Buscar órdenes de compra"
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

      <DataTable<OrdenCompra>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Compras. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay órdenes de compra"
        descripcionVacia="Cuando le compres a un proveedor, la orden aparecerá acá con su estado de aprobación y de recepción."
      />
    </div>
  )
}
