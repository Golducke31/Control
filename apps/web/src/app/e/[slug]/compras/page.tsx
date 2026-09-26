import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { ComprasCliente } from './ComprasCliente'

export const metadata: Metadata = { title: 'Compras' }

/**
 * Compras (F6).
 *
 * Server Component: resuelve la primera página de órdenes y la pasa como
 * `initialData`. El estado de la vista vive en la URL (A12).
 */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarOrdenesCompra({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <ComprasCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
