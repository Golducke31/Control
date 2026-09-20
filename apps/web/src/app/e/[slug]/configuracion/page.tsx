import { Suspense } from 'react'
import type { Metadata } from 'next'
import { ConfiguracionCliente, temaInicial } from './ConfiguracionCliente'

export const metadata: Metadata = { title: 'Configuración' }

/**
 * Configuración (F8).
 *
 * El tema inicial sale de la empresa de la URL: la paleta es un dato del inquilino, así
 * que la ventana abre con la suya y no con una por defecto. No hay consulta de datos:
 * las paletas y las plantillas son del sistema de diseño, no del servidor.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const { paleta } = temaInicial(slug)

  return (
    <Suspense>
      <ConfiguracionCliente slug={slug} paletaInicial={paleta} />
    </Suspense>
  )
}
