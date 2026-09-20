import type {
  AccionTransferencia,
  Conciliacion,
  DepositoListado,
  DocumentoVentaListado,
  FacturacionListado,
  MovimientoStock,
  MovimientoStockListado,
  NivelStock,
  NivelStockListado,
  Orden,
  PanelResumen,
  ProductoListado,
  ReposicionListado,
  ResultadoRecuento,
  ResultadoTransferencia,
  TransferenciaListado,
} from '@control/contracts'
import {
  ConciliacionSchema,
  DepositoListadoSchema,
  DocumentoVentaListadoSchema,
  FacturacionListadoSchema,
  MovimientoStockListadoSchema,
  NivelStockListadoSchema,
  PanelResumenSchema,
  ProductoListadoSchema,
  ReposicionListadoSchema,
  TransferenciaListadoSchema,
  aplicarRecuento,
  aplicarTransferencia,
  conciliar,
  deltaDeMovimiento,
} from '@control/contracts'
import {
  productos,
  niveles,
  movimientos,
  depositos,
  transferencias,
  reposicion,
  conciliacionEjecutadaEn,
  documentosVenta,
  panelResumen,
  comprobantes,
} from '@control/contracts/fixtures'

/** Parámetros comunes de una consulta de lista. */
export interface ParametrosLista {
  empresaSlug: string
  texto?: string
  pagina: number
  porPagina: number
  orden?: Orden | null
}

/**
 * Contrato de datos que consumen los hooks.
 *
 * Los componentes nunca saben qué implementación está activa: en F3 es
 * `SimuladoCliente`, con el backend será `HttpCliente`. Cambiar `NEXT_PUBLIC_API_MODE`
 * conecta al real sin tocar un solo componente (§5.4).
 */
export interface ApiClient {
  listarProductos(p: ParametrosLista): Promise<ProductoListado>
  listarNiveles(p: ParametrosLista): Promise<NivelStockListado>
  listarMovimientos(p: ParametrosLista): Promise<MovimientoStockListado>
  listarDocumentosVenta(p: ParametrosLista): Promise<DocumentoVentaListado>
  /** Resumen del panel de operación diaria (objeto único, no una colección). */
  obtenerPanelResumen(empresaSlug: string): Promise<PanelResumen>
  listarComprobantes(p: ParametrosLista): Promise<FacturacionListado>

  // --- Inventario (F5) ---
  listarDepositos(p: ParametrosLista): Promise<DepositoListado>
  listarTransferencias(p: ParametrosLista): Promise<TransferenciaListado>
  listarReposicion(p: ParametrosLista): Promise<ReposicionListado>
  /** Resultado del job `stock.reconciliation` (objeto único). */
  obtenerConciliacion(empresaSlug: string): Promise<Conciliacion>
  /** Aplica un recuento físico: ajusta el saldo y escribe el libro. */
  aplicarRecuento(p: {
    empresaSlug: string
    nivel: NivelStock
    contado: number
  }): Promise<ResultadoRecuento>
  /** Confirma una transición de transferencia con la versión que el cliente leyó. */
  confirmarTransferencia(p: {
    empresaSlug: string
    id: string
    accion: AccionTransferencia
    versionEsperada: string
  }): Promise<ResultadoTransferencia>
}

