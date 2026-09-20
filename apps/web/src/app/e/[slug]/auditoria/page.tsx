import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { AuditoriaCliente } from './AuditoriaCliente'

export const metadata: Metadata = { title: 'Auditoría' }

/** Auditoría (F9). Server Component: primera página de eventos como `initialData`. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarAuditoria({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <AuditoriaCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
