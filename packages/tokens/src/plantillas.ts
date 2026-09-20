import { contraste, cumple } from './contraste.ts'
import { PALETAS_DE_INQUILINO } from './paletas.ts'
import type { PaletaDeInquilino } from './paletas.ts'

/**
 * Las cinco plantillas por rubro, espejo de `app.ui_templates`.
 *
 * Una plantilla **no elige colores**: el color es del inquilino. Elige densidad, radio,
 * barra lateral y cuánto vidrio, y ordena los indicadores y los gráficos. Eso es
 * deliberado: si una plantilla pudiera elegir colores, cada rubro tendría su propia
 * paleta y la verificación de contraste dejaría de cubrir el producto —hay que probar
 * lo que se puede elegir, y lo que se puede elegir es el primario del inquilino.
 *
 * Los valores salen de `db/seed/0001_system_catalog.sql`, que es donde el motor los
 * tiene. `plantillas.test.ts` recorre el **producto cartesiano** de las 5 plantillas por
 * las 4 paletas y exige que las 20 combinaciones pasen AA: una plantilla no puede
 * romper el contraste de una paleta, y esa es exactamente la clase de interacción que
 * un test por separado no ve.
 */

export type Densidad = 'compact' | 'comfortable'
export type BarraLateral = 'expanded' | 'rail'

export interface PlantillaDeRubro {
  /** La clave del motor (`app.ui_templates.key`). */
  clave: string
  nombre: string
  rubro: string
  densidad: Densidad
  /** Cuánto vidrio, de 0 a 1. */
  intensidadDeVidrio: number
  /** Radio de las tarjetas, en píxeles. */
  radio: number
  barraLateral: BarraLateral
}

export const PLANTILLAS: readonly PlantillaDeRubro[] = [
  {
    clave: 'retail-glass',
    nombre: 'Retail Glass',
    rubro: 'retail',
    densidad: 'comfortable',
    intensidadDeVidrio: 0.72,
    radio: 20,
    barraLateral: 'expanded',
  },
  {
    clave: 'services-glass',
    nombre: 'Services Glass',
    rubro: 'services',
    densidad: 'comfortable',
    intensidadDeVidrio: 0.68,
    radio: 18,
    barraLateral: 'rail',
  },
  {
    clave: 'distributor-glass',
    nombre: 'Distributor Glass',
    rubro: 'distributor',
    densidad: 'compact',
    intensidadDeVidrio: 0.62,
    radio: 16,
    barraLateral: 'expanded',
  },
  {
    clave: 'logistics-glass',
    nombre: 'Logistics Glass',
    rubro: 'logistics',
    densidad: 'compact',
    intensidadDeVidrio: 0.58,
    radio: 14,
    barraLateral: 'rail',
  },
  {
    clave: 'mixed-glass',
    nombre: 'Mixed Glass',
    rubro: 'mixed',
    densidad: 'comfortable',
    intensidadDeVidrio: 0.7,
    radio: 20,
    barraLateral: 'expanded',
  },
]

export function plantillaPorClave(clave: string): PlantillaDeRubro | null {
  return PLANTILLAS.find((plantilla) => plantilla.clave === clave) ?? null
}

/** Los límites que una plantilla tiene que respetar. */
export const LIMITES = {
  intensidadDeVidrio: { minimo: 0.4, maximo: 0.9 },
  radio: { minimo: 12, maximo: 24 },
} as const

/**
 * Verifica una plantilla sobre una paleta.
 *
 * Devuelve los problemas encontrados, no un booleano: quien llama tiene que poder decir
 * **qué** está mal, y una lista vacía es la única señal de conformidad.
 */
export function verificarPlantilla(
  plantilla: PlantillaDeRubro,
  paleta: PaletaDeInquilino,
): string[] {
  const problemas: string[] = []

  // 1 · La tinta derivada tiene que pasar AA sobre el primario del inquilino. Es la
  //     cláusula de la puerta, comprobada en cada combinación.
  const relacion = contraste(paleta.tintaSobrePrimario, paleta.primario)
  if (!cumple(relacion, 'AA')) {
    problemas.push(
      `${plantilla.clave} × ${paleta.slug}: la tinta ${paleta.tintaSobrePrimario} da ${relacion.toFixed(2)}:1 sobre ${paleta.primario}, y AA pide 4,5:1`,
    )
  }

  // 2 · La geometría tiene que estar en rango. Un radio de 40 px o un vidrio de 1 no
  //     rompen el contraste, pero rompen la interfaz.
  if (
    plantilla.intensidadDeVidrio < LIMITES.intensidadDeVidrio.minimo ||
    plantilla.intensidadDeVidrio > LIMITES.intensidadDeVidrio.maximo
  ) {
    problemas.push(
      `${plantilla.clave}: intensidad de vidrio ${plantilla.intensidadDeVidrio} fuera de [${LIMITES.intensidadDeVidrio.minimo}, ${LIMITES.intensidadDeVidrio.maximo}]`,
    )
  }
  if (plantilla.radio < LIMITES.radio.minimo || plantilla.radio > LIMITES.radio.maximo) {
    problemas.push(
      `${plantilla.clave}: radio ${plantilla.radio} fuera de [${LIMITES.radio.minimo}, ${LIMITES.radio.maximo}]`,
    )
  }

  return problemas
}

/**
 * Las variables CSS de una combinación de plantilla y paleta.
 *
 * Es una función **pura** de sus dos entradas: aplicar una plantilla es recalcular este
 * objeto y escribirlo en el elemento, sin pedirle nada al servidor. Ésa es la razón por
 * la que cambiar de plantilla no recarga: no hay ninguna consulta en el camino.
 */
export function variablesDeTema(
  plantilla: PlantillaDeRubro,
  paleta: PaletaDeInquilino,
): Record<string, string> {
  return {
    '--control-primario': paleta.primario,
    '--control-tinta-sobre-primario': paleta.tintaSobrePrimario,
    '--control-densidad': plantilla.densidad === 'compact' ? '0.86' : '1',
    '--control-radio-tarjeta': `${plantilla.radio}px`,
    '--control-vidrio': String(plantilla.intensidadDeVidrio),
    '--control-barra-lateral': plantilla.barraLateral === 'rail' ? 'rail' : 'expanded',
  }
}
