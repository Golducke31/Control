'use client'

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ApiClient, ParametrosLista } from './cliente.ts'
import type { Coleccion } from '@control/contracts'
import type { Orden } from '@control/contracts'

/**
 * Hook de consulta de una colección.
 *
 * Une tres cosas que la arquitectura exige por separado:
 *
 * 1. **El cliente** (`ApiClient`) — el componente no sabe si es simulado o real.
 * 2. **React Query** — cache por empresa (la clave incluye `empresaSlug`) y
 *    `keepPreviousData` para que la paginación no parpadee.
 * 3. **El estado de URL** — `texto`, `pagina`, `porPagina` y `orden` vienen del hook
 *    `useUrlState`, así que recargar restaura la vista (A12).
 *
 * `initialData` lo hidrata el Server Component con la primera consulta, para que la
 * pintura inicial no tenga cascada de peticiones (§5.3).
 */
export function useColeccion<T>(opts: {
  cliente: ApiClient
  empresaSlug: string
  texto: string
  pagina: number
  porPagina: number
  orden: Orden | null
  queryKey: string[]
  consultar: (cliente: ApiClient, params: ParametrosLista) => Promise<Coleccion<T>>
  initialData?: Coleccion<T> | undefined
}) {
  const { cliente, empresaSlug, texto, pagina, porPagina, orden, queryKey, consultar, initialData } = opts

  return useQuery({
    queryKey: [
      ...queryKey,
      empresaSlug,
      texto,
      pagina,
      porPagina,
      orden?.campo ?? '—',
      orden?.dir ?? '—',
    ],
    queryFn: () => consultar(cliente, { empresaSlug, texto, pagina, porPagina, orden }),
    initialData,
    placeholderData: keepPreviousData,
  })
}
