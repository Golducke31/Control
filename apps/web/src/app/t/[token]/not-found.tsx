import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

export const metadata: Metadata = {
  title: 'Envío no encontrado',
  robots: { index: false, follow: false },
}

/**
 * El 404 del seguimiento público.
 *
 * `notFound()` y no una pantalla propia con estado 200. La diferencia no es cosmética:
 * un `200` para un recurso que no existe le dice a un buscador —y a cualquier cliente
 * HTTP— que el código **es válido**, y eso convierte al link de seguimiento en algo que
 * se indexa y se cachea como si tuviera contenido.
 *
 * El mensaje **no repite el token**. No es sólo para no devolver lo que escribió quien
 * entró: un token de tracking es la única credencial del link, y no tiene por qué quedar
 * escrito en una pantalla que alguien puede fotografiar o compartir.
 */
export default async function NoEncontrado() {
  const t = await getTranslations('trackingNoEncontrado')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <h1 className="text-lg font-semibold text-principal">{t('titulo')}</h1>
      <p className="text-sm text-secundario">{t('descripcion')}</p>
    </main>
  )
}
