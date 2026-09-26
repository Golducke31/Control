'use client'

import { EncabezadoDeVentana, Boton, Insignia } from '@control/ui'
import { useTranslations } from 'next-intl'
import type { DeterminacionIva } from '@control/contracts'
import { formatearFechaHora, pesos } from '@/datos/formato'

/** La **clave del mensaje** de cada estado. El texto vive en el catálogo, no acá. */
const CLAVE_ESTADO: Record<DeterminacionIva['estado'], 'aFavor' | 'aPagar' | 'sinMovimiento'> = {
  a_favor: 'aFavor',
  a_pagar: 'aPagar',
  sin_movimiento: 'sinMovimiento',
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
  const t = useTranslations('fiscal')
  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={t('titulo')}
        descripcion={t('descripcion')}
        barra={
          <>
            <Insignia tono={inicial.estado === 'a_pagar' ? 'atencion' : 'exito'} conPunto>
              {t(CLAVE_ESTADO[inicial.estado])}
            </Insignia>
            <span className="text-xs text-terciario">
              {t('calculada', { fecha: formatearFechaHora(inicial.calculadaEn) })}
            </span>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
          <h2 className="text-sm font-medium text-principal">{t('debitoFiscal')}</h2>
          <div className="mt-3">
            <Fila etiqueta={t('ventasNetas')} valor={pesos(inicial.ventasNetas)} />
            <Fila etiqueta={t('ivaDebito')} valor={pesos(inicial.ivaDebito)} />
          </div>
        </section>

        <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
          <h2 className="text-sm font-medium text-principal">{t('creditoFiscal')}</h2>
          <div className="mt-3">
            <Fila etiqueta={t('comprasNetas')} valor={pesos(inicial.comprasNetas)} />
            <Fila etiqueta={t('ivaCredito')} valor={pesos(inicial.ivaCredito)} />
          </div>
        </section>
      </div>

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
        <h2 className="text-sm font-medium text-principal">{t('saldoTecnico', { periodo })}</h2>
        <div className="mt-3">
          <Fila etiqueta={t('componentesDelSaldo')} valor={pesos(inicial.saldoTecnico)} fuerte />
        </div>
        <p className="mt-3 text-xs text-secundario">
          {inicial.saldoTecnico > 0 ? t('saldoAPagar') : t('saldoAFavor')}
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        <Boton variante="secundario" tamano="sm" href={`/e/${slug}/fiscal/determinacion`}>
          {t('determinacion')}
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/alicuotas`}>
          {t('alicuotas')}
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/retenciones`}>
          {t('retenciones')}
        </Boton>
        <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/fiscal/libros`}>
          {t('libros')}
        </Boton>
      </div>
    </div>
  )
}
