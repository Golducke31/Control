import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimuladoCliente } from './cliente.ts'
import {
  ProductoListadoSchema,
  DocumentoVentaListadoSchema,
  FacturacionListadoSchema,
  PanelResumenSchema,
  ConciliacionSchema,
  DepositoListadoSchema,
  TransferenciaListadoSchema,
  ReposicionListadoSchema,
} from '@control/contracts'

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

// ---------------------------------------------------------------------------
// Inventario (F5). Las lecturas van primero: las escrituras de más abajo mutan el
// almacén en proceso del adaptador simulado, y el orden importa.
// ---------------------------------------------------------------------------

test('obtenerConciliacion corre la misma función que el job y reporta el desvío sembrado', async () => {
  const r = await cliente.obtenerConciliacion('andes')
  assert.deepEqual(ConciliacionSchema.parse(r), r)
  assert.equal(r.empresa, 'andes')
  assert.equal(r.nivelesRevisados, 5)
  assert.equal(r.cuadra, false, 'el libro no explica todo el saldo, y el job lo dice')
  assert.equal(r.diferencias.length, 1, 'un solo desvío, el sembrado a propósito')
  assert.equal(r.diferencias[0]?.diferencia, -3)
})

test('listarDepositos valida y trae los tres depósitos', async () => {
  const r = await cliente.listarDepositos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(DepositoListadoSchema.parse(r), r)
  assert.equal(r.paginacion.total, 3)
})

test('listarTransferencias valida y ordena por unidades', async () => {
  const r = await cliente.listarTransferencias({
    empresaSlug: 'andes',
    pagina: 1,
    porPagina: 50,
    orden: { campo: 'unidades', dir: 'desc' },
  })
  assert.deepEqual(TransferenciaListadoSchema.parse(r), r)
  const unidades = r.items.map((t) => t.items.reduce((s, i) => s + i.cantidadEnviada, 0))
  assert.deepEqual(unidades, [...unidades].sort((a, b) => b - a), 'descendente por unidades')
})

test('listarReposicion valida y sólo trae lo que está bajo el mínimo', async () => {
  const r = await cliente.listarReposicion({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(ReposicionListadoSchema.parse(r), r)
  assert.ok(r.items.length > 0)
  assert.ok(r.items.every((x) => x.disponible < x.minimo), 'todo lo listado está bajo el mínimo')
})

test('aplicarRecuento ajusta el saldo y deja la fila en el libro, visible en la lectura siguiente', async () => {
  const antes = await cliente.listarNiveles({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const objetivo = antes.items[0]
  assert.ok(objetivo !== undefined)
  if (objetivo === undefined) return

  const libroAntes = await cliente.listarMovimientos({ empresaSlug: 'andes', pagina: 1, porPagina: 100 })

  const r = await cliente.aplicarRecuento({
    empresaSlug: 'andes',
    nivel: objetivo,
    contado: objetivo.cantidad - 2,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.ajuste.nivel.cantidad, objetivo.cantidad - 2)

  const despues = await cliente.listarNiveles({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const actualizado = despues.items.find(
    (n) => n.productoId === objetivo.productoId && n.depositoId === objetivo.depositoId,
  )
  assert.equal(actualizado?.cantidad, objetivo.cantidad - 2, 'la escritura se ve en la lectura siguiente')

  const libroDespues = await cliente.listarMovimientos({ empresaSlug: 'andes', pagina: 1, porPagina: 100 })
  assert.equal(libroDespues.paginacion.total, libroAntes.paginacion.total + 1, 'el libro ganó una fila')
})

test('aplicarRecuento rechaza contar por debajo de lo reservado', async () => {
  const lista = await cliente.listarNiveles({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const conReserva = lista.items.find((n) => n.reservada > 0)
  assert.ok(conReserva !== undefined, 'hay un nivel con reserva para probar')
  if (conReserva === undefined) return

  const r = await cliente.aplicarRecuento({ empresaSlug: 'andes', nivel: conReserva, contado: 0 })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'contado_por_debajo_de_lo_reservado')
})

test('confirmarTransferencia con una versión vieja avisa y no cambia nada', async () => {
  const lista = await cliente.listarTransferencias({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const borrador = lista.items.find((t) => t.estado === 'draft')
  assert.ok(borrador !== undefined)
  if (borrador === undefined) return

  const r = await cliente.confirmarTransferencia({
    empresaSlug: 'andes',
    id: borrador.id,
    accion: 'despachar',
    versionEsperada: '2020-01-01T00:00:00.000Z',
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'conflicto_de_version')
  assert.equal(r.versionActual, borrador.actualizadaEn)

  const despues = await cliente.listarTransferencias({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.equal(despues.items.find((t) => t.id === borrador.id)?.estado, 'draft', 'sigue en borrador')
})

test('confirmarTransferencia con la versión vigente despacha y mueve el saldo del origen', async () => {
  const lista = await cliente.listarTransferencias({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const borrador = lista.items.find((t) => t.estado === 'draft')
  assert.ok(borrador !== undefined)
  if (borrador === undefined) return

  const item = borrador.items[0]
  assert.ok(item !== undefined)
  if (item === undefined) return

  const nivelesAntes = await cliente.listarNiveles({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const origenAntes = nivelesAntes.items.find(
    (n) => n.productoId === item.productoId && n.depositoId === borrador.desdeId,
  )

  const r = await cliente.confirmarTransferencia({
    empresaSlug: 'andes',
    id: borrador.id,
    accion: 'despachar',
    versionEsperada: borrador.actualizadaEn,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.transferencia.estado, 'dispatched')
  assert.equal(r.movimientos.length, 1, 'despachar registra sólo la salida')
  assert.equal(r.movimientos[0]?.tipo, 'transfer_out')

  const nivelesDespues = await cliente.listarNiveles({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const origenDespues = nivelesDespues.items.find(
    (n) => n.productoId === item.productoId && n.depositoId === borrador.desdeId,
  )
  assert.equal(
    origenDespues?.cantidad,
    (origenAntes?.cantidad ?? 0) - item.cantidadEnviada,
    'el saldo del origen bajó lo que salió',
  )
})
