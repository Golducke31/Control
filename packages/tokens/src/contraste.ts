/**
 * Aritmética de contraste según WCAG 2.2.
 *
 * Es la base de todo el sistema de color: los tokens no se eligen por gusto sino
 * por el número que sale de acá. Por eso vive en el paquete de tokens y no en la
 * suite de tests —el generador y la aplicación necesitan los mismos cálculos—.
 *
 * Fórmulas de la recomendación:
 *   · luminancia relativa: 0.2126·R + 0.7152·G + 0.0722·B, con cada canal
 *     linealizado (los valores bajos divididos por 12.92, el resto por la
 *     transformación de gamma).
 *   · relación de contraste: (L_claro + 0.05) / (L_oscuro + 0.05).
 */

export type Rgb = readonly [number, number, number]

/** Niveles de conformidad que el sistema usa. */
export type Nivel = 'AAA' | 'AA' | 'AA-texto-grande' | 'no-cumple'

/** Lo que se le puede exigir a un par de colores. */
export type Exigencia = Nivel

const HEX = /^#([0-9a-fA-F]{6})$/

/**
 * Convierte «#RRGGBB» a sus tres canales.
 *
 * Falla ruidosamente ante cualquier otra forma: un color mal escrito en un token
 * tiene que romper la generación, no producir un color parecido en silencio.
 */
export function aRgb(valor: string): Rgb {
  const encontrado = HEX.exec(valor.trim())
  const cuerpo = encontrado?.[1]
  if (cuerpo === undefined) {
    throw new Error(
      `Color hexadecimal inválido: ${JSON.stringify(valor)}. Se espera la forma «#RRGGBB».`,
    )
  }
  const n = Number.parseInt(cuerpo, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** Vuelve de los tres canales a «#RRGGBB», en mayúsculas. */
export function aHex(rgb: Rgb): string {
  const canal = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${canal(rgb[0])}${canal(rgb[1])}${canal(rgb[2])}`
}

/** Acepta un hex o un Rgb ya resuelto. */
function normalizar(valor: string | Rgb): Rgb {
  return typeof valor === 'string' ? aRgb(valor) : valor
}

/** Luminancia relativa, entre 0 y 1. */
export function luminancia(valor: string | Rgb): number {
  const [r, g, b] = normalizar(valor)
  const canal = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b)
}

/** Relación de contraste entre dos colores. Va de 1 a 21, y es simétrica. */
export function contraste(a: string | Rgb, b: string | Rgb): number {
  const la = luminancia(a)
  const lb = luminancia(b)
  const claro = Math.max(la, lb)
  const oscuro = Math.min(la, lb)
  return (claro + 0.05) / (oscuro + 0.05)
}

/**
 * Umbrales de la recomendación.
 *
 * `AA-texto-grande` existe porque WCAG baja el mínimo a 3:1 para texto de 19px
 * en negrita o 24px normal. El sistema lo usa para habilitar combinaciones que
 * serían ilegibles en cuerpo —como el blanco sobre el naranja de marca— y **sólo**
 * en titulares.
 */
const MINIMOS: Record<Nivel, number> = {
  AAA: 7,
  AA: 4.5,
  'AA-texto-grande': 3,
  'no-cumple': 0,
}

/** El nivel más alto que un par de colores alcanza. */
export function nivelDe(relacion: number): Nivel {
  if (relacion >= MINIMOS.AAA) return 'AAA'
  if (relacion >= MINIMOS.AA) return 'AA'
  if (relacion >= MINIMOS['AA-texto-grande']) return 'AA-texto-grande'
  return 'no-cumple'
}

/** Si un par de colores satisface la exigencia pedida. */
export function cumple(relacion: number, exigido: Exigencia): boolean {
  return relacion >= MINIMOS[exigido]
}

/**
 * Aclara u oscurece un color mezclándolo con blanco o con negro.
 *
 * Se usa para derivar la tinta legible sobre un color cualquiera —el primario de
 * un inquilino, por ejemplo— sin tener que fijarla a mano.
 */
export function mezclar(valor: string | Rgb, hacia: 'blanco' | 'negro', cantidad: number): Rgb {
  const [r, g, b] = normalizar(valor)
  const objetivo = hacia === 'blanco' ? 255 : 0
  const k = Math.max(0, Math.min(1, cantidad))
  return [r + (objetivo - r) * k, g + (objetivo - g) * k, b + (objetivo - b) * k]
}

/**
 * Elige la tinta legible sobre un fondo dado.
 *
 * Prueba las dos candidatas del sistema —blanco y la tinta máxima de la marca— y
 * devuelve la que más contraste da. Si ninguna alcanza AA, devuelve la mejor y lo
 * informa, para que quien llama pueda avisar en vez de publicar un texto ilegible.
 *
 * Existe porque el sistema de marca escribe texto sobre el color del inquilino, y
 * medido sobre las paletas reales tres de las cuatro del prototipo dejaban el
 * blanco por debajo del mínimo.
 */
export function tintaSobre(
  fondo: string | Rgb,
  candidatas: readonly string[],
): { tinta: string; relacion: number; conforme: boolean } {
  if (candidatas.length === 0) {
    throw new Error('tintaSobre necesita al menos una candidata.')
  }
  let mejor = { tinta: candidatas[0] as string, relacion: 0, conforme: false }
  for (const candidata of candidatas) {
    const relacion = contraste(candidata, fondo)
    if (relacion > mejor.relacion) {
      mejor = { tinta: candidata, relacion, conforme: cumple(relacion, 'AA') }
    }
  }
  return mejor
}
