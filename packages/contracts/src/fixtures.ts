import type { Categoria } from './catalogo.ts'
import type { Marca } from './catalogo.ts'
import type { Producto } from './catalogo.ts'
import type { Deposito } from './stock.ts'
import type { NivelStock } from './stock.ts'
import type { MovimientoStock } from './stock.ts'
import type { Reposicion } from './stock.ts'
import type { Transferencia } from './stock.ts'
import type { DocumentoVenta, PanelResumen, ComprobanteFiscal } from './ventas.ts'
import type { OrdenCompra, PagoProveedor, Recepcion, FacturaCompra } from './compras.ts'
import type { Cheque, CuentaTesoreria, MovimientoTesoreria } from './tesoreria.ts'
import type { Asiento, Periodo } from './contabilidad.ts'
import type { Alicuota, DeterminacionIva, Retencion } from './fiscal.ts'
import type {
  ConfirmacionEntrega,
  Envio,
  EventoTracking,
  Incidencia,
  Parada,
  Vehiculo,
} from './logistica.ts'
import type { Miembro } from './gobierno.ts'
import type { AuditoriaEvento } from './gobierno.ts'
import type { EscenarioDeTrabajo } from './trabajos.ts'

/**
 * Datos simulados que cumplen los esquemas del contrato.
 *
 * Es la única fuente de los datos de demostración: el adaptador los filtra y
 * pagina, y `mock.test.ts` los valida contra los esquemas. Si el esquema y estos
 * datos divergen, el test falla — un mock que no valida da una falsa sensación de
 * que la integración va a funcionar (§5.4).
 *
 * Regla de negocio verificada por la suite: en `NivelStock`, `disponible` es
 * siempre `cantidad - reservada`.
 */

export const categorias: Categoria[] = [
  { id: 'cat_licores', nombre: 'Licores' },
  { id: 'cat_cervezas', nombre: 'Cervezas' },
  { id: 'cat_snacks', nombre: 'Snacks' },
  { id: 'cat_limpieza', nombre: 'Limpieza' },
]

export const marcas: Marca[] = [
  { id: 'mk_andes', nombre: 'Andes' },
  { id: 'mk_pampa', nombre: 'Pampa' },
  { id: 'mk_nord', nombre: 'Nórdico' },
]

export const productos: Producto[] = [
  {
    id: 'prd_001',
    sku: 'LIC-AN-001',
    nombre: 'Gin Andes 750 ml',
    descripcion: 'Gin de alta graduación, edición local.',
    categoriaId: 'cat_licores',
    marcaId: 'mk_andes',
    estado: 'activo',
    precio: 8990,
    costo: 6100,
    moneda: 'ARS',
    stock: 142,
    creadoEn: '2026-01-12T10:00:00.000Z',
    actualizadoEn: '2026-09-10T14:30:00.000Z',
  },
  {
    id: 'prd_002',
    sku: 'CER-PA-014',
    nombre: 'IPA Pampa 355 ml',
    categoriaId: 'cat_cervezas',
    marcaId: 'mk_pampa',
    estado: 'activo',
    precio: 1290,
    costo: 720,
    moneda: 'ARS',
    stock: 980,
    creadoEn: '2026-02-03T09:15:00.000Z',
    actualizadoEn: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'prd_003',
    sku: 'SNK-ND-003',
    nombre: 'Mix Nórdico 200 g',
    categoriaId: 'cat_snacks',
    marcaId: 'mk_nord',
    estado: 'activo',
    precio: 650,
    costo: 310,
    moneda: 'ARS',
    stock: 430,
    creadoEn: '2026-02-20T11:40:00.000Z',
    actualizadoEn: '2026-09-01T16:20:00.000Z',
  },
  {
    id: 'prd_004',
    sku: 'LIM-AN-009',
    nombre: 'Desinfectante Andes 1 L',
    categoriaId: 'cat_limpieza',
    marcaId: 'mk_andes',
    estado: 'inactivo',
    precio: 1890,
    costo: 980,
    moneda: 'ARS',
    stock: 0,
    creadoEn: '2026-03-15T13:00:00.000Z',
    actualizadoEn: '2026-08-22T10:05:00.000Z',
  },
  {
    id: 'prd_005',
    sku: 'LIC-AN-002',
    nombre: 'Aperol Andes 700 ml',
    categoriaId: 'cat_licores',
    marcaId: 'mk_andes',
    estado: 'descontinuado',
    precio: 5490,
    costo: 3300,
    moneda: 'ARS',
    stock: 18,
    creadoEn: '2025-11-01T08:00:00.000Z',
    actualizadoEn: '2026-07-30T09:00:00.000Z',
  },
  {
    id: 'prd_006',
    sku: 'CER-PA-015',
    nombre: 'Rubia Pampa 355 ml',
    categoriaId: 'cat_cervezas',
    marcaId: 'mk_pampa',
    estado: 'activo',
    precio: 990,
    costo: 540,
    moneda: 'ARS',
    stock: 1200,
    creadoEn: '2026-02-03T09:20:00.000Z',
    actualizadoEn: '2026-09-14T12:00:00.000Z',
  },
  {
    id: 'prd_007',
    sku: 'SNK-ND-004',
    nombre: 'Pretzel Nórdico 150 g',
    categoriaId: 'cat_snacks',
    marcaId: 'mk_nord',
    estado: 'activo',
    precio: 720,
    costo: 360,
    moneda: 'ARS',
    stock: 260,
    creadoEn: '2026-02-21T11:00:00.000Z',
    actualizadoEn: '2026-09-11T15:30:00.000Z',
  },
  {
    id: 'prd_008',
    sku: 'LIC-AN-003',
    nombre: 'Whisky Andes 12 años 700 ml',
    descripcion: 'Añejado en barrica.',
    categoriaId: 'cat_licores',
    marcaId: 'mk_andes',
    estado: 'activo',
    precio: 14990,
    costo: 9800,
    moneda: 'ARS',
    stock: 64,
    creadoEn: '2026-01-20T10:30:00.000Z',
    actualizadoEn: '2026-09-13T17:45:00.000Z',
  },
]

function nivel(producto: Producto, depositoId: string, depositoNombre: string, cantidad: number, reservada: number): NivelStock {
  return {
    productoId: producto.id,
    sku: producto.sku,
    nombre: producto.nombre,
    depositoId,
    depositoNombre,
    cantidad,
    reservada,
    disponible: cantidad - reservada,
  }
}

const prd001 = productos[0]!
const prd002 = productos[1]!
const prd003 = productos[2]!

