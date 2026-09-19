import Link from 'next/link'

/**
 * Migas de pan.
 *
 * Se derivan de la ruta, no se escriben por ventana: con catorce ventanas y sus
 * subrutas, una lista escrita a mano se desincroniza en la primera que cambie de
 * nombre. Y son lo que responde «dónde estoy» cuando el usuario llega por un enlace
 * compartido, sin haber navegado.
 */
export interface TramoDeMigas {
  titulo: string
  href?: string
}

export function Migas({ tramos }: { tramos: readonly TramoDeMigas[] }) {
  if (tramos.length === 0) return null

  return (
    <nav aria-label="Ubicación" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-terciario">
        {tramos.map((tramo, i) => {
          const ultimo = i === tramos.length - 1
          return (
            <li key={`${tramo.titulo}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && (
                <span aria-hidden="true" className="text-borde-control">
                  /
                </span>
              )}
              {tramo.href !== undefined && !ultimo ? (
                <Link
                  href={tramo.href}
                  className="rounded-[var(--control-radio-sm)] transition-colors duration-[var(--control-dur-rapida)] hover:text-acento"
                >
                  {tramo.titulo}
                </Link>
              ) : (
                <span aria-current={ultimo ? 'page' : undefined} className={ultimo ? 'font-medium text-secundario' : undefined}>
                  {tramo.titulo}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
