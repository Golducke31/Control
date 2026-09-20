import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { PanelCliente } from './PanelCliente'

export const metadata: Metadata = { title: 'Panel' }

/**
 * Panel (F4).
 *
 * Server Component: resuelve el resumen con el cliente y lo hidrata en React Query
 * como `initialData`. El cliente simulado es en proceso; con el backend, `getCliente()`
 * devuelve la implementación real y nada cambia.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()
  const inicial = await cliente.obtenerPanelResumen(slug)

  return (
    <Suspense>
      <PanelCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
