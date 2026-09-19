import type { Metadata } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'

// El orden importa: los tokens primero, y después los estilos de la aplicación, que
// ajustan la familia tipográfica con las que `next/font` sirve desde nuestro origen.
import '@control/tokens/tokens.css'
import '@/estilos/globals.css'

/**
 * Tipografía.
 *
 * `next/font` descarga las fuentes en el build y las **sirve desde nuestro propio
 * origen**: no hay una petición a un tercero en tiempo de ejecución, que es la
 * condición que el sistema de diseño exige para funcionar en una red restringida.
 * Además calcula las métricas de reserva, así que no hay salto de composición.
 */
const titulos = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--fuente-titulos',
  weight: ['500', '600', '700'],
})

const cuerpo = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--fuente-cuerpo',
  weight: ['400', '500', '600'],
})

export const metadata: Metadata = {
  title: {
    default: 'Control',
    template: '%s · Control',
  },
  description:
    'Plataforma de gestión comercial, stock, logística y facturación electrónica para empresas que operan en serio.',
}

export default function LayoutRaiz({ children }: { children: ReactNode }) {
  return (
    // El tema por defecto es el claro, con la carcasa violeta. El oscuro es una
    // variante: alcanza con `data-tema="oscuro"`, y no hay un segundo sistema.
    <html lang="es-AR" data-tema="claro" className={`${titulos.variable} ${cuerpo.variable}`}>
      <body>{children}</body>
    </html>
  )
}
