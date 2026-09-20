import { aHex, contraste, cumple, mezclar, tintaSobre } from './contraste.ts'

/**
 * Las cuatro paletas de inquilino.
 *
 * **El defecto que este módulo corrige.** El prototipo escribía texto blanco sobre el
 * color primario del inquilino **sin verificar nada**. Medido, tres de las cuatro
 * paletas dejaban el blanco por debajo del mínimo de AA: un cliente que eligiera verde
 * o rosa recibía una aplicación inaccesible, y nada lo avisaba.
 *
 * La corrección no es oscurecer los primarios —el color es del inquilino, no nuestro—
 * sino **derivar la tinta**: se prueban el blanco y una rampa de tonos oscurecidos del
 * propio primario, y se elige el que más contrasta. Con eso las cuatro pasan AA sin
 * tocar un solo color de marca.
 *
 * `paletas.test.ts` lo verifica, y además deja escrita la medición del defecto original
 * como prueba negativa: si alguien vuelve a fijar el blanco, el test dice cuáles fallan.
 */

export interface PrimarioDeInquilino {
  slug: string
  nombre: string
  /** El color que el inquilino elige. Es un **dato**, no una decisión de diseño. */
  primario: string
}

/** Los cuatro inquilinos del prototipo, con el primario que cada uno eligió. */
export const PRIMARIOS_DE_INQUILINO: readonly PrimarioDeInquilino[] = [
  { slug: 'andes', nombre: 'Andes Trading', primario: '#6D5EF8' },
  { slug: 'nordico', nombre: 'Nórdico Retail', primario: '#E879A6' },
  { slug: 'pampa', nombre: 'Pampa Logística', primario: '#10B981' },
  { slug: 'sur', nombre: 'Sur Servicios', primario: '#F97316' },
]

/**
 * Los escalones de oscurecimiento con los que se busca la tinta.
 *
 * Se mezcla el primario hacia el negro en cuatro pasos: el primero apenas lo apaga y el
 * último es casi negro. Con la rampa, un primario claro encuentra una tinta que pasa AA
 * sin salir de su propia familia de color.
 */
const ESCALONES_DE_TINTA = [0.4, 0.55, 0.7, 0.85] as const

export interface PaletaDeInquilino extends PrimarioDeInquilino {
  /** La tinta que se escribe **sobre** el primario. Derivada, nunca fijada a mano. */
  tintaSobrePrimario: string
  relacionDeTinta: number
  /** Verdadero cuando la tinta elegida alcanza AA sobre el primario. */
  conforme: boolean
}

/** Deriva la paleta completa de un inquilino a partir de su primario. */
export function paletaDeInquilino(primario: PrimarioDeInquilino): PaletaDeInquilino {
  const candidatas = [
    '#FFFFFF',
    ...ESCALONES_DE_TINTA.map((cantidad) => aHex(mezclar(primario.primario, 'negro', cantidad))),
  ]
  const elegida = tintaSobre(primario.primario, candidatas)
  return {
    ...primario,
    tintaSobrePrimario: elegida.tinta,
    relacionDeTinta: elegida.relacion,
    conforme: elegida.conforme,
  }
}

/** Las cuatro paletas ya derivadas. */
export const PALETAS_DE_INQUILINO: readonly PaletaDeInquilino[] = PRIMARIOS_DE_INQUILINO.map(paletaDeInquilino)

/** La paleta de un inquilino por su slug, o `null` si no existe. */
export function paletaPorSlug(slug: string): PaletaDeInquilino | null {
  return PALETAS_DE_INQUILINO.find((paleta) => paleta.slug === slug) ?? null
}

/**
 * Lo que hacía el prototipo: blanco fijo, sin medir.
 *
 * Se conserva como función para que la prueba negativa pueda reproducir el defecto y
 * afirmar **cuáles** de las cuatro paletas fallaban. Una prueba que dice «tres de cuatro
 * fallaban» sin decir cuáles no sirve para volver a comprobarlo el día que alguien
 * cambie un primario.
 */
export function tintaDelPrototipo(primario: string): {
  tinta: string
  relacion: number
  conforme: boolean
} {
  const relacion = contraste('#FFFFFF', primario)
  return { tinta: '#FFFFFF', relacion, conforme: cumple(relacion, 'AA') }
}
