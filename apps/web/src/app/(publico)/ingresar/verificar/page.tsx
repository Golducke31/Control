import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

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
  const t = await getTranslations('verificar')
  const tc = await getTranslations('comun')

  if (desafio === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
        <div className="rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 text-center">
          <p className="text-principal">{t('sinDesafio')}</p>
          <Link href="/ingresar" className="mt-2 inline-block text-acento hover:underline">
            {tc('volverAlIngreso')}
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
