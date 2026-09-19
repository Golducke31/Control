import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claveDeConsulta, debeDescartarCache, slugDeRuta } from './cache.ts'

/**
 * Aislamiento de cache por empresa. La defensa contra la fuga entre inquilinos es doble: las
 * claves siempre llevan el slug (estructural) y se vacía la cache al cambiar de empresa. La
 * prueba negativa fuerza el caso que el sistema existe para evitar.
 */

test('toda clave de consulta lleva el slug de la empresa adelante', () => {
  const clave = claveDeConsulta('andes', 'remitos', 7)
  assert.deepEqual(clave, ['empresa', 'andes', 'remitos', 7])
  assert.equal(clave[0], 'empresa')
  assert.equal(clave[1], 'andes')
})

test('dos empresas nunca comparten una clave', () => {
  const a = claveDeConsulta('andes', 'remitos')
  const p = claveDeConsulta('pampa', 'remitos')
  assert.notDeepEqual(a, p)
})

test('el descarte de cache sólo ocurre cuando el slug cambia', () => {
  assert.equal(debeDescartarCache('andes', 'pampa'), true)
  assert.equal(debeDescartarCache('andes', 'andes'), false)
})

test('la primera carga no descarta (no hay nada que cruzar)', () => {
  assert.equal(debeDescartarCache(null, 'andes'), false)
})

test('slugDeRuta extrae el slug de una ruta de carcasa', () => {
  assert.equal(slugDeRuta('/e/andes/panel'), 'andes')
  assert.equal(slugDeRuta('/e/pampa/stock/depositos'), 'pampa')
  assert.equal(slugDeRuta('/ingresar'), null)
})
