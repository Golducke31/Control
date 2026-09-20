'use client'

import { useMemo } from 'react'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Orden, Paginacion, Transferencia } from '@control/contracts'
import { accionesTransferencia, ETIQUETA_ESTADO_TRANSFERENCIA, unidadesDeTransferencia } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { useColeccion } from '@/datos/useColeccion'
import { useUrlState } from '@/datos/useUrlState'
import { formatearFechaHora, formatearNumero } from '@/datos/formato'

const TONO_ESTADO: Record<Transferencia['estado'], 'neutro' | 'atencion' | 'exito' | 'peligro'> = {
  draft: 'neutro',
  dispatched: 'atencion',
  received: 'exito',
  cancelled: 'peligro',
}

/**
 * Transferencias (F5 · Stock) — el listado.
 *
 * Las acciones de cada fila **no** se deciden acá: salen de `accionesTransferencia`,
 * la misma función que usa el detalle y que prueba la suite. Y el enlace al detalle es
 * donde vive el bloqueo optimista: en el listado no se escribe.
 */
export function TransferenciasCliente({
  slug,
  initialData,
}: {
  slug: string
  initialData: { items: Transferencia[]; paginacion: Paginacion }
}) {
  const { texto, pagina, porPagina, orden, setEstado, filtroActivo } = useUrlState()
  const cliente = getCliente()

  const consulta = useColeccion<Transferencia>({
    cliente,
    empresaSlug: slug,
    texto,
    pagina,
    porPagina,
    orden,
    queryKey: ['stock-transferencias', slug],
    consultar: (c, p) => c.listarTransferencias(p),
    initialData,
  })

  const columnas = useMemo<Columna<Transferencia>[]>(
    () => [
      {
        id: 'codigo',
        titulo: 'Código',
        campoOrden: 'codigo',
        ordenable: true,
        cuerpo: (t) => <span className="font-mono text-xs text-secundario">{t.codigo}</span>,
      },
      {
        id: 'recorrido',
        titulo: 'Recorrido',
        cuerpo: (t) => (
          <span className="text-secundario">
            {t.desdeNombre} <span className="text-terciario">→</span> {t.hastaNombre}
          </span>
        ),
      },
      {
        id: 'estado',
        titulo: 'Estado',
        campoOrden: 'estado',
        ordenable: true,
        cuerpo: (t) => (
          <Insignia tono={TONO_ESTADO[t.estado]} conPunto>
            {ETIQUETA_ESTADO_TRANSFERENCIA[t.estado]}
          </Insignia>
        ),
      },
      {
        id: 'unidades',
        titulo: 'Unidades',
        alinear: 'derecha',
        campoOrden: 'unidades',
        ordenable: true,
        cuerpo: (t) => formatearNumero.format(unidadesDeTransferencia(t.items)),
      },
      {
        id: 'actualizada',
        titulo: 'Última edición',
        alinear: 'derecha',
        cuerpo: (t) => <span className="text-secundario">{formatearFechaHora(t.actualizadaEn)}</span>,
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: (t) => {
          const pendientes = accionesTransferencia(t.estado)
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <Boton
                variante="fantasma"
                tamano="sm"
                href={`/e/${slug}/stock/transferencias/${t.id}`}
              >
                Abrir
              </Boton>
              <span className="text-xs text-terciario">
                {pendientes.length === 0 ? 'sin acciones' : `${pendientes.length} disponible(s)`}
              </span>
            </div>
          )
        },
      },
    ],
    [slug],
  )

  const alOrdenar = (campo: string) => {
    const dir: Orden['dir'] = orden?.campo === campo && orden.dir === 'asc' ? 'desc' : 'asc'
    setEstado({ orden: { campo, dir }, pagina: 1 })
  }

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Transferencias"
        descripcion="Mercadería que se mueve entre depósitos. Al despachar sale del origen; al recibir entra al destino, con lo efectivamente recibido."
        barra={
          <>
            <input
              type="search"
              value={texto}
              onChange={(e) => setEstado({ texto: e.target.value, pagina: 1 })}
              placeholder="Buscar por código, depósito o estado…"
              aria-label="Buscar transferencias"
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

      <DataTable<Transferencia>
        columnas={columnas}
        datos={consulta.data?.items ?? []}
        cargando={consulta.isLoading}
        error={consulta.isError ? 'No se pudo contactar a Transferencias. Reintentá en unos segundos.' : null}
        alReintentar={() => consulta.refetch()}
        orden={orden}
        alOrdenar={alOrdenar}
        paginacion={consulta.data?.paginacion ?? null}
        alPaginar={(p) => setEstado({ pagina: p })}
        filtroActivo={filtroActivo}
        tituloVacia="No hay transferencias"
        descripcionVacia="Cuando muevas mercadería entre depósitos, la transferencia aparecerá acá."
      />
    </div>
  )
}
