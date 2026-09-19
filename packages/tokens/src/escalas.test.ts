/**
 * Suite de las escalas.
 *
 * Fija los 36 valores publicados en `docs/PLAN-FRONTEND-PRODUCCION.md` §3.2. No es
 * una repetición del generador: es lo que hace que el documento y el código no se
 * separen. Si alguien cambia el algoritmo de derivación —o la rampa, o la curva de
 * saturación— esta suite lo dice, en vez de que el plan empiece a mentir en silencio.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { aRgb, contraste, cumple } from './contraste.ts'
import { PASOS, derivarEscala, derivarNeutral } from './derivar.ts'
import { ANCLAS, ESCALAS, LIENZO, PALETA_INDICADA, SEMANTICOS, SERIES, paso } from './escalas.ts'
import type { NombreDeEscala } from './escalas.ts'

/** La tabla tal como está publicada en el plan. */
const PUBLICADO: Record<NombreDeEscala, Record<number, string>> = {
  scarlet: {
    50: '#F7F7FA', 100: '#ECEBF4', 200: '#DAD7EA', 300: '#C4BFDF', 400: '#AAA2D4',
    500: '#8C81C9', 600: '#6B5BC0', 700: '#4E3CAF', 800: '#392A8C', 900: '#261A66',
    950: '#1A1243', 990: '#100C27',
  },
  orange: {
    50: '#FBF8F6', 100: '#F5ECE7', 200: '#EED9CE', 300: '#E8C1AD', 400: '#E5A485',
    500: '#E78453', 600: '#EF5F18', 700: '#C24A0F', 800: '#993B0D', 900: '#732D0B',
    950: '#502008', 990: '#2E1305',
  },
  neutral: {
    50: '#F8F8F9', 100: '#F0F0F2', 200: '#E2E2E7', 300: '#CDCBD5', 400: '#B1AFBE',
    500: '#9390A4', 600: '#76728B', 700: '#5B586C', 800: '#444150', 900: '#312F3A',
    950: '#222129', 990: '#18171C',
  },
}

test('los tres colores indicados están, con el valor exacto de la referencia', () => {
  assert.equal(PALETA_INDICADA.white, '#FFFFFF')
  assert.equal(PALETA_INDICADA.orange, '#EF5F18')
  assert.equal(PALETA_INDICADA.scarlet, '#261A66')
})

test('las escalas reproducen los 36 valores publicados', () => {
  let comprobados = 0
  for (const nombre of Object.keys(PUBLICADO) as NombreDeEscala[]) {
    for (const [pasoCrudo, esperado] of Object.entries(PUBLICADO[nombre])) {
      const p = Number(pasoCrudo)
      assert.equal(
        ESCALAS[nombre][p as keyof typeof ESCALAS[typeof nombre]],
        esperado,
        `${nombre}-${p}`,
      )
      comprobados++
    }
  }
  assert.equal(comprobados, 36, 'tienen que ser doce pasos por tres escalas')
})

test('el paso del ancla sale exacto, no interpolado', () => {
  assert.equal(ESCALAS.scarlet[900], PALETA_INDICADA.scarlet)
  assert.equal(ESCALAS.orange[600], PALETA_INDICADA.orange)
  assert.equal(ANCLAS.scarlet.paso, 900)
  assert.equal(ANCLAS.orange.paso, 600)
})

test('cada escala tiene los doce pasos y todos son hex válidos', () => {
  for (const nombre of Object.keys(ESCALAS) as NombreDeEscala[]) {
    for (const p of PASOS) {
      const valor = ESCALAS[nombre][p]
      assert.equal(typeof valor, 'string', `${nombre}-${p} falta`)
      assert.doesNotThrow(() => aRgb(valor), `${nombre}-${p} no es un hex válido`)
    }
  }
})

test('la luminosidad es monótona: cada paso es más oscuro que el anterior', () => {
  // Sin esto la escala no sirve para derivar roles: un paso claro en medio de los
  // oscuros rompería la correspondencia entre número y peso visual.
  const luminancia = (hex: string) => {
    const [r, g, b] = aRgb(hex)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  for (const nombre of Object.keys(ESCALAS) as NombreDeEscala[]) {
    let anterior = Number.POSITIVE_INFINITY
    for (const p of PASOS) {
      const actual = luminancia(ESCALAS[nombre][p])
      assert.ok(
        actual < anterior,
        `${nombre}-${p} no es más oscuro que el paso anterior (${actual} vs ${anterior})`,
      )
      anterior = actual
    }
  }
})

test('los tonos de lienzo son los muestreados de la imagen', () => {
  assert.equal(LIENZO.canvas, '#130D36')
  assert.equal(LIENZO.profundo, '#1E154C')
  assert.equal(LIENZO.medio, '#3D3165')
  assert.equal(LIENZO.claro, '#E7E4E8')
})

test('los semánticos tienen tres valores y la tinta es la más viva que cumple AA', () => {
  for (const [nombre, valores] of Object.entries(SEMANTICOS)) {
    assert.ok(valores.base.startsWith('#'), `${nombre}.base`)
    assert.ok(valores.claro.startsWith('#'), `${nombre}.claro`)
    assert.ok(valores.profundo.startsWith('#'), `${nombre}.profundo`)
    assert.ok(
      cumple(contraste(valores.profundo, valores.claro), 'AA'),
      `${nombre}: la tinta profunda tiene que alcanzar AA sobre su fondo claro`,
    )
    // Y la base NO sirve como texto sobre su fondo claro: es el error que el
    // sistema existe para evitar.
    assert.ok(
      !cumple(contraste(valores.base, valores.claro), 'AA'),
      `${nombre}: la base no debería alcanzar AA sobre su fondo claro`,
    )
  }
})

test('la paleta de series arranca por la marca y no repite colores', () => {
  assert.equal(SERIES[0], ESCALAS.scarlet[600])
  assert.equal(SERIES[1], ESCALAS.orange[600])
  assert.equal(new Set(SERIES).size, SERIES.length, 'no puede haber dos series del mismo color')
})

test('paso() devuelve el color y falla ante un nombre inexistente', () => {
  assert.equal(paso('scarlet', 900), '#261A66')
  assert.throws(() => paso('scarlet' as NombreDeEscala, 123 as never), /no tiene el paso/)
})

test('derivarEscala rechaza un ancla mal escrita en vez de inventar un color', () => {
  assert.throws(() => derivarEscala('naranja', 600), /Color hexadecimal inválido/)
  assert.throws(() => derivarNeutral('#12345'), /Color hexadecimal inválido/)
})
