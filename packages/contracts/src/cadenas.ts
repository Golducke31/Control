import type { DocumentoVenta } from './ventas.ts'

/**
 * Acciones que la barra de una ventana de operación ofrece sobre un documento.
 *
 * Son las transiciones válidas de la cadena de E6 vista desde el frontend. Cada
 * valor es el nombre de la acción que dispara el backend correspondiente; el
 * componente sólo las muestra si aparecen acá —nunca las decide por su cuenta—.
 */
export type AccionDocumento =
  | 'emitir'
  | 'aceptar'
  | 'rechazar'
  | 'crear_pedido'
  | 'confirmar'
  | 'crear_remito'
  | 'facturar'
  | 'autorizar'
  | 'crear_devolucion'

/** Etiqueta legible en español de cada acción, para la UI. */
export const ETIQUETA_ACCION: Record<AccionDocumento, string> = {
  emitir: 'Emitir',
  aceptar: 'Aceptar',
  rechazar: 'Rechazar',
  crear_pedido: 'Crear pedido',
  confirmar: 'Confirmar',
  crear_remito: 'Crear remito',
  facturar: 'Facturar',
  autorizar: 'Autorizar',
  crear_devolucion: 'Crear devolución',
}

/**
 * Acciones disponibles de un documento de la cadena de ventas.
 *
 * Función pura: recibe el «hoy» explícito en vez de leer `new Date()`, así la
 * regla de vencimiento es reproducible y la prueba negativa puede forzarla (§ADR
 * 0004, F-6). Las dos reglas de la puerta de F4 caen de acá:
 *
 * 1. Una cotización **vencida** (`venceEn` < `hoy`, estando `pendiente`) no ofrece
 *    `aceptar` —`accept_quote()` del motor la rechazaría igual.
 * 2. Un remito **facturado en su totalidad** (`facturadoCompleto`) no ofrece
 *    `facturar` —`invoice_delivery_note()` no debe duplicar la factura.
 */
export function accionesDisponibles(doc: DocumentoVenta, hoy: string): AccionDocumento[] {
  const vencida =
    doc.tipo === 'cotizacion' && doc.venceEn != null && doc.venceEn < hoy

  switch (doc.tipo) {
    case 'cotizacion':
      if (doc.estado === 'borrador') return ['emitir']
      if (doc.estado === 'pendiente') return vencida ? [] : ['aceptar']
      if (doc.estado === 'aceptado') return ['crear_pedido']
      return []

    case 'pedido':
      if (doc.estado === 'borrador') return ['confirmar']
      if (doc.estado === 'pendiente' || doc.estado === 'aceptado') return ['crear_remito']
      return []

    case 'remito':
      if (doc.estado === 'pendiente') return doc.facturadoCompleto ? [] : ['facturar']
      return []

    case 'factura':
      if (doc.estado === 'borrador') return ['autorizar']
      if (doc.estado === 'pendiente') return ['crear_devolucion']
      return []

    case 'devolucion':
      if (doc.estado === 'borrador') return ['confirmar']
      return []
  }
}

/** Verdadero cuando el documento no ofrece ninguna transición (está quieto). */
export function documentoQuieto(doc: DocumentoVenta, hoy: string): boolean {
  return accionesDisponibles(doc, hoy).length === 0
}
