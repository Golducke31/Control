/**
 * Suite del cambio de tema (F8).
 *
 * La puerta dice «cambiar de plantilla no recarga». Es una afirmación sobre el
 * **camino** que toma el cambio, no sobre su resultado, así que no se puede probar
 * mirando la pantalla: se prueba mirando el código. Es el mismo tipo de aserción que
 * `rutas.test.ts` hace sobre los archivos de página —estructural, sobre la fuente—.
 *
 * La propiedad que se sostiene: aplicar un tema es recalcular `variablesDeTema` y
 * escribirlo en el `style`, sin ninguna consulta y sin ninguna navegación. Si alguien
 * cambia el selector por un `router.push` —o por un formulario que recarga— el test
 * falla, porque el `router.push` tiene que estar escrito en alguna parte para existir.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { PALETAS_DE_INQUILINO, PLANTILLAS, plantillaPorClave, variablesDeTema } from '@control/tokens'

const COMPONENTE = join(
  import.meta.dirname,
  'app',
  'e',
  '[slug]',
  'configuracion',
  'ConfiguracionCliente.tsx',
)

const fuente = readFileSync(COMPONENTE, 'utf8')

/**
 * Quita los comentarios del código.
 *
 * Sin esto, la prueba se dispara con su propia documentación: el comentario del
 * componente explica que no hay ningún `router.push`, y el texto de ese comentario
 * contiene la palabra. Una comprobación sobre la fuente tiene que mirar **código**, y un
 * comentario que explica por qué algo no está no es ese algo.
 *
 * El recorrido respeta las cadenas —simples, dobles y plantillas— para no confundir un
 * `//` dentro de una URL con el comienzo de un comentario.
 */
function sinComentarios(codigo: string): string {
  let salida = ''
  let i = 0
  while (i < codigo.length) {
    const actual = codigo[i]
    const siguiente = codigo[i + 1]

    if (actual === '/' && siguiente === '/') {
      while (i < codigo.length && codigo[i] !== '\n') i += 1
      continue
    }
    if (actual === '/' && siguiente === '*') {
      i += 2
      while (i < codigo.length && !(codigo[i] === '*' && codigo[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (actual === "'" || actual === '"' || actual === '`') {
      const cierre = actual
      salida += actual
      i += 1
      while (i < codigo.length && codigo[i] !== cierre) {
        if (codigo[i] === '\\') {
          salida += codigo[i]
          i += 1
        }
        salida += codigo[i]
        i += 1
      }
      salida += cierre
      i += 1
      continue
    }

    salida += actual
    i += 1
  }
  return salida
}

const codigo = sinComentarios(fuente)

test('PUERTA F8·2 · el selector de plantilla no navega ni recarga', () => {
  for (const prohibido of ['next/navigation', 'router.push', 'router.replace', 'location.reload', 'window.location']) {
    assert.ok(
      !codigo.includes(prohibido),
      `el selector usa «${prohibido}»: cambiar de plantilla recargaría o perdería el estado`,
    )
  }
})

test('el cambio de tema se aplica escribiendo las variables, no pidiendo datos', () => {
  assert.ok(codigo.includes('variablesDeTema'), 'el componente tiene que aplicar las variables del sistema de tokens')
  assert.ok(codigo.includes('style={variables'), 'las variables tienen que ir al style del contenedor')
  // Y no hay ninguna consulta en el camino: el tema es del sistema de diseño, no del servidor.
  for (const consulta of ['useQuery', 'useColeccion', 'fetch(']) {
    assert.ok(!codigo.includes(consulta), `«${consulta}» no tiene nada que hacer en el cambio de tema`)
  }
})

test('el selector elige con estado de interfaz, no con enlaces', () => {
  assert.ok(codigo.includes('useState'), 'la selección vive en estado del componente')
  assert.ok(
    codigo.includes('onClick={() => setClaveDePlantilla'),
    'cada plantilla se elige con un onClick, que no navega',
  )
})

test('aplicar cualquier combinación es puro y no falla', () => {
  // La contracara: el camino sin recarga sólo sirve si el cálculo es total. Se recorren
  // las 20 combinaciones y ninguna puede quedar sin variables.
  for (const plantilla of PLANTILLAS) {
    for (const paleta of PALETAS_DE_INQUILINO) {
      const variables = variablesDeTema(plantilla, paleta)
      assert.ok(Object.keys(variables).length >= 6, `${plantilla.clave} × ${paleta.slug} quedó sin variables`)
      assert.equal(variables['--control-primario'], paleta.primario)
      assert.equal(variables['--control-tinta-sobre-primario'], paleta.tintaSobrePrimario)
    }
  }
})

test('la plantilla y la paleta iniciales de una empresa son válidas', () => {
  // La página resuelve el tema inicial con `temaInicial(slug)`; un slug sin paleta
  // propia no puede dejar la ventana sin tema.
  const retail = plantillaPorClave('retail-glass')
  assert.ok(retail !== null)
  assert.equal(variablesDeTema(retail, PALETAS_DE_INQUILINO[0]!)['--control-barra-lateral'], 'expanded')
})