export const niveles: NivelStock[] = [
  nivel(prd001, 'dep_central', 'Depósito central', 100, 8),
  nivel(prd001, 'dep_sur', 'Depósito sur', 42, 4),
  nivel(prd002, 'dep_central', 'Depósito central', 700, 12),
  nivel(prd002, 'dep_sur', 'Depósito sur', 280, 20),
  nivel(prd003, 'dep_central', 'Depósito central', 430, 0),
]

export const depositos: Deposito[] = [
  { id: 'dep_central', nombre: 'Depósito central', empresaSlug: 'andes', direccion: 'Av. Rivadavia 4200, CABA', activo: true },
  { id: 'dep_sur', nombre: 'Depósito sur', empresaSlug: 'andes', direccion: 'Camino de Cintura 1500, Lanús', activo: true },
  { id: 'dep_norte', nombre: 'Depósito norte', empresaSlug: 'andes', direccion: 'Ruta 9 km 42, Escobar', activo: false },
]

/**
 * El libro mayor de inventario.
 *
 * Está armado para que **la conciliación cuadre salvo un desvío deliberado**: en cada
 * producto y depósito que tiene saldo, la suma de los movimientos da la cantidad del
 * nivel, excepto `prd_002` en `dep_sur`, donde el libro explica 283 y el saldo declara
 * 280 —tres unidades que el libro no explica—. Sin ese desvío la ventana de
 * conciliación mostraría siempre una tabla vacía y nadie sabría si el job funciona.
 *
 * Los movimientos de `transfer_out`/`transfer_in` acompañan a las transferencias
 * (`TRN-0009` ya recibida, `TRN-0012` despachada): una transferencia despachada mueve
 * el stock del origen aunque el destino todavía no lo haya recibido.
 */
export const movimientos: MovimientoStock[] = [
  {
    id: 'mv_001',
    productoId: prd001.id,
    sku: prd001.sku,
    nombre: prd001.nombre,
    tipo: 'purchase_in',
    cantidad: 120,
    depositoId: 'dep_central',
    motivo: 'Recepción OC-2041',
    fecha: '2026-09-10T14:30:00.000Z',
    documento: 'OC-2041',
  },
  {
    id: 'mv_002',
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    tipo: 'sale_out',
    cantidad: -40,
    depositoId: 'dep_central',
    motivo: 'Venta mostrador',
    fecha: '2026-09-12T11:10:00.000Z',
    documento: 'FAC-A-00123',
  },
  {
    id: 'mv_003',
    productoId: prd003.id,
    sku: prd003.sku,
    nombre: prd003.nombre,
    tipo: 'transfer_out',
    cantidad: -30,
    depositoId: 'dep_central',
    motivo: 'Traslado a depósito sur',
    fecha: '2026-09-13T09:00:00.000Z',
    documento: 'TRN-0009',
  },
  {
    id: 'mv_010',
    productoId: prd003.id,
    sku: prd003.sku,
    nombre: prd003.nombre,
    tipo: 'transfer_in',
    cantidad: 30,
    depositoId: 'dep_sur',
    motivo: 'Traslado desde depósito central',
    fecha: '2026-09-14T11:00:00.000Z',
    documento: 'TRN-0009',
  },
  {
    id: 'mv_004',
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    tipo: 'adjustment_neg',
    cantidad: -5,
    depositoId: 'dep_sur',
    motivo: 'Merma por control de calidad',
    fecha: '2026-09-14T16:40:00.000Z',
  },
  {
    id: 'mv_006',
    productoId: prd001.id,
    sku: prd001.sku,
    nombre: prd001.nombre,
    tipo: 'purchase_in',
    cantidad: 42,
    depositoId: 'dep_sur',
    motivo: 'Recepción OC-2042',
    fecha: '2026-09-15T09:20:00.000Z',
    documento: 'OC-2042',
  },
  {
    id: 'mv_008',
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    tipo: 'purchase_in',
    cantidad: 288,
    depositoId: 'dep_sur',
    motivo: 'Recepción OC-2044',
    fecha: '2026-09-16T13:00:00.000Z',
    documento: 'OC-2044',
  },
  {
    id: 'mv_007',
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    tipo: 'purchase_in',
    cantidad: 800,
    depositoId: 'dep_central',
    motivo: 'Recepción OC-2043',
    fecha: '2026-09-17T10:00:00.000Z',
    documento: 'OC-2043',
  },
  {
    id: 'mv_011',
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    tipo: 'transfer_out',
    cantidad: -60,
    depositoId: 'dep_central',
    motivo: 'Traslado a depósito sur',
    fecha: '2026-09-18T10:30:00.000Z',
    documento: 'TRN-0012',
  },
  {
    id: 'mv_005',
    productoId: prd001.id,
    sku: prd001.sku,
    nombre: prd001.nombre,
    tipo: 'sale_out',
    cantidad: -20,
    depositoId: 'dep_central',
    motivo: 'Venta mostrador',
    fecha: '2026-09-18T12:00:00.000Z',
    documento: 'FAC-A-00124',
  },
  {
    id: 'mv_009',
    productoId: prd003.id,
    sku: prd003.sku,
    nombre: prd003.nombre,
    tipo: 'purchase_in',
    cantidad: 460,
    depositoId: 'dep_central',
    motivo: 'Recepción OC-2045',
    fecha: '2026-09-19T09:00:00.000Z',
    documento: 'OC-2045',
  },
]

/**
 * Transferencias entre depósitos, con los tres estados que la ventana necesita:
 * una en borrador (ofrece despachar), una despachada (ofrece recibir) y una recibida
 * (ya no ofrece nada). El detalle de la despachada es donde se ve el bloqueo
 * optimista: si alguien la modificó antes, la escritura avisa y no pisa.
 */
export const transferencias: Transferencia[] = [
  {
    id: 'tr_001',
    codigo: 'TRN-0009',
    desdeId: 'dep_central',
    desdeNombre: 'Depósito central',
    hastaId: 'dep_sur',
    hastaNombre: 'Depósito sur',
    estado: 'received',
    items: [
      { productoId: prd003.id, sku: prd003.sku, nombre: prd003.nombre, cantidadEnviada: 30, cantidadRecibida: 30 },
    ],
    notas: 'Reposición de snacks para la zona sur.',
    creadaEn: '2026-09-13T09:00:00.000Z',
    actualizadaEn: '2026-09-14T11:00:00.000Z',
  },
  {
    id: 'tr_002',
    codigo: 'TRN-0012',
    desdeId: 'dep_central',
    desdeNombre: 'Depósito central',
    hastaId: 'dep_sur',
    hastaNombre: 'Depósito sur',
    estado: 'dispatched',
    items: [
      { productoId: prd002.id, sku: prd002.sku, nombre: prd002.nombre, cantidadEnviada: 60, cantidadRecibida: null },
    ],
    notas: 'Salida en tránsito; el destino todavía no confirmó.',
    creadaEn: '2026-09-18T08:00:00.000Z',
    actualizadaEn: '2026-09-18T10:30:00.000Z',
  },
  {
    id: 'tr_003',
    codigo: 'TRN-0013',
    desdeId: 'dep_sur',
    desdeNombre: 'Depósito sur',
    hastaId: 'dep_central',
    hastaNombre: 'Depósito central',
    estado: 'draft',
    items: [
      { productoId: prd001.id, sku: prd001.sku, nombre: prd001.nombre, cantidadEnviada: 15, cantidadRecibida: null },
    ],
    creadaEn: '2026-09-19T15:00:00.000Z',
    actualizadaEn: '2026-09-19T15:00:00.000Z',
  },
]

