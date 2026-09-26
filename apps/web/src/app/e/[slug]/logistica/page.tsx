import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { LogisticaCliente } from './LogisticaCliente'

export const metadata: Metadata = { title: 'Logística' }

/**
 * Logística (F7).
 *
 * Server Component: resuelve la primera página de envíos y la pasa como `initialData`.
 * La ventana está detrás de la bandera `logistics.enabled` de la empresa, así que una
 * empresa sin transporte no la ve en el menú ni la alcanza por URL.
 */
export default async function Pagina({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<SearchParams>
}) {
  const { slug } = await params
  const sp = await searchParams
  const inicial = await getCliente().listarEnvios({ empresaSlug: slug, ...parametrosDeLista(sp) })

  return (
    <Suspense>
      <LogisticaCliente slug={slug} initialData={inicial} />
    </Suspense>
  )
}
