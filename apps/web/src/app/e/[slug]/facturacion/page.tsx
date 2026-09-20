import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { FacturacionCliente } from './FacturacionCliente'

export const metadata: Metadata = { title: 'Facturación' }

/**
 * Facturación (F4).
 *
 * Server Component: resuelve la primera página de comprobantes con el cliente y la
 * hidrata en React Query como `initialData`. El estado de la vista vive en la URL (A12).
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()
  const inicial = await cliente.listarComprobantes({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <FacturacionCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
