'use client'

/**
 * Proveedor de sesión y de cache de consultas.
 *
 * Vive dentro de la carcasa (una sola empresa a la vez), y es donde se materializa la
 * defensa contra la fuga entre inquilinos: en cuanto cambia el `slug` de la ruta, vacía
 * la cache de TanStack Query. Combinado con las claves por empresa (`claveDeConsulta`),
 * cambiar de empresa no deja ni un instante de datos de la anterior.
 *
 * También monta la banda de impersonación cuando la sesión la trae.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

import { BandaImpersonacion } from './BandaImpersonacion'
import { debeDescartarCache, slugDeRuta } from './cache'
import type { ContextoEmpresa } from './tipos'

export function ProveedorSesion({
  contexto,
  children,
}: {
  contexto: ContextoEmpresa
  children: React.ReactNode
}) {
  const [cliente] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  )

  const ruta = usePathname()
  const slug = slugDeRuta(ruta)
  const slugAnterior = useRef<string | null>(slug)

  useEffect(() => {
    if (slug !== null && debeDescartarCache(slugAnterior.current, slug)) {
      cliente.clear()
    }
    slugAnterior.current = slug
  }, [slug, cliente])

  return (
    <QueryClientProvider client={cliente}>
      {contexto.impersonacion !== null && (
        <BandaImpersonacion
          objetivo={contexto.usuario.nombre}
          por={contexto.impersonacion.por}
          exp={contexto.impersonacion.exp}
        />
      )}
      {children}
    </QueryClientProvider>
  )
}
