/**
 * Roles semánticos de color.
 *
 * Las escalas son la materia prima; los roles son lo que los componentes usan.
 * Un componente nunca dice «violeta 900»: dice «fondo de carcasa». Así, cambiar
 * el tema es cambiar la tabla de roles, y el lint puede exigir que no haya colores
 * fuera de acá.
 *
 * Los roles se resuelven a valores concretos —no a referencias— porque la suite de
 * contraste necesita hacer aritmética con ellos. El generador los emite como
 * variables CSS.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.4 y §3.5.
 */

import { mezclar } from './contraste.ts'
import { aHex } from './contraste.ts'
import { ESCALAS, LIENZO, PALETA_INDICADA, SEMANTICOS } from './escalas.ts'
import type { NombreDeSemantico } from './escalas.ts'

export type Tema = 'claro' | 'oscuro'

/** Nombre de un rol, sin el prefijo de variable CSS. */
export type NombreDeRol =
  | 'fondo-carcasa'
  | 'fondo-carcasa-sutil'
  | 'fondo-lienzo'
  | 'fondo-tarjeta'
  | 'fondo-sutil'
  | 'fondo-invertido'
  | 'fondo-accion'
  | 'texto-sobre-carcasa'
  | 'texto-sobre-carcasa-sutil'
  | 'texto-principal'
  | 'texto-secundario'
  | 'texto-terciario'
  | 'texto-deshabilitado'
  | 'texto-sobre-accion'
  | 'texto-sobre-peligro'
  | 'texto-sobre-invertido'
  | 'texto-acento'
  | 'borde-sutil'
  | 'borde-control'
  | 'borde-accion'
  | 'foco'

/** Un rol de estado: cada semántico aporta tres. */
export type RolDeEstado = `estado-${NombreDeSemantico}` | `estado-${NombreDeSemantico}-suave` | `estado-${NombreDeSemantico}-tinta`

export type Rol = NombreDeRol | RolDeEstado

/**
 * Cuánto se oscurece un semántico para hacer su fondo suave en tema oscuro.
 *
 * Sobre el lienzo violeta un fondo claro de estado sería un farol; se usa una
 * tintura profunda del propio color, que conserva la identidad y deja el texto en
 * la base —que sobre ese fondo pasa de 4,5:1 con holgura—.
 */
const TINTURA_OSCURA = 0.82

function rolesDeEstado(tema: Tema): Record<RolDeEstado, string> {
  const salida = {} as Record<RolDeEstado, string>
  for (const [nombre, valores] of Object.entries(SEMANTICOS) as [
    NombreDeSemantico,
    (typeof SEMANTICOS)[NombreDeSemantico],
  ][]) {
    salida[`estado-${nombre}`] = valores.base
    if (tema === 'claro') {
      salida[`estado-${nombre}-suave`] = valores.claro
      salida[`estado-${nombre}-tinta`] = valores.profundo
    } else {
      salida[`estado-${nombre}-suave`] = aHex(mezclar(valores.base, 'negro', TINTURA_OSCURA))
      salida[`estado-${nombre}-tinta`] = valores.base
    }
  }
  return salida
}

/**
 * Tema claro: carcasa violeta profunda y área de trabajo clara.
 *
 * Es el tema por defecto, y su forma sale de una medición: sobre la familia violeta
 * las superficies entre sí no llegan a 1,6:1 y la recomendación exige 3:1 para
 * límites de control. La única separación real disponible es el blanco, así que el
 * violeta se queda con la estructura y el blanco con el contenido.
 */
