import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accionesDisponibles, documentoQuieto, type AccionDocumento } from './cadenas.ts'
import type { DocumentoVenta } from './ventas.ts'

const HOY = '2026-09-19'

function doc(parcial: Partial<DocumentoVenta>): DocumentoVenta {
  return {
    id: 'x',
    tipo: 'cotizacion',
    numero: 'N-1',
    cliente: 'Cliente',
    estado: 'pendiente',
    total: 0,
    moneda: 'ARS',
    fecha: '2026-09-01T00:00:00.000Z',
    ...parcial,
  }
}

test('cotización en borrador ofrece emitir', () => {
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'cotizacion', estado: 'borrador' }), HOY), ['emitir'] as AccionDocumento[])
})

test('cotización pendiente y vigente ofrece aceptar', () => {
  assert.deepEqual(
    accionesDisponibles(doc({ tipo: 'cotizacion', estado: 'pendiente', venceEn: '2026-10-15' }), HOY),
    ['aceptar'] as AccionDocumento[],
  )
})

test('PUERTA F4·1: una cotización vencida NO ofrece aceptar', () => {
  const acciones = accionesDisponibles(doc({ tipo: 'cotizacion', estado: 'pendiente', venceEn: '2026-09-10' }), HOY)
  assert.ok(!acciones.includes('aceptar'), 'una cotización vencida no debe ofrecer aceptar')
  assert.deepEqual(acciones, [] as AccionDocumento[])
})

test('cotización aceptada ofrece crear pedido', () => {
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'cotizacion', estado: 'aceptado' }), HOY), ['crear_pedido'] as AccionDocumento[])
})

test('pedido pendiente o aceptado ofrece crear remito', () => {
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'pedido', estado: 'pendiente' }), HOY), ['crear_remito'] as AccionDocumento[])
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'pedido', estado: 'aceptado' }), HOY), ['crear_remito'] as AccionDocumento[])
})

test('remito pendiente sin facturar ofrece facturar', () => {
  assert.deepEqual(
    accionesDisponibles(doc({ tipo: 'remito', estado: 'pendiente', facturadoCompleto: false }), HOY),
    ['facturar'] as AccionDocumento[],
  )
})

test('PUERTA F4·2: un remito facturado en su totalidad NO ofrece facturar de nuevo', () => {
  const acciones = accionesDisponibles(doc({ tipo: 'remito', estado: 'pendiente', facturadoCompleto: true }), HOY)
  assert.ok(!acciones.includes('facturar'), 'un remito ya facturado no debe ofrecer facturar de nuevo')
  assert.deepEqual(acciones, [] as AccionDocumento[])
  // y un remito ya en estado facturado tampoco ofrece nada
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'remito', estado: 'facturado' }), HOY), [] as AccionDocumento[])
})

test('factura autorizada ofrece crear devolución; en borrador ofrece autorizar', () => {
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'factura', estado: 'pendiente' }), HOY), ['crear_devolucion'] as AccionDocumento[])
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'factura', estado: 'borrador' }), HOY), ['autorizar'] as AccionDocumento[])
})

test('devolución en borrador ofrece confirmar', () => {
  assert.deepEqual(accionesDisponibles(doc({ tipo: 'devolucion', estado: 'borrador' }), HOY), ['confirmar'] as AccionDocumento[])
})

test('la frontera de vencimiento es reproducible: venceEn == hoy sigue siendo aceptable', () => {
  // E6: `accept_quote()` rechaza sólo cuando CURRENT_DATE > valid_to; el día del
  // vencimiento la cotización todavía es aceptable (coincide con `v_quotes`).
  const acciones = accionesDisponibles(doc({ tipo: 'cotizacion', estado: 'pendiente', venceEn: '2026-09-19' }), HOY)
  assert.ok(acciones.includes('aceptar'), 'a la fecha de vencimiento la cotización todavía es aceptable')
})

test('documentoQuieto refleja la puerta en ambos sentidos', () => {
  assert.equal(documentoQuieto(doc({ tipo: 'cotizacion', estado: 'pendiente', venceEn: '2026-09-10' }), HOY), true)
  assert.equal(documentoQuieto(doc({ tipo: 'cotizacion', estado: 'pendiente', venceEn: '2026-10-15' }), HOY), false)
})
