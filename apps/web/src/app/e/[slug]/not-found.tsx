import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

/**
 * El 404 de una ventana (F9).
 *
 * Es el que responde cuando alguien pide una empresa de la que no es miembro, un envío
 * que no existe, o una ruta que no está en el mapa. La carcasa ya no está disponible en
 * este punto —`notFound()` corta el render del segmento—, así que la página ofrece la
 * salida mínima: volver a elegir empresa.
 *
 * **No dice qué pasó.** «No existe» y «no soy miembro» tienen la misma respuesta a
 * propósito: distinguirlas dejaría averiguar qué empresas existen probando slugs.
 */
export default async function NoEncontrado() {
  const t = await getTranslations('noEncontrado')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold text-principal">{t('titulo')}</h1>
      <p className="max-w-md text-sm text-secundario">{t('descripcion')}</p>
      <Link
        href="/empresas"
        className="rounded-[var(--control-radio)] bg-accion px-4 py-2 text-sm font-medium text-sobre-accion focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
      >
        {t('elegirEmpresa')}
      </Link>
    </main>
  )
}
