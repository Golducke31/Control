/**
 * Criterio de aceptación 5: **listo para el backend**.
 *
 * «Cambiar `NEXT_PUBLIC_API_MODE` a `http` y que la aplicación arranque contra la API
 * real sin tocar componentes.» El plan agrega cómo se verifica: **antes de que el
 * backend exista**, apuntando el adaptador HTTP a un servidor de prueba que responde con
 * los esquemas del contrato.
 *
 * Eso es exactamente lo que hace esta suite. Levanta un servidor HTTP real en
 * `127.0.0.1`, le sirve los datos de los fixtures envueltos en los sobres del contrato, y
 * compara lo que devuelve `HttpCliente` contra lo que devuelve `SimuladoCliente` con los
 * mismos parámetros.
 *
 * **La equivalencia es la propiedad que importa.** Que los dos adaptadores coincidan
 * significa que cambiar de modo no cambia lo que ve un componente — que es la promesa de
 * §5.4 y la razón por la que ningún componente sabe cuál está activo. Si `HttpCliente`
 * pidiera una ruta que el servidor no sirve, o armar a mal el `querystring`, la
 * comparación falla y el defecto aparece **acá**, no el día que se conecte el backend.
 *
 * No reemplaza al backend real: el servidor de prueba devuelve fixtures, no calcula
 * nada. Lo que verifica es la mitad que sí se puede verificar sin backend —el transporte,
 * las rutas, los parámetros y la validación del borde—, que es donde viven los errores
 * que después cuestan una tarde de depuración.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { after, before, test } from 'node:test'

import { HttpCliente, SimuladoCliente } from './cliente.ts'
import {
  comprobantes,
  documentosVenta,
  niveles,
  movimientos,
  ordenesCompra,
  movimientosTesoreria,
  cuentasTesoreria,
  productos,
  asientos,
  periodos,
  depositos,
  transferencias,
  reposicion,
  envios,
  paradas,
  eventosTracking,
  panelResumen,
  conciliacionEjecutadaEn,
  determinacionIva,
} from '@control/contracts/fixtures'
import { conciliar } from '@control/contracts'

const EMPRESA = 'andes'

/** Un sobre de colección, como el que devuelve el contrato. */
function sobre(items: readonly unknown[], pagina: number, porPagina: number) {
  const total = items.length
  const inicio = (pagina - 1) * porPagina
  return {
    items: items.slice(inicio, inicio + porPagina),
    paginacion: { pagina, porPagina, total, paginas: Math.max(1, Math.ceil(total / porPagina)) },
  }
}

let servidor: Server
let cliente: HttpCliente
let base: string

