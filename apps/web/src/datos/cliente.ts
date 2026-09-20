import type {
  ProductoListado,
  NivelStockListado,
  MovimientoStockListado,
  DocumentoVentaListado,
  Orden,
} from '@control/contracts'
import {
  ProductoListadoSchema,
  NivelStockListadoSchema,
  MovimientoStockListadoSchema,
  DocumentoVentaListadoSchema,
} from '@control/contracts'
import { productos, niveles, movimientos, documentosVenta } from '@control/contracts/fixtures'

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
      niveles,
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
      movimientos,
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
}

/** Selecciona la implementación según `NEXT_PUBLIC_API_MODE` (por defecto `simulado`). */
export function getCliente(): ApiClient {
  const modo = process.env.NEXT_PUBLIC_API_MODE ?? 'simulado'
  if (modo === 'http') {
    return new HttpCliente(process.env.NEXT_PUBLIC_API_URL ?? '/api/v1')
  }
  return new SimuladoCliente()
}
