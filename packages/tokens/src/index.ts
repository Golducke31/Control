/**
 * @control/tokens — el sistema de diseño de Control.
 *
 * Fuente única de color, tipografía y geometría. Los componentes no escriben
 * colores: leen roles.
 *
 * Tres formas de consumirlo, según quién pregunte:
 *
 *   · La aplicación, por CSS:  import '@control/tokens/tokens.css'
 *   · Los gráficos, por valor: import { ROLES } from '@control/tokens'
 *   · Las herramientas, por dato: generated/tokens.json
 *
 * `generar.ts` **no** se exporta a propósito: es un programa, corre al importarse
 * y escribiría archivos cada vez que alguien pida un color.
 */

export {
  aHex,
  aRgb,
  contraste,
  cumple,
  luminancia,
  mezclar,
  nivelDe,
  tintaSobre,
} from './contraste.ts'
export type { Exigencia, Nivel, Rgb } from './contraste.ts'

export { PASOS, derivarEscala, derivarNeutral } from './derivar.ts'
export type { OpcionesDeEscala, Paso } from './derivar.ts'

export { ANCLAS, ESCALAS, LIENZO, PALETA_INDICADA, SEMANTICOS, SERIES, paso } from './escalas.ts'
export type { NombreDeEscala, NombreDeSemantico } from './escalas.ts'

export { ROLES, ROLES_CLARO, ROLES_DE_LIENZO, ROLES_OSCURO } from './roles.ts'
export type { NombreDeRol, Rol, RolDeEstado, Tema } from './roles.ts'

export { PARES, describirViolacion, verificarRoles } from './verificacion.ts'
export type { ParVerificado, Violacion } from './verificacion.ts'

export {
  CIFRAS_TABULARES,
  ESCALA,
  FAMILIAS,
  PESOS,
  UMBRAL_TEXTO_GRANDE,
} from './tipografia.ts'
export type { NombreDeTexto, PasoDeTexto } from './tipografia.ts'

export {
  ALTO,
  DENSIDAD,
  ESPACIADO,
  LAYOUT,
  MOVIMIENTO,
  RADIOS,
  SOMBRAS,
} from './geometria.ts'
export type { NombreDeDensidad } from './geometria.ts'

export {
  PALETAS_DE_INQUILINO,
  PRIMARIOS_DE_INQUILINO,
  paletaDeInquilino,
  paletaPorSlug,
  tintaDelPrototipo,
} from './paletas.ts'
export type { PaletaDeInquilino, PrimarioDeInquilino } from './paletas.ts'

export {
  LIMITES,
  PLANTILLAS,
  plantillaPorClave,
  variablesDeTema,
  verificarPlantilla,
} from './plantillas.ts'
export type { BarraLateral, Densidad, PlantillaDeRubro } from './plantillas.ts'
