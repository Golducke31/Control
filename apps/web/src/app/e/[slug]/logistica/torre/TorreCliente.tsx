'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Envio, Paginacion } from '@control/contracts'
import { ordenarTablero } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useSuscripcion } from '@/componentes/ProveedorEnVivo'
import { TOPICO_TABLERO } from '@/datos/eventos'
import { formatearFechaHora } from '@/datos/formato'
import { ETIQUETA_ESTADO_ENVIO, TONO_ESTADO_ENVIO } from '../LogisticaCliente'

export interface ResumenDeTorre {
  activos: number
  enTransito: number
  incidencias: number
  entregados: number
}

function Indicador({ etiqueta, valor, alerta }: { etiqueta: string; valor: number; alerta?: boolean }) {
  return (
    <div className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
      <p className="text-xs text-terciario">{etiqueta}</p>
      <p
        className={
          alerta === true && valor > 0
            ? 'mt-1 text-2xl font-semibold tabular-nums text-peligro-tinta'
            : 'mt-1 text-2xl font-semibold tabular-nums text-principal'
        }
      >
        {valor}
      </p>
    </div>
  )
}

/**
 * Torre de control (F7) — el tablero en vivo.
 *
 * Es la ventana que justifica el canal: se suscribe al tópico `tablero` y, cuando llega
 * un evento, **invalida su consulta** en vez de escribir el estado a mano (§5.6). Así el
 * dato que se ve sigue viniendo de una sola fuente —TanStack Query— y el stream sólo
 * dice «esto cambió».
 *
 * La conexión **no** la abre esta ventana: la abre el proveedor de la carcasa, una vez
 * por pestaña, y la multiplexa. Esta ventana sólo dice qué tópico le interesa mientras
 * está montada. Con doscientos envíos en el tablero, sigue siendo una conexión.
 */
export function TorreCliente({
  slug,
  initialData,
  resumen,
}: {
  slug: string
  initialData: { items: Envio[]; paginacion: Paginacion }
  resumen: ResumenDeTorre
}) {
  const t = useTranslations('torre')
  const cliente = getCliente()
  const consultaCliente = useQueryClient()

  const consulta = useColeccion<Envio>({
    cliente,
    empresaSlug: slug,
    texto: '',
    pagina: 1,
    porPagina: 50,
    orden: null,
    queryKey: ['logistica-envios', slug],
    consultar: (c, p) => c.listarEnvios(p),
    initialData,
  })

  // La suscripción vive mientras la ventana está montada; al salir, el canal la suelta
  // y si era la última, la conexión se cierra.
  useSuscripcion('torre-de-control', [TOPICO_TABLERO], () => {
    void consultaCliente.invalidateQueries({ queryKey: ['logistica-envios', slug] })
  })

  const activos = useMemo(() => ordenarTablero(consulta.data?.items ?? []), [consulta.data])

  const columnas = useMemo<Columna<Envio>[]>(
    () => [
      {
        id: 'numero',
        titulo: 'Envío',
        cuerpo: (e) => <span className="font-mono text-xs text-secundario">{e.numero}</span>,
      },
      { id: 'cliente', titulo: 'Cliente', cuerpo: (e) => e.cliente },
      {
        id: 'destino',
        titulo: 'Destino',
        cuerpo: (e) => <span className="text-secundario">{e.localidadDestino}</span>,
      },
      {
        id: 'estado',
        titulo: 'Estado',
        cuerpo: (e) => (
          <Insignia tono={TONO_ESTADO_ENVIO[e.estado]} conPunto>
            {ETIQUETA_ESTADO_ENVIO[e.estado]}
          </Insignia>
        ),
      },
      {
        id: 'ventana',
        titulo: 'Ventana comprometida',
        alinear: 'derecha',
        cuerpo: (e) =>
          e.ventanaHasta === null ? (
            <span className="text-xs text-terciario">{t('sinVentana')}</span>
          ) : (
            <span className="text-secundario">{formatearFechaHora(e.ventanaHasta)}</span>
          ),
      },
      {
        id: 'paradas',
        titulo: 'Paradas',
        alinear: 'derecha',
        cuerpo: (e) => (
          <span className="tabular-nums text-secundario">
            {e.paradasCompletadas}/{e.paradas}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={t('titulo')}
        descripcion={t('descripcion')}
        barra={
          <>
            <span className="text-xs text-terciario">
              {t('resumen', { activos: activos.length, total: consulta.data?.paginacion.total ?? 0 })}
            </span>
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/logistica`}>
              {t('verTodos')}
            </Boton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador etiqueta={t('activos')} valor={resumen.activos} />
        <Indicador etiqueta={t('enTransito')} valor={resumen.enTransito} />
        <Indicador etiqueta={t('conIncidencia')} valor={resumen.incidencias} alerta />
        <Indicador etiqueta={t('entregados')} valor={resumen.entregados} />
      </div>

      <DataTable<Envio>
        columnas={columnas}
        datos={activos}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a la torre. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        tituloVacia={t('tituloVacia')}
        descripcionVacia={t('descripcionVacia')}
        caption="Envíos activos ordenados por urgencia"
      />
    </div>
  )
}
