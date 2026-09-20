import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Canal, retrocesoMs } from './canal.ts'

/**
 * La suite de la puerta de F7 · 1: **200 envíos con una sola conexión SSE**.
 */

// ---------------------------------------------------------------------------
// PUERTA F7 · 1 — una sola conexión, multiplexada por tópico
// ---------------------------------------------------------------------------

test('PUERTA F7·1 · doscientos envíos suscritos comparten UNA sola conexión', () => {
  const canal = new Canal()

  for (let i = 1; i <= 200; i++) {
    canal.suscribir(`tarjeta-${i}`, [`envio:${i}`, 'tablero'])
  }

  assert.equal(canal.suscriptoresActivos, 200, 'hay doscientos suscriptores')
  assert.equal(canal.topicos.length, 201, 'doscientos tópicos de envío más el del tablero')
  assert.equal(canal.conexiones, 1, 'y una sola conexión')
  assert.equal(canal.estado, 'en_vivo')
})

test('la conexión se abre con el primer suscriptor y se cierra con el último', () => {
  const canal = new Canal()
  assert.equal(canal.conexiones, 0, 'sin suscriptores no hay conexión que mantener')
  assert.equal(canal.estado, 'sin_conexion')

  canal.suscribir('torre', ['tablero'])
  assert.equal(canal.conexiones, 1)

  // Diez ventanas más se suman al mismo tópico: la conexión no se multiplica.
  for (let i = 0; i < 10; i++) canal.suscribir(`panel-${i}`, ['tablero'])
  assert.equal(canal.conexiones, 1)

  for (let i = 0; i < 10; i++) canal.desuscribir(`panel-${i}`)
  assert.equal(canal.conexiones, 1, 'mientras quede uno, sigue abierta')

  canal.desuscribir('torre')
  assert.equal(canal.conexiones, 0, 'sin nadie escuchando, se cierra')
  assert.equal(canal.estado, 'sin_conexion')
})

test('desuscribir libera los tópicos que quedan sin nadie', () => {
  const canal = new Canal()
  canal.suscribir('a', ['tablero', 'envio:1'])
  canal.suscribir('b', ['envio:1'])
  assert.deepEqual(canal.topicos, ['envio:1', 'tablero'])

  canal.desuscribir('b')
  assert.deepEqual(canal.topicos, ['envio:1', 'tablero'], 'a sigue escuchando envio:1')

  canal.desuscribir('a')
  assert.deepEqual(canal.topicos, [], 'nadie escucha nada: no quedan tópicos colgados')
})

test('escuchan dice a quién avisar de un evento', () => {
  const canal = new Canal()
  canal.suscribir('torre', ['tablero'])
  canal.suscribir('tarjeta-1', ['tablero', 'envio:1'])
  canal.suscribir('tarjeta-2', ['envio:2'])

  assert.deepEqual(canal.escuchan('tablero').sort(), ['tarjeta-1', 'torre'])
  assert.deepEqual(canal.escuchan('envio:1'), ['tarjeta-1'])
  assert.deepEqual(canal.escuchan('envio:2'), ['tarjeta-2'])
  assert.deepEqual(canal.escuchan('envio:99'), [], 'un tópico sin nadie no avisa a nadie')

  canal.desuscribir('tarjeta-1')
  assert.deepEqual(canal.escuchan('tablero'), ['torre'], 'el que se fue no recibe más')
})

test('una caída deja el canal reconectando, y el estado lo dice', () => {
  const canal = new Canal()
  canal.suscribir('torre', ['tablero'])
  assert.equal(canal.estado, 'en_vivo')

  canal.caida()
  assert.equal(canal.estado, 'reconectando', 'hay a quién servir, pero la conexión no está')
  assert.equal(canal.conexiones, 0)
  assert.equal(canal.intentosFallidos, 1)

  canal.conectar()
  assert.equal(canal.estado, 'en_vivo')
  assert.equal(canal.intentosFallidos, 0, 'al reconectar, el contador vuelve a cero')
})

test('una caída sin suscriptores no cuenta como intento fallido', () => {
  const canal = new Canal()
  canal.caida()
  assert.equal(canal.intentosFallidos, 0, 'no había nada que reconectar')
  assert.equal(canal.estado, 'sin_conexion')
})

// ---------------------------------------------------------------------------
// Visibilidad de la pestaña
// ---------------------------------------------------------------------------

test('con la pestaña oculta la conexión se cierra, y al volver se reanuda', () => {
  const canal = new Canal()
  canal.suscribir('torre', ['tablero'])
  assert.equal(canal.conexiones, 1)

  canal.ocultarPestana()
  assert.equal(canal.conexiones, 0, 'una conexión que nadie mira gasta batería y ancho de banda')
  assert.equal(canal.suscriptoresActivos, 1, 'pero la suscripción se conserva')
  assert.equal(canal.estado, 'sin_conexion')

  canal.mostrarPestana()
  assert.equal(canal.conexiones, 1, 'al volver se reanuda sola')
})

test('suscripción con la pestaña oculta: no abre hasta que se vea', () => {
  const canal = new Canal()
  canal.ocultarPestana()
  canal.suscribir('torre', ['tablero'])
  assert.equal(canal.conexiones, 0)
  assert.equal(canal.estado, 'sin_conexion')
  canal.mostrarPestana()
  assert.equal(canal.conexiones, 1)
})

// ---------------------------------------------------------------------------
// Retroceso exponencial con jitter
// ---------------------------------------------------------------------------

test('el retroceso crece exponencialmente y se topa', () => {
  const sinJitter = () => 1
  const opciones = { baseRetrocesoMs: 1000, maxRetrocesoMs: 30000 }

  assert.equal(retrocesoMs(1, sinJitter, opciones), 1000)
  assert.equal(retrocesoMs(2, sinJitter, opciones), 2000)
  assert.equal(retrocesoMs(3, sinJitter, opciones), 4000)
  assert.equal(retrocesoMs(4, sinJitter, opciones), 8000)
  assert.equal(retrocesoMs(5, sinJitter, opciones), 16000)
  assert.equal(retrocesoMs(6, sinJitter, opciones), 30000, 'se topa en el máximo')
  assert.equal(retrocesoMs(50, sinJitter, opciones), 30000, 'y no crece más allá')
})

test('el jitter reparte el reintento en vez de sincronizar todas las pestañas', () => {
  const opciones = { baseRetrocesoMs: 1000, maxRetrocesoMs: 30000 }
  // Con jitter completo, dos pestañas que se cayeron juntas no reintentan en el mismo
  // instante: sin esto, el reintento sincronizado vuelve a tumbar el servidor.
  assert.equal(retrocesoMs(5, () => 0, opciones), 0)
  assert.equal(retrocesoMs(5, () => 0.5, opciones), 8000)
  assert.equal(retrocesoMs(5, () => 1, opciones), 16000)
  // Y nunca supera el tope exponencial, sea cual sea el azar.
  for (const azar of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(retrocesoMs(9, () => azar, opciones) <= 30000)
  }
})

test('el canal expone el próximo reintento con el intento que lleva', () => {
  const canal = new Canal({ baseRetrocesoMs: 1000, maxRetrocesoMs: 30000 })
  canal.suscribir('torre', ['tablero'])

  canal.caida()
  assert.equal(canal.proximoReintentoMs(() => 1), 1000, 'primer intento')

  canal.caida()
  assert.equal(canal.proximoReintentoMs(() => 1), 2000, 'segundo intento: el doble')
})