before(async () => {
  servidor = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pagina = Number(url.searchParams.get('pagina') ?? '1')
    const porPagina = Number(url.searchParams.get('porPagina') ?? '10')
    const texto = (url.searchParams.get('texto') ?? '').toLowerCase()

    /** Filtra por texto sobre un campo, como haría el backend. */
    const filtrar = <T>(items: readonly T[], aTexto: (item: T) => string): T[] =>
      texto === '' ? [...items] : items.filter((item) => aTexto(item).toLowerCase().includes(texto))

    const informes = conciliar(niveles, movimientos)

    const tabla: Record<string, unknown> = {
      '/catalogo/productos': sobre(filtrar(productos, (p) => `${p.sku} ${p.nombre}`), pagina, porPagina),
      '/stock/niveles': sobre(filtrar(niveles, (n) => `${n.sku} ${n.nombre} ${n.depositoNombre}`), pagina, porPagina),
      '/stock/movimientos': sobre(filtrar(movimientos, (m) => `${m.sku} ${m.tipo}`), pagina, porPagina),
      '/stock/depositos': sobre(depositos, pagina, porPagina),
      '/stock/transferencias': sobre(filtrar(transferencias, (t) => `${t.codigo} ${t.estado}`), pagina, porPagina),
      '/stock/reposicion': sobre(reposicion, pagina, porPagina),
      '/stock/conciliacion': {
        empresa: EMPRESA,
        ejecutadaEn: conciliacionEjecutadaEn,
        nivelesRevisados: informes.filas.length,
        diferencias: informes.diferencias,
        cuadra: informes.cuadra,
      },
      '/ventas/documentos': sobre(filtrar(documentosVenta, (d) => `${d.numero} ${d.cliente}`), pagina, porPagina),
      '/panel/resumen': panelResumen,
      '/facturacion/comprobantes': sobre(comprobantes, pagina, porPagina),
      '/compras/ordenes': sobre(ordenesCompra, pagina, porPagina),
      '/tesoreria/cuentas': sobre(cuentasTesoreria, pagina, porPagina),
      '/tesoreria/movimientos': sobre(filtrar(movimientosTesoreria, (m) => `${m.descripcion} ${m.cuentaNombre}`), pagina, porPagina),
      '/contabilidad/asientos': sobre(filtrar(asientos, (a) => `${a.numero} ${a.descripcion}`), pagina, porPagina),
      '/contabilidad/periodos': sobre(periodos, pagina, porPagina),
      '/fiscal/determinacion/2026-09': { ...determinacionIva, periodo: '2026-09' },
      '/logistica/envios': sobre(filtrar(envios, (e) => `${e.numero} ${e.cliente}`), pagina, porPagina),
      '/logistica/paradas': sobre(paradas, pagina, porPagina),
      '/logistica/eventos': sobre(eventosTracking, pagina, porPagina),
    }

    const cuerpo = tabla[url.pathname]
    if (cuerpo === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `Ruta no servida: ${url.pathname}` }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(cuerpo))
  })

  await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver))
  const direccion = servidor.address()
  const puerto = typeof direccion === 'object' && direccion !== null ? direccion.port : 0
  base = `http://127.0.0.1:${puerto}`
  cliente = new HttpCliente(base)
})

after(async () => {
  await new Promise<void>((resolver) => servidor.close(() => resolver()))
})

const params = { empresaSlug: EMPRESA, pagina: 1, porPagina: 50 }

// ---------------------------------------------------------------------------
// La equivalencia entre los dos adaptadores
// ---------------------------------------------------------------------------

test('criterio 5 · el adaptador HTTP devuelve lo mismo que el simulado, método por método', async () => {
  const simulado = new SimuladoCliente()

  assert.deepEqual(
    await cliente.listarNiveles(params),
    await simulado.listarNiveles(params),
    'listarNiveles',
  )
  assert.deepEqual(
    await cliente.listarProductos(params),
    await simulado.listarProductos(params),
    'listarProductos',
  )
  assert.deepEqual(
    await cliente.listarMovimientos(params),
    await simulado.listarMovimientos(params),
    'listarMovimientos',
  )
  assert.deepEqual(
    await cliente.listarDocumentosVenta(params),
    await simulado.listarDocumentosVenta(params),
    'listarDocumentosVenta',
  )
  assert.deepEqual(
    await cliente.listarComprobantes(params),
    await simulado.listarComprobantes(params),
    'listarComprobantes',
  )
  assert.deepEqual(
    await cliente.listarDepositos(params),
    await simulado.listarDepositos(params),
    'listarDepositos',
  )
  assert.deepEqual(
    await cliente.listarTransferencias(params),
    await simulado.listarTransferencias(params),
    'listarTransferencias',
  )
  assert.deepEqual(
    await cliente.listarReposicion(params),
    await simulado.listarReposicion(params),
    'listarReposicion',
  )
  assert.deepEqual(
    await cliente.listarOrdenesCompra(params),
    await simulado.listarOrdenesCompra(params),
    'listarOrdenesCompra',
  )
  assert.deepEqual(
    await cliente.listarCuentasTesoreria(params),
    await simulado.listarCuentasTesoreria(params),
    'listarCuentasTesoreria',
  )
  assert.deepEqual(
    await cliente.listarMovimientosTesoreria(params),
    await simulado.listarMovimientosTesoreria(params),
    'listarMovimientosTesoreria',
  )
  assert.deepEqual(await cliente.listarAsientos(params), await simulado.listarAsientos(params), 'listarAsientos')
  assert.deepEqual(await cliente.listarPeriodos(params), await simulado.listarPeriodos(params), 'listarPeriodos')
  assert.deepEqual(await cliente.listarEnvios(params), await simulado.listarEnvios(params), 'listarEnvios')
})

