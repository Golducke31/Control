import { Suspense } from 'react'
import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { FiscalCliente } from './FiscalCliente'

export const metadata: Metadata = { title: 'Fiscal' }

/** El período que se muestra por defecto: el mes en curso, en formato `YYYY-MM`. */
function periodoActual(): string {
  return new Date().toISOString().slice(0, 7)
}

/**
 * Fiscal (F6).
 *
 * Server Component: resuelve la determinación de IVA del período en curso y la pasa
 * ya calculada. La sub-ruta `determinacion` es la que permitirá elegir otro período;
 * acá se muestra el que corresponde por defecto.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const periodo = periodoActual()
  const inicial = await getCliente().obtenerDeterminacionIva(slug, periodo)

  return (
    <Suspense>
      <FiscalCliente slug={slug} periodo={periodo} inicial={inicial} />
    </Suspense>
  )
}
