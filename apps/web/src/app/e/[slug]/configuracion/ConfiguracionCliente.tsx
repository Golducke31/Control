'use client'

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { EncabezadoDeVentana, Boton, Insignia } from '@control/ui'
import { PALETAS_DE_INQUILINO, PLANTILLAS, plantillaPorClave, variablesDeTema } from '@control/tokens'
import type { PaletaDeInquilino } from '@control/tokens'

/**
 * Configuración · Identidad y plantillas (F8).
 *
 * Acá se ven las dos cláusulas de la puerta de F8 que son de esta ventana:
 *
 * 1. **Las 4 paletas y las 5 plantillas pasan AA.** La tabla de abajo no muestra una
 *    opinión sobre los colores: muestra la medición. Cada fila es una paleta con la
 *    tinta que el sistema derivó para ella y su relación de contraste. La tinta no está
 *    escrita en el componente —se deriva en `@control/tokens`—, y por eso la tabla no
 *    puede mentir: si un primario cambiara, el número cambiaría solo.
 *
 * 2. **Cambiar de plantilla no recarga.** Elegir otra plantilla recalcula
 *    `variablesDeTema` y las escribe en el `style` del panel de vista previa. No hay
 *    ninguna consulta, ninguna navegación y ningún `router.push` en el camino: es una
 *    función pura de (plantilla, paleta) a propiedades CSS. Por eso el cambio es
 *    instantáneo y no pierde el estado de la pantalla.
 *
 * La selección vive en estado de interfaz (§5.7), no en la URL: no es un filtro que
 * alguien quiera compartir, es una preferencia de quien está mirando.
 */
export function ConfiguracionCliente({ slug, paletaInicial }: { slug: string; paletaInicial: string }) {
  const t = useTranslations('configuracion')
  const tc = useTranslations('comun')
  const [claveDePaleta, setClaveDePaleta] = useState(paletaInicial)
  const [claveDePlantilla, setClaveDePlantilla] = useState('retail-glass')

  const paleta = PALETAS_DE_INQUILINO.find((p) => p.slug === claveDePaleta) ?? PALETAS_DE_INQUILINO[0]
  const plantilla = plantillaPorClave(claveDePlantilla) ?? PLANTILLAS[0]

  // Una sola llamada, pura: es todo lo que hace falta para aplicar un tema.
  const variables = paleta !== undefined && plantilla !== undefined ? variablesDeTema(plantilla, paleta) : {}

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={t('titulo')}
        descripcion={t('descripcion')}
        barra={
          <>
            <span className="text-xs text-terciario">
              {t('resumen', { plantillas: PLANTILLAS.length, paletas: PALETAS_DE_INQUILINO.length })}
            </span>
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/configuracion/plantillas`}>
              {t('verPlantillas')}
            </Boton>
          </>
        }
      />

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
        <h2 className="text-sm font-medium text-principal">{t('paletaDeLaEmpresa')}</h2>
        <p className="mt-1 text-xs text-secundario">
          {t.rich('tintaDerivada', {
            fuerte: (trozos) => <span className="text-principal">{trozos}</span>,
          })}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('contrasteMedido')}</caption>
            <thead>
              <tr className="border-b border-borde-control text-left text-xs text-terciario">
                <th scope="col" className="py-2 pr-4 font-medium">{tc('empresa')}</th>
                <th scope="col" className="py-2 pr-4 font-medium">{tc('primario')}</th>
                <th scope="col" className="py-2 pr-4 font-medium">{tc('tinta')}</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">{tc('contraste')}</th>
                <th scope="col" className="py-2 font-medium">AA</th>
              </tr>
            </thead>
            <tbody>
              {PALETAS_DE_INQUILINO.map((p) => (
                <FilaDePaleta key={p.slug} paleta={p} elegida={p.slug === claveDePaleta} alElegir={setClaveDePaleta} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5">
        <h2 className="text-sm font-medium text-principal">{t('plantillaPorRubro')}</h2>
        <p className="mt-1 text-xs text-secundario">{t('plantillaAyuda')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {PLANTILLAS.map((p) => (
            <Boton
              key={p.clave}
              variante={p.clave === claveDePlantilla ? 'primario' : 'secundario'}
              tamano="sm"
              onClick={() => setClaveDePlantilla(p.clave)}
            >
              {p.nombre}
            </Boton>
          ))}
        </div>
        {plantilla !== undefined && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Dato etiqueta={t('rubro')} valor={plantilla.rubro} />
            <Dato
              etiqueta={t('densidad')}
              valor={plantilla.densidad === 'compact' ? t('densidadCompacta') : t('densidadComoda')}
            />
            <Dato etiqueta={t('radio')} valor={`${plantilla.radio} px`} />
            <Dato
              etiqueta={t('barraLateral')}
              valor={plantilla.barraLateral === 'rail' ? t('barraRiel') : t('barraExpandida')}
            />
          </dl>
        )}
      </section>

      {paleta !== undefined && plantilla !== undefined && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-principal">{t('vistaPrevia')}</h2>
          {/*
            Las variables se escriben acá y todo lo de adentro las lee. Cambiar de
            plantilla o de paleta es recalcular este objeto: por eso no recarga.
          */}
          <div
            style={variables as React.CSSProperties}
            className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-5"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="rounded-[var(--control-radio)] px-4 py-2 text-sm font-medium"
                style={{ background: 'var(--control-primario)', color: 'var(--control-tinta-sobre-primario)' }}
              >
                {t('accionPrincipal')}
              </span>
              <span className="text-sm text-secundario">
                {plantilla.nombre} · {paleta.nombre}
              </span>
            </div>
            <p className="mt-3 font-mono text-[11px] text-terciario">
              {Object.entries(variables)
                .map(([clave, valor]) => `${clave}: ${valor}`)
                .join(' · ')}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}

function FilaDePaleta({
  paleta,
  elegida,
  alElegir,
}: {
  paleta: PaletaDeInquilino
  elegida: boolean
  alElegir: (slug: string) => void
}) {
  return (
    <tr className={elegida ? 'border-b border-borde-control bg-sutil' : 'border-b border-borde-control'}>
      <td className="py-2 pr-4">
        <button
          type="button"
          onClick={() => alElegir(paleta.slug)}
          className="rounded-[var(--control-radio-sm)] text-left text-principal hover:text-accion focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        >
          {paleta.nombre}
        </button>
      </td>
      <td className="py-2 pr-4">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-4 rounded-sm border border-borde-control" style={{ background: paleta.primario }} />
          <span className="font-mono text-xs text-secundario">{paleta.primario}</span>
        </span>
      </td>
      <td className="py-2 pr-4">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-4 rounded-sm border border-borde-control" style={{ background: paleta.tintaSobrePrimario }} />
          <span className="font-mono text-xs text-secundario">{paleta.tintaSobrePrimario}</span>
        </span>
      </td>
      <td className="py-2 pr-4 text-right tabular-nums text-principal">{paleta.relacionDeTinta.toFixed(2)}:1</td>
      <td className="py-2">
        <Insignia tono={paleta.conforme ? 'exito' : 'peligro'} conPunto>
          {paleta.conforme ? 'cumple' : 'no cumple'}
        </Insignia>
      </td>
    </tr>
  )
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <dt className="text-terciario">{etiqueta}</dt>
      <dd className="mt-0.5 text-principal">{valor}</dd>
    </div>
  )
}
