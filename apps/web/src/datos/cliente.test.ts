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
  AsientoListadoSchema,
  DeterminacionIvaSchema,
  MovimientoTesoreriaListadoSchema,
  OrdenCompraListadoSchema,
  PeriodoListadoSchema,
  TrabajoListadoSchema,
  MiembroListadoSchema,
  AuditoriaListadoSchema,
  estadoDeTrabajo,
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

// ---------------------------------------------------------------------------
// Finanzas (F6). Las lecturas primero otra vez: las escrituras de más abajo mutan
// el almacén de períodos.
// ---------------------------------------------------------------------------

test('listarOrdenesCompra valida en la frontera y trae los seis estados del motor', async () => {
  const r = await cliente.listarOrdenesCompra({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(OrdenCompraListadoSchema.parse(r), r)
  assert.ok(r.items.length > 0)
  // Toda orden aprobada o recibida registra su aprobación (espeja po_approval_recorded).
  for (const o of r.items) {
    if (['approved', 'partially_received', 'received'].includes(o.estado)) {
      assert.notEqual(o.aprobadaEn, null, `${o.numero} sin registro de aprobación`)
    }
  }
})

test('listarMovimientosTesoreria valida y filtra por cuenta', async () => {
  const r = await cliente.listarMovimientosTesoreria({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(MovimientoTesoreriaListadoSchema.parse(r), r)
  const filtrado = await cliente.listarMovimientosTesoreria({
    empresaSlug: 'andes',
    texto: 'banco río',
    pagina: 1,
    porPagina: 50,
  })
  assert.ok(filtrado.paginacion.total < r.paginacion.total)
  assert.ok(filtrado.items.every((m) => m.cuentaNombre.toLowerCase().includes('banco río')))
})

test('listarAsientos valida y respeta la partida doble de los datos simulados', async () => {
  const r = await cliente.listarAsientos({ empresaSlug: 'andes', pagina: 1, porPagina: 500 })
  assert.deepEqual(AsientoListadoSchema.parse(r), r)
  const debito = r.items.reduce((s, a) => s + a.debito, 0)
  const credito = r.items.reduce((s, a) => s + a.credito, 0)
  assert.equal(debito, credito, 'los asientos simulados cierran por partida doble')
})

test('listarPeriodos valida y trae cerrado, abierto y reabierto', async () => {
  const r = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(PeriodoListadoSchema.parse(r), r)
  assert.ok(r.items.some((p) => p.estado === 'closed'))
  assert.ok(r.items.some((p) => p.estado === 'open'))
  assert.ok(r.items.some((p) => p.reabiertoEn !== null))
})

test('obtenerDeterminacionIva refleja el período pedido y valida', async () => {
  const r = await cliente.obtenerDeterminacionIva('andes', '2026-08')
  assert.deepEqual(DeterminacionIvaSchema.parse(r), r)
  assert.equal(r.periodo, '2026-08')
  assert.equal(r.saldoTecnico, r.ivaDebito - r.ivaCredito, 'el saldo técnico sale de los dos componentes')
})

test('cerrarPeriodo rechaza un período con asientos en borrador', async () => {
  const lista = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const conPendientes = lista.items.find((p) => p.estado === 'open' && p.asientosPendientes > 0)
  assert.ok(conPendientes !== undefined, 'hay un período con asientos pendientes para probar')
  if (conPendientes === undefined) return

  const r = await cliente.cerrarPeriodo({ empresaSlug: 'andes', periodo: conPendientes, autor: 'Ana Dueña' })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'asientos_pendientes')

  const despues = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.equal(despues.items.find((p) => p.id === conPendientes.id)?.estado, 'open', 'sigue abierto')
})

test('cerrarPeriodo cierra el que no tiene pendientes, y el cierre se ve en la lectura siguiente', async () => {
  const lista = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const limpio = lista.items.find((p) => p.estado === 'open' && p.asientosPendientes === 0)
  assert.ok(limpio !== undefined)
  if (limpio === undefined) return

  const r = await cliente.cerrarPeriodo({ empresaSlug: 'andes', periodo: limpio, autor: 'Ana Dueña' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.periodo.estado, 'closed')
  assert.equal(r.periodo.cerradoPor, 'Ana Dueña')
  assert.notEqual(r.periodo.cerradoEn, null, 'closed y cerradoEn van juntos')

  const despues = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const actualizado = despues.items.find((p) => p.id === limpio.id)
  assert.equal(actualizado?.estado, 'closed', 'la escritura se ve en la lectura siguiente')
})

test('reabrirPeriodo exige motivo y deja el rastro', async () => {
  const lista = await cliente.listarPeriodos({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  const cerrado = lista.items.find((p) => p.estado === 'closed')
  assert.ok(cerrado !== undefined)
  if (cerrado === undefined) return

  const sinMotivo = await cliente.reabrirPeriodo({
    empresaSlug: 'andes',
    periodo: cerrado,
    autor: 'Ana Dueña',
    motivo: '   ',
  })
  assert.equal(sinMotivo.ok, false)
  if (sinMotivo.ok) return
  assert.equal(sinMotivo.motivo, 'motivo_requerido')

  const conMotivo = await cliente.reabrirPeriodo({
    empresaSlug: 'andes',
    periodo: cerrado,
    autor: 'Ana Dueña',
    motivo: 'Faltó imputar un flete',
  })
  assert.equal(conMotivo.ok, true)
  if (!conMotivo.ok) return
  assert.equal(conMotivo.periodo.estado, 'open')
  assert.equal(conMotivo.periodo.cerradoEn, null, 'el cierre anterior se limpia')
  assert.equal(conMotivo.periodo.motivoReapertura, 'Faltó imputar un flete')
  assert.equal(conMotivo.periodo.reabiertoPor, 'Ana Dueña')
})

// ---------------------------------------------------------------------------
// Gobierno y plataforma (F9)
// ---------------------------------------------------------------------------

test('listarMiembros valida y trae los permisos por persona', async () => {
  const r = await cliente.listarMiembros({ empresaSlug: 'andes', pagina: 1, porPagina: 50 })
  assert.deepEqual(MiembroListadoSchema.parse(r), r)
  assert.ok(r.items.length > 0)
  assert.ok(r.items.every((m) => m.permisos.length > 0), 'cada miembro tiene sus permisos')
})

test('listarAuditoria valida y ordena por fecha', async () => {
  const r = await cliente.listarAuditoria({
    empresaSlug: 'andes',
    pagina: 1,
    porPagina: 50,
    orden: { campo: 'fecha', dir: 'desc' },
  })
  assert.deepEqual(AuditoriaListadoSchema.parse(r), r)
  const fechas = r.items.map((e) => e.fecha)
  assert.deepEqual(fechas, [...fechas].sort().reverse(), 'del más reciente al más antiguo')
})

test('listarTrabajos deriva el estado contra el reloj que recibe', async () => {
  const AHORA = Date.parse('2026-09-20T14:00:00.000Z')
  const r = await cliente.listarTrabajos({ empresaSlug: 'andes', pagina: 1, porPagina: 50, ahoraMs: AHORA })
  assert.deepEqual(TrabajoListadoSchema.parse(r), r)
  assert.ok(r.items.length >= 4, 'los cuatro jobs que el motor siembra tienen que estar')

  // El estado no viene en los datos: se deriva. Y como el reloj entra por parámetro, la
  // misma consulta con otro reloj tiene que dar otro resultado — que es lo que permite
  // probar el atraso sin esperar.
  const estados = new Set(r.items.map((t) => estadoDeTrabajo(t, AHORA)))
  assert.ok(estados.has('al_dia') || estados.has('corriendo'), 'algo tiene que estar sano')
  assert.ok(estados.has('fallando') || estados.has('atrasado'), 'y algo tiene que requerir atención')
})

test('el estado depende del desfase y no del reloj: el mundo simulado está siempre vivo', async () => {
  // Es la propiedad que hace útil al adaptador simulado. Si los escenarios guardaran
  // fechas fijas, en cuanto pasara la fecha del fixture **todos** los jobs aparecerían
  // atrasados y la ventana dejaría de decir la verdad. Como guardan el desfase
  // («corrió hace 6 horas»), el estado se mantiene sea cual sea el momento en que se
  // mire — y por eso el reloj se cancela: el atraso se mide contra el mismo `ahoraMs`
  // con el que se materializó.
  const AHORA = Date.parse('2026-09-20T14:00:00.000Z')
  const DIA = 24 * 3_600_000

  const base = await cliente.listarTrabajos({ empresaSlug: 'andes', pagina: 1, porPagina: 50, ahoraMs: AHORA })
  const lejos = await cliente.listarTrabajos({
    empresaSlug: 'andes',
    pagina: 1,
    porPagina: 50,
    ahoraMs: AHORA + 90 * DIA,
  })

  const estados = (items: typeof base.items, ahora: number) =>
    items.map((t) => `${t.codigo}:${estadoDeTrabajo(t, ahora)}`).join('|')

  assert.equal(
    estados(lejos.items, AHORA + 90 * DIA),
    estados(base.items, AHORA),
    'noventa días después, cada job sigue en el mismo estado',
  )
})