/**
 * Reposición, derivada de `app.v_low_stock`: disponible por debajo del mínimo.
 * `sugerido` repone hasta el doble del mínimo.
 */
export const reposicion: Reposicion[] = [
  {
    productoId: prd001.id,
    sku: prd001.sku,
    nombre: prd001.nombre,
    depositoId: 'dep_sur',
    depositoNombre: 'Depósito sur',
    disponible: 38,
    minimo: 50,
    sugerido: 62,
  },
  {
    productoId: prd002.id,
    sku: prd002.sku,
    nombre: prd002.nombre,
    depositoId: 'dep_sur',
    depositoNombre: 'Depósito sur',
    disponible: 260,
    minimo: 300,
    sugerido: 340,
  },
]

/**
 * Cuándo corrió por última vez el job `stock.reconciliation`.
 *
 * El resultado no se guarda: la ventana de conciliación lo **calcula** con
 * `conciliar(niveles, movimientos)`, la misma función pura que corre el backend. Así
 * el día que el motor reporte de verdad, la pantalla no cambia.
 */
export const conciliacionEjecutadaEn = '2026-09-20T06:00:00.000Z'

/**
 * Cadena de operación de ventas (cotización → pedido → remito → factura →
 * devolución). Incluye a propósito los dos casos de la puerta de F4:
 *
 * - `dv_001` (COT-0001) está `pendiente` pero **vencida** (`venceEn` en el pasado):
 *   la cadena no ofrece `aceptar`.
 * - `dv_003` (REM-0098) está `facturado` en su totalidad (`facturadoCompleto`):
 *   la cadena no ofrece `facturar` de nuevo.
 */
export const documentosVenta: DocumentoVenta[] = [
  {
    id: 'dv_001',
    tipo: 'cotizacion',
    numero: 'COT-0001',
    cliente: 'Distribuidora Sur',
    estado: 'pendiente',
    total: 358000,
    moneda: 'ARS',
    fecha: '2026-09-15T10:00:00.000Z',
    venceEn: '2026-09-10',
  },
  {
    id: 'dv_006',
    tipo: 'cotizacion',
    numero: 'COT-0003',
    cliente: 'Kiosco Centro',
    estado: 'pendiente',
    total: 42000,
    moneda: 'ARS',
    fecha: '2026-09-18T09:00:00.000Z',
    venceEn: '2026-10-15',
  },
  {
    id: 'dv_007',
    tipo: 'cotizacion',
    numero: 'COT-0004',
    cliente: 'Bar Norte',
    estado: 'borrador',
    total: 88000,
    moneda: 'ARS',
    fecha: '2026-09-19T11:00:00.000Z',
  },
  {
    id: 'dv_002',
    tipo: 'pedido',
    numero: 'PED-0042',
    cliente: 'Mayorista Norte',
    estado: 'aceptado',
    total: 1245000,
    moneda: 'ARS',
    fecha: '2026-09-16T12:30:00.000Z',
  },
  {
    id: 'dv_008',
    tipo: 'pedido',
    numero: 'PED-0043',
    cliente: 'Distribuidora Sur',
    estado: 'pendiente',
    total: 200000,
    moneda: 'ARS',
    fecha: '2026-09-17T14:00:00.000Z',
  },
  {
    id: 'dv_003',
    tipo: 'remito',
    numero: 'REM-0098',
    cliente: 'Distribuidora Sur',
    estado: 'facturado',
    total: 358000,
    moneda: 'ARS',
    fecha: '2026-09-17T15:00:00.000Z',
    facturadoCompleto: true,
  },
  {
    id: 'dv_009',
    tipo: 'remito',
    numero: 'REM-0099',
    cliente: 'Mayorista Norte',
    estado: 'pendiente',
    total: 1245000,
    moneda: 'ARS',
    fecha: '2026-09-18T16:00:00.000Z',
    facturadoCompleto: false,
  },
  {
    id: 'dv_004',
    tipo: 'factura',
    numero: 'FAC-A-00131',
    cliente: 'Mayorista Norte',
    estado: 'pendiente',
    total: 1245000,
    moneda: 'ARS',
    fecha: '2026-09-17T15:30:00.000Z',
  },
  {
    id: 'dv_010',
    tipo: 'factura',
    numero: 'FAC-A-00132',
    cliente: 'Distribuidora Sur',
    estado: 'borrador',
    total: 358000,
    moneda: 'ARS',
    fecha: '2026-09-18T17:00:00.000Z',
  },
  {
    id: 'dv_005',
    tipo: 'devolucion',
    numero: 'DEV-0001',
    cliente: 'Kiosco Centro',
    estado: 'borrador',
    total: 42000,
    moneda: 'ARS',
    fecha: '2026-09-19T08:00:00.000Z',
  },
]

export const panelResumen: PanelResumen = {
  empresa: 'andes',
  periodo: '2026-09',
  kpis: [
    { id: 'ventas_mes', etiqueta: 'Ventas del mes', valor: 1845000, moneda: 'ARS', tendencia: 'sube' },
    { id: 'cobranzas', etiqueta: 'Cobranzas', valor: 1320000, moneda: 'ARS', tendencia: 'sube' },
    { id: 'pendientes', etiqueta: 'Documentos pendientes', valor: 4, moneda: null, tendencia: 'baja' },
    { id: 'stock_bajo', etiqueta: 'Productos bajo stock', valor: 2, moneda: null, tendencia: 'plana' },
  ],
}

