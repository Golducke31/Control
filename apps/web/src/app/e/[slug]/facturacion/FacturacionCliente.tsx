'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { ComprobanteFiscal, Orden, Paginacion } from '@control/contracts'
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

const TONO_ESTADO: Record<ComprobanteFiscal['estado'], 'neutro' | 'exito' | 'peligro'> = {
  borrador: 'neutro',
  autorizada: 'exito',
  anulada: 'peligro',
}

const TONO_RESULTADO: Record<ComprobanteFiscal['resultado'], 'exito' | 'peligro' | 'atencion'> = {
  A: 'exito',
  R: 'peligro',
  P: 'atencion',
}

const TONO_PAGO: Record<ComprobanteFiscal['payment_status'], 'atencion' | 'exito'> = {
  pendiente: 'atencion',
  parcial: 'atencion',
  pagado: 'exito',
}

const ETIQUETA_RESULTADO: Record<ComprobanteFiscal['resultado'], string> = {
  A: 'Aprobado',
  R: 'Rechazado',
  P: 'Pendiente',
}

const ETIQUETA_PAGO: Record<ComprobanteFiscal['payment_status'], string> = {
  pendiente: 'Pendiente',
  parcial: 'Parcial',
  pagado: 'Pagado',
}

/**
 * Facturación (F4) — comprobantes fiscales ya autorizados por AFIP o en borrador.
 *
 * Vista de reporte: estado de autorización, resultado de AFIP y estado de cobro. El
 * filtro/página/orden viven en la URL (A12) y la consulta va por `useColeccion`.
 */
export function FacturacionCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: ComprobanteFiscal[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<ComprobanteFiscal>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['facturacion', slug],
    consultar: (c, p) => c.listarComprobantes(p),
    initialData,
  })

  const columnas = useMemo<Columna<ComprobanteFiscal>[]>(
    () => [
      { id: 'numero', titulo: 'Número', campoOrden: 'numero', ordenable: true, cuerpo: (c) => <span className="font-mono text-xs text-secundario">{c.numero}</span> },
      {
        id: 'tipo',
        titulo: 'Tipo',
        cuerpo: (c) => <Insignia tono={c.tipo === 'factura' ? 'exito' : 'atencion'} conPunto>{c.tipo}</Insignia>,
      },
      { id: 'cliente', titulo: 'Cliente', campoOrden: 'cliente', ordenable: true, cuerpo: (c) => c.cliente },
      {
        id: 'estado',
        titulo: 'Autorización',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (c) => (
          <Insignia tono={TONO_ESTADO[c.estado]} conPunto>
            {c.estado}
          </Insignia>
        ),
      },
      {
        id: 'resultado',
        titulo: 'AFIP',
        cuerpo: (c) => (
          <Insignia tono={TONO_RESULTADO[c.resultado]} conPunto>
            {ETIQUETA_RESULTADO[c.resultado]}
          </Insignia>
        ),
      },
      {
        id: 'pagado',
        titulo: 'Cobro',
        alinear: 'derecha',
        cuerpo: (c) => (
          <div className="text-right">
            <div className="tabular-nums text-principal">{formatearPesos.format(c.pagado / 100)}</div>
            <div className="text-xs text-terciario tabular-nums">de {formatearPesos.format(c.total / 100)}</div>
          </div>
        ),
      },
      {
        id: 'payment_status',
        titulo: 'Estado de pago',
        cuerpo: (c) => (
          <Insignia tono={TONO_PAGO[c.payment_status]} conPunto>
            {ETIQUETA_PAGO[c.payment_status]}
          </Insignia>
        ),
      },
      {
        id: 'fecha',
        titulo: 'Fecha',
        alinear: 'derecha',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (c) => <span className="text-secundario">{formatearFecha(c.fecha)}</span>,
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
        titulo="Facturación"
        descripcion="Comprobantes fiscales autorizados por AFIP o en borrador, con su estado de cobro."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por número o cliente…"
              aria-label="Buscar comprobantes"
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

      <DataTable<ComprobanteFiscal>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Facturación. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay comprobantes todavía"
        descripcionVacia="Cuando factures, los comprobantes aparecerán listados acá."
      />
    </div>
  )
}