/** Pequeño motor de consulta en memoria sobre los fixtures. */
function consultar<T>(
  items: T[],
  p: ParametrosLista,
  aTexto: (item: T) => string,
  aCampo: (item: T, campo: string) => string | number | undefined,
): { items: T[]; total: number; paginas: number } {
  const texto = p.texto?.trim().toLowerCase() ?? ''
  const filtrados = texto
    ? items.filter((i) => aTexto(i).toLowerCase().includes(texto))
    : items

  const ordenados = [...filtrados]
  if (p.orden && p.orden.campo) {
    const dir = p.orden.dir === 'desc' ? -1 : 1
    const campo = p.orden.campo
    ordenados.sort((a, b) => {
      const va = aCampo(a, campo)
      const vb = aCampo(b, campo)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
  }

  const total = ordenados.length
  const paginas = Math.max(1, Math.ceil(total / p.porPagina))
  const inicio = (p.pagina - 1) * p.porPagina
  const pagina = ordenados.slice(inicio, inicio + p.porPagina)
  return { items: pagina, total, paginas }
}

/**
 * El almacén en proceso del adaptador simulado.
 *
 * Es **module-level** y no de instancia a propósito: `getCliente()` construye un
 * cliente nuevo en cada llamada —el Server Component y el componente cliente piden el
 * suyo—, así que un estado de instancia se perdería entre la escritura y la lectura
 * que la sigue. El adaptador simulado *es* el servidor en esta fase: su almacén tiene
 * que durar lo que dura el proceso, igual que una base.
 *
 * Las lecturas pasan por acá y no por los fixtures directos, para que una escritura
 * simulada se vea en la pantalla siguiente.
 */
const almacen = {
  niveles: [...niveles],
  movimientos: [...movimientos],
  transferencias: [...transferencias],
}

/**
 * Aplica el efecto de una lista de movimientos sobre los saldos materializados.
 *
 * Espeja lo que hace el motor dentro de la misma transacción: el libro y el saldo se
 * mueven juntos. Si el movimiento dejaría el saldo por debajo de lo reservado, se
 * omite —el motor abortaría con el CHECK `sl_reserved_le_on_hand`— en vez de dejar un
 * nivel inválido dando vueltas.
 */
function aplicarAlSaldo(movimientos: readonly MovimientoStock[]): void {
  for (const movimiento of movimientos) {
    const i = almacen.niveles.findIndex(
      (n) => n.productoId === movimiento.productoId && n.depositoId === movimiento.depositoId,
    )
    if (i === -1) continue
    const actual = almacen.niveles[i]
    if (actual === undefined) continue
    const cantidad = actual.cantidad + deltaDeMovimiento(movimiento)
    if (cantidad < actual.reservada) continue
    almacen.niveles[i] = { ...actual, cantidad, disponible: cantidad - actual.reservada }
  }
}

/**
 * Adaptador simulado.
 *
 * No usa MSW: resuelve en proceso y devuelve los fixtures **validados con Zod en
 * la salida** (validación en el borde, §5.4). MSW queda para los tests de
 * componente de F9, cuando convenga interceptar `fetch` real; acá lo que importa
 * es que los datos que entran a la app cumplan el contrato, y eso lo garantiza el
 * parse, no el transporte.
 */
export class SimuladoCliente implements ApiClient {
  async listarProductos(p: ParametrosLista): Promise<ProductoListado> {
    const r = consultar(
      productos,
      p,
      (x) => `${x.sku} ${x.nombre}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'sku' || campo === 'estado' || campo === 'stock' || campo === 'precio')
          return x[campo]
        return undefined
      },
    )
    return ProductoListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarNiveles(p: ParametrosLista): Promise<NivelStockListado> {
    const r = consultar(
      almacen.niveles,
      p,
      (x) => `${x.sku} ${x.nombre} ${x.depositoNombre}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'sku' || campo === 'cantidad' || campo === 'disponible' || campo === 'depositoNombre')
          return x[campo]
        return undefined
      },
    )
    return NivelStockListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarMovimientos(p: ParametrosLista): Promise<MovimientoStockListado> {
    const r = consultar(
      almacen.movimientos,
      p,
      (x) => `${x.sku} ${x.nombre} ${x.tipo} ${x.motivo ?? ''}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'sku' || campo === 'tipo' || campo === 'cantidad' || campo === 'fecha')
          return x[campo]
        return undefined
      },
    )
    return MovimientoStockListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarDocumentosVenta(p: ParametrosLista): Promise<DocumentoVentaListado> {
    const r = consultar(
      documentosVenta,
      p,
      (x) => `${x.numero} ${x.cliente} ${x.tipo} ${x.estado}`,
      (x, campo) => {
        if (campo === 'numero' || campo === 'cliente' || campo === 'tipo' || campo === 'estado' || campo === 'total' || campo === 'fecha')
          return x[campo]
        return undefined
      },
    )
    return DocumentoVentaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async obtenerPanelResumen(empresaSlug: string): Promise<PanelResumen> {
    return PanelResumenSchema.parse({ ...panelResumen, empresa: empresaSlug })
  }

  async listarComprobantes(p: ParametrosLista): Promise<FacturacionListado> {
    const r = consultar(
      comprobantes,
      p,
      (x) => `${x.numero} ${x.cliente} ${x.tipo} ${x.estado}`,
      (x, campo) => {
        if (campo === 'numero' || campo === 'cliente' || campo === 'tipo' || campo === 'estado' || campo === 'total' || campo === 'fecha')
          return x[campo]
        return undefined
      },
    )
    return FacturacionListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  // --- Inventario (F5) ---

  async listarDepositos(p: ParametrosLista): Promise<DepositoListado> {
    const r = consultar(
      depositos,
      p,
      (x) => `${x.nombre} ${x.direccion ?? ''}`,
      (x, campo) => {
        if (campo === 'nombre') return x.nombre
        if (campo === 'activo') return x.activo === true ? 1 : 0
        return undefined
      },
    )
    return DepositoListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarTransferencias(p: ParametrosLista): Promise<TransferenciaListado> {
    const r = consultar(
      almacen.transferencias,
      p,
      (x) => `${x.codigo} ${x.desdeNombre} ${x.hastaNombre} ${x.estado}`,
      (x, campo) => {
        if (campo === 'codigo' || campo === 'desdeNombre' || campo === 'hastaNombre' || campo === 'estado')
          return x[campo]
        if (campo === 'unidades') return x.items.reduce((s, i) => s + i.cantidadEnviada, 0)
        return undefined
      },
    )
    return TransferenciaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarReposicion(p: ParametrosLista): Promise<ReposicionListado> {
    const r = consultar(
      reposicion,
      p,
      (x) => `${x.sku} ${x.nombre} ${x.depositoNombre}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'sku' || campo === 'disponible' || campo === 'minimo' || campo === 'sugerido')
          return x[campo]
        return undefined
      },
    )
    return ReposicionListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async obtenerConciliacion(empresaSlug: string): Promise<Conciliacion> {
    // Se calcula con la misma función pura que corre el job, sobre el almacén vivo:
    // así una transferencia despachada desde la interfaz se refleja en el informe.
    const resultado = conciliar(almacen.niveles, almacen.movimientos)
    return ConciliacionSchema.parse({
      ejecutadaEn: conciliacionEjecutadaEn,
      nivelesRevisados: resultado.filas.length,
      diferencias: resultado.diferencias,
      cuadra: resultado.cuadra,
      empresa: empresaSlug,
    })
  }

  async aplicarRecuento(p: {
    empresaSlug: string
    nivel: NivelStock
    contado: number
  }): Promise<ResultadoRecuento> {
    const i = almacen.niveles.findIndex(
      (n) => n.productoId === p.nivel.productoId && n.depositoId === p.nivel.depositoId,
    )
    const actual = i === -1 ? p.nivel : almacen.niveles[i]
    if (actual === undefined) return aplicarRecuento(p.nivel, p.contado, { idMovimiento: '', fecha: '' })

    const resultado = aplicarRecuento(actual, p.contado, {
      idMovimiento: `mv_rec_${actual.productoId}_${actual.depositoId}_${almacen.movimientos.length + 1}`,
      fecha: new Date().toISOString(),
    })
    if (!resultado.ok) return resultado

    if (i !== -1) almacen.niveles[i] = resultado.ajuste.nivel
    if (resultado.ajuste.movimiento !== null) almacen.movimientos.push(resultado.ajuste.movimiento)
    return resultado
  }

  async confirmarTransferencia(p: {
    empresaSlug: string
    id: string
    accion: AccionTransferencia
    versionEsperada: string
  }): Promise<ResultadoTransferencia> {
    const i = almacen.transferencias.findIndex((t) => t.id === p.id)
    const actual = almacen.transferencias[i]
    if (actual === undefined) {
      return { ok: false, motivo: 'transicion_invalida', estado: 'received' }
    }

    const resultado = aplicarTransferencia(actual, p.accion, p.versionEsperada, {
      fecha: new Date().toISOString(),
      prefijo: `mv_${actual.codigo}`,
    })
    if (!resultado.ok) return resultado

    if (i !== -1) almacen.transferencias[i] = resultado.transferencia
    almacen.movimientos.push(...resultado.movimientos)
    aplicarAlSaldo(resultado.movimientos)
    return resultado
  }
}