export const comprobantes: ComprobanteFiscal[] = [
  {
    id: 'cp_001',
    numero: 'FAC-A-00131',
    tipo: 'factura',
    cliente: 'Mayorista Norte',
    total: 1245000,
    moneda: 'ARS',
    autorizacion: '21150123456789',
    resultado: 'A',
    estado: 'autorizada',
    pagado: 600000,
    payment_status: 'parcial',
    fecha: '2026-09-17T15:30:00.000Z',
  },
  {
    id: 'cp_002',
    numero: 'FAC-A-00132',
    tipo: 'factura',
    cliente: 'Distribuidora Sur',
    total: 358000,
    moneda: 'ARS',
    autorizacion: null,
    resultado: 'P',
    estado: 'borrador',
    pagado: 0,
    payment_status: 'pendiente',
    fecha: '2026-09-18T17:00:00.000Z',
  },
  {
    id: 'cp_003',
    numero: 'NC-A-0007',
    tipo: 'nota_credito',
    cliente: 'Kiosco Centro',
    total: 42000,
    moneda: 'ARS',
    autorizacion: '21150987654321',
    resultado: 'A',
    estado: 'autorizada',
    pagado: 0,
    payment_status: 'pagado',
    fecha: '2026-09-19T08:30:00.000Z',
  },
]

export const miembros: Miembro[] = [
  {
    usuarioId: 'u_ana',
    nombre: 'Ana Dueña',
    iniciales: 'AD',
    rol: 'Propietario',
    permisos: ['inventory.read', 'inventory.adjust', 'sales.read', 'sales.write'],
    estado: 'active',
  },
  {
    usuarioId: 'u_beto',
    nombre: 'Beto Encargado',
    iniciales: 'BE',
    rol: 'Encargado de depósito',
    permisos: ['inventory.read', 'inventory.adjust', 'inventory.transfer'],
    estado: 'active',
  },
]

export const auditoria: AuditoriaEvento[] = [
  {
    id: 'au_001',
    fecha: '2026-09-15T10:00:00.000Z',
    actor: 'Ana Dueña',
    accion: 'crear',
    entidad: 'cotizacion',
    entidadId: 'dv_001',
    detalle: 'Cotización COT-0001 a Distribuidora Sur',
  },
  {
    id: 'au_002',
    fecha: '2026-09-17T15:30:00.000Z',
    actor: 'Ana Dueña',
    accion: 'facturar',
    entidad: 'remito',
    entidadId: 'dv_003',
    detalle: 'Remito REM-0098 facturado como FAC-A-00131',
  },
]

/**
 * Las tareas programadas, como **escenarios** y no como fechas fijas.
 *
 * Los cuatro primeros son los jobs que el motor siembra
 * (`db/migrations/0010_job_ledger.sql`), con su cadencia y su tolerancia reales. El
 * quinto no está en el motor: es un job de ejemplo que **dejó de correr**, que es el caso
 * que la ventana existe para mostrar —un job que falla deja un error, uno que dejó de
 * correr no deja nada—.
 *
 * Las fechas no se guardan: se guarda **hace cuánto** corrió cada uno, y el adaptador
 * simulado lo materializa contra el reloj de quien mira. Con fechas fijas, apenas pasara
 * esa fecha todos los jobs aparecerían atrasados y la ventana dejaría de decir la verdad.
 */
const HORA = 3600_000
const DIA = 24 * HORA

export const trabajos: EscenarioDeTrabajo[] = [
  {
    codigo: 'stock.reconciliation',
    descripcion: 'Compara stock_levels contra la suma de stock_movements y reporta diferencias',
    cadenciaMs: DIA,
    toleranciaMs: 12 * HORA,
    critico: true,
    activo: true,
    ultimaCorridaHaceMs: 6 * HORA,
    duracionMs: 42_000,
    estadoDeLaUltimaCorrida: 'succeeded',
    host: 'worker-1',
    error: null,
  },
  {
    codigo: 'certificate.expiry',
    descripcion: 'Alerta de vencimiento de certificados AFIP a 45, 30 y 15 días',
    cadenciaMs: DIA,
    toleranciaMs: 6 * HORA,
    critico: true,
    activo: true,
    ultimaCorridaHaceMs: 8 * HORA,
    duracionMs: 3_100,
    estadoDeLaUltimaCorrida: 'succeeded',
    host: 'worker-1',
    error: null,
  },
  {
    codigo: 'partition.maintenance',
    descripcion: 'Crea las particiones de los próximos meses para tracking y auditoría',
    cadenciaMs: 30 * DIA,
    toleranciaMs: 3 * DIA,
    critico: true,
    activo: true,
    // Una corrida viva: la ventana tiene que poder decir «lleva 20 minutos corriendo» y
    // no confundirlo con un atraso.
    ultimaCorridaHaceMs: 20 * 60_000,
    duracionMs: null,
    estadoDeLaUltimaCorrida: 'running',
    host: 'worker-2',
    error: null,
  },
  {
    codigo: 'partition.retention',
    descripcion: 'Purga particiones de posiciones GPS fuera de la ventana de retención',
    cadenciaMs: 30 * DIA,
    toleranciaMs: 3 * DIA,
    critico: false,
    activo: true,
    // 35 días sobre una cadencia de 30 más 3 de tolerancia: **atrasado**. Es el estado que
    // la ventana existe para mostrar —un job que dejó de correr no deja error, y el hueco
    // se descubre cuando falta un dato—.
    ultimaCorridaHaceMs: 35 * DIA,
    duracionMs: 1_240_000,
    estadoDeLaUltimaCorrida: 'succeeded',
    host: 'worker-2',
    error: null,
  },
  {
    codigo: 'accounting.reconciliation',
    descripcion: 'Verifica y reporta la proyección de saldos por cuenta y período',
    cadenciaMs: DIA,
    toleranciaMs: 12 * HORA,
    critico: true,
    activo: true,
    // Falló hace tres días y no volvió a correr: es el caso que la ventana tiene que
    // poner arriba, porque un job caído no se nota hasta que falta un dato.
    ultimaCorridaHaceMs: 3 * DIA,
    duracionMs: 8_500,
    estadoDeLaUltimaCorrida: 'failed',
    host: 'worker-1',
    error: 'timeout al leer accounting.account_balances',
  },
  {
    codigo: 'logistics.pod_cleanup',
    descripcion: 'Depura las fotos de POD fuera de la ventana de retención',
    cadenciaMs: 7 * DIA,
    toleranciaMs: DIA,
    critico: false,
    activo: true,
    ultimaCorridaHaceMs: null,
    duracionMs: null,
    estadoDeLaUltimaCorrida: 'skipped',
    host: null,
    error: null,
  },
]

// ---------------------------------------------------------------------------
// Finanzas (F6)
// ---------------------------------------------------------------------------

/**
 * Períodos contables, con los tres casos que la ventana necesita mostrar:
 * uno **cerrado** (Julio), uno **reabierto** (Agosto, con su motivo y su autor —el
 * rastro que el motor exige) y los abiertos donde todavía se imputa.
 *
 * Los campos respetan los CHECK del motor: `closed` y `cerradoEn` van siempre
 * juntos, y una reapertura tiene motivo y autor. `periodos.test.ts` lo verifica.
 */
