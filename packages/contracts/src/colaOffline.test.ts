import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLA_VACIA, colaAlDia, encolar, pendientesDe, sincronizar } from './colaOffline.ts'
import type { OperacionPendiente } from './colaOffline.ts'

function operacion(id: string, tipo: string, creadaEn: string): Omit<OperacionPendiente, 'intentos'> {
  return { id, envioId: 'env_1', tipo, descripcion: tipo, payload: {}, creadaEn }
}

// ---------------------------------------------------------------------------
// Encolar
// ---------------------------------------------------------------------------

test('encolar agrega la operación con cero intentos', () => {
  const estado = encolar(COLA_VACIA, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  assert.equal(pendientesDe(estado), 1)
  assert.equal(estado.pendientes[0]?.intentos, 0)
  assert.equal(colaAlDia(estado), false)
})

test('encolar la misma operación dos veces no la duplica', () => {
  // Es el caso real: la app manda el evento, se corta la red antes de la respuesta y
  // el usuario vuelve a tocar el botón. El `clientEventId` es el mismo.
  const op = operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z')
  const una = encolar(COLA_VACIA, op)
  const dos = encolar(una, op)
  assert.equal(dos, una, 'devuelve el mismo estado: no hay nada que hacer')
  assert.equal(pendientesDe(dos), 1)
})

test('una operación ya aplicada no se vuelve a encolar', () => {
  // La app se cerró después de mandar el evento pero antes de borrarlo de la cola.
  const estado = { pendientes: [], aplicadas: ['op_1'] }
  const despues = encolar(estado, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  assert.equal(pendientesDe(despues), 0, 'reenviarla aplicaría el evento dos veces')
})

// ---------------------------------------------------------------------------
// Sincronizar
// ---------------------------------------------------------------------------

test('sincronizar aplica en orden y vacía la cola', () => {
  let estado = COLA_VACIA
  estado = encolar(estado, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  estado = encolar(estado, operacion('op_2', 'salir_a_reparto', '2026-09-20T10:05:00.000Z'))
  estado = encolar(estado, operacion('op_3', 'entregar', '2026-09-20T10:30:00.000Z'))

  const aplicadas: string[] = []
  const r = sincronizar(estado, (op) => {
    aplicadas.push(op.tipo)
    return true
  })

  assert.deepEqual(aplicadas, ['despachar', 'salir_a_reparto', 'entregar'], 'el orden se respeta')
  assert.deepEqual(r.aplicadas, ['op_1', 'op_2', 'op_3'])
  assert.equal(pendientesDe(r.estado), 0)
  assert.equal(colaAlDia(r.estado), true)
  assert.equal(r.incompleta, false)
})

test('una falla detiene la cola y NO reordena lo que queda', () => {
  // Entregar antes de despachar produciría un historial que el motor no habría
  // aceptado: por eso no se saltea la que falló.
  let estado = COLA_VACIA
  estado = encolar(estado, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  estado = encolar(estado, operacion('op_2', 'salir_a_reparto', '2026-09-20T10:05:00.000Z'))
  estado = encolar(estado, operacion('op_3', 'entregar', '2026-09-20T10:30:00.000Z'))

  const intentadas: string[] = []
  const r = sincronizar(estado, (op) => {
    intentadas.push(op.tipo)
    return op.tipo !== 'salir_a_reparto'
  })

  assert.deepEqual(intentadas, ['despachar', 'salir_a_reparto'], 'no se intentó entregar')
  assert.deepEqual(r.aplicadas, ['op_1'])
  assert.equal(r.incompleta, true)
  assert.deepEqual(
    r.estado.pendientes.map((p) => p.id),
    ['op_2', 'op_3'],
    'las que quedan conservan su orden',
  )
  assert.equal(r.estado.pendientes[0]?.intentos, 1, 'la que falló sumó un intento')
  assert.equal(r.estado.pendientes[1]?.intentos, 0, 'la que ni se intentó no')
})

test('una segunda sincronización después del éxito no reaplica nada', () => {
  let estado = COLA_VACIA
  estado = encolar(estado, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  const primera = sincronizar(estado, () => true)

  let llamadas = 0
  const segunda = sincronizar(primera.estado, () => {
    llamadas += 1
    return true
  })

  assert.equal(llamadas, 0, 'la cola está vacía: no se envía nada')
  assert.deepEqual(segunda.aplicadas, [])
  assert.deepEqual(segunda.estado.aplicadas, ['op_1'], 'el registro de aplicadas se conserva')
})

test('el reintento aplica lo que había quedado pendiente', () => {
  let estado = COLA_VACIA
  estado = encolar(estado, operacion('op_1', 'despachar', '2026-09-20T10:00:00.000Z'))
  estado = encolar(estado, operacion('op_2', 'entregar', '2026-09-20T10:30:00.000Z'))

  const primera = sincronizar(estado, (op) => op.id === 'op_1')
  assert.deepEqual(primera.estado.pendientes.map((p) => p.id), ['op_2'])

  const segunda = sincronizar(primera.estado, () => true)
  assert.deepEqual(segunda.aplicadas, ['op_2'])
  assert.equal(colaAlDia(segunda.estado), true)
  assert.deepEqual(segunda.estado.aplicadas, ['op_1', 'op_2'])
})
