'use client'

import { useQuery } from '@tanstack/react-query'
import { EncabezadoDeVentana, Tarjeta, Insignia, Esqueleto, EstadoVacio } from '@control/ui'
import type { PanelResumen } from '@control/contracts'
import { getCliente } from '@/datos/cliente'

const formatear = (valor: number, moneda: 'ARS' | 'USD' | null) =>
  moneda
    ? new Intl.NumberFormat('es-AR', { style: 'currency', currency: moneda, maximumFractionDigits: 0 }).format(valor)
    : String(valor)

const TONO_TENDENCIA = {
  sube: 'exito',
  baja: 'peligro',
  plana: 'informacion',
} as const

/**
 * Panel de operación diaria (F4).
 *
 * No es una colección: es un objeto único (`PanelResumen`) que la barra de acciones
 * no pagina. `useQuery` lo cachea por empresa; el Server Component lo hidrata como
 * `initialData` para la primera pintura sin cascada.
 */
export function PanelCliente({ slug, initialData }: { slug: string; initialData?: PanelResumen | undefined }) {
  const cliente = getCliente()
  const consulta = useQuery({
    queryKey: ['panel', slug],
    queryFn: () => cliente.obtenerPanelResumen(slug),
    initialData,
  })
  const resumen = consulta.data

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Panel"
        descripcion="Indicadores del período. La cadena completa de documentos se opera desde Ventas y Facturación."
      />

      {consulta.isLoading && !resumen ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy>
          {Array.from({ length: 4 }).map((_, i) => (
            <Tarjeta key={i} relleno="ninguno" className="p-5">
              <Esqueleto filas={2} alto="texto" />
            </Tarjeta>
          ))}
        </div>
      ) : consulta.isError ? (
        <EstadoVacio titulo="No se pudo cargar el panel" descripcion="Reintentá en unos segundos." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {resumen?.kpis.map((k) => (
            <Tarjeta key={k.id} relleno="ninguno" className="p-5">
              <p className="text-sm text-secundario">{k.etiqueta}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-principal">
                {formatear(k.valor, k.moneda)}
              </p>
              {k.tendencia && (
                <Insignia tono={TONO_TENDENCIA[k.tendencia]} conPunto className="mt-3">
                  {k.tendencia}
                </Insignia>
              )}
            </Tarjeta>
          ))}
        </div>
      )}
    </div>
  )
}
