import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { VentasCliente } from './VentasCliente'

export const metadata: Metadata = { title: 'Ventas' }

/**
 * Ventas (F4).
 *
 * Server Component: resuelve la primera página de la cadena con el cliente y la
 * hidrata en React Query como `initialData`. El estado de la vista vive en la URL
 * (A12); recargar restaura filtros, página y orden.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()
  const inicial = await cliente.listarDocumentosVenta({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <VentasCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
