import type { ReactNode } from 'react'

import { cn } from './cn'

export type TonoDeInsignia = 'neutro' | 'accion' | 'exito' | 'atencion' | 'peligro' | 'informacion'

/**
 * Cada tono usa el par verificado de su estado: fondo suave con la tinta encima.
 *
 * Nunca se usa el color base como texto —sobre una superficie clara el verde de
 * éxito da 2,24:1—, y por eso el tono `neutro` no es «gris» sino el par de texto
 * secundario sobre el fondo sutil, que también está medido.
 */
const TONOS: Record<TonoDeInsignia, string> = {
  neutro: 'bg-sutil text-secundario border-borde-sutil',
  accion: 'bg-accion/10 text-acento border-accion/30',
  exito: 'bg-exito-suave text-exito-tinta border-exito-tinta/25',
  atencion: 'bg-atencion-suave text-atencion-tinta border-atencion-tinta/25',
  peligro: 'bg-peligro-suave text-peligro-tinta border-peligro-tinta/25',
  informacion: 'bg-informacion-suave text-informacion-tinta border-informacion-tinta/25',
}

export interface PropsDeInsignia {
  children: ReactNode
  tono?: TonoDeInsignia
  className?: string
  /** Punto de color a la izquierda, para las tablas donde el texto es un código. */
  conPunto?: boolean
}

export function Insignia({ children, tono = 'neutro', className, conPunto = false }: PropsDeInsignia) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--control-radio-full)] border px-2 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONOS[tono],
        className,
      )}
    >
      {conPunto && (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      )}
      {children}
    </span>
  )
}
