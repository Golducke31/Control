import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { EquipoCliente } from './EquipoCliente'

export const metadata: Metadata = { title: 'Equipo' }

/** Equipo (F9). Server Component: primera página de miembros como `initialData`. */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const inicial = await getCliente().listarMiembros({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <EquipoCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
