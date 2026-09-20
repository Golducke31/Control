'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Asiento, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFecha, pesos } from '@/datos/formato'

/** El origen es `accounting.entry_source` del motor: de qué hecho nació el asiento. */
const ETIQUETA_ORIGEN: Record<Asiento['origen'], string> = {
  invoice: 'Factura de venta',
  credit_note: 'Nota de crédito',
  debit_note: 'Nota de débito',
  payment: 'Cobro',
  purchase: 'Compra',
  supplier_payment: 'Pago a proveedor',
  stock_movement: 'Movimiento de stock',
  payroll: 'Sueldos',
  tax: 'Impuesto',
  depreciation: 'Amortización',
  opening: 'Saldo inicial',
  closing: 'Cierre',
  manual: 'Manual',
}

export interface ResumenContable {
  asientos: number
  debito: number
  credito: number
  partidaDoble: boolean
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
 * Contabilidad (F6) — el libro diario.
 *
 * Débito y crédito se muestran en columnas separadas, y no como un «monto con
 * signo», porque el balance de sumas y saldos **es** la comparación entre esos dos
 * totales: colapsarlos escondería justo lo que hay que vigilar. El indicador de
 * partida doble compara los totales completos y avisa si no cierran.
 */
export function ContabilidadCliente({
  slug,
  initialData,
  resumen,
}: {
  slug: string
  initialData: { items: Asiento[]; paginacion: Paginacion }
  resumen: ResumenContable
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Asiento>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['contabilidad-asientos', slug],
    consultar: (c, p) => c.listarAsientos(p),
    initialData,
  })

  const columnas = useMemo<Columna<Asiento>[]>(
    () => [
      {
        id: 'numero',
        titulo: 'Número',
        campoOrden: 'numero',
        ordenable: true,
        cuerpo: (a) => <span className="font-mono text-xs text-secundario">{a.numero}</span>,
      },
      {
        id: 'fecha',
        titulo: 'Fecha',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (a) => <span className="text-secundario">{formatearFecha(a.fecha)}</span>,
      },
      { id: 'descripcion', titulo: 'Descripción', cuerpo: (a) => a.descripcion },
      {
        id: 'origen',
        titulo: 'Origen',
        campoOrden: 'origen',
        ordenable: true,
        cuerpo: (a) => (
          <Insignia tono="informacion" conPunto>
            {ETIQUETA_ORIGEN[a.origen]}
          </Insignia>
        ),
      },
      {
        id: 'periodo',
        titulo: 'Período',
        cuerpo: (a) => <span className="text-secundario">{a.periodoNombre}</span>,
      },
      {
        id: 'debito',
        titulo: 'Débito',
        alinear: 'derecha',
        campoOrden: 'debito',
        ordenable: true,
        cuerpo: (a) => <span className="tabular-nums">{pesos(a.debito)}</span>,
      },
      {
        id: 'credito',
        titulo: 'Crédito',
        alinear: 'derecha',
        campoOrden: 'credito',
        ordenable: true,
        cuerpo: (a) => <span className="tabular-nums">{pesos(a.credito)}</span>,
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
        titulo="Contabilidad"
        descripcion="El libro diario: cada asiento con su origen y su período. La partida doble la garantiza el motor, y acá se ve."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por número, descripción u origen…"
              aria-label="Buscar asientos"
              className="h-9 min-w-64 flex-1 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            />
            {filtroActivo && (
              <Boton variante="fantasma" tamano="sm" onClick={() => setEstado({ texto: '', orden: null, pagina: 1 })}>
                Limpiar
              </Boton>
            )}
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/contabilidad/periodos`}>
              Períodos
            </Boton>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Indicador etiqueta="Asientos" valor={String(resumen.asientos)} />
        <Indicador etiqueta="Débitos" valor={pesos(resumen.debito)} />
        <Indicador
          etiqueta="Créditos"
          valor={pesos(resumen.credito)}
          nota={resumen.partidaDoble ? 'la partida doble cierra' : 'la partida doble NO cierra'}
        />
      </div>

      <DataTable<Asiento>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Contabilidad. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="El libro está vacío"
        descripcionVacia="Los asientos se generan solos desde las ventas, las compras y el stock."
      />
    </div>
  )
}
