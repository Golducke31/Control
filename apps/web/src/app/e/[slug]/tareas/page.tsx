import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import type { SearchParams } from '@/datos/parametros'
import { parametrosDeLista } from '@/datos/parametros'
import { TareasCliente } from './TareasCliente'

export const metadata: Metadata = { title: 'Tareas programadas' }

/**
 * Tareas programadas (F9).
 *
 * El reloj con el que se calculan los atrasos se toma **acá**, una sola vez, y se pasa al
 * componente cliente como prop. Leerlo dentro del render del cliente daría un valor
 * distinto en el servidor y en el navegador, y las duraciones y los atrasos cambiarían
 * entre el HTML y la hidratación: es el desajuste clásico de una fecha en un componente
 * cliente.
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
  const ahoraMs = Date.now()
  const inicial = await getCliente().listarTrabajos({ empresaSlug: slug, ...parametrosDeLista(sp), ahoraMs })

  return (
    <Suspense>
      <TareasCliente slug={slug} initialData={inicial} ahoraMs={ahoraMs} />
    </Suspense>
  )
}
