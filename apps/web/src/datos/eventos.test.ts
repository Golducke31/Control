import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codificarEvento, codificarLatido, topicDeEnvio, TOPICO_TABLERO } from './eventos.ts'

test('un evento se codifica en el formato de SSE y termina en línea vacía', () => {
  const marco = codificarEvento({ topico: 'envio:env_1', tipo: 'envio.actualizado', datos: { estado: 'in_transit' } })

  // La forma exacta: los campos en sus líneas, y el marco cerrado por una línea vacía
  // —que en el texto son dos saltos al final: el que cierra `data:` y el de la línea
  // vacía que termina el evento—.
  assert.equal(
    marco,
    'event: envio.actualizado\ndata: {"topico":"envio:env_1","datos":{"estado":"in_transit"}}\n\n',
  )
  assert.ok(marco.endsWith('\n\n'), 'sin la línea vacía el cliente no cierra el evento')

  const lineas = marco.split('\n')
  assert.equal(lineas[0], 'event: envio.actualizado')
  assert.ok(lineas[1]?.startsWith('data: '), 'los datos van en su propia línea')
})

test('los datos viajan como JSON con el tópico adentro', () => {
  const marco = codificarEvento({ topico: 'envio:env_1', tipo: 'envio.actualizado', datos: { estado: 'delivered' } })
  const linea = marco.split('\n')[1] ?? ''
  const json = JSON.parse(linea.slice('data: '.length))
  assert.deepEqual(json, { topico: 'envio:env_1', datos: { estado: 'delivered' } })
})

test('un salto de línea en los datos NO parte el marco', () => {
  // Es la trampa del formato: SSE delimita por líneas, así que un `\n` sin escapar
  // dentro del payload haría que el cliente leyera un campo inventado. `JSON.stringify`
  // lo escapa, y esta prueba es la que lo deja escrito.
  const marco = codificarEvento({
    topico: TOPICO_TABLERO,
    tipo: 'envio.actualizado',
    datos: { descripcion: 'Primera línea\nSegunda línea\r\nTercera' },
  })

  const lineas = marco.split('\n').filter((l) => l !== '')
  assert.equal(lineas.length, 2, 'sólo la línea de evento y la de datos')

  const json = JSON.parse((lineas[1] ?? '').slice('data: '.length))
  assert.equal(json.datos.descripcion, 'Primera línea\nSegunda línea\r\nTercera', 'el contenido se conserva íntegro')
})

test('un salto de línea en el nombre del evento se sanea', () => {
  const marco = codificarEvento({ topico: 'x', tipo: 'envio\nmalicioso', datos: {} })
  assert.equal(marco.split('\n')[0], 'event: enviomalicioso', 'un `event:` partido inyectaría un campo')
})

test('el latido es un comentario, que el cliente ignora', () => {
  const marco = codificarLatido()
  assert.ok(marco.startsWith(':'), 'SSE no tiene ping: el latido es un comentario')
  assert.ok(marco.endsWith('\n\n'))
})

test('el tópico de un envío se arma en un solo lugar', () => {
  assert.equal(topicDeEnvio('env_1'), 'envio:env_1')
  assert.equal(TOPICO_TABLERO, 'tablero')
})
