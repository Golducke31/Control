import type { ReactNode } from 'react'

import { cn } from './cn'

export interface PropsDeEstadoVacio {
  titulo: string
  /** Explica qué es esta ventana y cuál es la primera acción. Nunca «no hay datos». */
  descripcion?: string
  /** La primera acción, que es lo que convierte un vacío en un punto de partida. */
  accion?: ReactNode
  icono?: ReactNode
  className?: string
}

/**
 * Estado vacío.
 *
 * La regla A5 del plan de arquitectura de información exige que toda ventana tenga
 * un estado vacío explícito. El texto no dice «no hay datos»: dice qué es esta
 * ventana y cómo se empieza, porque un vacío sin instrucciones es un callejón.
 */
export function EstadoVacio({
  titulo,
  descripcion,
  accion,
  icono,
  className,
}: PropsDeEstadoVacio) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-[var(--control-radio)]',
        'border border-dashed border-borde-control px-6 py-12 text-center',
        className,
      )}
    >
      {icono !== undefined && (
        <div className="text-terciario" aria-hidden="true">
          {icono}
        </div>
      )}
      <p className="text-base font-medium text-principal">{titulo}</p>
      {descripcion !== undefined && (
        <p className="max-w-md text-sm text-secundario">{descripcion}</p>
      )}
      {accion !== undefined && <div className="mt-1">{accion}</div>}
    </div>
  )
}
