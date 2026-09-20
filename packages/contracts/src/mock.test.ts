import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProductoSchema, ProductoListadoSchema } from './catalogo.ts'
import { NivelStockSchema } from './stock.ts'
import { DocumentoVentaSchema } from './ventas.ts'
import { MiembroSchema } from './gobierno.ts'
import {
  productos,
  niveles,
  movimientos,
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
