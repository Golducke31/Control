import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { ContabilidadCliente } from './ContabilidadCliente'
import type { ResumenContable } from './ContabilidadCliente'

export const metadata: Metadata = { title: 'Contabilidad' }

/**
 * Contabilidad (F6).
 *
 * El resumen de partida doble se calcula sobre **todos** los asientos, no sobre la
 * página: es la comprobación que tiene que valer para el libro entero.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()

  const [inicial, todos] = await Promise.all([
    cliente.listarAsientos({ empresaSlug: slug, pagina: 1, porPagina: 10 }),
    cliente.listarAsientos({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  const debito = todos.items.reduce((suma, a) => suma + a.debito, 0)
  const credito = todos.items.reduce((suma, a) => suma + a.credito, 0)

  const resumen: ResumenContable = {
    asientos: todos.paginacion.total,
    debito,
    credito,
    partidaDoble: debito === credito,
  }

  return (
    <Suspense>
      <ContabilidadCliente slug={slug} initialData={inicial} resumen={resumen} />
    </Suspense>
  )
}
