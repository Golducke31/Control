/**
 * Tipografía.
 *
 * Dos familias, servidas localmente: la aplicación tiene que funcionar en una red
 * restringida y no puede depender de un tercero para dibujar texto. Space Grotesk
 * para títulos y cifras —tiene cifras tabulares, que es lo que hace legible una
 * columna de importes— e Inter para el cuerpo y los formularios.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.6.
 */

export const FAMILIAS = {
  titulos: "'Space Grotesk', system-ui, sans-serif",
  cuerpo: "'Inter', system-ui, sans-serif",
  mono: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
} as const

export interface PasoDeTexto {
  /** Tamaño en píxeles. */
  tamano: number
  /** Altura de línea en píxeles. */
  interlinea: number
}

/**
 * Escala tipográfica con razón 1,25.
 *
 * Los tamaños son múltiplos impares a propósito: 15px y 13px rinden mejor que 16px
 * y 14px en tablas densas, y el sistema pasa ocho horas por día en tablas.
 */
export const ESCALA = {
  xs: { tamano: 11, interlinea: 16 },
  sm: { tamano: 13, interlinea: 20 },
  base: { tamano: 15, interlinea: 24 },
  lg: { tamano: 18, interlinea: 28 },
  xl: { tamano: 22, interlinea: 30 },
  '2xl': { tamano: 28, interlinea: 36 },
  '3xl': { tamano: 36, interlinea: 44 },
  '4xl': { tamano: 46, interlinea: 52 },
} as const satisfies Record<string, PasoDeTexto>

export type NombreDeTexto = keyof typeof ESCALA

export const PESOS = {
  normal: 400,
  medio: 500,
  fuerte: 600,
  titulo: 700,
} as const

/**
 * Umbral de «texto grande» de WCAG 2.2.
 *
 * Aparece en tres de las prohibiciones del sistema de color —el blanco sobre el
 * naranja de marca sólo es admisible por encima de este tamaño—, así que se define
 * una sola vez y el lint lo conoce.
 */
export const UMBRAL_TEXTO_GRANDE = {
  /** 19px en negrita o más. */
  tamanoNegrita: 19,
  /** 24px normal o más. */
  tamanoNormal: 24,
} as const

/**
 * Cifras tabulares, obligatorias en toda columna numérica, total y saldo.
 *
 * Sin esto los importes bailan al ordenar y leer una columna se vuelve imposible.
 */
export const CIFRAS_TABULARES = 'tabular-nums' as const
