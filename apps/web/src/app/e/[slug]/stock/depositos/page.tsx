import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { DepositosCliente } from './DepositosCliente'

export const metadata: Metadata = { title: 'Depósitos' }

/** Depósitos (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarDepositos({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <DepositosCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