export const periodos: Periodo[] = [
  {
    id: 'per_2026_07',
    numero: 7,
    nombre: 'Julio 2026',
    ejercicio: 2026,
    desde: '2026-07-01',
    hasta: '2026-07-31',
    estado: 'closed',
    cerradoEn: '2026-08-04T12:00:00.000Z',
    cerradoPor: 'Ana Dueña',
    reabiertoEn: null,
    reabiertoPor: null,
    motivoReapertura: null,
    asientosPendientes: 0,
  },
  {
    id: 'per_2026_08',
    numero: 8,
    nombre: 'Agosto 2026',
    ejercicio: 2026,
    desde: '2026-08-01',
    hasta: '2026-08-31',
    estado: 'open',
    cerradoEn: null,
    cerradoPor: null,
    reabiertoEn: '2026-09-08T09:30:00.000Z',
    reabiertoPor: 'Ana Dueña',
    motivoReapertura: 'Faltó imputar la factura de flete del 28/08',
    asientosPendientes: 0,
  },
  {
    id: 'per_2026_09',
    numero: 9,
    nombre: 'Septiembre 2026',
    ejercicio: 2026,
    desde: '2026-09-01',
    hasta: '2026-09-30',
    estado: 'open',
    cerradoEn: null,
    cerradoPor: null,
    reabiertoEn: null,
    reabiertoPor: null,
    motivoReapertura: null,
    asientosPendientes: 2,
  },
  {
    id: 'per_2026_10',
    numero: 10,
    nombre: 'Octubre 2026',
    ejercicio: 2026,
    desde: '2026-10-01',
    hasta: '2026-10-31',
    estado: 'open',
    cerradoEn: null,
    cerradoPor: null,
    reabiertoEn: null,
    reabiertoPor: null,
    motivoReapertura: null,
    asientosPendientes: 0,
  },
]

export const asientos: Asiento[] = [
  {
    id: 'as_001',
    numero: 'AS-1041',
    fecha: '2026-09-30',
    descripcion: 'Venta FAC-A-00131',
    origen: 'invoice',
    debito: 124500000,
    credito: 124500000,
    periodoId: 'per_2026_09',
    periodoNombre: 'Septiembre 2026',
  },
  {
    id: 'as_002',
    numero: 'AS-1042',
    fecha: '2026-09-30',
    descripcion: 'Costo de la mercadería vendida',
    origen: 'stock_movement',
    debito: 62000000,
    credito: 62000000,
    periodoId: 'per_2026_09',
    periodoNombre: 'Septiembre 2026',
  },
  {
    id: 'as_003',
    numero: 'AS-1043',
    fecha: '2026-09-28',
    descripcion: 'Pago a proveedor OP-3310',
    origen: 'supplier_payment',
    debito: 48000000,
    credito: 48000000,
    periodoId: 'per_2026_09',
    periodoNombre: 'Septiembre 2026',
  },
  {
    id: 'as_004',
    numero: 'AS-1038',
    fecha: '2026-08-31',
    descripcion: 'Ajuste de cierre de agosto',
    origen: 'closing',
    debito: 4500000,
    credito: 4500000,
    periodoId: 'per_2026_08',
    periodoNombre: 'Agosto 2026',
  },
  {
    id: 'as_005',
    numero: 'AS-1046',
    fecha: '2026-10-02',
    descripcion: 'Compra de insumos de limpieza',
    origen: 'purchase',
    debito: 18000000,
    credito: 18000000,
    periodoId: 'per_2026_10',
    periodoNombre: 'Octubre 2026',
  },
]

/**
 * Órdenes de compra, cubriendo los seis estados del CHECK del motor.
 *
 * `aprobadaEn` respeta `po_approval_recorded`: una orden en `approved`,
 * `partially_received` o `received` **siempre** registra quién y cuándo aprobó. Sin
 * eso, «aprobada» sería un estado que cualquiera escribe sin haber aprobado nada.
 */
export const ordenesCompra: OrdenCompra[] = [
  {
    id: 'oc_001',
    numero: 'OC-2043',
    proveedorId: 'prov_andes',
    proveedor: 'Distribuidora Andes',
    estado: 'received',
    total: 48000000,
    moneda: 'ARS',
    fecha: '2026-09-10T10:00:00.000Z',
    aprobadaEn: '2026-09-10T11:00:00.000Z',
    recibidoCompleto: true,
  },
  {
    id: 'oc_002',
    numero: 'OC-2044',
    proveedorId: 'prov_sur',
    proveedor: 'Bebidas del Sur',
    estado: 'partially_received',
    total: 18500000,
    moneda: 'ARS',
    fecha: '2026-09-16T09:00:00.000Z',
    aprobadaEn: '2026-09-16T10:00:00.000Z',
    recibidoCompleto: false,
  },
  {
    id: 'oc_003',
    numero: 'OC-2045',
    proveedorId: 'prov_norte',
    proveedor: 'Insumos Norte',
    estado: 'approved',
    total: 7200000,
    moneda: 'ARS',
    fecha: '2026-09-19T14:00:00.000Z',
    aprobadaEn: '2026-09-19T15:00:00.000Z',
    recibidoCompleto: false,
  },
  {
    id: 'oc_004',
    numero: 'OC-2046',
    proveedorId: 'prov_andes',
    proveedor: 'Distribuidora Andes',
    estado: 'pending_approval',
    total: 3300000,
    moneda: 'ARS',
    fecha: '2026-09-20T08:00:00.000Z',
    aprobadaEn: null,
    recibidoCompleto: false,
  },
  {
    id: 'oc_005',
    numero: 'OC-2047',
    proveedorId: 'prov_sur',
    proveedor: 'Bebidas del Sur',
    estado: 'draft',
    total: 1450000,
    moneda: 'ARS',
    fecha: '2026-09-20T09:30:00.000Z',
    aprobadaEn: null,
    recibidoCompleto: false,
  },
]

export const recepciones: Recepcion[] = [
  {
    id: 'rc_001',
    numero: 'REC-0001',
    ordenNumero: 'OC-2043',
    proveedor: 'Distribuidora Andes',
    documentoProveedor: 'R-88123',
    unidades: 240,
    fecha: '2026-09-12T09:00:00.000Z',
  },
  {
    id: 'rc_002',
    numero: 'REC-0002',
    ordenNumero: 'OC-2044',
    proveedor: 'Bebidas del Sur',
    documentoProveedor: 'R-91004',
    unidades: 96,
    fecha: '2026-09-18T11:00:00.000Z',
  },
]

