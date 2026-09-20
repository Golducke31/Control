'use client'

import { EncabezadoDeVentana, Boton, Insignia } from '@control/ui'
import type { DeterminacionIva } from '@control/contracts'
import { formatearFechaHora, pesos } from '@/datos/formato'

const ETIQUETA_ESTADO: Record<DeterminacionIva['estado'], string> = {
  a_favor: 'a favor',
  a_pagar: 'a pagar',
  sin_movimiento: 'sin movimiento',
}

function Fila({ etiqueta, valor, fuerte }: { etiqueta: string; valor: string; fuerte?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-borde-control py-2 last:border-b-0">
      <span className={fuerte === true ? 'text-sm font-medium text-principal' : 'text-sm text-secundario'}>{etiqueta}</span>
      <span className={fuerte === true ? 'tabular-nums font-semibold text-principal' : 'tabular-nums text-principal'}>
        {valor}
      </span>
    </div>
  )
}

/**
 * Fiscal (F6) — la posición de IVA del período.
 *
 * Se muestran los **dos componentes** del saldo técnico y no sólo el resultado: un
 * número solo no se audita, y el contador necesita ver de dónde sale. El saldo es
 * `IVA débito − IVA crédito`, calculado por el motor.
 *
 * Los comprobantes de terceros, las alícuotas con vigencia, las retenciones y los
 * libros viven en las sub-rutas de esta ventana.
 */
export function FiscalCliente({
  slug,
  periodo,
  inicial,
}: {
  slug: string
  periodo: string
  inicial: DeterminacionIva
}) {
  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Fiscal"
        descripcion="La posición de IVA del período, con sus dos componentes a la vista. Una alícuota es una norma con fecha: se calcula con la vigente al período, no con la de hoy."
        barra={
          <>
            <Insignia tono={inicial.estado === 'a_pagar' ? 'atencion' : 'exito'} conPunto>
              {ETIQUETA_ESTADO[inicial.estado]}
            </Insignia>
            <span className="text-xs text-terciario">
              calculada {formatearFechaHora(inicial.calculadaEn)}
            </span>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
          <h2 className="text-sm font-medium text-principal">Débito fiscal · ventas</h2>
          <div className="mt-3">
            <Fila etiqueta="Ventas netas" valor={pesos(inicial.ventasNetas)} />
            <Fila etiqueta="IVA débito" valor={pesos(inicial.ivaDebito)} />
          </div>
        </section>

        <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
          <h2 className="text-sm font-medium text-principal">Crédito fiscal · compras</h2>
          <div className="mt-3">
            <Fila etiqueta="Compras netas" valor={pesos(inicial.comprasNetas)} />
            <Fila etiqueta="IVA crédito" valor={pesos(inicial.ivaCredito)} />
          </div>
        </section>
      </div>

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
        <h2 className="text-sm font-medium text-principal">Saldo técnico del período {periodo}</h2>
        <div className="mt-3">
          <Fila etiqueta="IVA débito − IVA crédito" valor={pesos(inicial.saldoTecnico)} fuerte />
        </div>
        <p className="mt-3 text-xs text-secundario">
          {inicial.saldoTecnico > 0
            ? 'El saldo es a pagar: el débito fiscal supera al crédito del período.'
            : 'El saldo queda a favor y se arrastra al período siguiente.'}
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        <Boton variante="secundario" tamano="sm" href={`/e/${slug}/fiscal/determinacion`}>
          Determinación por período
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/alicuotas`}>
          Alícuotas
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/retenciones`}>
          Retenciones
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/libros`}>
          Libros
        </Boton>
      </div>
    </div>
  )
}
