import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accionesTransferencia,
  aplicarRecuento,
  aplicarTransferencia,
  conciliar,
  deltaDeMovimiento,
  movimientosDeTransferencia,
  SIGNO_DEL_MOVIMIENTO,
  unidadesDeTransferencia,
} from './inventario.ts'
import type { MovimientoStock, NivelStock, Transferencia } from './stock.ts'
import { niveles, movimientos, transferencias } from './fixtures.ts'

const HOY = '2026-09-20T12:00:00.000Z'

function nivel(parcial: Partial<NivelStock> = {}): NivelStock {
  const cantidad = parcial.cantidad ?? 100
  const reservada = parcial.reservada ?? 0
  return {
    productoId: 'prd_x',
    sku: 'SKU-X',
    nombre: 'Producto X',
    depositoId: 'dep_a',
    depositoNombre: 'Depósito A',
    cantidad,
    reservada,
    disponible: cantidad - reservada,
    ...parcial,
  }
}

function transferencia(parcial: Partial<Transferencia> = {}): Transferencia {
  return {
    id: 'tr_1',
    codigo: 'TRN-0001',
    desdeId: 'dep_a',
    desdeNombre: 'Depósito A',
    hastaId: 'dep_b',
    hastaNombre: 'Depósito B',
    estado: 'draft',
    items: [{ productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', cantidadEnviada: 10, cantidadRecibida: null }],
    creadaEn: '2026-09-19T10:00:00.000Z',
    actualizadaEn: '2026-09-19T10:00:00.000Z',
    ...parcial,
  }
}

// ---------------------------------------------------------------------------
// El signo del movimiento es el del motor
// ---------------------------------------------------------------------------

test('SIGNO_DEL_MOVIMIENTO cubre los nueve tipos y coincide con el CASE del motor', () => {
  // El CASE de app.apply_stock_movement, escrito aparte y a mano, para que el test
  // falle si alguien cambia la tabla sin cambiar el motor (o al revés).
  const esperado: Record<string, number> = {
    purchase_in: 1,
    transfer_in: 1,
    adjustment_pos: 1,
    return_in: 1,
    release: 0,
    reservation: 0,
    sale_out: -1,
    transfer_out: -1,
    adjustment_neg: -1,
  }
  assert.deepEqual(SIGNO_DEL_MOVIMIENTO, esperado)
  assert.equal(Object.keys(SIGNO_DEL_MOVIMIENTO).length, 9)
})

test('deltaDeMovimiento da lo mismo con la cantidad firmada o sin firmar', () => {
  const base = {
    id: 'mv',
    productoId: 'prd_x',
    sku: 'SKU-X',
    nombre: 'Producto X',
    depositoId: 'dep_a',
    fecha: HOY,
  }
  const firmado: MovimientoStock = { ...base, tipo: 'sale_out', cantidad: -40 }
  const sinFirmar: MovimientoStock = { ...base, tipo: 'sale_out', cantidad: 40 }
  assert.equal(deltaDeMovimiento(firmado), -40)
  assert.equal(deltaDeMovimiento(sinFirmar), -40, 'el signo lo decide el tipo, no el dato guardado')
})

test('las reservas no mueven la cantidad física', () => {
  const reserva: MovimientoStock = {
    id: 'mv',
    productoId: 'prd_x',
    sku: 'SKU-X',
    nombre: 'Producto X',
    depositoId: 'dep_a',
    tipo: 'reservation',
    cantidad: 25,
    fecha: HOY,
  }
  assert.equal(deltaDeMovimiento(reserva), 0)
})

// ---------------------------------------------------------------------------
// PUERTA F5 · 1 — el recuento ajusta el saldo y queda en el libro mayor
// ---------------------------------------------------------------------------

test('PUERTA F5·1 · el recuento ajusta el saldo Y deja la fila en el libro', () => {
  const antes = nivel({ cantidad: 100, reservada: 8 })
  const r = aplicarRecuento(antes, 97, { idMovimiento: 'mv_rec_1', fecha: HOY })

  assert.equal(r.ok, true)
  if (!r.ok) return

  // Las dos mitades de la regla, en la misma aserción de flujo.
  assert.equal(r.ajuste.nivel.cantidad, 97, 'el saldo quedó ajustado')
  assert.notEqual(r.ajuste.movimiento, null, 'y el libro mayor tiene su fila')
  assert.equal(r.ajuste.movimiento?.id, 'mv_rec_1')
  assert.equal(r.ajuste.movimiento?.tipo, 'adjustment_neg')
  assert.equal(r.ajuste.movimiento?.cantidad, -3)
  assert.equal(r.ajuste.movimiento?.depositoId, 'dep_a')
})

test('el recuento conserva la reserva y recalcula el disponible', () => {
  const r = aplicarRecuento(nivel({ cantidad: 100, reservada: 30 }), 120, {
    idMovimiento: 'mv_rec_2',
    fecha: HOY,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.ajuste.nivel.reservada, 30, 'lo reservado no lo toca un recuento')
  assert.equal(r.ajuste.nivel.disponible, 90, 'disponible = cantidad - reservada')
  assert.equal(r.ajuste.movimiento?.tipo, 'adjustment_pos')
  assert.equal(r.ajuste.movimiento?.cantidad, 20)
})

test('un recuento sin diferencia no escribe nada en el libro', () => {
  const r = aplicarRecuento(nivel({ cantidad: 100 }), 100, { idMovimiento: 'mv_rec_3', fecha: HOY })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.ajuste.movimiento, null, 'sin delta no hay movimiento que registrar')
  assert.equal(r.ajuste.nivel.cantidad, 100)
})

test('el recuento devuelto sigue cumpliendo la invariante disponible = cantidad - reservada', () => {
  // Se recorren también los casos que el motor rechaza: la invariante tiene que
  // valer para todo resultado aceptado, y los rechazados no deben producir un nivel.
  for (const contado of [0, 5, 42, 500]) {
    const r = aplicarRecuento(nivel({ cantidad: 50, reservada: 5 }), contado, {
      idMovimiento: `mv_rec_${contado}`,
      fecha: HOY,
    })
    if (contado < 5) {
      assert.equal(r.ok, false, `contar ${contado} con 5 reservadas debe rechazarse`)
      continue
    }
    assert.equal(r.ok, true)
    if (!r.ok) continue
    assert.equal(r.ajuste.nivel.disponible, r.ajuste.nivel.cantidad - r.ajuste.nivel.reservada)
    assert.ok(r.ajuste.nivel.disponible >= 0)
  }
})

test('PUERTA F5·1 (negativa) · contar por debajo de lo reservado se rechaza, como el CHECK del motor', () => {
  // Espeja `sl_reserved_le_on_hand`: el motor aborta la escritura, así que el
  // frontend no puede ofrecer un ajuste que va a fallar del otro lado.
  const r = aplicarRecuento(nivel({ cantidad: 100, reservada: 25 }), 20, {
    idMovimiento: 'mv_rec_x',
    fecha: HOY,
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'contado_por_debajo_de_lo_reservado')
  assert.equal(r.reservada, 25)
})

test('contar exactamente lo reservado sí es válido (la frontera es inclusiva)', () => {
  const r = aplicarRecuento(nivel({ cantidad: 100, reservada: 25 }), 25, {
    idMovimiento: 'mv_rec_y',
    fecha: HOY,
  })
  assert.equal(r.ok, true, 'contado == reservada deja disponible 0, que el CHECK permite')
})

// ---------------------------------------------------------------------------
// PUERTA F5 · 2 — la transferencia con edición concurrente avisa y no pisa
// ---------------------------------------------------------------------------

test('PUERTA F5·2 · una versión vieja avisa y NO pisa el cambio ajeno', () => {
  const enServidor = transferencia({ actualizadaEn: '2026-09-20T09:00:00.000Z' })
  const versionQueLeyoElCliente = '2026-09-19T10:00:00.000Z'

  const r = aplicarTransferencia(enServidor, 'despachar', versionQueLeyoElCliente, {
    fecha: HOY,
    prefijo: 'mv_tr',
  })

  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'conflicto_de_version')
  assert.equal(r.versionActual, '2026-09-20T09:00:00.000Z', 'se informa la versión vigente')
  // Lo importante: no hay ninguna transferencia modificada en el resultado.
  assert.ok(!('transferencia' in r), 'un conflicto no devuelve estado para escribir')
})

test('con la versión vigente la transición sí se aplica', () => {
  const vigente = transferencia({ actualizadaEn: '2026-09-20T09:00:00.000Z' })
  const r = aplicarTransferencia(vigente, 'despachar', vigente.actualizadaEn, {
    fecha: HOY,
    prefijo: 'mv_tr',
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.transferencia.estado, 'dispatched')
  assert.equal(r.transferencia.actualizadaEn, HOY, 'la marca avanza con la escritura')
})

test('una transición que no corresponde al estado se rechaza', () => {
  const borrador = transferencia({ estado: 'draft' })
  const r = aplicarTransferencia(borrador, 'recibir', borrador.actualizadaEn, {
    fecha: HOY,
    prefijo: 'mv_tr',
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'transicion_invalida')
  assert.equal(r.estado, 'draft')
})

test('una transferencia al mismo depósito se rechaza (espeja st_distinct_wr)', () => {
  const r = aplicarTransferencia(
    transferencia({ hastaId: 'dep_a' }),
    'despachar',
    '2026-09-19T10:00:00.000Z',
    { fecha: HOY, prefijo: 'mv_tr' },
  )
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'depositos_iguales')
})

test('accionesTransferencia describe la máquina de estados completa', () => {
  assert.deepEqual(accionesTransferencia('draft'), ['despachar', 'cancelar'])
  assert.deepEqual(accionesTransferencia('dispatched'), ['recibir', 'cancelar'])
  assert.deepEqual(accionesTransferencia('received'), [])
  assert.deepEqual(accionesTransferencia('cancelled'), [])
})

test('despachar registra sólo la salida; recibir registra salida y entrada', () => {
  const despachada = transferencia({ estado: 'dispatched' })
  const soloSalida = movimientosDeTransferencia(despachada, HOY, 'mv_tr')
  assert.equal(soloSalida.length, 1)
  assert.equal(soloSalida[0]?.tipo, 'transfer_out')
  assert.equal(soloSalida[0]?.depositoId, 'dep_a')
  assert.equal(soloSalida[0]?.cantidad, -10)

  const recibida = transferencia({ estado: 'received' })
  const ambas = movimientosDeTransferencia(recibida, HOY, 'mv_tr')
  assert.equal(ambas.length, 2, 'una salida y una entrada')
  assert.equal(ambas[1]?.tipo, 'transfer_in')
  assert.equal(ambas[1]?.depositoId, 'dep_b')
})

test('lo recibido puede ser menor que lo enviado, y la entrada usa lo recibido', () => {
  const recibida = transferencia({
    estado: 'received',
    items: [
      { productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', cantidadEnviada: 10, cantidadRecibida: 7 },
    ],
  })
  const movimientos = movimientosDeTransferencia(recibida, HOY, 'mv_tr')
  const entrada = movimientos.find((m) => m.tipo === 'transfer_in')
  assert.equal(entrada?.cantidad, 7, 'la merma del traslado no entra al destino')
  assert.equal(entrada?.cantidad, 7)
  assert.notEqual(entrada?.cantidad, 10)
})

test('una transferencia cancelada o en borrador no mueve stock', () => {
  assert.deepEqual(movimientosDeTransferencia(transferencia({ estado: 'draft' }), HOY, 'mv_tr'), [])
  assert.deepEqual(movimientosDeTransferencia(transferencia({ estado: 'cancelled' }), HOY, 'mv_tr'), [])
})

test('unidadesDeTransferencia suma los renglones', () => {
  assert.equal(unidadesDeTransferencia(transferencia().items), 10)
  assert.equal(unidadesDeTransferencia([]), 0)
})

// ---------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------

test('conciliar cuadra cuando el libro explica el saldo', () => {
  const n = [nivel({ cantidad: 100, reservada: 0 })]
  const m: MovimientoStock[] = [
    { id: 'a', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'purchase_in', cantidad: 120, fecha: HOY },
    { id: 'b', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'sale_out', cantidad: -20, fecha: HOY },
  ]
  const r = conciliar(n, m)
  assert.equal(r.cuadra, true)
  assert.deepEqual(r.diferencias, [])
  assert.equal(r.filas[0]?.libro, 100)
  assert.equal(r.filas[0]?.diferencia, 0)
})

test('conciliar reporta la diferencia cuando el libro no alcanza al saldo', () => {
  const n = [nivel({ cantidad: 97 })]
  const m: MovimientoStock[] = [
    { id: 'a', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'purchase_in', cantidad: 100, fecha: HOY },
  ]
  const r = conciliar(n, m)
  assert.equal(r.cuadra, false)
  assert.equal(r.diferencias.length, 1)
  assert.equal(r.diferencias[0]?.diferencia, -3, 'el saldo declara 3 menos de lo que el libro explica')
})

test('conciliar no cuenta las reservas como cantidad física', () => {
  const n = [nivel({ cantidad: 50, reservada: 10 })]
  const m: MovimientoStock[] = [
    { id: 'a', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'purchase_in', cantidad: 50, fecha: HOY },
    { id: 'b', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'reservation', cantidad: 10, fecha: HOY },
  ]
  const r = conciliar(n, m)
  assert.equal(r.cuadra, true, 'una reserva no desvía la cantidad física')
})

test('conciliar separa por depósito: el mismo producto en dos depósitos no se mezcla', () => {
  const n = [
    nivel({ cantidad: 10, depositoId: 'dep_a' }),
    nivel({ cantidad: 20, depositoId: 'dep_b' }),
  ]
  const m: MovimientoStock[] = [
    { id: 'a', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_a', tipo: 'purchase_in', cantidad: 10, fecha: HOY },
    { id: 'b', productoId: 'prd_x', sku: 'SKU-X', nombre: 'Producto X', depositoId: 'dep_b', tipo: 'purchase_in', cantidad: 20, fecha: HOY },
  ]
  assert.equal(conciliar(n, m).cuadra, true)
})

// ---------------------------------------------------------------------------
// Los datos simulados y la lógica dicen lo mismo
// ---------------------------------------------------------------------------

test('los movimientos simulados respetan el signo que su tipo implica', () => {
  for (const m of movimientos) {
    const signo = SIGNO_DEL_MOVIMIENTO[m.tipo]
    if (signo === 0) continue
    assert.equal(
      Math.sign(m.cantidad),
      signo,
      `el movimiento ${m.id} (${m.tipo}) tiene el signo cambiado`,
    )
  }
})

test('la conciliación de los datos simulados cuadra salvo la diferencia deliberada', () => {
  const r = conciliar(niveles, movimientos)
  // Los fixtures incluyen a propósito un desvío de 3 unidades (prd_002 en dep_sur),
  // para que la ventana de conciliación muestre un hallazgo real y no una tabla vacía.
  assert.equal(r.diferencias.length, 1, 'exactamente un desvío sembrado')
  assert.equal(r.diferencias[0]?.diferencia, -3)
  assert.equal(r.cuadra, false)
  assert.equal(r.filas.length, niveles.length)
})

test('las transferencias simuladas traen los tres estados que la ventana necesita', () => {
  const estados = new Set(transferencias.map((t) => t.estado))
  assert.ok(estados.has('draft'), 'una en borrador, para poder despachar')
  assert.ok(estados.has('dispatched'), 'una despachada, para poder recibir')
  assert.ok(estados.has('received'), 'una recibida, que ya no ofrece acciones')
})
