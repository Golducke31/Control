import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { TransferenciasCliente } from './TransferenciasCliente'

export const metadata: Metadata = { title: 'Transferencias' }

/** Transferencias (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarTransferencias({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <TransferenciasCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
