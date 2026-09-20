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
import type { Miembro } from './gobierno.ts'
import type { AuditoriaEvento } from './gobierno.ts'
import type { Tarea } from './gobierno.ts'

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

export const tareas: Tarea[] = [
  {
    id: 'tk_001',
    titulo: 'Conciliar cierre de septiembre',
    estado: 'en_curso',
    asignadoA: 'u_ana',
    vence: '2026-09-30T00:00:00.000Z',
  },
  {
    id: 'tk_002',
    titulo: 'Revisar merma de depósito sur',
    estado: 'abierta',
    asignadoA: 'u_beto',
  },
  {
    id: 'tk_003',
    titulo: 'Cargar catálogo Q4',
    estado: 'completada',
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
