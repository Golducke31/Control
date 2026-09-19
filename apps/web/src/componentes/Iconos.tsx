import type { ReactNode } from 'react'

import type { NombreDeIcono } from '@/rutas'

/**
 * Iconos de la aplicación.
 *
 * Set propio de 24×24 con trazo de 1,75, en vez de una fuente de iconos: una fuente
 * completa pesa más que los catorce trazados que se usan, y no se puede ajustar el
 * grosor por contexto.
 *
 * Todos son decorativos por defecto: el icono nunca es el único portador de
 * significado, siempre va acompañado de texto o de un `aria-label` en el contenedor.
 */
const ICONOS: Record<NombreDeIcono, ReactNode> = {
  panel: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  ventas: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 4 4 5-6" />
    </>
  ),
  facturacion: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h4" />
    </>
  ),
  catalogo: (
    <>
      <path d="m21 8-9-5-9 5 9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </>
  ),
  stock: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  compras: (
    <>
      <path d="M2 3h3l2.6 11.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6" />
      <circle cx="9.5" cy="20" r="1.5" />
      <circle cx="17.5" cy="20" r="1.5" />
    </>
  ),
  tesoreria: (
    <>
      <path d="M3 7h18v12H3z" />
      <path d="M3 7l3-4h12l3 4" />
      <circle cx="12" cy="13" r="2.5" />
    </>
  ),
  contabilidad: (
    <>
      <path d="M4 3h16v18H4z" />
      <path d="M8 7h8M8 11h3M8 15h3M14 11h2M14 15h2" />
    </>
  ),
  fiscal: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01" />
    </>
  ),
  logistica: (
    <>
      <path d="M3 18V7a1 1 0 0 1 1-1h10v12" />
      <path d="M14 10h4l3 4v4h-3" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  equipo: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </>
  ),
  configuracion: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  auditoria: (
    <>
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  tareas: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
}

export interface PropsDeIcono {
  nombre: NombreDeIcono
  tamano?: number
  className?: string
}

export function Icono({ nombre, tamano = 18, className }: PropsDeIcono) {
  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {ICONOS[nombre]}
    </svg>
  )
}
