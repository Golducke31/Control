import { redirect } from 'next/navigation'

import { sesionActual } from '@/sesion'
import { FormularioIngreso } from './FormularioIngreso'

/**
 * Pantalla de ingreso.
 *
 * Si ya hay sesión, no tiene sentido mostrarla: deriva a la raíz, que resuelve la empresa
 * por defecto. Si no, muestra el formulario. Vive fuera de la carcasa (`(publico)`), así que
 * no tiene barra lateral ni menú.
 */
export default async function PaginaIngreso() {
  const sesion = await sesionActual()
  if (sesion !== null) redirect('/')

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <FormularioIngreso />
    </main>
  )
}
