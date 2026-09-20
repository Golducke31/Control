import { Suspense } from 'react'
import type { Metadata } from 'next'
import { paletaInicial } from '@/datos/tema'
import { ConfiguracionCliente } from './ConfiguracionCliente'

export const metadata: Metadata = { title: 'Configuración' }

/**
 * Configuración (F8).
 *
 * El tema inicial sale de la empresa de la URL: la paleta es un dato del inquilino, así
 * que la ventana abre con la suya y no con una por defecto. No hay consulta de datos: las
 * paletas y las plantillas son del sistema de diseño, no del servidor.
 *
 * `paletaInicial` se importa de `@/datos/tema` y **no** de `./ConfiguracionCliente`: un
 * helper que el servidor llama no puede vivir en un módulo `'use client'`, porque desde
 * el servidor sería una referencia de cliente y no una función.
 */
export default async function Pagina({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  return (
    <Suspense>
      <ConfiguracionCliente slug={slug} paletaInicial={paletaInicial(slug)} />
    </Suspense>
  )
}
