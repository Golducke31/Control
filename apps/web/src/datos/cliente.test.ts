import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimuladoCliente } from './cliente.ts'
import { ProductoListadoSchema, DocumentoVentaListadoSchema, FacturacionListadoSchema, PanelResumenSchema } from '@control/contracts'

const cliente = new SimuladoCliente()

test('listarProductos valida en la frontera y devuelve el sobre', async () => {
  const r = await cliente.listarProductos({ empresaSlug: 'andes', pagina: 1, porPagina: 10 })
  // El parse contra el esquema del contrato es la validación en el borde (§5.4).
  assert.deepEqual(ProductoListadoSchema.parse(r), r)
  assert.ok(r.items.length > 0)
  assert.equal(r.paginacion.total, r.items.length)
})

test('el filtro de texto acota los resultados', async () => {
  const todos = await cliente.listarProductos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const filtrado = await cliente.listarProductos({
    empresaSlug: 'andes',
    texto: 'gin',
    pagina: 1,
    porPagina: 50,
  })
  assert.ok(filtrado.paginacion.total < todos.paginacion.total, 'el filtro reduce la cuenta')
  assert.ok(
    filtrado.items.every((p) => `${p.sku} ${p.nombre}`.toLowerCase().includes('gin')),
    'todo lo devuelto coincide con el texto',
  )
})

test('la paginación recorta y reporta el total de páginas', async () => {
  const r = await cliente.listarProductos({ empresaSlug: 'andes', pagina: 1, porPagina: 3 })
  assert.equal(r.items.length, 3)
  assert.ok(r.paginacion.paginas >= 2)
  const p2 = await cliente.listarProductos({ empresaSlug: 'andes', pagina: 2, porPagina: 3 })
  assert.notDeepEqual(
    p2.items.map((i) => i.id),
    r.items.map((i) => i.id),
    'la página 2 trae otros productos',
  )
})

test('el orden por precio es estable y direccional', async () => {
  const asc = await cliente.listarProductos({
    empresaSlug: 'andes',
    pagina: 1,
    porPagina: 50,
    orden: { campo: 'precio', dir: 'asc' },
  })
  const precios = asc.items.map((i) => i.precio)
  const ordenado = [...precios].sort((a, b) => a - b)
  assert.deepEqual(precios, ordenado, 'precio ascendente')
})

test('listarDocumentosVenta valida en la frontera y trae la cadena', async () => {
  const r = await cliente.listarDocumentosVenta({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(DocumentoVentaListadoSchema.parse(r), r)
  assert.ok(r.items.some((d) => d.tipo === 'cotizacion' && d.venceEn != null), 'la cadena trae cotizaciones con vencimiento')
  assert.ok(r.items.some((d) => d.tipo === 'remito' && d.facturadoCompleto === true), 'la cadena trae remitos facturados')
})

test('obtenerPanelResumen refleja la empresa y valida el contrato', async () => {
  const r = await cliente.obtenerPanelResumen('pampa')
  assert.deepEqual(PanelResumenSchema.parse(r), r)
  assert.equal(r.empresa, 'pampa')
  assert.ok(r.kpis.length > 0)
})

test('listarComprobantes valida y filtra por texto', async () => {
  const r = await cliente.listarComprobantes({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(FacturacionListadoSchema.parse(r), r)
  const filtrado = await cliente.listarComprobantes({
    empresaSlug: 'andes',
    texto: 'mayorista',
    pagina: 1,
    porPagina: 50,
  })
  assert.ok(filtrado.paginacion.total < r.paginacion.total)
  assert.ok(filtrado.items.every((c) => `${c.numero} ${c.cliente}`.toLowerCase().includes('mayorista')))
})
