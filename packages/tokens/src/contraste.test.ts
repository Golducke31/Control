/**
 * Suite de la aritmética de contraste.
 *
 * Verifica el cálculo contra valores conocidos y, sobre todo, verifica que el
 * verificador **pueda fallar**. Un control que no puede fallar no protege nada, y
 * este proyecto ya se comió ese problema una vez con dos jobs del CI que no podían
 * pasar nunca.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  aHex,
  aRgb,
  contraste,
  cumple,
  luminancia,
  mezclar,
  nivelDe,
  tintaSobre,
} from './contraste.ts'

test('aRgb convierte y aHex vuelve, sin perder nada', () => {
  assert.deepEqual(aRgb('#261A66'), [0x26, 0x1a, 0x66])
  assert.equal(aHex(aRgb('#EF5F18')), '#EF5F18')
  assert.equal(aHex(aRgb('#ffffff')), '#FFFFFF')
})

test('aRgb acepta sólo la forma «#RRGGBB» y falla ruidosamente', () => {
  for (const malo of ['261A66', '#261A6', '#GGGGGG', '', '#261A66FF', 'rgb(1,2,3)']) {
    assert.throws(() => aRgb(malo), /Color hexadecimal inválido/, `debería rechazar ${JSON.stringify(malo)}`)
  }
})

test('la luminancia y el contraste coinciden con los valores de la recomendación', () => {
  // Blanco sobre negro es el máximo posible: 21:1.
  assert.equal(Number(contraste('#FFFFFF', '#000000').toFixed(2)), 21)
  // Un color consigo mismo: 1:1.
  assert.equal(Number(contraste('#261A66', '#261A66').toFixed(2)), 1)
  // El contraste es simétrico.
  assert.equal(
    contraste('#EF5F18', '#FFFFFF').toFixed(6),
    contraste('#FFFFFF', '#EF5F18').toFixed(6),
  )
  assert.equal(Number(luminancia('#FFFFFF').toFixed(4)), 1)
  assert.equal(Number(luminancia('#000000').toFixed(4)), 0)
})

test('los contrastes que el plan publica se reproducen exactamente', () => {
  const publicados: [string, string, number][] = [
    ['#FFFFFF', '#130D36', 18.44],
    ['#261A66', '#FFFFFF', 14.77],
    ['#EF5F18', '#130D36', 5.55],
    ['#EF5F18', '#FFFFFF', 3.32],
    ['#EF5F18', '#E7E4E8', 2.64],
    ['#100C27', '#EF5F18', 5.73],
    ['#FFFFFF', '#C24A0F', 4.91],
    ['#FFFFFF', '#993B0D', 7.03],
    ['#130D36', '#3D3165', 1.6],
    ['#FFFFFF', '#E879A6', 2.72],
    ['#FFFFFF', '#10B981', 2.54],
    ['#FFFFFF', '#F97316', 2.8],
    ['#2FC48A', '#DEEDE7', 1.85],
  ]
  for (const [frente, fondo, esperado] of publicados) {
    const obtenido = Number(contraste(frente, fondo).toFixed(2))
    assert.equal(
      obtenido,
      esperado,
      `${frente} sobre ${fondo}: el cálculo da ${obtenido}, el documento dice ${esperado}`,
    )
  }
})

test('los niveles se asignan en los umbrales correctos', () => {
  assert.equal(nivelDe(21), 'AAA')
  assert.equal(nivelDe(7), 'AAA')
  assert.equal(nivelDe(6.99), 'AA')
  assert.equal(nivelDe(4.5), 'AA')
  assert.equal(nivelDe(4.49), 'AA-texto-grande')
  assert.equal(nivelDe(3), 'AA-texto-grande')
  assert.equal(nivelDe(2.99), 'no-cumple')

  assert.ok(cumple(4.5, 'AA'))
  assert.ok(!cumple(4.49, 'AA'))
  assert.ok(cumple(3, 'AA-texto-grande'))
  assert.ok(!cumple(3, 'AA'))
})

test('mezclar acerca al blanco o al negro sin salirse de rango', () => {
  assert.deepEqual(aHex(mezclar('#261A66', 'blanco', 0)), '#261A66')
  assert.deepEqual(aHex(mezclar('#261A66', 'blanco', 1)), '#FFFFFF')
  assert.deepEqual(aHex(mezclar('#261A66', 'negro', 1)), '#000000')
  // La cantidad se satura: no hay forma de pasarse de rango.
  assert.deepEqual(aHex(mezclar('#261A66', 'blanco', 5)), '#FFFFFF')
  assert.deepEqual(aHex(mezclar('#261A66', 'negro', -3)), '#261A66')
})

test('tintaSobre elige la candidata con más contraste y avisa si no alcanza', () => {
  // El caso que motivó la función: el naranja de marca no admite blanco en cuerpo.
  const sobreNaranja = tintaSobre('#EF5F18', ['#FFFFFF', '#100C27'])
  assert.equal(sobreNaranja.tinta, '#100C27')
  assert.ok(sobreNaranja.conforme, 'la tinta violeta tiene que alcanzar AA sobre el naranja')

  // Y avisa cuando ninguna candidata sirve, en vez de publicar un texto ilegible.
  // Con dos tintas que fallan devuelve igual la de mayor contraste —el blanco, que
  // da 3,32:1— y lo marca como no conforme, para que quien llama pueda avisar.
  const sinSalida = tintaSobre('#EF5F18', ['#FFFFFF', '#F2555A'])
  assert.ok(!sinSalida.conforme, 'ninguna de las dos alcanza AA sobre el naranja')
  assert.equal(sinSalida.tinta, '#FFFFFF', 'devuelve la de mayor contraste')
  assert.ok(sinSalida.relacion > contraste('#F2555A', '#EF5F18'))
})

test('tintaSobre exige al menos una candidata', () => {
  assert.throws(() => tintaSobre('#EF5F18', []), /al menos una candidata/)
})
