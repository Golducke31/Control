import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VENTANAS } from '../rutas.ts'
import { CONTRATOS, contratoDeVentana } from './contrato.ts'

test('toda ventana del mapa declara su contrato', () => {
  for (const v of VENTANAS) {
    const c = contratoDeVentana(v.id)
    assert.ok(c !== null, `la ventana ${v.id} no declara contrato`)
    assert.match(c.endpoint, /^\/api\/v1\//, `el endpoint de ${v.id} debe ser /api/v1/...`)
    assert.ok(
      typeof c.esquema?.safeParse === 'function',
      `el contrato de ${v.id} no tiene un esquema Zod`,
    )
  }
})

test('no hay contratos huérfanos (la divergencia se detecta en ambos sentidos)', () => {
  const ids = new Set(VENTANAS.map((v) => v.id))
  for (const id of Object.keys(CONTRATOS)) {
    assert.ok(ids.has(id), `el contrato ${id} no corresponde a ninguna ventana del mapa`)
  }
})

test('catalogo está cableado y el resto declarado', () => {
  assert.equal(CONTRATOS.catalogo!.estado, 'listo')
  const reales = Object.values(CONTRATOS)
    .filter((c) => c.estado === 'listo')
    .map((c) => c.ventanaId)
  assert.ok(reales.includes('catalogo'), 'catalogo es la primera ventana cableada en F3')
})
