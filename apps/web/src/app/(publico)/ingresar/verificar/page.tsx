import Link from 'next/link'

import { FormularioVerificacion } from './FormularioVerificacion'

/**
 * Pantalla de verificación en dos pasos.
 *
 * Toma el desafío firmado de la URL (lo dejó el paso de credenciales). Sin desafío no hay
 * nada que verificar: vuelve al ingreso.
 */
export default async function PaginaVerificar({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>
}) {
  const { d: desafio } = await searchParams

  if (desafio === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
        <div className="rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 text-center">
          <p className="text-principal">No hay una verificación en curso.</p>
          <Link href="/ingresar" className="mt-2 inline-block text-acento hover:underline">
            Volver al ingreso
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <FormularioVerificacion desafio={desafio} />
    </main>
  )
}
