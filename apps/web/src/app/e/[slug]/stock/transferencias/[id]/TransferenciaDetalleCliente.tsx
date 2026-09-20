'use client'

import { useMemo, useState } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { AccionTransferencia, ItemTransferencia, Transferencia } from '@control/contracts'
import {
  accionesTransferencia,
  ETIQUETA_ESTADO_TRANSFERENCIA,
  ETIQUETA_TRANSFERENCIA,
  unidadesDeTransferencia,
} from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { formatearFechaHora, formatearNumero } from '@/datos/formato'

const TONO_ESTADO: Record<Transferencia['estado'], 'neutro' | 'atencion' | 'exito' | 'peligro'> = {
  draft: 'neutro',
  dispatched: 'atencion',
  received: 'exito',
  cancelled: 'peligro',
}

type Aviso =
  | { clase: 'ok'; texto: string }
  | { clase: 'conflicto'; texto: string; versionActual: string }
  | { clase: 'error'; texto: string }

/**
 * Detalle de la transferencia (F5 · Stock) — donde se ve el **bloqueo optimista**.
 *
 * La pantalla guarda la versión que leyó (`versionEnPantalla`) y la manda en cada
 * escritura. Es lo que hace un navegador con una pestaña abierta hace rato: escribe
 * contra lo que vio, no contra lo que hay.
 *
 * Después de una escritura exitosa la versión en pantalla **no** se actualiza a
 * propósito. Así el mecanismo queda a la vista en una sola pestaña: la segunda acción
 * se rechaza con el conflicto, en vez de pisar en silencio el cambio que ya ocurrió.
 * El botón «Sincronizar versión» es el equivalente a recargar la pantalla.
 *
 * Nada de esto decide la regla: la decisión está en `aplicarTransferencia`, que la
 * suite prueba en negativo. Acá sólo se muestra el resultado.
 */
