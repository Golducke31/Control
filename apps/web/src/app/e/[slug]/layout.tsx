import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { Carcasa } from '@/componentes/Carcasa'
import { resolverContexto, sesionActual } from '@/sesion'

/**
 * La carcasa de una empresa.
 *
 * Todo se resuelve **en el servidor**, desde el `slug` de la URL:
 *
 * 1. Si no hay sesión válida → redirige al ingreso.
 * 2. Si hay sesión pero el usuario no es miembro de esta empresa → 404, no pantalla vacía.
 * 3. Si pasa, entrega el contexto (permisos de este usuario, empresas, impersonación) a la
 *    carcasa. El cliente no decide a qué empresa entra ni qué puede ver.
 *
 * El `slug` viene de la URL y se verifica contra la membresía; nunca se confía en algo que
 * el cliente envíe aparte de la cookie de sesión.
 */
export default async function LayoutDeEmpresa({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  const sesion = await sesionActual()
  if (sesion === null) redirect('/ingresar')

  const resultado = resolverContexto(sesion, slug)
  if (!resultado.ok) notFound()

  return <Carcasa contexto={resultado.contexto}>{children}</Carcasa>
}
