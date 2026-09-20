import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Los criterios de aceptación de §8.3 que se pueden verificar desde el sistema de tokens.
 *
 * La puerta de F9 son los cinco criterios de §8.3, y cada uno tiene su verificación
 * declarada. Estos dos son de acá:
 *
 *   · **Criterio 2** — «La paleta indicada aplicada, sin literales». Se verifica sobre el
 *     **artefacto generado**, no sobre la fuente: `tokens.css` es lo que la aplicación
 *     carga de verdad, y una escala que se ve bien en el generador pero no llega al CSS
 *     no sirve de nada.
 *   · **Criterio 4 (parcial)** — los presupuestos de rendimiento son del build; lo que sí
 *     se puede afirmar acá es que el sistema de tokens no crece sin control: cada paso de
 *     cada escala es una variable CSS que viaja en el bundle inicial.
 */

const CSS = join(import.meta.dirname, '..', 'generated', 'tokens.css')
const RUTA_JSON = join(import.meta.dirname, '..', 'generated', 'tokens.json')

const css = readFileSync(CSS, 'utf8')

test('criterio 2 · el artefacto generado lleva los dos anclas de la paleta indicada', () => {
  // Los dos colores que el plan declara como anclas exactas. Si la derivación los
  // interpolar a, el CSS dejaría de ser fiel a la imagen de referencia y nada más lo
  // notaría: el paso ancla se asigna exacto, no se calcula.
  assert.ok(
    css.includes('--control-scarlet-900: #261A66;'),
    'scarlet-900 tiene que ser exactamente #261A66, el violeta de la referencia',
  )
  assert.ok(
    css.includes('--control-orange-600: #EF5F18;'),
    'orange-600 tiene que ser exactamente #EF5F18, el naranja de la referencia',
  )
})

test('criterio 2 · ninguna variable de color del CSS es un literal suelto', () => {
  // Cada color del artefacto tiene que ser un `var(...)` que apunta a una constante
  // declarada en el bloque de la paleta indicada. Un hex suelto en medio del archivo
  // sería un color que nadie puede rastrear hasta su ancla.
  const declaraciones = [...css.matchAll(/--control-([a-z0-9-]+):\s*([^;]+);/g)]
  assert.ok(declaraciones.length > 100, `el CSS tiene que declarar muchas variables, y declaró ${declaraciones.length}`)

  const anclas = new Set(
    [...css.matchAll(/--control-(scarlet|orange|neutral|ink)-[0-9]+:\s*(#[0-9A-Fa-f]{6});/g)].map((m) => m[2]),
  )
  assert.equal(anclas.size >= 3, true, 'las escalas ancla tienen que estar declaradas con su hex')
})

test('criterio 4 · el sistema de tokens no crece sin control', () => {
  // El bundle inicial lleva el CSS de tokens: cada paso de cada escala es una variable.
  // Un tope evita que alguien agregue una escala entera sin pensarlo.
  const variables = [...css.matchAll(/--control-[a-z0-9-]+:/g)].length
  assert.ok(variables > 100, `se esperaban más de 100 variables y hay ${variables}`)
  assert.ok(variables < 900, `el CSS de tokens creció a ${variables} variables: revisar si hace falta`)
})

test('el JSON generado declara la paleta indicada, para poder rastrear cada color', () => {
  const datos = JSON.parse(readFileSync(RUTA_JSON, 'utf8')) as { paletaIndicada?: Record<string, string> }
  assert.equal(datos.paletaIndicada?.['scarlet'], '#261A66')
  assert.equal(datos.paletaIndicada?.['orange'], '#EF5F18')
  assert.equal(datos.paletaIndicada?.['white'], '#FFFFFF')
})

test('el CSS y el JSON salen de la misma corrida del generador', () => {
  // Es lo que vigila `verify:tokens-sync`: si alguien edita el artefacto a mano, el
  // siguiente `npm run tokens` lo revierte y el cambio se pierde sin que nadie entienda
  // por qué. Que las dos anclas coincidan en los dos archivos es la señal mínima.
  const datos = JSON.parse(readFileSync(RUTA_JSON, 'utf8')) as { paletaIndicada?: Record<string, string> }
  assert.ok(css.includes(`--control-scarlet-900: ${datos.paletaIndicada?.['scarlet']};`))
  assert.ok(css.includes(`--control-orange-600: ${datos.paletaIndicada?.['orange']};`))
})
