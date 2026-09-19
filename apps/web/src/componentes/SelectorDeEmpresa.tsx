'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@control/ui'

import type { Empresa } from '@/empresa'

/**
 * Selector de empresa.
 *
 * Es un componente de cliente por una razón concreta: conserva **la ventana actual**
 * al cambiar de empresa. Si sólo enlazara a `/e/<slug>`, cambiar de empresa devolvería
 * siempre al panel y se perdería el lugar donde estaba el usuario.
 *
 * En F2 este componente sigue existiendo con la misma forma; lo que cambia es de dónde
 * sale la lista —hoy son empresas de demostración, después serán las membresías del
 * usuario— y que al cambiar de empresa se descarta la caché de consultas.
 */
export function SelectorDeEmpresa({
  empresas,
  actual,
}: {
  empresas: readonly Empresa[]
  actual: Empresa
}) {
  const ruta = usePathname()

  // Se reemplaza el slug en la ruta actual y se conserva el resto.
  const rutaEn = (slug: string): string => {
    const resto = ruta.split('/').slice(3).join('/')
    return `/e/${slug}${resto.length > 0 ? `/${resto}` : ''}`
  }

  return (
    <details className="relative">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2.5 rounded-[var(--control-radio-sm)] px-2 py-1.5',
          'hover:bg-carcasa-sutil focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco',
        )}
        aria-label={`Empresa actual: ${actual.nombre}. Cambiar de empresa`}
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radio-sm)] bg-accion text-xs font-semibold text-sobre-accion"
        >
          {actual.iniciales}
        </span>
        <span className="min-w-0 text-left">
          <span className="block truncate text-sm font-medium text-sobre-carcasa">{actual.nombre}</span>
          <span className="block truncate text-xs text-sobre-carcasa-sutil">{actual.rol}</span>
        </span>
      </summary>

      <div className="absolute top-full left-0 z-40 mt-2 w-72 overflow-hidden rounded-[var(--control-radio)] border border-borde-sutil bg-carcasa shadow-lg">
        <p className="border-b border-borde-sutil px-3 py-2 text-xs font-medium tracking-wide text-sobre-carcasa-sutil uppercase">
          Empresas
        </p>
        <ul>
          {empresas.map((empresa) => {
            const esActual = empresa.slug === actual.slug
            return (
              <li key={empresa.slug}>
                <Link
                  href={rutaEn(empresa.slug)}
                  aria-current={esActual ? 'true' : undefined}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-carcasa-sutil',
                    esActual ? 'text-sobre-carcasa' : 'text-sobre-carcasa-sutil',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radio-sm)] border border-borde-sutil text-xs font-medium"
                  >
                    {empresa.iniciales}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-sobre-carcasa">{empresa.nombre}</span>
                    <span className="block truncate text-xs">{empresa.descripcion}</span>
                  </span>
                  {esActual && (
                    <span className="ml-auto text-xs text-acento" aria-hidden="true">
                      ●
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}
