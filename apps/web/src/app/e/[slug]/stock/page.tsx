import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { StockCliente } from './StockCliente'
import type { ResumenDeStock } from './StockCliente'

export const metadata: Metadata = { title: 'Stock' }

/**
 * Stock (F5).
 *
 * Server Component: resuelve la primera página de niveles y, por separado, el
 * resumen que alimenta los indicadores —que necesita la lista **completa**, no la
 * página visible—. La primera página viaja como `initialData` a React Query, así que
 * la pintura inicial no tiene cascada de peticiones (§5.3).
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()

  const [inicial, todos, depositos, reposicion] = await Promise.all([
    cliente.listarNiveles({ empresaSlug: slug, pagina: 1, porPagina: 10 }),
    cliente.listarNiveles({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
    cliente.listarDepositos({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
    cliente.listarReposicion({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  const resumen: ResumenDeStock = {
    niveles: todos.paginacion.total,
    unidades: todos.items.reduce((suma, n) => suma + n.cantidad, 0),
    reservadas: todos.items.reduce((suma, n) => suma + n.reservada, 0),
    depositos: depositos.paginacion.total,
    bajoMinimo: reposicion.paginacion.total,
  }

  return (
    <Suspense>
      <StockCliente slug={slug} initialData={inicial} resumen={resumen} />
    </Suspense>
  )
}
