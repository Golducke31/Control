'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { MovimientoTesoreria, Orden, Paginacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFecha, pesos } from '@/datos/formato'

/** El tipo es `treasury.movement_kind` del motor; acá se muestra en castellano. */
const ETIQUETA_MOVIMIENTO: Record<MovimientoTesoreria['tipo'], string> = {
  opening: 'Saldo inicial',
  customer_payment: 'Cobro de cliente',
  check_cleared: 'Cheque acreditado',
  check_rejected: 'Cheque rechazado',
  supplier_payment: 'Pago a proveedor',
  transfer_in: 'Transferencia recibida',
  transfer_out: 'Transferencia enviada',
  bank_fee: 'Comisión bancaria',
  deposit: 'Depósito',
  withdrawal: 'Extracción',
  adjustment: 'Ajuste',
  other: 'Otro',
}

export interface ResumenDeTesoreria {
  saldoArs: number
  cuentas: number
  sinConciliar: number
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
 * Tesorería (F6) — caja y bancos.
 *
 * La columna «Conciliado» es la que hace útil a la ventana: un movimiento sin
 * conciliar es exactamente la diferencia entre lo que dice el banco y lo que dice el
 * sistema, y es lo que después se cierra en la conciliación bancaria.
 *
 * El saldo del indicador se calcula sobre **todas** las cuentas en pesos, no sobre la
 * página visible: un total que depende de la página no es un total.
 */
export function TesoreriaCliente({
  slug,
  initialData,
  resumen,
}: {
  slug: string
  initialData: { items: MovimientoTesoreria[]; paginacion: Paginacion }
  resumen: ResumenDeTesoreria
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<MovimientoTesoreria>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['tesoreria-movimientos', slug],
    consultar: (c, p) => c.listarMovimientosTesoreria(p),
    initialData,
  })

  const columnas = useMemo<Columna<MovimientoTesoreria>[]>(
    () => [
      {
        id: 'fecha',
        titulo: 'Fecha',
        campoOrden: 'fecha',
        ordenable: true,
        cuerpo: (m) => <span className="text-secundario">{formatearFecha(m.fecha)}</span>,
      },
      {
        id: 'cuenta',
        titulo: 'Cuenta',
        campoOrden: 'cuentaNombre',
        ordenable: true,
        cuerpo: (m) => m.cuentaNombre,
      },
      {
        id: 'tipo',
        titulo: 'Tipo',
        campoOrden: 'tipo',
        ordenable: true,
        cuerpo: (m) => (
          <Insignia tono={m.direccion === 'credit' ? 'exito' : 'peligro'} conPunto>
            {ETIQUETA_MOVIMIENTO[m.tipo]}
          </Insignia>
        ),
      },
      { id: 'descripcion', titulo: 'Detalle', cuerpo: (m) => <span className="text-secundario">{m.descripcion}</span> },
      {
        id: 'monto',
        titulo: 'Monto',
        alinear: 'derecha',
        campoOrden: 'monto',
        ordenable: true,
        cuerpo: (m) => (
          <span className={m.direccion === 'credit' ? 'tabular-nums text-exito' : 'tabular-nums text-peligro'}>
            {m.direccion === 'credit' ? '+' : '−'}
            {pesos(m.monto).replace('$', '$ ')}
          </span>
        ),
      },
      {
        id: 'conciliado',
        titulo: 'Conciliado',
        cuerpo: (m) =>
          m.conciliado ? (
            <span className="text-xs text-terciario">sí</span>
          ) : (
            <Insignia tono="atencion" conPunto>
              sin conciliar
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
        titulo="Tesorería"
        descripcion="Caja y bancos: cada cobro, pago y comisión con su cuenta. Lo que no está conciliado es la diferencia contra el extracto."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por cuenta, tipo o detalle…"
              aria-label="Buscar movimientos de tesorería"
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Indicador etiqueta="Saldo en pesos" valor={pesos(resumen.saldoArs)} />
        <Indicador etiqueta="Cuentas" valor={String(resumen.cuentas)} />
        <Indicador
          etiqueta="Sin conciliar"
          valor={String(resumen.sinConciliar)}
          nota={resumen.sinConciliar > 0 ? 'pendiente de conciliación bancaria' : 'todo conciliado'}
        />
      </div>

      <DataTable<MovimientoTesoreria>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Tesorería. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay movimientos"
        descripcionVacia="Cada cobro, pago o comisión deja su movimiento acá."
      />
    </div>
  )
}
