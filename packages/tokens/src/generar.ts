/**
 * Generador de artefactos del sistema de diseño.
 *
 * Escribe tres archivos a partir de las escalas y los roles:
 *
 *   · `generated/tokens.css`  — las variables CSS que consume la aplicación.
 *   · `generated/theme.ts`    — los mismos valores como módulo TypeScript, para los
 *                               gráficos, que necesitan el color como valor y no
 *                               como referencia a una variable.
 *   · `generated/tokens.json` — el volcado completo, para herramientas de diseño y
 *                               para la suite de contraste.
 *
 * Los tres se **commitean**. No es una comodidad: es lo que evita que la aplicación
 * dependa de que alguien se acuerde de generar antes de compilar. Y como están
 * commiteados, hace falta una puerta que impida que se desincronicen de la fuente,
 * que es lo que hace `--check`:
 *
 *     node src/generar.ts           # regenera
 *     node src/generar.ts --check   # falla si el resultado no coincide con la fuente
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.10.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PASOS } from './derivar.ts'
import { ESCALAS, LIENZO, PALETA_INDICADA, SEMANTICOS, SERIES } from './escalas.ts'
import type { NombreDeEscala } from './escalas.ts'
import {
  ALTO,
  DENSIDAD,
  ESPACIADO,
  LAYOUT,
  MOVIMIENTO,
  RADIOS,
  SOMBRAS,
} from './geometria.ts'
import { ROLES, ROLES_DE_LIENZO } from './roles.ts'
import type { Rol, Tema } from './roles.ts'
import { CIFRAS_TABULARES, ESCALA, FAMILIAS, PESOS } from './tipografia.ts'

const RAIZ = join(import.meta.dirname, '..')
const SALIDA = join(RAIZ, 'generated')

const CABECERA = `/*
 * ARCHIVO GENERADO — no editar a mano.
 *
 * Fuente: packages/tokens/src/{escalas,roles,tipografia,geometria}.ts
 * Regenerar: npm run generate --workspace @control/tokens
 * Verificar: npm run check --workspace @control/tokens
 */`

const ESCALAS_NOMBRES = Object.keys(ESCALAS) as NombreDeEscala[]
const TEMAS: readonly Tema[] = ['claro', 'oscuro']

function nombreDeEscala(nombre: NombreDeEscala, paso: number): string {
  return `--control-${nombre}-${paso}`
}

function construirCss(): string {
  const lineas: string[] = [CABECERA, '']

  lineas.push(':root {')
  lineas.push('  /* ---- Paleta indicada: las únicas constantes escritas a mano ---- */')
  lineas.push(`  --control-white: ${PALETA_INDICADA.white};`)
  lineas.push(`  --control-orange: ${PALETA_INDICADA.orange};`)
  lineas.push(`  --control-scarlet: ${PALETA_INDICADA.scarlet};`)
  lineas.push('')

  lineas.push('  /* ---- Tonos de lienzo, muestreados de la imagen de referencia ---- */')
  for (const [nombre, valor] of Object.entries(ROLES_DE_LIENZO)) {
    lineas.push(`  --control-${nombre}: ${valor};`)
  }
  lineas.push('')

  for (const nombre of ESCALAS_NOMBRES) {
    lineas.push(`  /* ---- Escala ${nombre} ---- */`)
    for (const paso of PASOS) {
      lineas.push(`  ${nombreDeEscala(nombre, paso)}: ${ESCALAS[nombre][paso]};`)
    }
    lineas.push('')
  }

  lineas.push('  /* ---- Semánticos: base, fondo suave y tinta ---- */')
  for (const [nombre, valores] of Object.entries(SEMANTICOS)) {
    lineas.push(`  --control-${nombre}: ${valores.base};`)
    lineas.push(`  --control-${nombre}-suave: ${valores.claro};`)
    lineas.push(`  --control-${nombre}-tinta: ${valores.profundo};`)
  }
  lineas.push('')

  lineas.push('  /* ---- Series de gráfico, en orden ---- */')
  SERIES.forEach((color, i) => {
    lineas.push(`  --control-serie-${i + 1}: ${color};`)
  })
  lineas.push('')

  lineas.push(...bloqueDeRoles('claro'))
  lineas.push(...bloqueDeTipografia())
  lineas.push(...bloqueDeGeometria())
  lineas.push('}')

  lineas.push('')
  lineas.push('/*')
  lineas.push(' * Tema oscuro: el mismo sistema con otros valores.')
  lineas.push(' *')
  lineas.push(' * Su regla propia es que TODA superficie lleva borde. No es estética: sobre la')
  lineas.push(' * familia violeta las superficies entre sí no pasan de 1,6:1, así que el borde es')
  lineas.push(' * el único separador disponible para cumplir 1.4.11.')
  lineas.push(' */')
  lineas.push('[data-tema="oscuro"] {')
  lineas.push(...bloqueDeRoles('oscuro', '  '))
  lineas.push(...bloqueDeSombras('oscuro'))
  lineas.push('}')

  lineas.push('')
  lineas.push('/* El modo reducido se aplica globalmente, no componente por componente. */')
  lineas.push('@media (prefers-reduced-motion: reduce) {')
  lineas.push('  :root {')
  lineas.push('    --control-dur-rapida: 0ms;')
  lineas.push('    --control-dur-normal: 0ms;')
  lineas.push('    --control-dur-lenta: 0ms;')
  lineas.push('  }')
  lineas.push('}')
  lineas.push('')

  return lineas.join('\n')
}

function bloqueDeRoles(tema: Tema, sangria = '  '): string[] {
  const lineas: string[] = [`${sangria}/* ---- Roles · tema ${tema} ---- */`]
  for (const [rol, valor] of Object.entries(ROLES[tema]) as [Rol, string][]) {
    lineas.push(`${sangria}--control-${rol}: ${valor};`)
  }
  return lineas
}

function bloqueDeSombras(tema: Tema): string[] {
  const s = SOMBRAS[tema]
  return [
    '',
    '  /* ---- Elevación ---- */',
    `  --control-sombra-sm: ${s.sm};`,
    `  --control-sombra: ${s.normal};`,
    `  --control-sombra-lg: ${s.lg};`,
  ]
}

function bloqueDeTipografia(): string[] {
  const lineas: string[] = ['', '  /* ---- Tipografía ---- */']
  lineas.push(`  --control-fuente-titulos: ${FAMILIAS.titulos};`)
  lineas.push(`  --control-fuente-cuerpo: ${FAMILIAS.cuerpo};`)
  lineas.push(`  --control-fuente-mono: ${FAMILIAS.mono};`)
  for (const [nombre, paso] of Object.entries(ESCALA)) {
    lineas.push(`  --control-texto-${nombre}: ${paso.tamano}px;`)
    lineas.push(`  --control-interlinea-${nombre}: ${paso.interlinea}px;`)
  }
  for (const [nombre, valor] of Object.entries(PESOS)) {
    lineas.push(`  --control-peso-${nombre}: ${valor};`)
  }
  lineas.push(`  --control-cifras: ${CIFRAS_TABULARES};`)
  return lineas
}

function bloqueDeGeometria(): string[] {
  const lineas: string[] = ['', '  /* ---- Geometría ---- */']
  for (const [nombre, valor] of Object.entries(ESPACIADO)) {
    lineas.push(`  --control-esp-${nombre}: ${valor}px;`)
  }
  for (const [nombre, valor] of Object.entries(RADIOS)) {
    lineas.push(`  --control-radio${nombre === 'normal' ? '' : `-${nombre}`}: ${valor}px;`)
  }
  lineas.push(`  --control-sombra-sm: ${SOMBRAS.claro.sm};`)
  lineas.push(`  --control-sombra: ${SOMBRAS.claro.normal};`)
  lineas.push(`  --control-sombra-lg: ${SOMBRAS.claro.lg};`)
  lineas.push(`  --control-dur-rapida: ${MOVIMIENTO.rapida}ms;`)
  lineas.push(`  --control-dur-normal: ${MOVIMIENTO.normal}ms;`)
  lineas.push(`  --control-dur-lenta: ${MOVIMIENTO.lenta}ms;`)
  lineas.push(`  --control-curva: ${MOVIMIENTO.curva};`)
  lineas.push(`  --control-ancho-carcasa: ${LAYOUT.anchoCarcasa}px;`)
  lineas.push(`  --control-ancho-carcasa-colapsada: ${LAYOUT.anchoCarcasaColapsada}px;`)
  lineas.push(`  --control-alto-encabezado: ${LAYOUT.altoEncabezado}px;`)
  lineas.push(`  --control-ancho-max-contenido: ${LAYOUT.anchoMaxContenido}px;`)
  lineas.push(`  --control-objetivo-tactil: ${LAYOUT.objetivoTactil}px;`)
  lineas.push(`  --control-densidad: ${DENSIDAD.comoda};`)
  lineas.push(`  --control-alto-fila: calc(${ALTO.fila}px * var(--control-densidad));`)
  lineas.push(`  --control-alto-control: calc(${ALTO.control}px * var(--control-densidad));`)
  return lineas
}

function construirTheme(): string {
  const lineas: string[] = [CABECERA, '']
  lineas.push('export type Tema = ' + TEMAS.map((t) => `'${t}'`).join(' | '))
  lineas.push('')
  lineas.push('/** Las tres escalas, con el paso del ancla exacto. */')
  lineas.push('export const ESCALAS = {')
  for (const nombre of ESCALAS_NOMBRES) {
    lineas.push(`  ${nombre}: {`)
    for (const paso of PASOS) {
      lineas.push(`    ${paso}: '${ESCALAS[nombre][paso]}',`)
    }
    lineas.push('  },')
  }
  lineas.push('} as const')
  lineas.push('')
  lineas.push('/** Los tres colores indicados. */')
  lineas.push('export const PALETA_INDICADA = {')
  for (const [nombre, valor] of Object.entries(PALETA_INDICADA)) {
    lineas.push(`  ${nombre}: '${valor}',`)
  }
  lineas.push('} as const')
  lineas.push('')
  lineas.push('/** Los tonos de lienzo. */')
  lineas.push('export const LIENZO = {')
  for (const [nombre, valor] of Object.entries(LIENZO)) {
    lineas.push(`  ${nombre}: '${valor}',`)
  }
  lineas.push('} as const')
  lineas.push('')
  lineas.push('/** Cada semántico con sus tres valores. */')
  lineas.push('export const SEMANTICOS = {')
  for (const [nombre, valores] of Object.entries(SEMANTICOS)) {
    lineas.push(`  ${nombre}: { base: '${valores.base}', suave: '${valores.claro}', tinta: '${valores.profundo}' },`)
  }
  lineas.push('} as const')
  lineas.push('')
  lineas.push('/** Orden de las series de gráfico. */')
  lineas.push('export const SERIES = [')
  for (const color of SERIES) lineas.push(`  '${color}',`)
  lineas.push('] as const')
  lineas.push('')
  lineas.push('/** Los roles de color resueltos, por tema. */')
  lineas.push('export const ROLES = {')
  for (const tema of TEMAS) {
    lineas.push(`  ${tema}: {`)
    for (const [rol, valor] of Object.entries(ROLES[tema]) as [Rol, string][]) {
      lineas.push(`    '${rol}': '${valor}',`)
    }
    lineas.push('  },')
  }
  lineas.push('} as const')
  lineas.push('')
  lineas.push('export type NombreDeRol = keyof (typeof ROLES)[' + `'claro'` + ']')
  lineas.push('')
  lineas.push('/** Devuelve el color de un rol en un tema. Falla si el rol no existe. */')
  lineas.push('export function rol(tema: Tema, nombre: NombreDeRol): string {')
  lineas.push('  return ROLES[tema][nombre]')
  lineas.push('}')
  lineas.push('')
  return lineas.join('\n')
}

function construirJson(): string {
  return (
    JSON.stringify(
      {
        nota: 'Generado por packages/tokens/src/generar.ts. No editar a mano.',
        paletaIndicada: PALETA_INDICADA,
        lienzo: LIENZO,
        escalas: ESCALAS,
        semanticos: SEMANTICOS,
        series: SERIES,
        roles: ROLES,
        tipografia: { familias: FAMILIAS, escala: ESCALA, pesos: PESOS },
        geometria: {
          espaciado: ESPACIADO,
          radios: RADIOS,
          sombras: SOMBRAS,
          movimiento: MOVIMIENTO,
          layout: LAYOUT,
          densidad: DENSIDAD,
          alto: ALTO,
        },
      },
      null,
      2,
    ) + '\n'
  )
}

interface Artefacto {
  ruta: string
  contenido: string
}

/** Los tres artefactos con su contenido esperado, sin tocar el disco. */
export function artefactos(): Artefacto[] {
  return [
    { ruta: join(SALIDA, 'tokens.css'), contenido: construirCss() },
    { ruta: join(SALIDA, 'theme.ts'), contenido: construirTheme() },
    { ruta: join(SALIDA, 'tokens.json'), contenido: construirJson() },
  ]
}

/** Escribe los tres artefactos. Devuelve las rutas relativas escritas. */
export function generar(): string[] {
  mkdirSync(SALIDA, { recursive: true })
  const escritos: string[] = []
  for (const { ruta, contenido } of artefactos()) {
    writeFileSync(ruta, contenido, 'utf8')
    escritos.push(ruta.slice(RAIZ.length + 1))
  }
  return escritos
}

/**
 * Artefactos commiteados que no coinciden con la fuente.
 *
 * Sin esta comprobación, el generador y los artefactos se separan en silencio:
 * alguien cambia un ancla, no regenera, y la aplicación sigue pintando la paleta
 * vieja mientras la suite de contraste verifica la nueva. Es el mismo defecto que el
 * proyecto ya corrigió en el lint de RLS y en el `tsconfig` raíz —un control que no
 * mira lo que dice mirar—.
 *
 * Devuelve la lista en vez de terminar el proceso: así la suite puede usarla y el
 * ejecutable decide qué hacer con el resultado.
 */
export function artefactosDesincronizados(): string[] {
  const desincronizados: string[] = []

  for (const { ruta, contenido } of artefactos()) {
    const relativo = ruta.slice(RAIZ.length + 1)
    let enDisco: string
    try {
      enDisco = readFileSync(ruta, 'utf8')
    } catch {
      desincronizados.push(`${relativo} (no existe)`)
      continue
    }
    if (enDisco !== contenido) desincronizados.push(relativo)
  }

  return desincronizados
}