export function TransferenciaDetalleCliente({
  slug,
  inicial,
}: {
  slug: string
  inicial: Transferencia
}) {
  const [transferencia, setTransferencia] = useState(inicial)
  const [versionEnPantalla, setVersionEnPantalla] = useState(inicial.actualizadaEn)
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [enviando, setEnviando] = useState(false)

  const desincronizada = versionEnPantalla !== transferencia.actualizadaEn

  const columnas = useMemo<Columna<ItemTransferencia>[]>(
    () => [
      {
        id: 'sku',
        titulo: 'SKU',
        cuerpo: (i) => <span className="font-mono text-xs text-secundario">{i.sku}</span>,
      },
      { id: 'nombre', titulo: 'Producto', cuerpo: (i) => i.nombre },
      {
        id: 'enviada',
        titulo: 'Enviada',
        alinear: 'derecha',
        cuerpo: (i) => formatearNumero.format(i.cantidadEnviada),
      },
      {
        id: 'recibida',
        titulo: 'Recibida',
        alinear: 'derecha',
        cuerpo: (i) =>
          i.cantidadRecibida === null ? (
            <span className="text-xs text-terciario">sin recibir</span>
          ) : (
            formatearNumero.format(i.cantidadRecibida)
          ),
      },
      {
        id: 'merma',
        titulo: 'Merma',
        alinear: 'derecha',
        cuerpo: (i) => {
          if (i.cantidadRecibida === null) return <span className="text-xs text-terciario">—</span>
          const merma = i.cantidadEnviada - i.cantidadRecibida
          return merma === 0 ? (
            <span className="text-secundario">0</span>
          ) : (
            <span className="tabular-nums text-peligro">{formatearNumero.format(merma)}</span>
          )
        },
      },
    ],
    [],
  )

  async function ejecutar(accion: AccionTransferencia) {
    setEnviando(true)
    setAviso(null)
    try {
      const resultado = await getCliente().confirmarTransferencia({
        empresaSlug: slug,
        id: transferencia.id,
        accion,
        versionEsperada: versionEnPantalla,
      })

      if (resultado.ok) {
        setTransferencia(resultado.transferencia)
        // A propósito NO se sincroniza `versionEnPantalla`: así se ve el conflicto.
        setAviso({
          clase: 'ok',
          texto: `${ETIQUETA_TRANSFERENCIA[accion]}: hecho. La versión que tenés en pantalla quedó vieja; probá otra acción para ver el bloqueo optimista, o sincronizala.`,
        })
      } else if (resultado.motivo === 'conflicto_de_version') {
        setAviso({
          clase: 'conflicto',
          texto: 'Alguien más modificó esta transferencia desde que la abriste. No se pisó nada.',
          versionActual: resultado.versionActual,
        })
      } else {
        setAviso({ clase: 'error', texto: `No se puede ${ETIQUETA_TRANSFERENCIA[accion].toLowerCase()}: ${resultado.motivo}.` })
      }
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={`Transferencia ${transferencia.codigo}`}
        descripcion={`${transferencia.desdeNombre} → ${transferencia.hastaNombre}. Última edición: ${formatearFechaHora(transferencia.actualizadaEn)}.`}
        barra={
          <>
            <Insignia tono={TONO_ESTADO[transferencia.estado]} conPunto>
              {ETIQUETA_ESTADO_TRANSFERENCIA[transferencia.estado]}
            </Insignia>
            <span className="text-xs text-terciario">
              {formatearNumero.format(unidadesDeTransferencia(transferencia.items))} unidades
            </span>
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/stock/transferencias`}>
              Volver al listado
            </Boton>
          </>
        }
      />

      <section className="rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-principal">Acciones</h2>
            <p className="mt-0.5 text-xs text-secundario">
              Se escriben contra la versión que esta pantalla leyó
              {desincronizada ? ' — y está desincronizada a propósito.' : '.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {accionesTransferencia(transferencia.estado).map((accion) => (
              <Boton
                key={accion}
                variante={accion === 'cancelar' ? 'secundario' : 'primario'}
                tamano="sm"
                onClick={() => void ejecutar(accion)}
                disabled={enviando}
              >
                {ETIQUETA_TRANSFERENCIA[accion]}
              </Boton>
            ))}
            {accionesTransferencia(transferencia.estado).length === 0 && (
              <span className="text-xs text-terciario">La transferencia está cerrada: no ofrece transiciones.</span>
            )}
            <Boton
              variante="fantasma"
              tamano="sm"
              onClick={() => {
                setVersionEnPantalla(transferencia.actualizadaEn)
                setAviso(null)
              }}
              disabled={!desincronizada}
            >
              Sincronizar versión
            </Boton>
          </div>
        </div>

        <p className="mt-3 font-mono text-[11px] text-terciario">
          versión en pantalla: {versionEnPantalla}
          {desincronizada ? ` · vigente: ${transferencia.actualizadaEn}` : ' · al día'}
        </p>

        {aviso !== null && (
          <p
            className={
              aviso.clase === 'ok'
                ? 'mt-3 rounded-[var(--control-radio)] bg-exito-suave px-3 py-2 text-sm text-exito'
                : aviso.clase === 'conflicto'
                  ? 'mt-3 rounded-[var(--control-radio)] bg-peligro-suave px-3 py-2 text-sm text-peligro'
                  : 'mt-3 rounded-[var(--control-radio)] bg-sutil px-3 py-2 text-sm text-secundario'
            }
          >
            {aviso.texto}
            {aviso.clase === 'conflicto' && (
              <span className="ml-1 font-mono text-[11px]">(versión vigente: {aviso.versionActual})</span>
            )}
          </p>
        )}
      </section>

      <DataTable<ItemTransferencia>
        columnas={columnas}
        datos={transferencia.items}
        cargando={false}
        error={null}
        tituloVacia="La transferencia no tiene renglones"
        descripcionVacia="Una transferencia sin renglones no mueve stock."
      />

      {transferencia.notas !== undefined && (
        <p className="text-sm text-secundario">
          <span className="text-terciario">Notas: </span>
          {transferencia.notas}
        </p>
      )}
    </div>
  )
}
