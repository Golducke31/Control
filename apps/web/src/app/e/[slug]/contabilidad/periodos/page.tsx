import { Suspense } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getCliente } from '@/datos/cliente'
import { resolverContexto, sesionActual } from '@/sesion'
import { PeriodosCliente } from './PeriodosCliente'

export const metadata: Metadata = { title: 'Períodos' }

/**
 * Períodos (F6 · Contabilidad).
 *
 * El autor del cierre sale de la sesión y no de una constante: cerrar un período
 * queda auditado con quién lo hizo, así que la pantalla tiene que firmar con el
 * usuario real. La resolución es la misma que usa la carcasa, para que el nombre que
 * se ve acá sea el de la sesión y no uno inventado.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  const sesion = await sesionActual()
  if (sesion === null) redirect('/ingresar')

  const resultado = resolverContexto(sesion, slug)
  if (!resultado.ok) notFound()

  const lista = await getCliente().listarPeriodos({ empresaSlug: slug, pagina: 1, porPagina: 500 })

  return (
    <Suspense>
      <PeriodosCliente slug={slug} inicial={lista.items} autor={resultado.contexto.usuario.nombre} />
    </Suspense>
  )
}
