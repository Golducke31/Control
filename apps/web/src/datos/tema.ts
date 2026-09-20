import { PALETAS_DE_INQUILINO } from '@control/tokens'

/**
 * El tema inicial de una empresa.
 *
 * Vive en un módulo **sin `'use client'`** a propósito. La primera versión estaba dentro
 * de `ConfiguracionCliente.tsx`, que sí lo tiene, y eso la convertía en una **referencia
 * de cliente**: el Server Component que la llamaba fallaba en runtime con «Attempted to
 * call temaInicial() from the server but temaInicial is on the client».
 *
 * El typecheck no lo ve, los tests tampoco y `next build` tampoco: es una regla de
 * frontera que sólo se manifiesta cuando alguien pide la ruta. Un helper puro que usan los
 * dos lados no puede vivir en un módulo marcado como cliente — tiene que vivir en uno
 * compartido, y `datos/` es donde vive lo compartido.
 */
export function paletaInicial(slug: string): string {
  if (PALETAS_DE_INQUILINO.some((paleta) => paleta.slug === slug)) return slug
  return PALETAS_DE_INQUILINO[0]?.slug ?? 'andes'
}
