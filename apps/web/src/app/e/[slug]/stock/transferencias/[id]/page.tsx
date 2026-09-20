import { Suspense } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getCliente } from '@/datos/cliente'
import { TransferenciaDetalleCliente } from './TransferenciaDetalleCliente'

export const metadata: Metadata = { title: 'Detalle de la transferencia' }

/**
 * Detalle de la transferencia (F5 · Stock).
 *
 * El Server Component resuelve la transferencia y la pasa entera: la pantalla necesita
 * su `actualizadaEn` —la marca del bloqueo optimista— y no sólo su contenido. Un id
 * que no existe es un 404, no una pantalla vacía.
 */
export default async function Pagina({
  params,
}: {
  params: Promise<{ slug: string; id: string }>
}) {
  const { slug, id } = await params
  const lista = await getCliente().listarTransferencias({ empresaSlug: slug, pagina: 1, porPagina: 500 })
  const transferencia = lista.items.find((t) => t.id === id)

  if (transferencia === undefined) notFound()

  return (
    <Suspense>
      <TransferenciaDetalleCliente slug={slug} inicial={transferencia} />
    </Suspense>
  )
}
