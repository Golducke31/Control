import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { DepositosCliente } from './DepositosCliente'

export const metadata: Metadata = { title: 'Depósitos' }

/** Depósitos (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarDepositos({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <DepositosCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
