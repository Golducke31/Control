'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { Orden } from '@control/contracts'

/** Estado de la ventana que vive en la URL (regla A12): filtros, página y orden. */
export interface EstadoUrl {
  texto: string
  pagina: number
  porPagina: number
  orden: Orden | null
}

function parseOrden(valor: string | null): Orden | null {
  if (!valor) return null
  const [campo, dir] = valor.split(':')
  if (!campo) return null
  return { campo, dir: dir === 'desc' ? 'desc' : 'asc' }
}

/**
 * Estado de la ventana anclado en la URL.
 *
 * Recargar restaura la vista exacta (A12): filtros, página y orden se leen de
 * `searchParams` y se escriben con `router.replace`, así el enlace es compartible y
 * dos pestañas en la misma empresa no se pisan. Nada de esto vive en Zustand.
 */
export function useUrlState() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const texto = params.get('texto') ?? ''
  const pagina = Number(params.get('pagina') ?? '1') || 1
  const porPagina = Number(params.get('porPagina') ?? '10') || 10
  const orden = parseOrden(params.get('orden'))

  const setEstado = useCallback(
    (next: Partial<EstadoUrl>) => {
      const sp = new URLSearchParams(params.toString())
      if (next.texto !== undefined) {
        if (next.texto) sp.set('texto', next.texto)
        else sp.delete('texto')
      }
      if (next.pagina !== undefined) {
        if (next.pagina > 1) sp.set('pagina', String(next.pagina))
        else sp.delete('pagina')
      }
      if (next.porPagina !== undefined) sp.set('porPagina', String(next.porPagina))
      if (next.orden !== undefined) {
        if (next.orden) sp.set('orden', `${next.orden.campo}:${next.orden.dir}`)
        else sp.delete('orden')
      }
      router.replace(`${pathname}?${sp.toString()}`)
    },
    [params, pathname, router],
  )

  return {
    texto,
    pagina,
    porPagina,
    orden,
    setEstado,
    filtroActivo: texto !== '' || orden !== null,
  }
}
