/**
 * La paleta del sistema, en un solo lugar.
 *
 * Los tres colores indicados son las únicas constantes escritas a mano. Todo lo
 * demás —las tres escalas de doce pasos, los tonos de lienzo, las tintas— se
 * deriva de ellos, de modo que cambiar un ancla regenera el sistema entero y la
 * suite vuelve a verificar todos los pares de contraste.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.
 */

import { derivarEscala, derivarNeutral } from './derivar.ts'
import type { Paso } from './derivar.ts'

/** Los tres colores de la referencia, con el papel que cumple cada uno. */
export const PALETA_INDICADA = {
  /** Superficie de contenido: tarjetas, tablas, formularios. */
  white: '#FFFFFF',
  /** Acción y acento: botón primario, enlaces, foco, series destacadas. */
  orange: '#EF5F18',
  /** Marca y estructura: carcasa, encabezados, texto principal sobre claro. */
  scarlet: '#261A66',
} as const

/**
 * Tonos de lienzo, muestreados de la imagen de referencia.
 *
 * No están declarados en ella, pero son los que permiten construir el fondo
 * profundo. Se tomaron por muestreo de la propia imagen —el violeta profundo
 * dominante aparece en el 19% de su superficie—.
 */
export const LIENZO = {
  /** Fondo profundo dominante. La carcasa. */
  canvas: '#130D36',
  /** Superficie elevada sobre el lienzo. */
  profundo: '#1E154C',
  /** Violeta medio: bordes y separadores. */
  medio: '#3D3165',
  /** Contrafondo claro de la referencia. */
  claro: '#E7E4E8',
} as const

/** El paso donde cada color indicado cae naturalmente. */
export const ANCLAS = {
  scarlet: { hex: PALETA_INDICADA.scarlet, paso: 900 },
  orange: { hex: PALETA_INDICADA.orange, paso: 600 },
} as const satisfies Record<string, { hex: string; paso: Paso }>

/** Las tres escalas de doce pasos. */
export const ESCALAS = {
  scarlet: derivarEscala(ANCLAS.scarlet.hex, ANCLAS.scarlet.paso),
  orange: derivarEscala(ANCLAS.orange.hex, ANCLAS.orange.paso),
  neutral: derivarNeutral(PALETA_INDICADA.scarlet),
} as const

export type NombreDeEscala = keyof typeof ESCALAS

/**
 * Los cuatro semánticos, cada uno con tres valores.
 *
 * La tinta `profunda` no es «la base más oscura»: es la más viva que todavía
 * alcanza 4,5:1 sobre su propio fondo claro. Se calculó así, y por eso los valores
 * quedan apenas por encima del mínimo en vez de innecesariamente oscuros. Usar la
 * base como texto sobre el fondo claro es el error más común de esta familia —
 * el verde de éxito sobre su propio fondo da 1,8:1.
 */
export const SEMANTICOS = {
  exito: { base: '#2FC48A', claro: '#DEEDE7', profundo: '#1C7653' },
  atencion: { base: '#F5B22E', claro: '#F1E9DA', profundo: '#8E6007' },
  peligro: { base: '#F2555A', claro: '#F0DBDB', profundo: '#C50F15' },
  informacion: { base: '#539BF5', claro: '#DAE4F1', profundo: '#0C60C9' },
} as const

export type NombreDeSemantico = keyof typeof SEMANTICOS

/** Resuelve un paso de una escala por nombre. Falla si el nombre no existe. */
export function paso(escala: NombreDeEscala, valor: Paso): string {
  const encontrado = ESCALAS[escala][valor]
  if (encontrado === undefined) {
    throw new Error(`La escala «${escala}» no tiene el paso ${valor}.`)
  }
  return encontrado
}

/** Orden de las series de gráfico. Nunca se elige un color de serie fuera de acá. */
export const SERIES = [
  ESCALAS.scarlet[600],
  ESCALAS.orange[600],
  ESCALAS.neutral[500],
  SEMANTICOS.exito.base,
  SEMANTICOS.informacion.base,
  SEMANTICOS.atencion.base,
  SEMANTICOS.peligro.base,
] as const
