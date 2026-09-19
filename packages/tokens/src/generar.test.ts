/**
 * Suite del generador.
 *
 * Dos cosas: que los artefactos commiteados estén sincronizados con la fuente, y que
 * esa comprobación **pueda fallar**. Lo segundo importa más que lo primero — una
 * puerta que siempre dice que sí no protege nada, y este repositorio ya tuvo dos
 * jobs del CI en ese estado.
 */

import assert from 'node:assert/strict'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { artefactos, artefactosDesincronizados } from './generar.ts'

const GENERADOS = join(import.meta.dirname, '..', 'generated')

test('los tres artefactos existen y están sincronizados con la fuente', () => {
  const desincronizados = artefactosDesincronizados()
  assert.deepEqual(
    desincronizados,
    [],
    'hay artefactos generados que no coinciden: ejecutar `npm run generate`',
  )
})

test('el generador es determinista: dos corridas dan exactamente lo mismo', () => {
  const primera = artefactos()
  const segunda = artefactos()
  assert.deepEqual(primera, segunda)
  assert.equal(primera.length, 3)
})

test('la comprobación de sincronización detecta un artefacto alterado', () => {
  const objetivo = join(GENERADOS, 'tokens.css')
  const original = readFileSync(objetivo, 'utf8')

  try {
    // Se rompe el artefacto como lo haría un cambio de ancla sin regenerar.
    writeFileSync(objetivo, original.replace('--control-scarlet-900: #261A66;', '--control-scarlet-900: #000000;'), 'utf8')
    const detectados = artefactosDesincronizados()
    assert.ok(
      detectados.some((r) => r.endsWith('tokens.css')),
      `la comprobación tiene que detectar tokens.css alterado, y devolvió: ${detectados.join(', ') || 'nada'}`,
    )
  } finally {
    writeFileSync(objetivo, original, 'utf8')
  }

  // Y al restaurarlo, vuelve a estar conforme.
  assert.deepEqual(artefactosDesincronizados(), [])
})

test('la comprobación detecta un artefacto que falta', () => {
  const objetivo = join(GENERADOS, 'tokens.json')
  const guardado = `${objetivo}.guardado`

  try {
    renameSync(objetivo, guardado)
    const detectados = artefactosDesincronizados()
    assert.ok(
      detectados.some((r) => r.includes('tokens.json')),
      `un artefacto ausente tiene que reportarse, y devolvió: ${detectados.join(', ') || 'nada'}`,
    )
  } finally {
    renameSync(guardado, objetivo)
  }

  assert.deepEqual(artefactosDesincronizados(), [])
})

test('el CSS lleva la paleta indicada, con el paso del ancla exacto', () => {
  const css = readFileSync(join(GENERADOS, 'tokens.css'), 'utf8')
  assert.match(css, /--control-scarlet-900: #261A66;/)
  assert.match(css, /--control-orange-600: #EF5F18;/)
  assert.match(css, /--control-white: #FFFFFF;/)
  // Y los tonos de lienzo, que no están declarados en la referencia.
  assert.match(css, /--control-lienzo-canvas: #130D36;/)
})

test('el CSS define los roles en los dos temas y el modo reducido', () => {
  const css = readFileSync(join(GENERADOS, 'tokens.css'), 'utf8')
  assert.match(css, /:root \{/)
  assert.match(css, /\[data-tema="oscuro"\] \{/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /--control-fondo-carcasa:/)
  assert.match(css, /--control-texto-sobre-accion:/)
  // El tema oscuro redefine los roles, no los repite con el mismo valor.
  const bloques = css.split('[data-tema="oscuro"]')
  assert.equal(bloques.length, 2, 'tiene que haber exactamente un bloque de tema oscuro')
})

test('el tema oscuro redefine los roles que cambian y no toca los que no', () => {
  const css = readFileSync(join(GENERADOS, 'tokens.css'), 'utf8')
  const [, oscuro = ''] = css.split('[data-tema="oscuro"]')
  // Cambian:
  assert.match(oscuro, /--control-fondo-tarjeta: #1E154C;/)
  assert.match(oscuro, /--control-texto-principal: #F0F0F2;/)
  // No cambian (el naranja de acción es el mismo en los dos temas):
  assert.match(oscuro, /--control-fondo-accion: #EF5F18;/)
})

test('el módulo generado expone los roles y una función de acceso', () => {
  const ts = readFileSync(join(GENERADOS, 'theme.ts'), 'utf8')
  assert.match(ts, /export const ROLES = \{/)
  assert.match(ts, /export const SERIES = \[/)
  assert.match(ts, /export function rol\(tema: Tema, nombre: NombreDeRol\): string/)
})

test('el JSON es válido y lleva la paleta, las escalas y los roles', () => {
  const crudo = readFileSync(join(GENERADOS, 'tokens.json'), 'utf8')
  const datos = JSON.parse(crudo) as {
    paletaIndicada: Record<string, string>
    escalas: Record<string, Record<string, string>>
    roles: Record<string, Record<string, string>>
  }
  assert.equal(datos.paletaIndicada['scarlet'], '#261A66')
  assert.equal(datos.escalas['scarlet']?.['900'], '#261A66')
  assert.equal(datos.escalas['orange']?.['600'], '#EF5F18')
  assert.equal(datos.roles['claro']?.['fondo-tarjeta'], '#FFFFFF')
  assert.equal(datos.roles['oscuro']?.['fondo-tarjeta'], '#1E154C')
})
