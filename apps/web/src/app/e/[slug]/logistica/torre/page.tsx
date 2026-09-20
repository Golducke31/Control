import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { TorreCliente } from './TorreCliente'
import type { ResumenDeTorre } from './TorreCliente'

export const metadata: Metadata = { title: 'Torre de control' }

/**
 * Torre de control (F7).
 *
 * El resumen se calcula sobre **todos** los envíos, no sobre la página del tablero: un
 * contador de incidencias que depende de la página visible no cuenta incidencias.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()

  const [inicial, todos] = await Promise.all([
    cliente.listarEnvios({ empresaSlug: slug, pagina: 1, porPagina: 50 }),
    cliente.listarEnvios({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  const resumen: ResumenDeTorre = {
    activos: todos.items.filter((e) => e.estado !== 'delivered' && e.estado !== 'cancelled').length,
    enTransito: todos.items.filter((e) => e.estado === 'in_transit' || e.estado === 'out_for_delivery').length,
    incidencias: todos.items.filter((e) => e.estado === 'incident').length,
    entregados: todos.items.filter((e) => e.estado === 'delivered').length,
  }

  return (
    <Suspense>
      <TorreCliente slug={slug} initialData={inicial} resumen={resumen} />
    </Suspense>
  )
}
