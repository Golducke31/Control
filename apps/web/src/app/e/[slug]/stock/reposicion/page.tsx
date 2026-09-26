import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { ReposicionCliente } from './ReposicionCliente'

export const metadata: Metadata = { title: 'Reposición' }

/** Reposición (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarReposicion({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <ReposicionCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