export const facturasCompra: FacturaCompra[] = [
  {
    id: 'fc_001',
    numero: 'FC-A-2201',
    proveedor: 'Distribuidora Andes',
    total: 48000000,
    pagado: 48000000,
    moneda: 'ARS',
    venceEn: '2026-10-10',
    estado: 'paid',
    fecha: '2026-09-11T10:00:00.000Z',
  },
  {
    id: 'fc_002',
    numero: 'FC-A-2202',
    proveedor: 'Bebidas del Sur',
    total: 18500000,
    pagado: 6000000,
    moneda: 'ARS',
    venceEn: '2026-10-16',
    estado: 'partial',
    fecha: '2026-09-17T10:00:00.000Z',
  },
  {
    id: 'fc_003',
    numero: 'FC-A-2203',
    proveedor: 'Insumos Norte',
    total: 7200000,
    pagado: 0,
    moneda: 'ARS',
    venceEn: '2026-09-25',
    estado: 'pending',
    fecha: '2026-09-19T16:00:00.000Z',
  },
]

export const pagosProveedor: PagoProveedor[] = [
  {
    id: 'pp_001',
    numero: 'OP-3310',
    proveedor: 'Distribuidora Andes',
    monto: 48000000,
    medio: 'transfer',
    referencia: 'TRF-99231',
    moneda: 'ARS',
    fecha: '2026-09-20T10:00:00.000Z',
  },
  {
    id: 'pp_002',
    numero: 'OP-3311',
    proveedor: 'Bebidas del Sur',
    monto: 6000000,
    medio: 'cheque',
    referencia: 'CH-000412',
    moneda: 'ARS',
    fecha: '2026-09-22T10:00:00.000Z',
  },
]

export const cuentasTesoreria: CuentaTesoreria[] = [
  { id: 'ct_001', nombre: 'Caja central', tipo: 'cash', moneda: 'ARS', saldo: 485000, activa: true },
  { id: 'ct_002', nombre: 'Banco Río · Cuenta corriente', tipo: 'bank', moneda: 'ARS', saldo: 18450000, activa: true },
  { id: 'ct_003', nombre: 'Banco Pampa · Caja de ahorro USD', tipo: 'bank', moneda: 'USD', saldo: 320000, activa: false },
]

export const movimientosTesoreria: MovimientoTesoreria[] = [
  {
    id: 'mt_001',
    fecha: '2026-09-20T10:00:00.000Z',
    cuentaId: 'ct_002',
    cuentaNombre: 'Banco Río · Cuenta corriente',
    tipo: 'supplier_payment',
    direccion: 'debit',
    monto: 48000000,
    descripcion: 'Pago FC-A-2201 a Distribuidora Andes',
    conciliado: true,
  },
  {
    id: 'mt_002',
    fecha: '2026-09-18T12:00:00.000Z',
    cuentaId: 'ct_002',
    cuentaNombre: 'Banco Río · Cuenta corriente',
    tipo: 'customer_payment',
    direccion: 'credit',
    monto: 35800000,
    descripcion: 'Cobro FAC-A-00131 de Distribuidora Sur',
    conciliado: false,
  },
  {
    id: 'mt_003',
    fecha: '2026-09-16T09:00:00.000Z',
    cuentaId: 'ct_001',
    cuentaNombre: 'Caja central',
    tipo: 'customer_payment',
    direccion: 'credit',
    monto: 890000,
    descripcion: 'Cobro de mostrador',
    conciliado: true,
  },
  {
    id: 'mt_004',
    fecha: '2026-09-22T10:00:00.000Z',
    cuentaId: 'ct_002',
    cuentaNombre: 'Banco Río · Cuenta corriente',
    tipo: 'check_rejected',
    direccion: 'debit',
    monto: 6000000,
    descripcion: 'Cheque CH-000412 rechazado',
    conciliado: false,
  },
  {
    id: 'mt_005',
    fecha: '2026-09-15T09:00:00.000Z',
    cuentaId: 'ct_002',
    cuentaNombre: 'Banco Río · Cuenta corriente',
    tipo: 'bank_fee',
    direccion: 'debit',
    monto: 45000,
    descripcion: 'Comisión de mantenimiento',
    conciliado: true,
  },
]

export const cheques: Cheque[] = [
  { id: 'ch_001', numero: 'CH-000412', estado: 'endorsed', librador: 'Bebidas del Sur', monto: 6000000, moneda: 'ARS', venceEn: '2026-10-05', propio: false },
  { id: 'ch_002', numero: 'CH-000413', estado: 'in_portfolio', librador: 'Distribuidora Andes', monto: 1250000, moneda: 'ARS', venceEn: '2026-10-12', propio: false },
  { id: 'ch_003', numero: 'CH-000900', estado: 'deposited', librador: 'Control SA', monto: 2400000, moneda: 'ARS', venceEn: '2026-09-28', propio: true },
  { id: 'ch_004', numero: 'CH-000901', estado: 'rejected', librador: 'Control SA', monto: 980000, moneda: 'ARS', venceEn: '2026-09-20', propio: true },
]

export const determinacionIva: DeterminacionIva = {
  periodo: '2026-09',
  ventasNetas: 41200000,
  ivaDebito: 8652000,
  comprasNetas: 22800000,
  ivaCredito: 4788000,
  saldoTecnico: 3864000,
  estado: 'a_pagar',
  calculadaEn: '2026-10-02T06:00:00.000Z',
}

export const alicuotas: Alicuota[] = [
  { id: 'al_001', impuesto: 'IVA', codigo: '21', porcentaje: 21, desde: '2026-01-01', hasta: null },
  { id: 'al_002', impuesto: 'IVA', codigo: '10.5', porcentaje: 10.5, desde: '2026-01-01', hasta: null },
  { id: 'al_003', impuesto: 'Ingresos brutos', codigo: '3', porcentaje: 3, desde: '2026-01-01', hasta: null },
]

export const retenciones: Retencion[] = [
  { id: 'rt_001', regimen: 'IVA', sujeto: 'Distribuidora Andes', base: 48000000, alicuota: 0.5, monto: 240000, fecha: '2026-09-20' },
  { id: 'rt_002', regimen: 'Ingresos brutos', sujeto: 'Bebidas del Sur', base: 18500000, alicuota: 3, monto: 555000, fecha: '2026-09-17' },
]

// ---------------------------------------------------------------------------
// Logística (F7)
// ---------------------------------------------------------------------------

