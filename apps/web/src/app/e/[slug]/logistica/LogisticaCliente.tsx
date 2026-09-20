'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Envio, Orden, Paginacion } from '@control/contracts'
import { ETIQUETA_ACCION_ENVIO, accionesEnvio } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'

export const ETIQUETA_ESTADO_ENVIO: Record<Envio['estado'], string> = {
  draft: 'borrador',
  preparing: 'en preparación',
  ready: 'listo',
  in_transit: 'en tránsito',
  out_for_delivery: 'en reparto',
  delivered: 'entregado',
  incident: 'con incidencia',
  cancelled: 'cancelado',
}

export const TONO_ESTADO_ENVIO: Record<
  Envio['estado'],
  'neutro' | 'atencion' | 'informacion' | 'accion' | 'exito' | 'peligro'
> = {
  draft: 'neutro',
  preparing: 'informacion',
  ready: 'accion',
  in_transit: 'informacion',
  out_for_delivery: 'accion',
  delivered: 'exito',
  incident: 'peligro',
  cancelled: 'neutro',
}

const ETIQUETA_PRIORIDAD: Record<number, string> = {
  1: 'urgente',
  2: 'alta',
  3: 'media',
  4: 'baja',
  5: 'muy baja',
}

/**
 * Logística (F7) — el tablero de envíos.
 *
 * Cada fila ofrece **sólo** las transiciones que su estado habilita, y las pide a
 * `accionesEnvio` en vez de decidirlas: la misma función que prueba la suite. Una
 * ventana que arma su propia lista de botones se desincroniza de la máquina de estados
 * en el primer cambio.
 *
 * El tablero operativo deja afuera lo entregado y lo cancelado, como el índice parcial
 * `idx_sh_active_board` del motor. La vista en vivo, con el canal SSE, está en la torre.
 */
export function LogisticaCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Envio[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Envio>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['logistica-envios', slug],
    consultar: (c, p) => c.listarEnvios(p),
    initialData,
  })

  const columnas = useMemo<Columna<Envio>[]>(
    () => [
      {
        id: 'numero',
        titulo: 'Envío',
        campoOrden: 'numero',
        ordenable: true,
        cuerpo: (e) => <span className="font-mono text-xs text-secundario">{e.numero}</span>,
      },
      { id: 'cliente', titulo: 'Cliente', campoOrden: 'cliente', ordenable: true, cuerpo: (e) => e.cliente },
      {
        id: 'destino',
        titulo: 'Destino',
        campoOrden: 'localidadDestino',
        ordenable: true,
        cuerpo: (e) => <span className="text-secundario">{e.localidadDestino}</span>,
      },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (e) => (
          <Insignia tono={TONO_ESTADO_ENVIO[e.estado]} conPunto>
            {ETIQUETA_ESTADO_ENVIO[e.estado]}
          </Insignia>
        ),
      },
      {
        id: 'prioridad',
        titulo: 'Prioridad',
        alinear: 'derecha',
        campoOrden: 'prioridad',
        ordenable: true,
        cuerpo: (e) => <span className="text-secundario">{ETIQUETA_PRIORIDAD[e.prioridad] ?? e.prioridad}</span>,
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
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: (e) => {
          const acciones = accionesEnvio(e)
          if (acciones.length === 0) {
            return <span className="text-xs text-terciario">—</span>
          }
          return (
            <div className="flex flex-wrap gap-1.5">
              {acciones.map((accion) => (
                <Boton key={accion} variante="fantasma" tamano="sm" onClick={() => undefined}>
                  {ETIQUETA_ACCION_ENVIO[accion]}
                </Boton>
              ))}
            </div>
          )
        },
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
        titulo="Logística"
        descripcion="El tablero de envíos: en preparación, en tránsito, en reparto y las incidencias. Cada envío ofrece sólo las transiciones que su estado habilita."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por número, cliente o destino…"
              aria-label="Buscar envíos"
              className="h-9 min-w-64 flex-1 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-3 text-sm text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            />
            {filtroActivo && (
              <Boton variante="fantasma" tamano="sm" onClick={() => setEstado({ texto: '', orden: null, pagina: 1 })}>
                Limpiar
              </Boton>
            )}
            <Boton variante="secundario" tamano="sm" href={`/e/${slug}/logistica/torre`}>
              Torre de control
            </Boton>
          </>
        }
      />

      <DataTable<Envio>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Logística. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay envíos"
        descripcionVacia="Cuando despaches mercadería a un cliente, el envío aparecerá acá con su seguimiento."
      />
    </div>
  )
}
