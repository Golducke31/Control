/*
 * ARCHIVO GENERADO — no editar a mano.
 *
 * Fuente: packages/tokens/src/{escalas,roles,tipografia,geometria}.ts
 * Regenerar: npm run generate --workspace @control/tokens
 * Verificar: npm run check --workspace @control/tokens
 */

export type Tema = 'claro' | 'oscuro'

/** Las tres escalas, con el paso del ancla exacto. */
export const ESCALAS = {
  scarlet: {
    50: '#F7F7FA',
    100: '#ECEBF4',
    200: '#DAD7EA',
    300: '#C4BFDF',
    400: '#AAA2D4',
    500: '#8C81C9',
    600: '#6B5BC0',
    700: '#4E3CAF',
    800: '#392A8C',
    900: '#261A66',
    950: '#1A1243',
    990: '#100C27',
  },
  orange: {
    50: '#FBF8F6',
    100: '#F5ECE7',
    200: '#EED9CE',
    300: '#E8C1AD',
    400: '#E5A485',
    500: '#E78453',
    600: '#EF5F18',
    700: '#C24A0F',
    800: '#993B0D',
    900: '#732D0B',
    950: '#502008',
    990: '#2E1305',
  },
  neutral: {
    50: '#F8F8F9',
    100: '#F0F0F2',
    200: '#E2E2E7',
    300: '#CDCBD5',
    400: '#B1AFBE',
    500: '#9390A4',
    600: '#76728B',
    700: '#5B586C',
    800: '#444150',
    900: '#312F3A',
    950: '#222129',
    990: '#18171C',
  },
} as const

/** Los tres colores indicados. */
export const PALETA_INDICADA = {
  white: '#FFFFFF',
  orange: '#EF5F18',
  scarlet: '#261A66',
} as const

/** Los tonos de lienzo. */
export const LIENZO = {
  canvas: '#130D36',
  profundo: '#1E154C',
  medio: '#3D3165',
  claro: '#E7E4E8',
} as const

/** Cada semántico con sus tres valores. */
export const SEMANTICOS = {
  exito: { base: '#2FC48A', suave: '#DEEDE7', tinta: '#1C7653' },
  atencion: { base: '#F5B22E', suave: '#F1E9DA', tinta: '#8E6007' },
  peligro: { base: '#F2555A', suave: '#F0DBDB', tinta: '#C50F15' },
  informacion: { base: '#539BF5', suave: '#DAE4F1', tinta: '#0C60C9' },
} as const

/** Orden de las series de gráfico. */
export const SERIES = [
  '#6B5BC0',
  '#EF5F18',
  '#9390A4',
  '#2FC48A',
  '#539BF5',
  '#F5B22E',
  '#F2555A',
] as const

/** Los roles de color resueltos, por tema. */
export const ROLES = {
  claro: {
    'fondo-carcasa': '#100C27',
    'fondo-carcasa-sutil': '#392A8C',
    'fondo-lienzo': '#F7F7FA',
    'fondo-tarjeta': '#FFFFFF',
    'fondo-sutil': '#F0F0F2',
    'fondo-invertido': '#261A66',
    'fondo-accion': '#EF5F18',
    'texto-sobre-carcasa': '#F0F0F2',
    'texto-sobre-carcasa-sutil': '#B1AFBE',
    'texto-principal': '#261A66',
    'texto-secundario': '#444150',
    'texto-terciario': '#5B586C',
    'texto-deshabilitado': '#9390A4',
    'texto-sobre-accion': '#100C27',
    'texto-sobre-peligro': '#FFFFFF',
    'texto-sobre-invertido': '#FFFFFF',
    'texto-acento': '#993B0D',
    'borde-sutil': '#E2E2E7',
    'borde-control': '#76728B',
    'borde-accion': '#EF5F18',
    'foco': '#EF5F18',
    'estado-exito': '#2FC48A',
    'estado-exito-suave': '#DEEDE7',
    'estado-exito-tinta': '#1C7653',
    'estado-atencion': '#F5B22E',
    'estado-atencion-suave': '#F1E9DA',
    'estado-atencion-tinta': '#8E6007',
    'estado-peligro': '#F2555A',
    'estado-peligro-suave': '#F0DBDB',
    'estado-peligro-tinta': '#C50F15',
    'estado-informacion': '#539BF5',
    'estado-informacion-suave': '#DAE4F1',
    'estado-informacion-tinta': '#0C60C9',
  },
  oscuro: {
    'fondo-carcasa': '#130D36',
    'fondo-carcasa-sutil': '#261A66',
    'fondo-lienzo': '#100C27',
    'fondo-tarjeta': '#1E154C',
    'fondo-sutil': '#1A1243',
    'fondo-invertido': '#261A66',
    'fondo-accion': '#EF5F18',
    'texto-sobre-carcasa': '#F0F0F2',
    'texto-sobre-carcasa-sutil': '#B1AFBE',
    'texto-principal': '#F0F0F2',
    'texto-secundario': '#CDCBD5',
    'texto-terciario': '#B1AFBE',
    'texto-deshabilitado': '#9390A4',
    'texto-sobre-accion': '#100C27',
    'texto-sobre-peligro': '#100C27',
    'texto-sobre-invertido': '#FFFFFF',
    'texto-acento': '#E5A485',
    'borde-sutil': '#3D3165',
    'borde-control': '#8C81C9',
    'borde-accion': '#EF5F18',
    'foco': '#EF5F18',
    'estado-exito': '#2FC48A',
    'estado-exito-suave': '#082319',
    'estado-exito-tinta': '#2FC48A',
    'estado-atencion': '#F5B22E',
    'estado-atencion-suave': '#2C2008',
    'estado-atencion-tinta': '#F5B22E',
    'estado-peligro': '#F2555A',
    'estado-peligro-suave': '#2C0F10',
    'estado-peligro-tinta': '#F2555A',
    'estado-informacion': '#539BF5',
    'estado-informacion-suave': '#0F1C2C',
    'estado-informacion-tinta': '#539BF5',
  },
} as const

export type NombreDeRol = keyof (typeof ROLES)['claro']

/** Devuelve el color de un rol en un tema. Falla si el rol no existe. */
export function rol(tema: Tema, nombre: NombreDeRol): string {
  return ROLES[tema][nombre]
}
