import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { Carcasa } from '@/componentes/Carcasa'
import { empresaPorSlug } from '@/empresa'

/**
 * La carcasa de una empresa.
 *
 * La empresa se resuelve **en el servidor**, desde el `slug` de la URL, y si no existe
 * la respuesta es un 404 —no una pantalla vacía—. Es el mismo criterio que el resto del
 * sistema: el cliente no decide a qué empresa entra ni qué puede ver.
 *
 * En F2 esto además verifica la membresía del usuario y entrega sus permisos reales.
 */
export default async function LayoutDeEmpresa({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const empresa = empresaPorSlug(slug)

  if (empresa === undefined) notFound()

  return <Carcasa empresa={empresa}>{children}</Carcasa>
}
