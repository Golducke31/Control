import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envioPorTracking, proyeccionPublica } from './tracking.ts'
import { CLAVES_PUBLICAS, TrackingPublicoSchema } from './logistica.ts'
import type { Envio, EventoTracking } from './logistica.ts'
import { envios, eventosTracking } from './fixtures.ts'

const FECHA = '2026-09-20T14:00:00.000Z'

function envio(parcial: Partial<Envio> = {}): Envio {
  return {
    id: 'env_1',
    numero: 'ENV-0001',
    trackingCode: 'TRK-AAAA1111',
    cliente: 'Distribuidora Sur',
    estado: 'in_transit',
    prioridad: 3,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Av. Siempre Viva 742',
    localidadDestino: 'Lanús',
    ventanaDesde: '2026-09-21T09:00:00.000Z',
    ventanaHasta: '2026-09-21T13:00:00.000Z',
    despachadoEn: '2026-09-20T10:00:00.000Z',
    entregadoEn: null,
    distanciaMetros: 18400,
    transportista: 'Transportes Ríos',
    patente: 'AB 123 CD',
    paradas: 1,
    paradasCompletadas: 0,
    ...parcial,
  }
}

function evento(envioId: string, descripcion: string, fecha: string): EventoTracking {
  return {
    id: `ev_${descripcion}`,
    envioId,
    estado: 'in_transit',
    codigo: 'at_hub',
    descripcion,
    fecha,
    actor: 'driver',
    requiereConfirmacion: false,
    confirmadoEn: null,
    clientEventId: null,
  }
}

// ---------------------------------------------------------------------------
// PUERTA F7 · 3 — el tracking público no expone datos de más
// ---------------------------------------------------------------------------

test('PUERTA F7·3 · la proyección tiene EXACTAMENTE los campos permitidos, ni uno más', () => {
  const publico = proyeccionPublica(envio(), [])
  assert.deepEqual(
    Object.keys(publico).sort(),
    [...CLAVES_PUBLICAS].sort(),
    'un campo nuevo en el envío no puede colarse solo a la vista pública',
  )
})

test('PUERTA F7·3 · la proyección no filtra el cliente, el transportista, la patente ni los ids', () => {
  const publico = proyeccionPublica(envio(), [evento('env_1', 'Llegó al centro de distribución', FECHA)])
  const serializado = JSON.stringify(publico)

  for (const secreto of ['Distribuidora Sur', 'Transportes Ríos', 'AB 123 CD', 'TRK-AAAA1111', 'env_1', 'Depósito central']) {
    assert.ok(
      !serializado.includes(secreto),
      `«${secreto}» no puede aparecer en la vista pública`,
    )
  }
})

test('PUERTA F7·3 · los eventos de otro envío no entran en la proyección', () => {
  const a = envio({ id: 'env_a', numero: 'ENV-0001' })
  const publico = proyeccionPublica(a, [
    evento('env_a', 'Salio del deposito', '2026-09-20T10:00:00.000Z'),
    evento('env_b', 'Evento de otro envio', '2026-09-20T11:00:00.000Z'),
    evento('env_c', 'Y de un tercero', '2026-09-20T12:00:00.000Z'),
  ])

  assert.equal(publico.eventos.length, 1, 'sólo el evento del envío pedido')
  assert.equal(publico.eventos[0]?.descripcion, 'Salio del deposito')
})

test('la proyección valida contra el esquema público', () => {
  const publico = proyeccionPublica(envio(), [evento('env_1', 'En reparto', FECHA)])
  assert.deepEqual(TrackingPublicoSchema.parse(publico), publico)
})

test('los eventos públicos salen ordenados por fecha', () => {
  const publico = proyeccionPublica(envio(), [
    evento('env_1', 'Tercero', '2026-09-20T14:00:00.000Z'),
    evento('env_1', 'Primero', '2026-09-20T09:00:00.000Z'),
    evento('env_1', 'Segundo', '2026-09-20T11:00:00.000Z'),
  ])
  assert.deepEqual(
    publico.eventos.map((e) => e.descripcion),
    ['Primero', 'Segundo', 'Tercero'],
  )
})

test('un envío sin eventos produce una proyección válida y vacía', () => {
  const publico = proyeccionPublica(envio({ estado: 'draft' }), [])
  assert.deepEqual(publico.eventos, [])
  assert.equal(publico.estado, 'draft')
})

// ---------------------------------------------------------------------------
// El token
// ---------------------------------------------------------------------------

test('el token de tracking resuelve a un solo envío', () => {
  const encontrado = envioPorTracking(envios, envios[0]?.trackingCode ?? '')
  assert.equal(encontrado?.id, envios[0]?.id)
})

test('un token inexistente devuelve null y no un envío vacío', () => {
  // Distinguir «no existe» de «existe sin eventos» importa: un envío inventado para un
  // token inexistente dejaría deducir qué códigos existen por diferencia.
  assert.equal(envioPorTracking(envios, 'TRK-NO-EXISTE'), null)
})

test('los envíos simulados tienen un código de tracking único', () => {
  const codigos = envios.map((e) => e.trackingCode)
  assert.equal(new Set(codigos).size, codigos.length, 'espeja sh_tracking_unique')
})

test('cada envío simulado tiene eventos y todos son del envío', () => {
  const ids = new Set(envios.map((e) => e.id))
  for (const ev of eventosTracking) {
    assert.ok(ids.has(ev.envioId), `el evento ${ev.id} apunta a un envío que no existe`)
  }
  for (const e of envios) {
    assert.ok(
      eventosTracking.some((ev) => ev.envioId === e.id),
      `${e.numero} no tiene eventos: la vista pública quedaría vacía`,
    )
  }
})
