import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contraste, cumple } from './contraste.ts'
import {
  PALETAS_DE_INQUILINO,
  PRIMARIOS_DE_INQUILINO,
  paletaDeInquilino,
  paletaPorSlug,
  tintaDelPrototipo,
} from './paletas.ts'

// ---------------------------------------------------------------------------
// La cláusula de la puerta: las cuatro paletas pasan AA
// ---------------------------------------------------------------------------

test('PUERTA F8·1a · las cuatro paletas de inquilino pasan AA', () => {
  assert.equal(PALETAS_DE_INQUILINO.length, 4)
  for (const paleta of PALETAS_DE_INQUILINO) {
    assert.ok(
      paleta.conforme,
      `${paleta.nombre}: la tinta ${paleta.tintaSobrePrimario} da ${paleta.relacionDeTinta.toFixed(2)}:1 sobre ${paleta.primario}`,
    )
    assert.ok(
      cumple(contraste(paleta.tintaSobrePrimario, paleta.primario), 'AA'),
      `${paleta.nombre}: recomprobación independiente`,
    )
  }
})

test('la tinta se deriva y no siempre es blanca', () => {
  // La mitad interesante de la corrección: sobre un primario claro, la tinta legible es
  // un tono oscuro de su propia familia, no blanco.
  const conTintaOscura = PALETAS_DE_INQUILINO.filter((p) => p.tintaSobrePrimario !== '#FFFFFF')
  assert.equal(conTintaOscura.length, 3, 'tres de las cuatro necesitan una tinta oscura')

  const andes = paletaPorSlug('andes')
  assert.equal(andes?.tintaSobrePrimario, '#FFFFFF', 'sobre el violeta profundo, blanco es lo correcto')
})

test('la tinta elegida es la que más contrasta entre las candidatas', () => {
  for (const paleta of PALETAS_DE_INQUILINO) {
    const relacionElegida = contraste(paleta.tintaSobrePrimario, paleta.primario)
    const relacionBlanco = contraste('#FFFFFF', paleta.primario)
    assert.ok(
      relacionElegida >= relacionBlanco,
      `${paleta.nombre}: la tinta elegida no puede contrastar menos que el blanco`,
    )
    assert.equal(Number(relacionElegida.toFixed(6)), Number(paleta.relacionDeTinta.toFixed(6)))
  }
})

// ---------------------------------------------------------------------------
// El defecto original, como prueba negativa
// ---------------------------------------------------------------------------

test('PUERTA F8·1a (negativa) · el blanco fijo del prototipo fallaba en tres de las cuatro', () => {
  // Reproduce la medición que motivó el módulo. Si alguien vuelve a fijar el blanco, esta
  // prueba dice exactamente cuáles paletas quedan ilegibles.
  const fallan = PRIMARIOS_DE_INQUILINO.filter((p) => !tintaDelPrototipo(p.primario).conforme).map((p) => p.slug)
  assert.deepEqual(fallan.sort(), ['nordico', 'pampa', 'sur'], 'las tres que el plan midió por debajo de AA')

  // Y el caso que sí pasaba, para que la prueba no sea «todo falla».
  const andes = tintaDelPrototipo('#6D5EF8')
  assert.equal(andes.conforme, true, 'sobre el violeta el blanco sí alcanzaba AA')
  assert.ok(andes.relacion > 4.5 && andes.relacion < 4.7, `la medición del plan era 4,56:1 y dio ${andes.relacion.toFixed(2)}`)
})

test('una paleta inventada con un primario ilegible se detecta', () => {
  // Cualquier primario nuevo pasa por la misma derivación, así que un color imposible
  // —amarillo puro— tiene que encontrar igual una tinta oscura que cumpla.
  const amarillo = paletaDeInquilino({ slug: 'prueba', nombre: 'Prueba', primario: '#FFE600' })
  assert.equal(amarillo.conforme, true, 'la derivación tiene que resolver también un primario extremo')
  assert.notEqual(amarillo.tintaSobrePrimario, '#FFFFFF', 'blanco sobre amarillo es ilegible')
})

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

test('los cuatro inquilinos del prototipo están, con su primario', () => {
  assert.deepEqual(
    PRIMARIOS_DE_INQUILINO.map((p) => p.slug),
    ['andes', 'nordico', 'pampa', 'sur'],
  )
  assert.equal(paletaPorSlug('nordico')?.primario, '#E879A6')
})

test('paletaPorSlug devuelve null para un inquilino que no existe', () => {
  assert.equal(paletaPorSlug('inexistente'), null)
})

test('ningún primario se repite y todos son hex de seis dígitos', () => {
  const primarios = PRIMARIOS_DE_INQUILINO.map((p) => p.primario)
  assert.equal(new Set(primarios).size, primarios.length)
  for (const primario of primarios) {
    assert.match(primario, /^#[0-9A-F]{6}$/i, `${primario} no es un hex de seis dígitos`)
  }
})
