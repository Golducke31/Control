/**
 * Aislamiento de cache por empresa.
 *
 * El punto crítico de F2: cambiar de empresa no puede dejar datos de la anterior visibles
 * ni un instante —es una fuga entre inquilinos en la interfaz—. La defensa es doble:
 *
 * 1. **Estructural.** Toda clave de consulta lleva el `slug` de la empresa adelante, así
 *    que dos empresas nunca comparten una entrada de cache aunque coincidan en ruta.
 * 2. **Explícita.** Al cambiar de `slug`, el proveedor de la carcasa vacía la cache entera.
 *
 * Ambas se prueban: `claveDeConsulta` siempre prefija el slug, y `debeDescartarCache`
 * sólo es verdadero cuando el slug efectivamente cambió.
 */

export type Clave = (string | number)[]

/** Construye una clave de consulta ya aislada por empresa. */
export function claveDeConsulta(slug: string, ...partes: (string | number)[]): Clave {
  return ['empresa', slug, ...partes]
}

/**
 * Decide si, al navegar, hay que descartar la cache.
 *
 * Sólo descarta cuando el slug nuevo difiere del anterior. La primera carga (`anterior`
 * es `null`) no descarta: no hay nada que cruzar.
 */
export function debeDescartarCache(slugAnterior: string | null, slugNuevo: string): boolean {
  return slugAnterior !== null && slugAnterior !== slugNuevo
}

/** Extrae el `slug` de una ruta dentro de la carcasa (`/e/andes/panel` → `andes`). */
export function slugDeRuta(ruta: string): string | null {
  const partes = ruta.split('/').filter(Boolean)
  return partes[0] === 'e' && partes[1] !== undefined ? partes[1] : null
}
