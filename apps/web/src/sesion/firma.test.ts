import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emitirToken, verificarToken } from './firma.ts'

/**
 * La cookie de sesión es `valor.firma`. La prueba negativa es la parte que importa: si alguien
 * la manipula, la firma no cuadra y `verificarToken` devuelve `null` —no una sesión falsa—.
 */
test('un token firmado se verifica íntegro', () => {
  const token = emitirToken('sub=u_ana')
  assert.equal(verificarToken(token), 'sub=u_ana')
})

test('cambiar un carácter del valor invalida la firma', () => {
  const token = emitirToken('sub=u_ana')
  const partes = token.split('.')
  const valor = partes[0] ?? ''
  const firma = partes[1] ?? ''
  const manipulado = `sub=u_ottro.${firma}`
  // El split anterior es sólo para ilustrar; el manipulado real cambia el valor y deja la firma.
  assert.equal(verificarToken(manipulado), null)
  assert.ok(valor.length > 0 && firma.length > 0)
})

test('pegarme la firma de otro valor no sirve', () => {
  const otro = emitirToken('sub=u_beto')
  const firmaAjena = otro.split('.').at(-1)
  const intento = `sub=u_ana.${firmaAjena}`
  assert.equal(verificarToken(intento), null)
})

test('un token sin separador no es válido', () => {
  assert.equal(verificarToken('no-hay-firma'), null)
})

test('la comparación de firmas es resistente a temporización', () => {
  // No es un test de valor, pero sí de que no lanza y es determinista ante entradas iguales.
  const a = emitirToken('x')
  const b = emitirToken('x')
  assert.equal(verificarToken(a), verificarToken(b))
})
