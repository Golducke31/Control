import type { Orden } from '@control/contracts'

/**
 * Los parámetros de una lista, leídos de la URL.
 *
 * Existe porque hay **dos** lugares que tienen que interpretar la misma URL: el hook
 * `useUrlState` en el navegador y el Server Component que resuelve la primera página.
 * Cuando cada uno los leía por su cuenta, el servidor pintaba siempre `pagina: 1` sin
 * filtro ni orden, y el cliente guardaba esa respuesta como `initialData` de la clave que
 * sí llevaba los parámetros: la pantalla mostraba el filtro escrito en el campo y los
 * datos sin filtrar, y como `initialData` cuenta como dato fresco, nadie corregía nada.
 *
 * Una función, dos consumidores: si el parseo cambia, cambia para los dos.
 */
export interface ParametrosDeLista {
  texto: string
  pagina: number
  porPagina: number
  orden: Orden | null
}

/** Lo que Next entrega en `searchParams` de un `page.tsx`. */
export type SearchParams = Record<string, string | string[] | undefined>

/** `campo:dirección`, como lo escribe `useUrlState`. Un valor raro se ignora. */
export function parsearOrden(valor: string | null | undefined): Orden | null {
  if (!valor) return null
  const [campo, dir] = valor.split(':')
  if (!campo) return null
  return { campo, dir: dir === 'desc' ? 'desc' : 'asc' }
}

/**
 * El valor de un parámetro, tomando el primero si viene repetido.
 *
 * `?texto=a&texto=b` es válido en HTTP y Next lo entrega como arreglo; el cliente se
 * queda con el primero, así que el servidor tiene que hacer lo mismo para no resolver una
 * consulta distinta de la que el navegador va a pedir después.
 */
function uno(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor
}

/**
 * Interpreta la URL como lo hace `useUrlState`.
 *
 * Los valores por defecto tienen que coincidir con los del hook —`pagina` 1, `texto`
 * vacío, `orden` nulo—: si no coincidieran, el servidor resolvería una consulta que el
 * navegador nunca pediría y la primera pintura quedaría descartada.
 */
export function parametrosDeLista(
  sp: SearchParams | undefined,
  opciones: { porPagina?: number } = {},
): ParametrosDeLista {
  const porDefecto = opciones.porPagina ?? 10
  const bruto = uno(sp?.porPagina)
  const porPagina = bruto === undefined ? porDefecto : Number(bruto) || porDefecto
  return {
    texto: uno(sp?.texto) ?? '',
    pagina: Number(uno(sp?.pagina) ?? '1') || 1,
    porPagina,
    orden: parsearOrden(uno(sp?.orden)),
  }
}
