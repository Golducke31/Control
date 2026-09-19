'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@control/ui'

import { Icono } from './Iconos'
import type { BloqueDeMenu } from './tipos'

/**
 * La barra lateral.
 *
 * Es un componente de cliente por una sola razón: necesita `usePathname` para marcar
 * el ítem activo. El menú en sí llega ya filtrado desde el servidor —por permisos y
 * por banderas de funcionalidad—, así que acá no hay ninguna decisión de autorización:
 * sólo se dibuja lo que le pasaron.
 *
 * El ítem activo lleva una barra naranja de 3px. Es el acento de acción, y es lo que
 * responde «estás acá» en una aplicación de catorce ventanas.
 */
export function BarraLateral({
  bloques,
  slug,
  alNavegar,
  etiqueta,
}: {
  bloques: readonly BloqueDeMenu[]
  slug: string
  alNavegar?: () => void
  etiqueta: string
}) {
  const ruta = usePathname()

  return (
    <nav aria-label={etiqueta} className="flex flex-col gap-5 px-3 py-4">
      {bloques.map((bloque) => (
        <div key={bloque.grupo}>
          <p className="px-2.5 pb-1.5 text-xs font-medium tracking-wide text-sobre-carcasa-sutil uppercase">
            {bloque.titulo}
          </p>
          <ul className="flex flex-col gap-0.5">
            {bloque.ventanas.map((ventana) => {
              const href = `/e/${slug}/${ventana.segmento}`
              const activa = ruta === href || ruta.startsWith(`${href}/`)

              // Con `exactOptionalPropertyTypes`, pasar `undefined` a una prop opcional
              // no es lo mismo que omitirla. Se arma el objeto por partes para no
              // declarar props que no corresponden.
              const estado = {
                ...(activa ? { 'aria-current': 'page' as const } : {}),
                ...(alNavegar !== undefined ? { onClick: alNavegar } : {}),
              }

              return (
                <li key={ventana.id}>
                  <Link
                    href={href}
                    {...estado}
                    className={cn(
                      'relative flex items-center gap-2.5 rounded-[var(--control-radio-sm)] py-2 pr-2.5 pl-3',
                      'text-sm transition-colors duration-[var(--control-dur-rapida)]',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco',
                      activa
                        ? 'bg-carcasa-sutil font-medium text-sobre-carcasa'
                        : 'text-sobre-carcasa-sutil hover:bg-carcasa-sutil hover:text-sobre-carcasa',
                    )}
                  >
                    {activa && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-accion"
                      />
                    )}
                    <Icono nombre={ventana.icono} tamano={17} />
                    <span className="truncate">{ventana.titulo}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
