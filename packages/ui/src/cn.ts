/**
 * Une clases descartando lo que no corresponde.
 *
 * Deliberadamente sin dependencias: para concatenar cadenas no hace falta traer
 * `clsx` ni `tailwind-merge`. Si algún día hace falta resolver conflictos entre
 * clases de Tailwind, se justifica la dependencia entonces; hoy no hay ninguno.
 */

export type Clase = string | false | null | undefined

export function cn(...partes: Clase[]): string {
  return partes.filter((parte): parte is string => typeof parte === 'string' && parte.length > 0).join(' ')
}
