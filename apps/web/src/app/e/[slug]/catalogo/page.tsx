import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { CatalogoCliente } from './CatalogoCliente'

export const metadata: Metadata = { title: 'Catálogo' }

/**
 * Catálogo (F3).
 *
 * Server Component: resuelve los datos iniciales con el cliente y los hidrata en
 * React Query como `initialData`, así la primera pintura no tiene cascada de
 * peticiones (§5.3). El estado de la vista (filtros, página, orden) vive en la URL
 * y lo maneja el cliente, de modo que recargar restaura la vista exacta (A12).
 *
 * El cliente simulado es en proceso en F3; con el backend, `getCliente()` devuelve
 * la implementación real y nada de esto cambia.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()
  const inicial = await cliente.listarProductos({ empresaSlug: slug, pagina: 1, porPagina: 10 })

  return (
    <Suspense>
      <CatalogoCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