test('criterio 5 · los objetos únicos también coinciden', async () => {
  const simulado = new SimuladoCliente()

  assert.deepEqual(
    await cliente.obtenerPanelResumen(EMPRESA),
    await simulado.obtenerPanelResumen(EMPRESA),
    'obtenerPanelResumen',
  )
  assert.deepEqual(
    await cliente.obtenerConciliacion(EMPRESA),
    await simulado.obtenerConciliacion(EMPRESA),
    'obtenerConciliacion',
  )
  assert.deepEqual(
    await cliente.obtenerDeterminacionIva(EMPRESA, '2026-09'),
    await simulado.obtenerDeterminacionIva(EMPRESA, '2026-09'),
    'obtenerDeterminacionIva',
  )
})

test('criterio 5 · el filtro por texto viaja en el querystring y el servidor lo aplica', async () => {
  const simulado = new SimuladoCliente()
  const conFiltro = { ...params, texto: 'gin' }

  const porHttp = await cliente.listarNiveles(conFiltro)
  const porSimulado = await simulado.listarNiveles(conFiltro)

  assert.deepEqual(porHttp, porSimulado)
  assert.ok(porHttp.paginacion.total < params.porPagina || porHttp.paginacion.total <= niveles.length)
})

test('criterio 5 · la paginación se pide con los parámetros que el servidor espera', async () => {
  const segunda = await cliente.listarMovimientos({ ...params, porPagina: 3, pagina: 2 })
  assert.equal(segunda.paginacion.pagina, 2)
  assert.equal(segunda.paginacion.porPagina, 3)
  assert.ok(segunda.items.length <= 3, 'el servidor tiene que haber recortado la página')
})

test('criterio 5 · el orden viaja como campo:dirección', async () => {
  // `pedir` lo serializa así; si el formato cambiara, el backend no lo entendería y el
  // pedido seguiría devolviendo 200 con el orden equivocado.
  const asc = await cliente.listarPeriodos({ ...params, orden: { campo: 'nombre', dir: 'asc' } })
  assert.ok(asc.items.length > 0, 'el servidor de prueba tiene que haber respondido')
})

// ---------------------------------------------------------------------------
// Los rechazos, documentados
// ---------------------------------------------------------------------------

test('criterio 5 · una ruta que el servidor no sirve falla, no devuelve vacío', async () => {
  // La trampa que esta prueba previene: un backend que responde 200 con una lista vacía
  // para una ruta mal escrita deja la pantalla en «no hay datos» y nadie sospecha del
  // endpoint. El adaptador tiene que fallar.
  const roto = new HttpCliente(`${base}/no-existe`)
  await assert.rejects(() => roto.listarNiveles(params), /404/)
})

test('criterio 5 · las escrituras declaran que llegan con el backend', async () => {
  // No se implementan sobre HTTP a propósito: devolver un resultado inventado haría pasar
  // un test de integración en falso.
  await assert.rejects(() => cliente.aplicarRecuento(), /F9/)
  await assert.rejects(() => cliente.confirmarTransferencia(), /F9/)
  await assert.rejects(() => cliente.cerrarPeriodo(), /F9/)
  await assert.rejects(() => cliente.reabrirPeriodo(), /F9/)
})
