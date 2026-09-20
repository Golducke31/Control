import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { RecuentoCliente } from './RecuentoCliente'

export const metadata: Metadata = { title: 'Recuento' }

/**
 * Recuento (F5 · Stock).
 *
 * Trae **todos** los niveles y todos los depósitos, no una página: una planilla de
 * conteo es una lista acotada —el depósito que se está contando— y paginarla obligaría
 * a contar de a diez renglones. El filtro por depósito vive en la URL.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()

  const [niveles, depositos] = await Promise.all([
    cliente.listarNiveles({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
    cliente.listarDepositos({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  return (
    <Suspense>
      <RecuentoCliente slug={slug} niveles={niveles.items} depositos={depositos.items} />
    </Suspense>
  )
}