/**
 * Cliente real contra `/api/v1`. No se ejercita en F3 (el backend viene en F9);
 * existe para que cambiar de modo no requiera tocar los componentes.
 */
export class HttpCliente implements ApiClient {
  private readonly baseUrl: string
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private async pedir<T>(ruta: string, p: ParametrosLista, esquema: { parse: (input: unknown) => T }): Promise<T> {
    const qs = new URLSearchParams()
    if (p.texto) qs.set('texto', p.texto)
    qs.set('pagina', String(p.pagina))
    qs.set('porPagina', String(p.porPagina))
    if (p.orden) qs.set('orden', `${p.orden.campo}:${p.orden.dir}`)
    const res = await fetch(`${this.baseUrl}${ruta}?${qs.toString()}`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Error ${res.status} al consultar ${ruta}`)
    return esquema.parse(await res.json())
  }

  listarProductos(p: ParametrosLista): Promise<ProductoListado> {
    return this.pedir('/catalogo/productos', p, ProductoListadoSchema)
  }
  listarNiveles(p: ParametrosLista): Promise<NivelStockListado> {
    return this.pedir('/stock/niveles', p, NivelStockListadoSchema)
  }
  listarMovimientos(p: ParametrosLista): Promise<MovimientoStockListado> {
    return this.pedir('/stock/movimientos', p, MovimientoStockListadoSchema)
  }
  listarDocumentosVenta(p: ParametrosLista): Promise<DocumentoVentaListado> {
    return this.pedir('/ventas/documentos', p, DocumentoVentaListadoSchema)
  }

  obtenerPanelResumen(empresaSlug: string): Promise<PanelResumen> {
    return this.pedir('/panel/resumen', { empresaSlug, pagina: 1, porPagina: 1, orden: null }, PanelResumenSchema)
  }

  listarComprobantes(p: ParametrosLista): Promise<FacturacionListado> {
    return this.pedir('/facturacion/comprobantes', p, FacturacionListadoSchema)
  }

  listarDepositos(p: ParametrosLista): Promise<DepositoListado> {
    return this.pedir('/stock/depositos', p, DepositoListadoSchema)
  }
  listarTransferencias(p: ParametrosLista): Promise<TransferenciaListado> {
    return this.pedir('/stock/transferencias', p, TransferenciaListadoSchema)
  }
  listarReposicion(p: ParametrosLista): Promise<ReposicionListado> {
    return this.pedir('/stock/reposicion', p, ReposicionListadoSchema)
  }
  obtenerConciliacion(empresaSlug: string): Promise<Conciliacion> {
    return this.pedir(
      '/stock/conciliacion',
      { empresaSlug, pagina: 1, porPagina: 1, orden: null },
      ConciliacionSchema,
    )
  }

  /**
   * Las dos escrituras de inventario quedan declaradas pero no implementadas sobre
   * HTTP: el backend llega en F9. Se falla con un mensaje explícito en vez de devolver
   * un resultado inventado, que es lo que haría pasar un test de integración en falso.
   * El modo por defecto es `simulado`, donde las dos están implementadas de verdad.
   */
  async aplicarRecuento(): Promise<ResultadoRecuento> {
    throw new Error('aplicarRecuento sobre HTTP llega con el backend (F9); usá NEXT_PUBLIC_API_MODE=simulado')
  }
  async confirmarTransferencia(): Promise<ResultadoTransferencia> {
    throw new Error('confirmarTransferencia sobre HTTP llega con el backend (F9); usá NEXT_PUBLIC_API_MODE=simulado')
  }
}

/** Selecciona la implementación según `NEXT_PUBLIC_API_MODE` (por defecto `simulado`). */
export function getCliente(): ApiClient {
  const modo = process.env.NEXT_PUBLIC_API_MODE ?? 'simulado'
  if (modo === 'http') {
    return new HttpCliente(process.env.NEXT_PUBLIC_API_URL ?? '/api/v1')
  }
  return new SimuladoCliente()
}
