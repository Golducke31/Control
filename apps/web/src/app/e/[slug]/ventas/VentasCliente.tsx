'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { DocumentoVenta, Orden, Paginacion } from '@control/contracts'
import { accionesDisponibles, ETIQUETA_ACCION } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'

const formatearPesos = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

const formatearFecha = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(iso))

const TONO_TIPO: Record<DocumentoVenta['tipo'], 'accion' | 'informacion' | 'atencion' | 'exito' | 'peligro'> = {
  cotizacion: 'accion',
  pedido: 'informacion',
  remito: 'atencion',
  factura: 'exito',
  devolucion: 'peligro',
}

const TONO_ESTADO: Record<DocumentoVenta['estado'], 'neutro' | 'atencion' | 'exito' | 'peligro'> = {
  borrador: 'neutro',
  pendiente: 'atencion',
  aceptado: 'exito',
  rechazado: 'peligro',
  vencido: 'peligro',
  facturado: 'exito',
}

/**
 * Ventas (F4) — la cadena completa de documentos operable contra datos simulados.
 *
 * Cada fila muestra las acciones que la cadena le habilita (`accionesDisponibles`),
 * y **sólo** esas: una cotización vencida no ofrece «Aceptar» y un remito ya facturado
 * no ofrece «Facturar» (puerta de F4). El backend que ejecuta esas transiciones llega
 * en F9; acá la visibilidad de la acción ya está gobernada por la misma regla.
 *
 * Filtros/página/orden viven en la URL (A12) y la consulta va por `useColeccion`.
 */
export function VentasCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: DocumentoVenta[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()
  // «Hoy» explícito: la regla de vencimiento es reproducible y no depende de now() oculto.
  const hoy = new Date().toISOString().slice(0, 10)

  const consulta = useColeccion<DocumentoVenta>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['ventas', slug],
    consultar: (c, p) => c.listarDocumentosVenta(p),
    initialData,
  })

  const columnas = useMemo<Columna<DocumentoVenta>[]>(
    () => [
      { id: 'numero', titulo: 'Número', campoOrden: 'numero', ordenable: true, cuerpo: (d) => <span className="font-mono text-xs text-secundario">{d.numero}</span> },
      {
        id: 'tipo',
        titulo: 'Tipo',
        cuerpo: (d) => (
          <Insignia tono={TONO_TIPO[d.tipo]} conPunto>
            {d.tipo}
          </Insignia>
        ),
      },
      { id: 'cliente', titulo: 'Cliente', campoOrden: 'cliente', ordenable: true, cuerpo: (d) => d.cliente },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (d) => (
          <Insignia tono={TONO_ESTADO[d.estado]} conPunto>
            {d.estado}
          </Insignia>
        ),
      },
      {
        id: 'total',
        titulo: 'Total',
        alinear: 'derecha',
        campoOrden: 'total',
        ordenable: true,
        cuerpo: (d) => formatearPesos.format(d.total / 100),
      },
      {
        id: 'fecha',
        titulo: 'Fecha',
        alinear: 'derecha',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (d) => <span className="text-secundario">{formatearFecha(d.fecha)}</span>,
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: (d) => {
          const acciones = accionesDisponibles(d, hoy)
          if (acciones.length === 0) {
            return <span className="text-xs text-terciario">—</span>
          }
          return (
            <div className="flex flex-wrap gap-1.5">
              {acciones.map((a) => (
                <Boton key={a} variante="fantasma" tamano="sm" onClick={() => undefined}>
                  {ETIQUETA_ACCION[a]}
                </Boton>
              ))}
            </div>
          )
        },
      },
    ],
    [hoy],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Ventas"
        descripcion="La cadena de documentos: cotización → pedido → remito → factura → devolución. Las acciones disponibles dependen del estado."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por número, cliente o tipo…"
              aria-label="Buscar documentos"
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

      <DataTable<DocumentoVenta>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Ventas. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay documentos todavía"
        descripcionVacia="Cuando operes la cadena de ventas, los documentos aparecerán listados acá."
      />
    </div>
  )
}
