import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { ConciliacionCliente } from './ConciliacionCliente'

export const metadata: Metadata = { title: 'Conciliación' }

/** Conciliación (F5 · Stock). Server Component: el informe entra ya resuelto. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().obtenerConciliacion(slug)

  return (
    <Suspense>
      <ConciliacionCliente slug={slug} inicial={inicial} />
    </Suspense>
  )
}
