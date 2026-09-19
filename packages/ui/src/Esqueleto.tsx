import { cn } from './cn'

export interface PropsDeEsqueleto {
  /** Cuántos bloques dibujar. Sirve para representar una lista. */
  filas?: number
  /** Alto de cada bloque. `bloque` es para gráficos y mapas. */
  alto?: 'texto' | 'titulo' | 'bloque'
  className?: string
  /**
   * Se oculta a los lectores de pantalla por defecto: el contenedor que espera datos
   * es quien anuncia el estado de carga, con `aria-busy` y un texto para lectores.
   */
  ocultoParaLectores?: boolean
}

const ALTOS: Record<NonNullable<PropsDeEsqueleto['alto']>, string> = {
  texto: 'h-4',
  titulo: 'h-7',
  bloque: 'h-48',
}

/**
 * Esqueleto de carga.
 *
 * Tiene la forma del contenido real, no un indicador giratorio centrado: cuando el
 * contenido llega, no hay salto de composición porque el espacio ya estaba ocupado
 * por algo del mismo tamaño.
 */
export function Esqueleto({
  filas = 1,
  alto = 'texto',
  className,
  ocultoParaLectores = true,
}: PropsDeEsqueleto) {
  return (
    <div
      className={cn('flex flex-col gap-2', className)}
      aria-hidden={ocultoParaLectores || undefined}
    >
      {Array.from({ length: Math.max(1, filas) }, (_, i) => (
        <div
          key={i}
          className={cn(
            'animate-pulse rounded-[var(--control-radio-sm)] bg-sutil',
            ALTOS[alto],
            // El último bloque de una lista va más corto, para que se lea como texto
            // y no como una tabla de filas idénticas.
            alto === 'texto' && i === filas - 1 && filas > 1 && 'w-2/3',
          )}
        />
      ))}
    </div>
  )
}
