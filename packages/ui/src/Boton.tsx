import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react'

import { cn } from './cn'

export type VarianteDeBoton = 'primario' | 'secundario' | 'fantasma' | 'peligro'
export type TamanoDeBoton = 'sm' | 'md' | 'lg'

/**
 * Rellenos e tintas por variante.
 *
 * Todos los pares de esta tabla están verificados por la suite de contraste de
 * `@control/tokens`: el relleno del botón primario es el naranja de marca con la
 * tinta violeta profunda encima (5,73:1), porque el blanco sobre ese naranja sólo
 * alcanza 3,32:1 y sirve únicamente para titulares.
 */
const VARIANTES: Record<VarianteDeBoton, string> = {
  primario: 'bg-accion text-sobre-accion border border-transparent',
  secundario: 'bg-tarjeta text-principal border border-borde-control',
  fantasma: 'bg-transparent text-principal border border-transparent',
  peligro: 'bg-peligro-solido text-sobre-peligro border border-transparent',
}

const TAMANOS: Record<TamanoDeBoton, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
}

/**
 * Botón.
 *
 * El estado `hover` **no cambia el relleno** de las variantes llenas: sólo levanta
 * la elevación. Ningún relleno alternativo está verificado todavía, y cambiar el
 * fondo a un color sin medir es exactamente cómo se rompe la accesibilidad sin que
 * nadie lo note. Las variantes que sí tienen un relleno alternativo verificado
 * —secundario y fantasma sobre el fondo sutil— lo usan.
 */
const HOVER: Record<VarianteDeBoton, string> = {
  primario: 'hover:shadow-md',
  secundario: 'hover:bg-sutil',
  fantasma: 'hover:bg-sutil',
  peligro: 'hover:shadow-md',
}

export interface PropsDeBoton extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: VarianteDeBoton
  tamano?: TamanoDeBoton
  /** Contenido a la izquierda del texto: normalmente un icono. */
  prefijo?: ReactNode
  /** Contenido a la derecha del texto. */
  sufijo?: ReactNode
  /** Muestra un indicador y bloquea la interacción sin desmontar el botón. */
  cargando?: boolean
  /** Si se pasa, el botón se renderiza como un enlace `<a>` con la misma apariencia. */
  href?: string
}

export function Boton({
  variante = 'secundario',
  tamano = 'md',
  prefijo,
  sufijo,
  cargando = false,
  className,
  children,
  disabled,
  type = 'button',
  href,
  onClick,
  ...resto
}: PropsDeBoton) {
  const clases = cn(
    'inline-flex select-none items-center justify-center rounded-[var(--control-radio)] font-medium',
    'transition-shadow duration-[var(--control-dur-rapida)]',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTES[variante],
    TAMANOS[tamano],
    HOVER[variante],
    className,
  )

  if (href !== undefined) {
    return (
      <a href={href} className={clases} onClick={onClick as unknown as MouseEventHandler<HTMLAnchorElement>}>
        {cargando ? <IndicadorDeCarga /> : prefijo}
        {children}
        {sufijo}
      </a>
    )
  }

  return (
    <button
      type={type}
      disabled={disabled ?? cargando}
      aria-busy={cargando || undefined}
      className={clases}
      onClick={onClick}
      {...resto}
    >
      {cargando ? <IndicadorDeCarga /> : prefijo}
      {children}
      {sufijo}
    </button>
  )
}

function IndicadorDeCarga() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}
