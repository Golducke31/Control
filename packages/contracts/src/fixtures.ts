import type { Categoria } from './catalogo.ts'
import type { Marca } from './catalogo.ts'
import type { Producto } from './catalogo.ts'
import type { NivelStock } from './stock.ts'
import type { MovimientoStock } from './stock.ts'
import type { DocumentoVenta, PanelResumen, ComprobanteFiscal } from './ventas.ts'
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
]

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