/**
 * Envíos, cubriendo los ocho estados de `logistics.shipment_status`.
 *
 * Todos respetan las dos coherencias del motor: `sh_delivered_ts` (sólo el entregado
 * tiene fecha de entrega) y `sh_window_valid` (la ventana no termina antes de
 * empezar). `envios.test.ts` lo verifica.
 *
 * El `trackingCode` es único por empresa (`sh_tracking_unique`) y es lo que resuelve
 * la página pública: por eso ninguno se repite.
 */
export const envios: Envio[] = [
  {
    id: 'env_001',
    numero: 'ENV-0001',
    trackingCode: 'TRK-9F2K7A01',
    cliente: 'Distribuidora Sur',
    estado: 'delivered',
    prioridad: 2,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Av. Siempre Viva 742',
    localidadDestino: 'Lanús',
    ventanaDesde: '2026-09-20T13:00:00.000Z',
    ventanaHasta: '2026-09-20T18:00:00.000Z',
    despachadoEn: '2026-09-20T10:00:00.000Z',
    entregadoEn: '2026-09-20T15:30:00.000Z',
    distanciaMetros: 18400,
    transportista: 'Transportes Ríos',
    patente: 'AB 123 CD',
    paradas: 2,
    paradasCompletadas: 2,
  },
  {
    id: 'env_002',
    numero: 'ENV-0002',
    trackingCode: 'TRK-9F2K7A02',
    cliente: 'Mayorista Norte',
    estado: 'out_for_delivery',
    prioridad: 1,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Ruta 9 km 42, Escobar',
    localidadDestino: 'Escobar',
    ventanaDesde: '2026-09-20T14:00:00.000Z',
    ventanaHasta: '2026-09-20T19:00:00.000Z',
    despachadoEn: '2026-09-20T11:00:00.000Z',
    entregadoEn: null,
    distanciaMetros: 52100,
    transportista: 'Transportes Ríos',
    patente: 'EF 456 GH',
    paradas: 2,
    paradasCompletadas: 1,
  },
  {
    id: 'env_003',
    numero: 'ENV-0003',
    trackingCode: 'TRK-9F2K7A03',
    cliente: 'Kiosco Centro',
    estado: 'in_transit',
    prioridad: 2,
    desde: 'Depósito sur, Camino de Cintura 1500',
    hasta: 'Belgrano 1220',
    localidadDestino: 'Lanús',
    ventanaDesde: '2026-09-20T15:00:00.000Z',
    ventanaHasta: '2026-09-20T20:00:00.000Z',
    despachadoEn: '2026-09-20T12:00:00.000Z',
    entregadoEn: null,
    distanciaMetros: 6100,
    transportista: 'Flota propia',
    patente: 'IJ 789 KL',
    paradas: 2,
    paradasCompletadas: 1,
  },
  {
    id: 'env_004',
    numero: 'ENV-0004',
    trackingCode: 'TRK-9F2K7A04',
    cliente: 'Bar Norte',
    estado: 'incident',
    prioridad: 3,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'San Martín 850',
    localidadDestino: 'San Isidro',
    ventanaDesde: '2026-09-20T14:00:00.000Z',
    ventanaHasta: '2026-09-20T17:00:00.000Z',
    despachadoEn: '2026-09-20T09:30:00.000Z',
    entregadoEn: null,
    distanciaMetros: 27300,
    transportista: 'Transportes Ríos',
    patente: 'AB 123 CD',
    paradas: 2,
    paradasCompletadas: 1,
  },
  {
    id: 'env_005',
    numero: 'ENV-0005',
    trackingCode: 'TRK-9F2K7A05',
    cliente: 'Almacén Sur',
    estado: 'ready',
    prioridad: 2,
    desde: 'Depósito sur, Camino de Cintura 1500',
    hasta: 'Mitre 455',
    localidadDestino: 'Avellaneda',
    ventanaDesde: '2026-09-21T09:00:00.000Z',
    ventanaHasta: '2026-09-21T13:00:00.000Z',
    despachadoEn: null,
    entregadoEn: null,
    distanciaMetros: 9200,
    transportista: 'Transportes Ríos',
    patente: null,
    paradas: 1,
    paradasCompletadas: 0,
  },
  {
    id: 'env_006',
    numero: 'ENV-0006',
    trackingCode: 'TRK-9F2K7A06',
    cliente: 'Rotisería Pampa',
    estado: 'preparing',
    prioridad: 3,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Los Andes 1900',
    localidadDestino: 'Morón',
    ventanaDesde: '2026-09-21T10:00:00.000Z',
    ventanaHasta: '2026-09-21T14:00:00.000Z',
    despachadoEn: null,
    entregadoEn: null,
    distanciaMetros: 24600,
    transportista: null,
    patente: null,
    paradas: 1,
    paradasCompletadas: 0,
  },
  {
    id: 'env_007',
    numero: 'ENV-0007',
    trackingCode: 'TRK-9F2K7A07',
    cliente: 'Farmacia Central',
    estado: 'draft',
    prioridad: 4,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Rivadavia 9100',
    localidadDestino: 'Ciudad Autónoma de Buenos Aires',
    ventanaDesde: null,
    ventanaHasta: null,
    despachadoEn: null,
    entregadoEn: null,
    distanciaMetros: null,
    transportista: null,
    patente: null,
    paradas: 1,
    paradasCompletadas: 0,
  },
  {
    id: 'env_008',
    numero: 'ENV-0008',
    trackingCode: 'TRK-9F2K7A08',
    cliente: 'Verdulería Norte',
    estado: 'cancelled',
    prioridad: 5,
    desde: 'Depósito central, Av. Rivadavia 4200',
    hasta: 'Constituyentes 3400',
    localidadDestino: 'Vicente López',
    ventanaDesde: '2026-09-19T09:00:00.000Z',
    ventanaHasta: '2026-09-19T13:00:00.000Z',
    despachadoEn: null,
    entregadoEn: null,
    distanciaMetros: 15800,
    transportista: null,
    patente: null,
    paradas: 1,
    paradasCompletadas: 0,
  },
]

