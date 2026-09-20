import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { TesoreriaCliente } from './TesoreriaCliente'
import type { ResumenDeTesoreria } from './TesoreriaCliente'

export const metadata: Metadata = { title: 'Tesorería' }

/**
 * Tesorería (F6).
 *
 * Los indicadores necesitan la lista **completa** de movimientos y de cuentas, así
 * que se resuelven acá —en el servidor— y no en el componente cliente, que sólo ve
 * la página visible. Un saldo que depende de la página no es un saldo.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const cliente = getCliente()

  const [inicial, todos, cuentas] = await Promise.all([
    cliente.listarMovimientosTesoreria({ empresaSlug: slug, pagina: 1, porPagina: 10 }),
    cliente.listarMovimientosTesoreria({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
    cliente.listarCuentasTesoreria({ empresaSlug: slug, pagina: 1, porPagina: 500 }),
  ])

  const resumen: ResumenDeTesoreria = {
    // Sólo las cuentas en pesos: sumar dólares sin tipo de cambio sería un número falso.
    saldoArs: cuentas.items.filter((c) => c.moneda === 'ARS').reduce((suma, c) => suma + c.saldo, 0),
    cuentas: cuentas.paginacion.total,
    sinConciliar: todos.items.filter((m) => !m.conciliado).length,
  }

  return (
    <Suspense>
      <TesoreriaCliente slug={slug} initialData={inicial} resumen={resumen} />
    </Suspense>
  )
}
