import type { ReactNode } from 'react'

import { cn } from './cn'

export interface PropsDeEncabezadoDeVentana {
  titulo: string
  descripcion?: string
  /** Acciones de la ventana. La principal va última, a la derecha. */
  acciones?: ReactNode
  /** Filtros y controles que aplican a toda la ventana. */
  barra?: ReactNode
  className?: string
}

/**
 * Encabezado de ventana.
 *
 * Es lo primero que hay dentro del área de trabajo y lo que responde «dónde estoy»
 * sin depender de las migas: el título de la ventana y, si hace falta, una línea que
 * explica para qué sirve. Con 14 ventanas, saber dónde se está es la mitad del
 * trabajo de navegación.
 */
export function EncabezadoDeVentana({
  titulo,
  descripcion,
  acciones,
  barra,
  className,
}: PropsDeEncabezadoDeVentana) {
  return (
    <header className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-principal">{titulo}</h1>
          {descripcion !== undefined && (
            <p className="mt-1 max-w-3xl text-sm text-secundario">{descripcion}</p>
          )}
        </div>
        {acciones !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{acciones}</div>
        )}
      </div>
      {barra !== undefined && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta px-3 py-2">
          {barra}
        </div>
      )}
    </header>
  )
}
