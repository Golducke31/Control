import type { ReactNode } from 'react'

import { cn } from './cn'

export interface PropsDeTarjeta {
  children: ReactNode
  className?: string
  titulo?: ReactNode
  descripcion?: ReactNode
  acciones?: ReactNode
  /**
   * Bloque de énfasis: borde izquierdo de acción.
   *
   * Sirve para el KPI o la alerta que tiene que leerse primero, sin recurrir a un
   * relleno de color que rompería el contraste del texto.
   */
  destacada?: boolean
  /** `ninguno` para tablas y mapas, que administran su propio relleno. */
  relleno?: 'normal' | 'ninguno'
}

/**
 * Tarjeta: la superficie de contenido del sistema.
 *
 * Lleva borde **siempre**, en los dos temas. En el tema claro es un separador sutil;
 * en el oscuro es el único separador disponible, porque sobre la familia violeta las
 * superficies entre sí no llegan a 3:1 y WCAG 1.4.11 lo exige. Que sea una constante
 * del componente y no una decisión de cada pantalla es lo que hace que la regla se
 * cumpla sin depender de que alguien se acuerde.
 */
export function Tarjeta({
  children,
  className,
  titulo,
  descripcion,
  acciones,
  destacada = false,
  relleno = 'normal',
}: PropsDeTarjeta) {
  const tieneCabecera = titulo !== undefined || descripcion !== undefined || acciones !== undefined

  return (
    <section
      className={cn(
        'rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta shadow-[var(--control-sombra-sm)]',
        destacada && 'border-l-[3px] border-l-accion',
        className,
      )}
    >
      {tieneCabecera && (
        <header
          className={cn(
            'flex flex-wrap items-start justify-between gap-3 border-b border-borde-sutil',
            relleno === 'normal' ? 'px-5 py-3.5' : 'px-4 py-3',
          )}
        >
          <div className="min-w-0">
            {titulo !== undefined && (
              <h2 className="text-lg font-medium text-principal">{titulo}</h2>
            )}
            {descripcion !== undefined && (
              <p className="mt-0.5 text-sm text-secundario">{descripcion}</p>
            )}
          </div>
          {acciones !== undefined && <div className="flex shrink-0 items-center gap-2">{acciones}</div>}
        </header>
      )}
      <div className={cn(relleno === 'normal' && 'p-5')}>{children}</div>
    </section>
  )
}
