import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accionesEnvio,
  aplicarAccionEnvio,
  envioActivo,
  envioCoherente,
  envioQuieto,
  ordenarTablero,
} from './envios.ts'
import type { Envio } from './logistica.ts'
import { envios } from './fixtures.ts'

const FECHA = '2026-09-20T14:00:00.000Z'

function envio(parcial: Partial<Envio> = {}): Envio {
  return {
    id: 'env_1',
    numero: 'ENV-0001',
    trackingCode: 'TRK-AAAA1111',
    cliente: 'Distribuidora Sur',
    estado: 'draft',
    prioridad: 3,
    desde: 'Depósito central',
    hasta: 'Av. Siempre Viva 742',
    localidadDestino: 'Lanús',
    ventanaDesde: '2026-09-21T09:00:00.000Z',
    ventanaHasta: '2026-09-21T13:00:00.000Z',
    despachadoEn: null,
    entregadoEn: null,
    distanciaMetros: 18400,
    transportista: 'Transportes Ríos',
    patente: 'AB 123 CD',
    paradas: 1,
    paradasCompletadas: 0,
    ...parcial,
  }
}

// ---------------------------------------------------------------------------
// La máquina de estados
// ---------------------------------------------------------------------------

test('la máquina de estados del envío cubre los ocho estados del motor', () => {
  assert.deepEqual(accionesEnvio(envio({ estado: 'draft' })), ['preparar', 'cancelar'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'preparing' })), ['marcar_listo', 'cancelar'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'ready' })), ['despachar', 'cancelar'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'in_transit' })), ['salir_a_reparto', 'reportar_incidencia'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'out_for_delivery' })), ['entregar', 'reportar_incidencia'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'incident' })), ['resolver_incidencia', 'cancelar'])
  assert.deepEqual(accionesEnvio(envio({ estado: 'delivered' })), [])
  assert.deepEqual(accionesEnvio(envio({ estado: 'cancelled' })), [])
})

test('una acción que no corresponde al estado se rechaza y dice por qué', () => {
  const r = aplicarAccionEnvio(envio({ estado: 'draft' }), 'entregar', { fecha: FECHA })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'accion_invalida')
  assert.equal(r.estado, 'draft', 'la ventana necesita saber en qué estado está para poder explicarlo')
})

test('despachar registra la fecha de despacho', () => {
  const r = aplicarAccionEnvio(envio({ estado: 'ready' }), 'despachar', { fecha: FECHA })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.envio.estado, 'in_transit')
  assert.equal(r.envio.despachadoEn, FECHA)
})

test('entregar registra la fecha y completa las paradas', () => {
  const r = aplicarAccionEnvio(envio({ estado: 'out_for_delivery', paradas: 3, paradasCompletadas: 2 }), 'entregar', {
    fecha: FECHA,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.envio.estado, 'delivered')
  assert.equal(r.envio.entregadoEn, FECHA)
  assert.equal(r.envio.paradasCompletadas, 3)
})

test('una incidencia no se cancela sola: se resuelve y el envío vuelve a tránsito', () => {
  const conIncidencia = aplicarAccionEnvio(envio({ estado: 'in_transit' }), 'reportar_incidencia', { fecha: FECHA })
  assert.equal(conIncidencia.ok, true)
  if (!conIncidencia.ok) return
  assert.equal(conIncidencia.envio.estado, 'incident')

  const resuelta = aplicarAccionEnvio(conIncidencia.envio, 'resolver_incidencia', { fecha: FECHA })
  assert.equal(resuelta.ok, true)
  if (!resuelta.ok) return
  assert.equal(resuelta.envio.estado, 'in_transit')
})

test('un envío entregado o cancelado está quieto', () => {
  assert.equal(envioQuieto(envio({ estado: 'delivered', entregadoEn: FECHA })), true)
  assert.equal(envioQuieto(envio({ estado: 'cancelled' })), true)
  assert.equal(envioQuieto(envio({ estado: 'ready' })), false)
})

// ---------------------------------------------------------------------------
// La coherencia del motor
// ---------------------------------------------------------------------------

test('un envío entregado sin fecha de entrega es incoherente (espeja sh_delivered_ts)', () => {
  // El motor lo rechaza con `status <> 'delivered' OR delivered_at IS NOT NULL`. Un
  // envío entregado sin fecha miente sobre cuándo se entregó.
  assert.equal(envioCoherente(envio({ estado: 'delivered', entregadoEn: null })), false)
  assert.equal(envioCoherente(envio({ estado: 'delivered', entregadoEn: FECHA })), true)
})

test('una ventana que termina antes de empezar es incoherente (espeja sh_window_valid)', () => {
  assert.equal(
    envioCoherente(envio({ ventanaDesde: '2026-09-21T13:00:00.000Z', ventanaHasta: '2026-09-21T09:00:00.000Z' })),
    false,
  )
  assert.equal(envioCoherente(envio({ ventanaDesde: null, ventanaHasta: null })), true, 'sin ventana es válido')
})

test('ninguna transición válida produce un envío incoherente', () => {
  // La propiedad que importa: el motor no puede rechazar lo que la ventana ofrece.
  let actual = envio({ estado: 'draft' })
  for (const accion of ['preparar', 'marcar_listo', 'despachar', 'salir_a_reparto', 'entregar'] as const) {
    const r = aplicarAccionEnvio(actual, accion, { fecha: FECHA })
    assert.equal(r.ok, true, `${accion} debería estar disponible en ${actual.estado}`)
    if (!r.ok) return
    actual = r.envio
    assert.equal(envioCoherente(actual), true, `el envío quedó incoherente después de ${accion}`)
  }
  assert.equal(actual.estado, 'delivered')
})

test('más paradas completadas que paradas es incoherente', () => {
  assert.equal(envioCoherente(envio({ paradas: 2, paradasCompletadas: 3 })), false)
})

// ---------------------------------------------------------------------------
// El tablero
// ---------------------------------------------------------------------------

test('el tablero deja afuera lo entregado y lo cancelado (espeja idx_sh_active_board)', () => {
  assert.equal(envioActivo(envio({ estado: 'delivered', entregadoEn: FECHA })), false)
  assert.equal(envioActivo(envio({ estado: 'cancelled' })), false)
  assert.equal(envioActivo(envio({ estado: 'in_transit' })), true)
})

test('el tablero ordena por urgencia y después por número', () => {
  const ordenados = ordenarTablero([
    envio({ id: 'c', numero: 'ENV-0003', prioridad: 5 }),
    envio({ id: 'a', numero: 'ENV-0001', prioridad: 1 }),
    envio({ id: 'b', numero: 'ENV-0002', prioridad: 1 }),
    envio({ id: 'd', numero: 'ENV-0004', prioridad: 3, estado: 'delivered', entregadoEn: FECHA }),
  ])
  assert.deepEqual(
    ordenados.map((e) => e.numero),
    ['ENV-0001', 'ENV-0002', 'ENV-0003'],
    'el entregado no entra al tablero',
  )
})

test('los envíos simulados cubren el camino completo y son coherentes', () => {
  for (const e of envios) {
    assert.equal(envioCoherente(e), true, `${e.numero} es incoherente`)
  }
  const estados = new Set(envios.map((e) => e.estado))
  assert.ok(estados.has('delivered'), 'hace falta uno entregado, para ver el cierre')
  assert.ok(estados.has('incident'), 'y uno con incidencia, para ver la salida lateral')
  assert.ok([...estados].some((s) => envioActivo(envio({ estado: s }))), 'y alguno activo para el tablero')
})