export const ROLES_CLARO: Record<Rol, string> = {
  'fondo-carcasa': ESCALAS.scarlet[990],
  // El ítem activo y el hover de la navegación. Es un violeta más claro que la
  // carcasa, y su par con el texto de navegación está verificado: sin un rol medido,
  // el estado activo terminaría siendo un `color-mix` sin medir.
  'fondo-carcasa-sutil': ESCALAS.scarlet[800],
  'fondo-lienzo': ESCALAS.scarlet[50],
  'fondo-tarjeta': PALETA_INDICADA.white,
  'fondo-sutil': ESCALAS.neutral[100],
  'fondo-invertido': ESCALAS.scarlet[900],
  'fondo-accion': ESCALAS.orange[600],

  'texto-sobre-carcasa': ESCALAS.neutral[100],
  // Para los ítems de navegación en reposo y las etiquetas de grupo. No se usa una
  // opacidad reducida del texto principal: una opacidad es un color sin medir, y el
  // sistema prefiere un paso de la escala que sí está verificado.
  'texto-sobre-carcasa-sutil': ESCALAS.neutral[400],
  'texto-principal': ESCALAS.scarlet[900],
  // Tres niveles de texto con separación suficiente entre sí. Los pasos se
  // eligieron midiendo sobre el LIENZO y no sobre la tarjeta: el lienzo es apenas
  // más oscuro que el blanco, y `neutral-600` —que sobre la tarjeta alcanza 4,56:1—
  // cae a 4,32:1 sobre el lienzo, por debajo del mínimo.
  'texto-secundario': ESCALAS.neutral[800],
  'texto-terciario': ESCALAS.neutral[700],
  'texto-deshabilitado': ESCALAS.neutral[500],
  'texto-sobre-accion': ESCALAS.scarlet[990],
  // El botón de peligro sólido. En tema claro se rellena con la tinta profunda del
  // rojo y lleva blanco encima; en tema oscuro se rellena con la base —que es
  // brillante— y lleva tinta oscura, el mismo patrón que el botón naranja. En los
  // dos casos el par está verificado.
  'texto-sobre-peligro': PALETA_INDICADA.white,
  'texto-sobre-invertido': PALETA_INDICADA.white,
  'texto-acento': ESCALAS.orange[800],

  'borde-sutil': ESCALAS.neutral[200],
  'borde-control': ESCALAS.neutral[600],
  'borde-accion': ESCALAS.orange[600],
  foco: ESCALAS.orange[600],

  ...rolesDeEstado('claro'),
}

/**
 * Tema oscuro: el mismo sistema con los valores invertidos.
 *
 * Es variante, no un segundo sistema de diseño. Su regla propia —que **toda
 * superficie lleva borde**— no es una preferencia estética: es la única forma de
 * cumplir 1.4.11 en esta familia de colores, donde la elevación no se puede
 * expresar con luminosidad.
 */
export const ROLES_OSCURO: Record<Rol, string> = {
  'fondo-carcasa': LIENZO.canvas,
  'fondo-carcasa-sutil': ESCALAS.scarlet[900],
  'fondo-lienzo': ESCALAS.scarlet[990],
  'fondo-tarjeta': LIENZO.profundo,
  // Más oscuro que la tarjeta, no más claro: sobre el lienzo violeta subir el
  // brillo para separar no funciona (1,1:1), así que la cebra baja.
  'fondo-sutil': ESCALAS.scarlet[950],
  'fondo-invertido': ESCALAS.scarlet[900],
  'fondo-accion': ESCALAS.orange[600],

  'texto-sobre-carcasa': ESCALAS.neutral[100],
  'texto-sobre-carcasa-sutil': ESCALAS.neutral[400],
  'texto-principal': ESCALAS.neutral[100],
  'texto-secundario': ESCALAS.neutral[300],
  'texto-terciario': ESCALAS.neutral[400],
  'texto-deshabilitado': ESCALAS.neutral[500],
  'texto-sobre-accion': ESCALAS.scarlet[990],
  'texto-sobre-peligro': ESCALAS.scarlet[990],
  'texto-sobre-invertido': PALETA_INDICADA.white,
  'texto-acento': ESCALAS.orange[400],

  'borde-sutil': LIENZO.medio,
  // Más claro que el borde del tema claro, a propósito: en el lienzo oscuro el
  // borde es el único separador disponible, así que tiene que verse.
  'borde-control': ESCALAS.scarlet[500],
  'borde-accion': ESCALAS.orange[600],
  foco: ESCALAS.orange[600],

  ...rolesDeEstado('oscuro'),
}

export const ROLES: Record<Tema, Record<Rol, string>> = {
  claro: ROLES_CLARO,
  oscuro: ROLES_OSCURO,
}

/** Los cuatro tonos de lienzo, también como roles. */
export const ROLES_DE_LIENZO = {
  'lienzo-canvas': LIENZO.canvas,
  'lienzo-profundo': LIENZO.profundo,
  'lienzo-medio': LIENZO.medio,
  'lienzo-claro': LIENZO.claro,
} as const
