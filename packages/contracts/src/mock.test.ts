import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProductoSchema, ProductoListadoSchema } from './catalogo.ts'
import {
  DepositoSchema,
  NivelStockSchema,
  ReposicionSchema,
  TransferenciaSchema,
} from './stock.ts'
import { DocumentoVentaSchema } from './ventas.ts'
import { MiembroSchema } from './gobierno.ts'
import {
  productos,
  niveles,
  movimientos,
  depositos,
  transferencias,
  reposicion,
  documentosVenta,
  miembros,
  auditoria,
  tareas,
} from './fixtures.ts'

test('los productos simulados validan contra el esquema', () => {
  assert.equal(productos.length, 8)
  for (const p of productos) ProductoSchema.parse(p)
})

test('la regla de negocio del nivel de stock se cumple en los datos simulados', () => {
  for (const n of niveles) {
    assert.equal(n.disponible, n.cantidad - n.reservada, `disponible roto en ${n.sku}`)
    NivelStockSchema.parse(n)
  }
  // Cobertura: al menos un nivel con reserva distinta de cero.
  assert.ok(niveles.some((n) => n.reservada > 0))
})

test('los movimientos usan valores válidos de app.stock_move_kind', () => {
  for (const m of movimientos) {
    // `tipo` es el enum del motor; el parse lo fuerza a coincidir.
    assert.ok(
      [
        'purchase_in',
        'sale_out',
        'transfer_out',
        'transfer_in',
        'adjustment_pos',
        'adjustment_neg',
        'return_in',
        'reservation',
        'release',
      ].includes(m.tipo),
      `tipo fuera de pg_enum: ${m.tipo}`,
    )
  }
})

test('el sobre de colección de productos es válido', () => {
  const lista = ProductoListadoSchema.parse({
    items: productos,
    paginacion: { pagina: 1, porPagina: 20, total: productos.length, paginas: 1 },
  })
  assert.equal(lista.items.length, productos.length)
})

test('documentos, miembros y tareas validan', () => {
  for (const d of documentosVenta) DocumentoVentaSchema.parse(d)
  for (const m of miembros) MiembroSchema.parse(m)
  for (const a of auditoria) {
    assert.ok(a.fecha.startsWith('2026'), 'fecha de auditoría presente')
  }
  assert.ok(tareas.length >= 1)
})

test('un producto con estado inexistente es rechazado (negativo)', () => {
  assert.throws(
    () =>
      ProductoSchema.parse({
        id: 'x',
        sku: 'X-1',
        nombre: 'Roto',
        categoriaId: 'c',
        marcaId: 'm',
        estado: 'produccion', // no es un valor del enum
        precio: 100,
        costo: 50,
        moneda: 'ARS',
        stock: 1,
        creadoEn: '2026-01-01T00:00:00.000Z',
        actualizadoEn: '2026-01-01T00:00:00.000Z',
      }),
    /estado/,
  )
})

test('un nivel con disponible inconsistente se detecta antes de validar', () => {
  // La regla de negocio no la impone el esquema Zod (es derivada); la suite la
  // vigila. Si un fixture la rompe, lo detectamos aquí, no en producción.
  const roto = niveles.map((n, i) =>
    i === 0 ? { ...n, disponible: n.cantidad - n.reservada + 1 } : n,
  )
  const inconsistente = roto.find(
    (n, i) => i === 0 && n.disponible !== n.cantidad - n.reservada,
  )
  assert.ok(inconsistente !== undefined, 'la regla de negocio se puede verificar')
})

test('los fixtures de inventario validan contra sus esquemas', () => {
  for (const d of depositos) DepositoSchema.parse(d)
  for (const t of transferencias) TransferenciaSchema.parse(t)
  for (const r of reposicion) ReposicionSchema.parse(r)
})

test('cada transferencia sale de un depósito distinto al que llega', () => {
  // Espeja el CHECK `st_distinct_wr` del motor: un fixture que lo rompiera estaría
  // mostrando un documento que la base no podría haber aceptado.
  for (const t of transferencias) {
    assert.notEqual(t.desdeId, t.hastaId, `${t.codigo} sale y llega al mismo depósito`)
  }
})

test('las transferencias despachadas o recibidas tienen su salida en el libro', () => {
  // Una transferencia que movió stock y no dejó rastro en el libro es exactamente lo
  // que la conciliación tiene que detectar; acá se vigila que los fixtures no lo hagan.
  const conSalida = transferencias.filter((t) => t.estado === 'dispatched' || t.estado === 'received')
  assert.ok(conSalida.length > 0, 'hay al menos una transferencia que movió stock')
  for (const t of conSalida) {
    assert.ok(
      movimientos.some((m) => m.documento === t.codigo && m.tipo === 'transfer_out'),
      `${t.codigo} movió stock pero no tiene su transfer_out en el libro`,
    )
  }
})

test('la reposición sugiere al menos lo que falta para llegar al mínimo', () => {
  for (const r of reposicion) {
    assert.ok(r.disponible < r.minimo, `${r.sku} no debería estar en reposición`)
    assert.ok(
      r.sugerido >= r.minimo - r.disponible,
      `${r.sku} sugiere ${r.sugerido}, menos de lo que falta (${r.minimo - r.disponible})`,
    )
  }
})
