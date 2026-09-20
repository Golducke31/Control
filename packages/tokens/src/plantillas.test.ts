import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITES, PLANTILLAS, plantillaPorClave, variablesDeTema, verificarPlantilla } from './plantillas.ts'
import type { PlantillaDeRubro } from './plantillas.ts'
import { PALETAS_DE_INQUILINO } from './paletas.ts'

/** Trae una plantilla y falla si no está: en la suite, una clave mal escrita es un error. */
function plantilla(clave: string): PlantillaDeRubro {
  const encontrada = plantillaPorClave(clave)
  if (encontrada === null) throw new Error(`La plantilla «${clave}» no existe.`)
  return encontrada
}

const RETAIL = plantilla('retail-glass')

// ---------------------------------------------------------------------------
// La cláusula de la puerta: las 5 plantillas × las 4 paletas pasan AA
// ---------------------------------------------------------------------------

test('PUERTA F8·1b · las 5 plantillas sobre las 4 paletas pasan AA (20 combinaciones)', () => {
  const problemas: string[] = []
  for (const plantilla of PLANTILLAS) {
    for (const paleta of PALETAS_DE_INQUILINO) {
      problemas.push(...verificarPlantilla(plantilla, paleta))
    }
  }
  assert.deepEqual(problemas, [], `combinaciones que no pasan:\n  ${problemas.join('\n  ')}`)
})

test('el producto cartesiano es completo: no se saltea ninguna combinación', () => {
  // Sin esto, un `filter` mal puesto podría dejar la verificación en 3 × 2 y el test
  // anterior seguiría verde.
  let verificadas = 0
  for (const plantilla of PLANTILLAS) {
    for (const paleta of PALETAS_DE_INQUILINO) {
      verificadas += 1
    }
  }
  assert.equal(verificadas, PLANTILLAS.length * PALETAS_DE_INQUILINO.length)
  assert.equal(verificadas, 20)
})

test('PUERTA F8·1b (negativa) · una plantilla con geometría fuera de rango se rechaza', () => {
  const exagerada = { ...RETAIL, radio: 48, intensidadDeVidrio: 1 }
  const problemas = verificarPlantilla(exagerada, PALETAS_DE_INQUILINO[0]!)
  assert.equal(problemas.length, 2, 'el radio y el vidrio tienen que reportarse los dos')
  assert.ok(problemas.some((p) => p.includes('radio')))
  assert.ok(problemas.some((p) => p.includes('vidrio')))
})

test('una paleta con tinta ilegible se detecta en cualquier plantilla', () => {
  const rota = { slug: 'x', nombre: 'X', primario: '#FFFFFF', tintaSobrePrimario: '#FFFFFF', relacionDeTinta: 1, conforme: false }
  for (const plantilla of PLANTILLAS) {
    const problemas = verificarPlantilla(plantilla, rota)
    assert.ok(problemas.some((p) => p.includes('4,5:1')), `${plantilla.clave} debería reportar la tinta`)
  }
})

// ---------------------------------------------------------------------------
// Las cinco plantillas del motor
// ---------------------------------------------------------------------------

test('las cinco plantillas de app.ui_templates están, con sus claves', () => {
  assert.deepEqual(
    PLANTILLAS.map((p) => p.clave),
    ['retail-glass', 'services-glass', 'distributor-glass', 'logistics-glass', 'mixed-glass'],
  )
  assert.equal(new Set(PLANTILLAS.map((p) => p.clave)).size, 5, 'sin claves repetidas')
})

test('las plantillas cubren las dos densidades y las dos barras laterales', () => {
  assert.deepEqual([...new Set(PLANTILLAS.map((p) => p.densidad))].sort(), ['comfortable', 'compact'])
  assert.deepEqual([...new Set(PLANTILLAS.map((p) => p.barraLateral))].sort(), ['expanded', 'rail'])
})

test('la geometría de cada plantilla está dentro de los límites declarados', () => {
  for (const plantilla of PLANTILLAS) {
    assert.ok(plantilla.intensidadDeVidrio >= LIMITES.intensidadDeVidrio.minimo)
    assert.ok(plantilla.intensidadDeVidrio <= LIMITES.intensidadDeVidrio.maximo)
    assert.ok(plantilla.radio >= LIMITES.radio.minimo)
    assert.ok(plantilla.radio <= LIMITES.radio.maximo)
  }
})

test('plantillaPorClave devuelve null para una plantilla que no existe', () => {
  assert.equal(plantillaPorClave('inexistente-glass'), null)
})

// ---------------------------------------------------------------------------
// Cambiar de plantilla no recarga
// ---------------------------------------------------------------------------

test('variablesDeTema es una función pura: los mismos datos dan las mismas variables', () => {
  // Es lo que sostiene el «no recarga»: aplicar una plantilla es recalcular este objeto,
  // no pedirle nada al servidor.
  const primera = variablesDeTema(RETAIL, PALETAS_DE_INQUILINO[0]!)
  const segunda = variablesDeTema(RETAIL, PALETAS_DE_INQUILINO[0]!)
  assert.deepEqual(primera, segunda)
})

test('cambiar de plantilla cambia las variables, y cambiar de paleta cambia la tinta', () => {
  const paleta = PALETAS_DE_INQUILINO[0]!
  const conRetail = variablesDeTema(RETAIL, paleta)
  const conLogistica = variablesDeTema(plantillaPorClave('logistics-glass')!, paleta)

  assert.notDeepEqual(conRetail, conLogistica, 'la densidad y el radio tienen que cambiar')
  assert.equal(conRetail['--control-primario'], conLogistica['--control-primario'], 'la paleta no cambió')
  assert.equal(conLogistica['--control-densidad'], '0.86', 'la plantilla compacta ajusta la densidad')
  assert.equal(conLogistica['--control-barra-lateral'], 'rail')

  const conOtraPaleta = variablesDeTema(RETAIL, PALETAS_DE_INQUILINO[1]!)
  assert.notEqual(conRetail['--control-primario'], conOtraPaleta['--control-primario'])
  assert.notEqual(conRetail['--control-tinta-sobre-primario'], conOtraPaleta['--control-tinta-sobre-primario'])
})

test('todas las variables que se escriben son propiedades CSS', () => {
  const variables = variablesDeTema(RETAIL, PALETAS_DE_INQUILINO[0]!)
  for (const clave of Object.keys(variables)) {
    assert.ok(clave.startsWith('--control-'), `${clave} no es una propiedad del sistema de tokens`)
  }
  assert.ok(Object.keys(variables).length >= 6)
})
