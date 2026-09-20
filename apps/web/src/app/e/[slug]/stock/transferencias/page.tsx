import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { TransferenciasCliente } from './TransferenciasCliente'

export const metadata: Metadata = { title: 'Transferencias' }

/** Transferencias (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarTransferencias({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <TransferenciasCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