export const paradas: Parada[] = [
  { id: 'par_001', envioId: 'env_001', orden: 0, tipo: 'pickup', estado: 'completed', direccion: 'Av. Rivadavia 4200', localidad: 'Ciudad Autónoma de Buenos Aires', ventanaDesde: null, ventanaHasta: null, completadaEn: '2026-09-20T10:00:00.000Z' },
  { id: 'par_002', envioId: 'env_001', orden: 1, tipo: 'delivery', estado: 'completed', direccion: 'Av. Siempre Viva 742', localidad: 'Lanús', ventanaDesde: '2026-09-20T13:00:00.000Z', ventanaHasta: '2026-09-20T18:00:00.000Z', completadaEn: '2026-09-20T15:30:00.000Z' },
  { id: 'par_003', envioId: 'env_002', orden: 0, tipo: 'pickup', estado: 'completed', direccion: 'Av. Rivadavia 4200', localidad: 'Ciudad Autónoma de Buenos Aires', ventanaDesde: null, ventanaHasta: null, completadaEn: '2026-09-20T11:00:00.000Z' },
  { id: 'par_004', envioId: 'env_002', orden: 1, tipo: 'delivery', estado: 'arrived', direccion: 'Ruta 9 km 42', localidad: 'Escobar', ventanaDesde: '2026-09-20T14:00:00.000Z', ventanaHasta: '2026-09-20T19:00:00.000Z', completadaEn: null },
  { id: 'par_005', envioId: 'env_003', orden: 0, tipo: 'pickup', estado: 'completed', direccion: 'Camino de Cintura 1500', localidad: 'Lanús', ventanaDesde: null, ventanaHasta: null, completadaEn: '2026-09-20T12:00:00.000Z' },
  { id: 'par_006', envioId: 'env_003', orden: 1, tipo: 'delivery', estado: 'pending', direccion: 'Belgrano 1220', localidad: 'Lanús', ventanaDesde: '2026-09-20T15:00:00.000Z', ventanaHasta: '2026-09-20T20:00:00.000Z', completadaEn: null },
]

export const vehiculos: Vehiculo[] = [
  { id: 'veh_001', patente: 'AB 123 CD', tipo: 'Furgón', capacidadKg: 1500, transportista: 'Transportes Ríos', activo: true },
  { id: 'veh_002', patente: 'EF 456 GH', tipo: 'Camión', capacidadKg: 8000, transportista: 'Transportes Ríos', activo: true },
  { id: 'veh_003', patente: 'IJ 789 KL', tipo: 'Utilitario', capacidadKg: 800, transportista: 'Flota propia', activo: false },
]

export const incidencias: Incidencia[] = [
  {
    id: 'inc_001',
    envioNumero: 'ENV-0004',
    causa: 'Domicilio cerrado',
    descripcion: 'Nadie atendió en el domicilio. Se reprograma para el día siguiente.',
    gravedad: 'media',
    resuelta: false,
    fecha: '2026-09-20T14:00:00.000Z',
  },
  {
    id: 'inc_002',
    envioNumero: 'ENV-0002',
    causa: 'Tránsito demorado',
    descripcion: 'Demora por corte en la autopista. El conductor avisó al cliente.',
    gravedad: 'baja',
    resuelta: true,
    fecha: '2026-09-20T13:10:00.000Z',
  },
]

/**
 * El historial de tracking.
 *
 * `clientEventId` queda en `null` para los eventos que cargó el sistema, y lleva el
 * valor que la PWA del conductor habría mandado en los que vienen del móvil: es la
 * clave con la que el motor deduplica los reintentos (`te_client_dedup`).
 */
export const eventosTracking: EventoTracking[] = [
  { id: 'ev_001', envioId: 'env_001', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-19T09:00:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_002', envioId: 'env_001', estado: 'in_transit', codigo: 'picked_up', descripcion: 'Retirado del depósito', fecha: '2026-09-20T10:00:00.000Z', actor: 'driver', requiereConfirmacion: false, confirmadoEn: null, clientEventId: 'cli_ev_001' },
  { id: 'ev_003', envioId: 'env_001', estado: 'out_for_delivery', codigo: 'out_for_delivery', descripcion: 'En reparto', fecha: '2026-09-20T13:00:00.000Z', actor: 'driver', requiereConfirmacion: false, confirmadoEn: null, clientEventId: 'cli_ev_002' },
  { id: 'ev_004', envioId: 'env_001', estado: 'delivered', codigo: 'delivered', descripcion: 'Entregado y firmado', fecha: '2026-09-20T15:30:00.000Z', actor: 'customer', requiereConfirmacion: true, confirmadoEn: '2026-09-20T15:30:00.000Z', clientEventId: null },
  { id: 'ev_005', envioId: 'env_002', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T08:00:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_006', envioId: 'env_002', estado: 'in_transit', codigo: 'picked_up', descripcion: 'Retirado del depósito', fecha: '2026-09-20T11:00:00.000Z', actor: 'driver', requiereConfirmacion: false, confirmadoEn: null, clientEventId: 'cli_ev_003' },
  { id: 'ev_007', envioId: 'env_002', estado: 'out_for_delivery', codigo: 'out_for_delivery', descripcion: 'En reparto', fecha: '2026-09-20T13:30:00.000Z', actor: 'driver', requiereConfirmacion: false, confirmadoEn: null, clientEventId: 'cli_ev_004' },
  { id: 'ev_008', envioId: 'env_003', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T07:00:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_009', envioId: 'env_003', estado: 'in_transit', codigo: 'at_hub', descripcion: 'Llegó al centro de distribución', fecha: '2026-09-20T12:00:00.000Z', actor: 'driver', requiereConfirmacion: false, confirmadoEn: null, clientEventId: 'cli_ev_005' },
  { id: 'ev_010', envioId: 'env_004', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T07:30:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_011', envioId: 'env_004', estado: 'incident', codigo: 'incident', descripcion: 'No se pudo entregar: domicilio cerrado', fecha: '2026-09-20T14:00:00.000Z', actor: 'driver', requiereConfirmacion: true, confirmadoEn: null, clientEventId: 'cli_ev_006' },
  { id: 'ev_012', envioId: 'env_005', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T09:30:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_013', envioId: 'env_006', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T09:00:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_014', envioId: 'env_007', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T10:00:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
  { id: 'ev_015', envioId: 'env_008', estado: 'draft', codigo: 'created', descripcion: 'Envío creado', fecha: '2026-09-20T08:30:00.000Z', actor: 'user', requiereConfirmacion: false, confirmadoEn: null, clientEventId: null },
]

export const confirmacionesEntrega: ConfirmacionEntrega[] = [
  {
    id: 'cnf_001',
    envioId: 'env_001',
    envioNumero: 'ENV-0001',
    receptor: 'Marta Gómez',
    documento: 'DNI 12.345.678',
    firmaUrl: 'https://pod.control.ar/cnf_001/firma.png',
    fotos: ['https://pod.control.ar/cnf_001/1.jpg'],
    conforme: true,
    observaciones: null,
    confirmadaEn: '2026-09-20T15:30:00.000Z',
  },
  {
    id: 'cnf_002',
    envioId: 'env_002',
    envioNumero: 'ENV-0002',
    receptor: null,
    documento: null,
    firmaUrl: null,
    fotos: [],
    conforme: null,
    observaciones: null,
    confirmadaEn: null,
  },
]
