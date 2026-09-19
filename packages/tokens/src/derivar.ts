/**
 * Derivación de escalas tonales a partir de un color ancla.
 *
 * El sistema tiene tres colores indicados y necesita doce pasos de cada uno para
 * poder usarlos como fondos, bordes, series de gráfico y texto. En vez de escribir
 * los 36 valores a mano —que se desincronizan en cuanto alguien toca un ancla— se
 * derivan.
 *
 * El paso del ancla se asigna **exacto**, no interpolado: `scarlet-900` es
 * literalmente `#261A66`. Los demás pasos salen de una rampa de luminosidad
 * perceptualmente espaciada, con una corrección de saturación que la baja en los
 * extremos claros —para que no se laven— y la sube en los oscuros.
 *
 * La conversión a HLS reproduce la del módulo `colorsys` de la biblioteca estándar
 * de Python, y el redondeo es a la mitad al par, porque con esos dos detalles se
 * generó la tabla publicada en `docs/PLAN-FRONTEND-PRODUCCION.md` §3.2. La suite
 * fija esos 36 valores: si alguien cambia el algoritmo, se entera.
 */

import type { Rgb } from './contraste.ts'
import { aHex, aRgb } from './contraste.ts'

/** Los doce pasos de una escala. */
export const PASOS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950, 990] as const
export type Paso = (typeof PASOS)[number]

/** Luminosidad objetivo por paso, en orden. Espaciado perceptual, no lineal. */
const RAMPA = [0.975, 0.945, 0.895, 0.815, 0.715, 0.605, 0.495, 0.385, 0.285, 0.205, 0.145, 0.1]

/** Acceso con verificación: `noUncheckedIndexedAccess` obliga a demostrar el rango. */
function en<T>(lista: readonly T[], indice: number): T {
  const valor = lista[indice]
  if (valor === undefined) {
    throw new Error(`Índice ${indice} fuera de rango (0..${lista.length - 1}).`)
  }
  return valor
}

/**
 * Redondeo a la mitad al par.
 *
 * Es el que usa Python, y el que produjo la tabla publicada. `Math.round` redondea
 * la mitad hacia arriba, así que en los pocos casos en que un canal cae justo en
 * `x.5` daría un valor distinto y el generador dejaría de reproducir el documento.
 */
function redondear(v: number): number {
  const suelo = Math.floor(v)
  const resto = v - suelo
  if (resto > 0.5) return suelo + 1
  if (resto < 0.5) return suelo
  return suelo % 2 === 0 ? suelo : suelo + 1
}

interface Hls {
  h: number
  l: number
  s: number
}

/** RGB (0..255) a HLS con los componentes en 0..1, como `colorsys.rgb_to_hls`. */
function aHls(rgb: Rgb): Hls {
  const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] as const
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const suma = max + min
  const dif = max - min
  const l = suma / 2

  if (max === min) return { h: 0, l, s: 0 }

  const s = l <= 0.5 ? dif / suma : dif / (2 - max - min)
  const rc = (max - r) / dif
  const gc = (max - g) / dif
  const bc = (max - b) / dif

  let h: number
  if (r === max) h = bc - gc
  else if (g === max) h = 2 + rc - bc
  else h = 4 + gc - rc

  h = (((h / 6) % 1) + 1) % 1
  return { h, l, s }
}

/** HLS (0..1) a RGB (0..255), como `colorsys.hls_to_rgb`. */
function aRgb255(h: number, l: number, s: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]

  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s
  const m1 = 2 * l - m2

  const componente = (entrada: number): number => {
    let x = ((entrada % 1) + 1) % 1
    if (x < 1 / 6) return m1 + (m2 - m1) * x * 6
    if (x < 1 / 2) return m2
    if (x < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - x) * 6
    return m1
  }

  return [
    componente(h + 1 / 3) * 255,
    componente(h) * 255,
    componente(h - 1 / 3) * 255,
  ]
}

export interface OpcionesDeEscala {
  /** Cuánta saturación conserva el paso más claro. Baja para que no se lave. */
  saturacionEnClaro?: number
  /** Cuánta saturación gana el paso más oscuro. Sube para conservar el carácter. */
  saturacionEnOscuro?: number
}

/**
 * Deriva los doce pasos de una escala desde su ancla.
 *
 * `pasoAncla` es el paso donde el color indicado cae naturalmente: 900 para un
 * color oscuro como el violeta de marca, 600 para uno de luminosidad media como el
 * naranja de acción. Ese paso sale exacto.
 */
export function derivarEscala(
  ancla: string,
  pasoAncla: Paso,
  opciones: OpcionesDeEscala = {},
): Record<Paso, string> {
  const saturacionEnClaro = opciones.saturacionEnClaro ?? 0.45
  const saturacionEnOscuro = opciones.saturacionEnOscuro ?? 0.92

  const base = aRgb(ancla)
  const { h, l, s } = aHls(base)
  const indiceAncla = PASOS.indexOf(pasoAncla)
  const ultimo = PASOS.length - 1

  const salida = {} as Record<Paso, string>

  for (let i = 0; i < PASOS.length; i++) {
    const paso = en(PASOS, i)

    let luminosidad: number
    if (i === indiceAncla) {
      luminosidad = l
    } else if (i < indiceAncla) {
      const t = i / indiceAncla
      luminosidad = RAMPA[0]! + (l - en(RAMPA, 0)) * t ** 1.35
    } else {
      const t = (i - indiceAncla) / (ultimo - indiceAncla)
      luminosidad = l + (en(RAMPA, ultimo) - l) * t ** 0.85
    }

    let factor: number
    if (i < indiceAncla) {
      factor = saturacionEnClaro + (1 - saturacionEnClaro) * (i / indiceAncla) ** 1.5
    } else if (i > indiceAncla) {
      factor = 1 + (saturacionEnOscuro - 1) * ((i - indiceAncla) / (ultimo - indiceAncla))
    } else {
      factor = 1
    }

    const saturacion = Math.min(1, s * factor)
    const rgb = aRgb255(h, luminosidad, saturacion)
    salida[paso] = aHex([redondear(rgb[0]), redondear(rgb[1]), redondear(rgb[2])])
  }

  return salida
}

/**
 * Deriva la escala neutra a partir del tono de la marca.
 *
 * No es gris puro: lleva un 10% de la saturación del violeta. Medido, un gris
 * neutro al lado de `#261A66` se lee sucio; con el sesgo, la familia entera
 * parece del mismo material.
 */
export function derivarNeutral(ancla: string, saturacion = 0.1): Record<Paso, string> {
  const { h } = aHls(aRgb(ancla))
  const salida = {} as Record<Paso, string>

  for (let i = 0; i < PASOS.length; i++) {
    const paso = en(PASOS, i)
    const rgb = aRgb255(h, en(RAMPA, i), saturacion)
    salida[paso] = aHex([redondear(rgb[0]), redondear(rgb[1]), redondear(rgb[2])])
  }

  return salida
}
