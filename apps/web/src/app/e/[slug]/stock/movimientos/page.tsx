import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { MovimientosCliente } from './MovimientosCliente'

export const metadata: Metadata = { title: 'Movimientos' }

/**
 * Movimientos (F5 · Stock).
 *
 * El libro mayor se resuelve en el servidor y viaja como `initialData`. El nombre del
 * depósito no viene en el movimiento —el motor guarda el `warehouse_id`—, así que se
 * resuelve acá una vez y se pasa como mapa, en vez de pedirlo por fila.
 */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const cliente = getCliente()

  const [inicial, depositos] = await Promise.all([
    cliente.listarMovimientos({ empresaSlug: slug, ...parametrosDeLista(sp) }),
    cliente.listarDepositos({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  const nombres = Object.fromEntries(depositos.items.map((d) => [d.id, d.nombre]))

  return (
    <Suspense>
      <MovimientosCliente slug={slug} initialData={inicial} depositos={nombres} />
    </Suspense>
  )
}
