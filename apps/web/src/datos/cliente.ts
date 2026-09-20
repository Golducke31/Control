import type {
  AccionTransferencia,
  AsientoListado,
  Conciliacion,
  CuentaTesoreriaListado,
  DepositoListado,
  DeterminacionIva,
  DocumentoVentaListado,
  EnvioListado,
  EventoTrackingListado,
  FacturacionListado,
  MovimientoStock,
  MovimientoStockListado,
  MovimientoTesoreriaListado,
  NivelStock,
  NivelStockListado,
  Orden,
  OrdenCompraListado,
  PanelResumen,
  ParadaListado,
  Periodo,
  PeriodoListado,
  ProductoListado,
  ReposicionListado,
  ResultadoCierre,
  ResultadoRecuento,
  ResultadoReapertura,
  ResultadoTransferencia,
  TrackingPublico,
  TransferenciaListado,
  TrabajoListado,
  MiembroListado,
  AuditoriaListado,
} from '@control/contracts'
import {
  AsientoListadoSchema,
  ConciliacionSchema,
  CuentaTesoreriaListadoSchema,
  DepositoListadoSchema,
  DeterminacionIvaSchema,
  DocumentoVentaListadoSchema,
  EnvioListadoSchema,
  EventoTrackingListadoSchema,
  FacturacionListadoSchema,
  MovimientoStockListadoSchema,
  MovimientoTesoreriaListadoSchema,
  NivelStockListadoSchema,
  OrdenCompraListadoSchema,
  PanelResumenSchema,
  ParadaListadoSchema,
  PeriodoListadoSchema,
  ProductoListadoSchema,
  ReposicionListadoSchema,
  TrackingPublicoSchema,
  TransferenciaListadoSchema,
  TrabajoListadoSchema,
  MiembroListadoSchema,
  AuditoriaListadoSchema,
  aplicarRecuento,
  aplicarTransferencia,
  cerrarPeriodo as cerrarPeriodoPuro,
  conciliar,
  deltaDeMovimiento,
  envioPorTracking,
  materializarTrabajo,
  proyeccionPublica,
  reabrirPeriodo as reabrirPeriodoPuro,
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
  ordenesCompra,
  cuentasTesoreria,
  movimientosTesoreria,
  asientos,
  periodos,
  determinacionIva,
  envios,
  paradas,
  eventosTracking,
  miembros,
  auditoria,
  trabajos,
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

  // --- Finanzas (F6) ---
  listarOrdenesCompra(p: ParametrosLista): Promise<OrdenCompraListado>
  listarCuentasTesoreria(p: ParametrosLista): Promise<CuentaTesoreriaListado>
  listarMovimientosTesoreria(p: ParametrosLista): Promise<MovimientoTesoreriaListado>
  listarAsientos(p: ParametrosLista): Promise<AsientoListado>
  listarPeriodos(p: ParametrosLista): Promise<PeriodoListado>
  /** Determinación de IVA del período (objeto único). */
  obtenerDeterminacionIva(empresaSlug: string, periodo: string): Promise<DeterminacionIva>
  /** Cierra un período. Rechaza si quedan asientos en borrador. */
  cerrarPeriodo(p: {
    empresaSlug: string
    periodo: Periodo
    autor: string
  }): Promise<ResultadoCierre>
  /** Reabre un período cerrado. Exige motivo: una reapertura sin registro es lo que el ADR impide. */
  reabrirPeriodo(p: {
    empresaSlug: string
    periodo: Periodo
    autor: string
    motivo: string
  }): Promise<ResultadoReapertura>

  // --- Logística (F7) ---
  listarEnvios(p: ParametrosLista): Promise<EnvioListado>
  listarParadas(p: ParametrosLista & { envioId?: string }): Promise<ParadaListado>
  listarEventos(p: ParametrosLista & { envioId?: string }): Promise<EventoTrackingListado>
  /**
   * La proyección pública de un envío, por su token.
   *
   * Devuelve `null` cuando el token no existe —no un envío vacío—: la página pública
   * tiene que poder distinguir «no existe» de «existe sin eventos».
   */
  obtenerTrackingPublico(empresaSlug: string, token: string): Promise<TrackingPublico | null>

  // --- Gobierno y plataforma (F9) ---
  listarMiembros(p: ParametrosLista): Promise<MiembroListado>
  listarAuditoria(p: ParametrosLista): Promise<AuditoriaListado>
  /**
   * Las tareas programadas.
   *
   * Recibe `ahoraMs` **por parámetro** y no lee el reloj: el estado de un job —al día,
   * atrasado, fallando— depende de cuándo se mire, y un cliente que decidiera la hora por
   * su cuenta haría que la ventana y la suite no pudieran ponerse de acuerdo.
   */
  listarTrabajos(p: ParametrosLista & { ahoraMs: number }): Promise<TrabajoListado>
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
  periodos: [...periodos],
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

  // --- Finanzas (F6) ---

  async listarOrdenesCompra(p: ParametrosLista): Promise<OrdenCompraListado> {
    const r = consultar(
      ordenesCompra,
      p,
      (x) => `${x.numero} ${x.proveedor} ${x.estado}`,
      (x, campo) => {
        if (campo === 'numero' || campo === 'proveedor' || campo === 'estado' || campo === 'total' || campo === 'fecha')
          return x[campo]
        return undefined
      },
    )
    return OrdenCompraListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarCuentasTesoreria(p: ParametrosLista): Promise<CuentaTesoreriaListado> {
    const r = consultar(
      cuentasTesoreria,
      p,
      (x) => `${x.nombre} ${x.tipo}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'saldo') return x[campo]
        if (campo === 'tipo') return x.tipo
        return undefined
      },
    )
    return CuentaTesoreriaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarMovimientosTesoreria(p: ParametrosLista): Promise<MovimientoTesoreriaListado> {
    const r = consultar(
      movimientosTesoreria,
      p,
      (x) => `${x.descripcion} ${x.cuentaNombre} ${x.tipo}`,
      (x, campo) => {
        if (campo === 'fecha' || campo === 'monto' || campo === 'tipo' || campo === 'cuentaNombre') return x[campo]
        return undefined
      },
    )
    return MovimientoTesoreriaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarAsientos(p: ParametrosLista): Promise<AsientoListado> {
    const r = consultar(
      asientos,
      p,
      (x) => `${x.numero} ${x.descripcion} ${x.origen} ${x.periodoNombre}`,
      (x, campo) => {
        if (campo === 'numero' || campo === 'fecha' || campo === 'origen' || campo === 'debito' || campo === 'credito')
          return x[campo]
        return undefined
      },
    )
    return AsientoListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarPeriodos(p: ParametrosLista): Promise<PeriodoListado> {
    const r = consultar(
      almacen.periodos,
      p,
      (x) => `${x.nombre} ${x.estado}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'estado') return x[campo]
        if (campo === 'numero') return x.numero
        return undefined
      },
    )
    return PeriodoListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async obtenerDeterminacionIva(empresaSlug: string, periodo: string): Promise<DeterminacionIva> {
    return DeterminacionIvaSchema.parse({ ...determinacionIva, periodo })
  }

  async cerrarPeriodo(p: { empresaSlug: string; periodo: Periodo; autor: string }): Promise<ResultadoCierre> {
    const i = almacen.periodos.findIndex((x) => x.id === p.periodo.id)
    const actual = i === -1 ? p.periodo : almacen.periodos[i]
    if (actual === undefined) return { ok: false, motivo: 'ya_cerrado' }

    // Los asientos pendientes salen del propio período: es el dato que impide cerrar.
    const resultado = cerrarPeriodoPuro(actual, {
      fecha: new Date().toISOString(),
      autor: p.autor,
      asientosPendientes: actual.asientosPendientes,
    })
    if (!resultado.ok) return resultado
    if (i !== -1) almacen.periodos[i] = resultado.periodo
    return resultado
  }

  async reabrirPeriodo(p: {
    empresaSlug: string
    periodo: Periodo
    autor: string
    motivo: string
  }): Promise<ResultadoReapertura> {
    const i = almacen.periodos.findIndex((x) => x.id === p.periodo.id)
    const actual = i === -1 ? p.periodo : almacen.periodos[i]
    if (actual === undefined) return { ok: false, motivo: 'no_esta_cerrado' }

    const resultado = reabrirPeriodoPuro(actual, {
      fecha: new Date().toISOString(),
      autor: p.autor,
      motivo: p.motivo,
    })
    if (!resultado.ok) return resultado
    if (i !== -1) almacen.periodos[i] = resultado.periodo
    return resultado
  }

  // --- Logística (F7) ---

  async listarEnvios(p: ParametrosLista): Promise<EnvioListado> {
    const r = consultar(
      envios,
      p,
      (x) => `${x.numero} ${x.cliente} ${x.estado} ${x.localidadDestino} ${x.trackingCode}`,
      (x, campo) => {
        if (campo === 'numero' || campo === 'cliente' || campo === 'estado' || campo === 'prioridad') return x[campo]
        if (campo === 'localidadDestino') return x.localidadDestino
        return undefined
      },
    )
    return EnvioListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarParadas(p: ParametrosLista & { envioId?: string }): Promise<ParadaListado> {
    const base = p.envioId === undefined ? paradas : paradas.filter((x) => x.envioId === p.envioId)
    const r = consultar(
      base,
      p,
      (x) => `${x.direccion} ${x.localidad} ${x.tipo} ${x.estado}`,
      (x, campo) => {
        if (campo === 'orden') return x.orden
        if (campo === 'localidad') return x.localidad
        return undefined
      },
    )
    return ParadaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarEventos(p: ParametrosLista & { envioId?: string }): Promise<EventoTrackingListado> {
    const base = p.envioId === undefined ? eventosTracking : eventosTracking.filter((x) => x.envioId === p.envioId)
    const r = consultar(
      base,
      p,
      (x) => `${x.codigo} ${x.descripcion} ${x.estado}`,
      (x, campo) => {
        if (campo === 'fecha') return x.fecha
        if (campo === 'estado' || campo === 'codigo') return x[campo]
        return undefined
      },
    )
    return EventoTrackingListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async obtenerTrackingPublico(empresaSlug: string, token: string): Promise<TrackingPublico | null> {
    const envio = envioPorTracking(envios, token)
    if (envio === null) return null
    // La proyección pública es una lista blanca: se construye acá, no en la página,
    // para que ninguna pantalla pueda decidir por su cuenta qué se publica.
    return TrackingPublicoSchema.parse(
      proyeccionPublica(
        envio,
        eventosTracking.filter((e) => e.envioId === envio.id),
      ),
    )
  }

  // --- Gobierno y plataforma (F9) ---

  async listarMiembros(p: ParametrosLista): Promise<MiembroListado> {
    const r = consultar(
      miembros,
      p,
      (x) => `${x.nombre} ${x.rol} ${x.estado}`,
      (x, campo) => {
        if (campo === 'nombre' || campo === 'rol' || campo === 'estado') return x[campo]
        if (campo === 'permisos') return x.permisos.length
        return undefined
      },
    )
    return MiembroListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarAuditoria(p: ParametrosLista): Promise<AuditoriaListado> {
    const r = consultar(
      auditoria,
      p,
      (x) => `${x.actor} ${x.accion} ${x.entidad} ${x.detalle ?? ''}`,
      (x, campo) => {
        if (campo === 'fecha') return x.fecha
        if (campo === 'actor' || campo === 'accion' || campo === 'entidad') return x[campo]
        return undefined
      },
    )
    return AuditoriaListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
  }

  async listarTrabajos(p: ParametrosLista & { ahoraMs: number }): Promise<TrabajoListado> {
    // Los escenarios se materializan contra el reloj que entra por parámetro: así el
    // mundo simulado está siempre «vivo» y la ventana muestra estados distintos en vez de
    // todos atrasados en cuanto pasa la fecha de un fixture.
    const materializados = trabajos.map((escenario) => materializarTrabajo(escenario, p.ahoraMs))
    const r = consultar(
      materializados,
      p,
      (x) => `${x.codigo} ${x.descripcion}`,
      (x, campo) => {
        if (campo === 'codigo' || campo === 'descripcion') return x[campo]
        if (campo === 'critico') return x.critico ? 1 : 0
        return undefined
      },
    )
    return TrabajoListadoSchema.parse({
      items: r.items,
      paginacion: { pagina: p.pagina, porPagina: p.porPagina, total: r.total, paginas: r.paginas },
    })
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

  listarOrdenesCompra(p: ParametrosLista): Promise<OrdenCompraListado> {
    return this.pedir('/compras/ordenes', p, OrdenCompraListadoSchema)
  }
  listarCuentasTesoreria(p: ParametrosLista): Promise<CuentaTesoreriaListado> {
    return this.pedir('/tesoreria/cuentas', p, CuentaTesoreriaListadoSchema)
  }
  listarMovimientosTesoreria(p: ParametrosLista): Promise<MovimientoTesoreriaListado> {
    return this.pedir('/tesoreria/movimientos', p, MovimientoTesoreriaListadoSchema)
  }
  listarAsientos(p: ParametrosLista): Promise<AsientoListado> {
    return this.pedir('/contabilidad/asientos', p, AsientoListadoSchema)
  }
  listarPeriodos(p: ParametrosLista): Promise<PeriodoListado> {
    return this.pedir('/contabilidad/periodos', p, PeriodoListadoSchema)
  }
  obtenerDeterminacionIva(empresaSlug: string, periodo: string): Promise<DeterminacionIva> {
    return this.pedir(
      `/fiscal/determinacion/${encodeURIComponent(periodo)}`,
      { empresaSlug, pagina: 1, porPagina: 1, orden: null },
      DeterminacionIvaSchema,
    )
  }

  /** Las dos escrituras de contabilidad: mismo criterio que las de inventario. */
  async cerrarPeriodo(): Promise<ResultadoCierre> {
    throw new Error('cerrarPeriodo sobre HTTP llega con el backend (F9); usá NEXT_PUBLIC_API_MODE=simulado')
  }
  async reabrirPeriodo(): Promise<ResultadoReapertura> {
    throw new Error('reabrirPeriodo sobre HTTP llega con el backend (F9); usá NEXT_PUBLIC_API_MODE=simulado')
  }

  listarEnvios(p: ParametrosLista): Promise<EnvioListado> {
    return this.pedir('/logistica/envios', p, EnvioListadoSchema)
  }
  listarParadas(p: ParametrosLista & { envioId?: string }): Promise<ParadaListado> {
    const ruta =
      p.envioId === undefined
        ? '/logistica/paradas'
        : `/logistica/envios/${encodeURIComponent(p.envioId)}/paradas`
    return this.pedir(ruta, p, ParadaListadoSchema)
  }
  listarEventos(p: ParametrosLista & { envioId?: string }): Promise<EventoTrackingListado> {
    const ruta =
      p.envioId === undefined
        ? '/logistica/eventos'
        : `/logistica/envios/${encodeURIComponent(p.envioId)}/eventos`
    return this.pedir(ruta, p, EventoTrackingListadoSchema)
  }

  /**
   * El tracking público no pasa por `pedir`: su 404 es un resultado esperado —el token
   * no existe— y no una excepción. Convertirlo en `null` deja que la página pública
   * muestre «no encontramos ese envío» en vez de un error de red.
   */
  async obtenerTrackingPublico(_empresaSlug: string, token: string): Promise<TrackingPublico | null> {
    const res = await fetch(`${this.baseUrl}/publico/tracking/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Error ${res.status} al consultar el tracking público`)
    return TrackingPublicoSchema.parse(await res.json())
  }

  listarMiembros(p: ParametrosLista): Promise<MiembroListado> {
    return this.pedir('/equipo/miembros', p, MiembroListadoSchema)
  }
  listarAuditoria(p: ParametrosLista): Promise<AuditoriaListado> {
    return this.pedir('/auditoria/eventos', p, AuditoriaListadoSchema)
  }
  /**
   * Sobre HTTP, `ahoraMs` no viaja: el estado de un job lo decide el servidor, que es
   * quien tiene el reloj y quien sabe cuándo corrió cada cosa. El parámetro existe para
   * que el adaptador simulado sea reproducible, no para mandarlo por la red.
   */
  listarTrabajos(p: ParametrosLista & { ahoraMs: number }): Promise<TrabajoListado> {
    return this.pedir('/tareas/trabajos', p, TrabajoListadoSchema)
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
