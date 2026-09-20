import { VENTANAS } from '../rutas.ts'
import {
  AsientoListadoSchema,
  DeterminacionIvaSchema,
  DocumentoVentaListadoSchema,
  EnvioListadoSchema,
  FacturacionListadoSchema,
  MiembroListadoSchema,
  MovimientoTesoreriaListadoSchema,
  NivelStockListadoSchema,
  OrdenCompraListadoSchema,
  PanelResumenSchema,
  PendienteSchema,
  ProductoListadoSchema,
  AuditoriaListadoSchema,
  TareaListadoSchema,
} from '@control/contracts'

/** Si el contrato de la ventana está cableado en el frontend (`listo`) o solo declarado (`pendiente`). */
export type EstadoDeContrato = 'listo' | 'pendiente'

/**
 * Contrato declarado de una ventana.
 *
 * Es la única fuente del endpoint y del esquema que la ventana consume. La suite
 * `contrato.test.ts` lo cruza contra `VENTANAS`: si una ventana del mapa no aparece
 * acá, o su endpoint no es una ruta `/api/v1`, el test falla. Así el menú y el
 * contrato no pueden diverger (la misma disciplina que el mapa de rutas).
 */
export interface ContratoVentana {
  ventanaId: string
  endpoint: string
  /** Esquema Zod de la colección principal de la ventana. */
  esquema: { safeParse: (valor: unknown) => unknown }
  estado: EstadoDeContrato
}

export const CONTRATOS: Record<string, ContratoVentana> = {
  panel: { ventanaId: 'panel', endpoint: '/api/v1/panel/resumen', esquema: PanelResumenSchema, estado: 'listo' },
  ventas: { ventanaId: 'ventas', endpoint: '/api/v1/ventas/documentos', esquema: DocumentoVentaListadoSchema, estado: 'listo' },
  facturacion: { ventanaId: 'facturacion', endpoint: '/api/v1/facturacion/comprobantes', esquema: FacturacionListadoSchema, estado: 'listo' },
  catalogo: { ventanaId: 'catalogo', endpoint: '/api/v1/catalogo/productos', esquema: ProductoListadoSchema, estado: 'listo' },
  stock: { ventanaId: 'stock', endpoint: '/api/v1/stock/niveles', esquema: NivelStockListadoSchema, estado: 'listo' },
  compras: { ventanaId: 'compras', endpoint: '/api/v1/compras/ordenes', esquema: OrdenCompraListadoSchema, estado: 'listo' },
  tesoreria: { ventanaId: 'tesoreria', endpoint: '/api/v1/tesoreria/movimientos', esquema: MovimientoTesoreriaListadoSchema, estado: 'listo' },
  contabilidad: { ventanaId: 'contabilidad', endpoint: '/api/v1/contabilidad/asientos', esquema: AsientoListadoSchema, estado: 'listo' },
  fiscal: { ventanaId: 'fiscal', endpoint: '/api/v1/fiscal/determinacion', esquema: DeterminacionIvaSchema, estado: 'listo' },
  logistica: { ventanaId: 'logistica', endpoint: '/api/v1/logistica/envios', esquema: EnvioListadoSchema, estado: 'listo' },
  equipo: { ventanaId: 'equipo', endpoint: '/api/v1/equipo/miembros', esquema: MiembroListadoSchema, estado: 'pendiente' },
  // Configuración no consume datos del servidor: su paleta y su plantilla son del
  // sistema de diseño, así que no hay endpoint que declarar. Se marca `listo` con el
  // esquema de la empresa, que es lo único que resolverá del backend.
  configuracion: { ventanaId: 'configuracion', endpoint: '/api/v1/configuracion/empresa', esquema: PendienteSchema, estado: 'listo' },
  auditoria: { ventanaId: 'auditoria', endpoint: '/api/v1/auditoria/eventos', esquema: AuditoriaListadoSchema, estado: 'pendiente' },
  tareas: { ventanaId: 'tareas', endpoint: '/api/v1/tareas/tareas', esquema: TareaListadoSchema, estado: 'pendiente' },
}

/** Devuelve el contrato de una ventana o `null` si no está declarado. */
export function contratoDeVentana(ventanaId: string): ContratoVentana | null {
  return CONTRATOS[ventanaId] ?? null
}
