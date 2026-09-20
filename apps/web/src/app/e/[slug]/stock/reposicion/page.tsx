import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { ReposicionCliente } from './ReposicionCliente'

export const metadata: Metadata = { title: 'Reposición' }

/** Reposición (F5 · Stock). Server Component: primera página como `initialData`. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarReposicion({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <ReposicionCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
