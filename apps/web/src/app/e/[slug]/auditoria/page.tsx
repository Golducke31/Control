import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { AuditoriaCliente } from './AuditoriaCliente'

export const metadata: Metadata = { title: 'Auditoría' }

/** Auditoría (F9). Server Component: primera página de eventos como `initialData`. */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarAuditoria({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <AuditoriaCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
