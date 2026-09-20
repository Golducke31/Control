import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { ComprasCliente } from './ComprasCliente'

export const metadata: Metadata = { title: 'Compras' }

/**
 * Compras (F6).
 *
 * Server Component: resuelve la primera página de órdenes y la pasa como
 * `initialData`. El estado de la vista vive en la URL (A12).
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarOrdenesCompra({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <ComprasCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
