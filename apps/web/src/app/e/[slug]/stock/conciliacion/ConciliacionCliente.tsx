'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Conciliacion, DiferenciaConciliacion } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { formatearFechaHora, formatearNumero } from '@/datos/formato'

/**
 * Conciliación (F5 · Stock) — el resultado del job `stock.reconciliation`.
 *
 * El job compara el saldo materializado contra la suma del libro mayor y **reporta sin
 * corregir**: la corrección es un recuento, y un recuento lo firma una persona. Por eso
 * esta ventana no tiene un botón «arreglar», sólo el informe y el enlace a Recuento.
 *
 * El informe se calcula con `conciliar()`, la misma función pura que corre el job, así
 * que el día que el backend lo reporte de verdad la pantalla no cambia.
 */
export function ConciliacionCliente({ slug, inicial }: { slug: string; inicial: Conciliacion }) {
  const t = useTranslations('conciliacion')
  const [informe, setInforme] = useState(inicial)
  const [actualizando, setActualizando] = useState(false)

  async function actualizar() {
    setActualizando(true)
    try {
      setInforme(await getCliente().obtenerConciliacion(slug))
    } finally {
      setActualizando(false)
    }
  }

  const columnas = useMemo<Columna<DiferenciaConciliacion>[]>(
    () => [
      {
        id: 'sku',
        titulo: 'SKU',
        cuerpo: (d) => <span className="font-mono text-xs text-secundario">{d.sku}</span>,
      },
      { id: 'nombre', titulo: 'Producto', cuerpo: (d) => d.nombre },
      {
        id: 'deposito',
        titulo: 'Depósito',
        cuerpo: (d) => <span className="text-secundario">{d.depositoNombre}</span>,
      },
      { id: 'saldo', titulo: 'Saldo', alinear: 'derecha', cuerpo: (d) => formatearNumero.format(d.saldo) },
      { id: 'libro', titulo: 'Libro', alinear: 'derecha', cuerpo: (d) => formatearNumero.format(d.libro) },
      {
        id: 'diferencia',
        titulo: 'Diferencia',
        alinear: 'derecha',
        cuerpo: (d) => (
          <span className="font-medium tabular-nums text-peligro-tinta">
            {d.diferencia > 0 ? '+' : ''}
            {formatearNumero.format(d.diferencia)}
          </span>
        ),
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: () => (
          <Boton variante="fantasma" tamano="sm" href={`/e/${slug}/stock/recuento`}>
            {t('contar')}
          </Boton>
        ),
      },
    ],
    [slug],
  )

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={t('titulo')}
        descripcion={t('descripcion')}
        barra={
          <>
            <Insignia tono={informe.cuadra ? 'exito' : 'peligro'} conPunto>
              {informe.cuadra ? t('cuadra') : t('diferencias', { cantidad: informe.diferencias.length })}
            </Insignia>
            <span className="text-xs text-terciario">
              {t('resumen', {
                niveles: formatearNumero.format(informe.nivelesRevisados),
                fecha: formatearFechaHora(informe.ejecutadaEn),
              })}
            </span>
            <Boton variante="secundario" tamano="sm" onClick={() => void actualizar()} disabled={actualizando}>
              {actualizando ? t('actualizando') : t('volverACorrer')}
            </Boton>
          </>
        }
      />

      <DataTable<DiferenciaConciliacion>
        columnas={columnas}
        datos={informe.diferencias}
        cargando={false}
        error={null}
        tituloVacia={t('tituloVacia')}
        descripcionVacia={t('descripcionVacia')}
      />
    </div>
  )
}
