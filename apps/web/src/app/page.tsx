import { redirect } from 'next/navigation'

import { empresaPorDefecto, sesionActual } from '@/sesion'

/**
 * La raíz no es una pantalla: es una decisión.
 *
 * Resuelve la sesión y deriva: sin sesión → ingreso; con sesión y al menos una empresa →
 * su empresa por defecto; con sesión pero sin empresas (p. ej. un usuario de plataforma) →
 * el selector de empresa, donde puede impersonar. El cliente nunca elige a qué empresa ir.
 */
export default async function Inicio() {
  const sesion = await sesionActual()
  if (sesion === null) redirect('/ingresar')

  const slug = empresaPorDefecto(sesion.sub)
  if (slug === null) redirect('/empresas')

  redirect(`/e/${slug}/panel`)
}
