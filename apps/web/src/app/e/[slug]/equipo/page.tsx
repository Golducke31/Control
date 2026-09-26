import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { EquipoCliente } from './EquipoCliente'

export const metadata: Metadata = { title: 'Equipo' }

/** Equipo (F9). Server Component: primera página de miembros como `initialData`. */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarMiembros({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <EquipoCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
