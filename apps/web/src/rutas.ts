/**
 * El mapa de ventanas.
 *
 * Una función, una ventana: cada módulo es una ruta propia, con su permiso, su
 * bandera de funcionalidad, su carga de datos y su bundle. No hay un dashboard
 * monolítico con pestañas que carguen todo.
 *
 * Este archivo es la **fuente única** del menú, de las guardas, de los títulos y de
 * los tests. Si cada uno se derivara por su cuenta, tarde o temprano divergirían, y
 * el síntoma sería un ítem de menú visible que lleva a un 403. Con un solo mapa
 * tipado eso no puede pasar, y la suite lo verifica.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §4.
 */

/** La fase del plan de frontend en la que se implementa cada ruta. */
export type Fase = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9'

export const FASES: readonly Fase[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']

/** Los seis agrupamientos del menú, en el orden en que se muestran. */
export const GRUPOS = {
  operacion: 'Operación',
  inventario: 'Inventario',
  compras: 'Compras',
  finanzas: 'Finanzas',
  logistica: 'Logística',
  gobierno: 'Gobierno',
} as const

export type Grupo = keyof typeof GRUPOS

/**
 * Los permisos que la base ya tiene.
 *
 * Es el espejo de `app.permissions`: **51 permisos en 16 recursos**. Los 33
 * originales más los 18 que sembró la fase F6 (compras, tesorería, contabilidad,
 * fiscal y tareas programadas). La suite de rutas comprueba que ninguna ventana use
 * un permiso que no esté acá, y `tools/check-permissions.mjs` cruza esta lista
 * contra el catálogo SQL en los dos sentidos — si divergen, `npm run verify` falla.
 */
export const PERMISOS_SEMBRADOS = [
  'accounting.close',
  'accounting.manage_accounts',
  'accounting.post',
  'accounting.read',
  'audit.read',
  'billing.afip_credentials',
  'billing.credit_note',
  'billing.issue_invoice',
  'billing.manage',
  'billing.read',
  'catalog.delete',
  'catalog.prices',
  'catalog.read',
  'catalog.write',
  'customers.read',
  'customers.write',
  'fiscal.determine',
  'fiscal.manage_rates',
  'fiscal.read',
  'fiscal.withholdings',
  'inventory.adjust',
  'inventory.read',
  'inventory.transfer',
  'inventory.warehouses',
  'logistics.config',
  'logistics.deliver',
  'logistics.dispatch',
  'logistics.read',
  'logistics.write',
  'ops.read',
  'ops.run',
  'payments.manage',
  'purchasing.pay',
  'purchasing.read',
  'purchasing.receive',
  'purchasing.write',
  'reports.export',
  'reports.financial',
  'sales.cancel',
  'sales.read',
  'sales.write',
  'team.invite',
  'team.manage',
  'team.manage_roles',
  'tenant.branding',
  'tenant.features',
  'tenant.settings',
  'treasury.checks',
  'treasury.read',
  'treasury.reconcile',
  'treasury.write',
] as const

/**
 * Los permisos que el mapa necesita y la base todavía no tiene.
 *
 * **Está vacía desde F6.** Los 18 permisos que faltaban —compras, tesorería,
 * contabilidad, fiscal y tareas programadas— se sembraron en
 * `db/seed/0001_system_catalog.sql` y se asignaron a los roles de sistema, así que
 * las catorce ventanas tienen guard.
 *
 * La lista se conserva vacía en vez de eliminarse porque es el mecanismo con el que
 * una fase futura declara un permiso antes de sembrarlo: mientras tenga entradas,
 * `rutas.test.ts` lo reporta, y `tools/check-permissions.mjs` cruza las dos listas
 * contra el catálogo SQL. Un arreglo no vacío significa «falta sembrar», no «error».
 */
export const PERMISOS_PENDIENTES = [] as const

export type Permiso = (typeof PERMISOS_SEMBRADOS)[number] | (typeof PERMISOS_PENDIENTES)[number]

/** Los nombres de los iconos disponibles. El componente los resuelve. */
export type NombreDeIcono =
  | 'panel'
  | 'ventas'
  | 'facturacion'
  | 'catalogo'
  | 'stock'
  | 'compras'
  | 'tesoreria'
  | 'contabilidad'
  | 'fiscal'
  | 'logistica'
  | 'equipo'
  | 'configuracion'
  | 'auditoria'
  | 'tareas'

/** Una ruta dentro de una ventana. */
export interface Subruta {
  id: string
  /** El segmento de URL, relativo a la ventana. Puede contener `[id]`. */
  segmento: string
  titulo: string
  /** En qué fase del plan se implementa. */
  fase: Fase
}

/** Una ventana: una función con su ruta raíz. */
export interface Ventana {
  id: string
  /** El segmento de URL, relativo a `/e/[slug]`. */
  segmento: string
  titulo: string
  /** Para qué sirve. Se muestra en el estado vacío y en el encabezado. */
  descripcion: string
  /** Permiso requerido. `null` significa «basta con tener sesión». */
  permiso: Permiso | null
  /** Bandera de `tenants.features` que la habilita. Sin ella, no existe. */
  funcionalidad?: string
  icono: NombreDeIcono
  grupo: Grupo
  /** En qué fase se implementa la ventana raíz. */
  fase: Fase
  subrutas: readonly Subruta[]
}

/**
 * Las catorce ventanas raíz, en el orden del menú.
 *
 * Cada una tiene su URL, su permiso y sus gráficos. No hay un panel genérico de
 * gráficos que se reutilice entre ventanas: los primitivos se comparten, la
 * semántica de las series no —un gráfico de IVA por alícuota no significa nada en
 * Stock—.
 */
export const VENTANAS: readonly Ventana[] = [
  {
    id: 'panel',
    segmento: 'panel',
    titulo: 'Panel de control',
    descripcion:
      'El estado de la empresa de un vistazo: ventas del período, documentos en curso, stock crítico y salud de las tareas programadas.',
    permiso: null,
    icono: 'panel',
    grupo: 'operacion',
    fase: 'F4',
    subrutas: [],
  },
  {
    id: 'ventas',
    segmento: 'ventas',
    titulo: 'Ventas',
    descripcion:
      'La cadena de documentos completa: cotización, pedido, remito, factura y devolución. Cada documento con su estado y sus transiciones válidas.',
    permiso: 'sales.read',
    icono: 'ventas',
    grupo: 'operacion',
    fase: 'F4',
    subrutas: [
      { id: 'pedidos', segmento: 'pedidos', titulo: 'Pedidos', fase: 'F4' },
      { id: 'pedido-nuevo', segmento: 'pedidos/nuevo', titulo: 'Nuevo pedido', fase: 'F4' },
      { id: 'pedido-detalle', segmento: 'pedidos/[id]', titulo: 'Detalle del pedido', fase: 'F4' },
      { id: 'cotizaciones', segmento: 'cotizaciones', titulo: 'Cotizaciones', fase: 'F4' },
      { id: 'cotizacion-nueva', segmento: 'cotizaciones/nueva', titulo: 'Nueva cotización', fase: 'F4' },
      { id: 'cotizacion-detalle', segmento: 'cotizaciones/[id]', titulo: 'Detalle de la cotización', fase: 'F4' },
      { id: 'remitos', segmento: 'remitos', titulo: 'Remitos', fase: 'F4' },
      { id: 'remito-detalle', segmento: 'remitos/[id]', titulo: 'Detalle del remito', fase: 'F4' },
      { id: 'devoluciones', segmento: 'devoluciones', titulo: 'Devoluciones', fase: 'F4' },
      { id: 'devolucion-detalle', segmento: 'devoluciones/[id]', titulo: 'Detalle de la devolución', fase: 'F4' },
      { id: 'clientes', segmento: 'clientes', titulo: 'Clientes', fase: 'F4' },
      { id: 'cliente-detalle', segmento: 'clientes/[id]', titulo: 'Ficha del cliente', fase: 'F4' },
      { id: 'cuenta-corriente', segmento: 'cuenta-corriente', titulo: 'Cuenta corriente', fase: 'F6' },
      { id: 'precios', segmento: 'precios', titulo: 'Listas de precios', fase: 'F4' },
      { id: 'precio-detalle', segmento: 'precios/[id]', titulo: 'Detalle de la lista', fase: 'F4' },
    ],
  },
  {
    id: 'facturacion',
    segmento: 'facturacion',
    titulo: 'Facturación',
    descripcion:
      'Comprobantes ante AFIP: la cola de emisión, los autorizados, los rechazados y el libro de IVA. Un comprobante autorizado no se edita.',
    permiso: 'billing.read',
    icono: 'facturacion',
    grupo: 'operacion',
    fase: 'F4',
    subrutas: [
      { id: 'nueva', segmento: 'nueva', titulo: 'Nuevo comprobante', fase: 'F4' },
      { id: 'detalle', segmento: '[id]', titulo: 'Detalle del comprobante', fase: 'F4' },
      { id: 'cola', segmento: 'cola', titulo: 'Cola de emisión', fase: 'F4' },
      { id: 'notas-de-credito', segmento: 'notas-de-credito', titulo: 'Notas de crédito', fase: 'F4' },
      { id: 'libro-iva', segmento: 'libro-iva', titulo: 'Libro de IVA', fase: 'F6' },
    ],
  },
  {
    id: 'catalogo',
    segmento: 'catalogo',
    titulo: 'Catálogo',
    descripcion:
      'Productos y variantes con su precio, su código de barras y su categoría. Es la base de todo lo que se vende, se compra y se cuenta.',
    permiso: 'catalog.read',
    icono: 'catalogo',
    grupo: 'inventario',
    fase: 'F5',
    subrutas: [
      { id: 'nuevo', segmento: 'nuevo', titulo: 'Nuevo producto', fase: 'F5' },
      { id: 'detalle', segmento: '[id]', titulo: 'Detalle del producto', fase: 'F5' },
      { id: 'categorias', segmento: 'categorias', titulo: 'Categorías', fase: 'F5' },
      { id: 'marcas', segmento: 'marcas', titulo: 'Marcas', fase: 'F5' },
      { id: 'importar', segmento: 'importar', titulo: 'Importar catálogo', fase: 'F5' },
    ],
  },
  {
    id: 'stock',
    segmento: 'stock',
    titulo: 'Stock',
    descripcion:
      'Niveles por depósito, el libro mayor de movimientos, transferencias y el resultado de la conciliación. El saldo y el libro se escriben en la misma transacción.',
    permiso: 'inventory.read',
    icono: 'stock',
    grupo: 'inventario',
    fase: 'F5',
    subrutas: [
      { id: 'movimientos', segmento: 'movimientos', titulo: 'Movimientos', fase: 'F5' },
      { id: 'depositos', segmento: 'depositos', titulo: 'Depósitos', fase: 'F5' },
      { id: 'transferencias', segmento: 'transferencias', titulo: 'Transferencias', fase: 'F5' },
      { id: 'transferencia-nueva', segmento: 'transferencias/nueva', titulo: 'Nueva transferencia', fase: 'F5' },
      { id: 'transferencia-detalle', segmento: 'transferencias/[id]', titulo: 'Detalle de la transferencia', fase: 'F5' },
      { id: 'reposicion', segmento: 'reposicion', titulo: 'Reposición', fase: 'F5' },
      { id: 'recuento', segmento: 'recuento', titulo: 'Recuento', fase: 'F5' },
      { id: 'conciliacion', segmento: 'conciliacion', titulo: 'Conciliación', fase: 'F5' },
    ],
  },
  {
    id: 'compras',
    segmento: 'compras',
    titulo: 'Compras',
    descripcion:
      'Proveedores, órdenes de compra, recepciones —totales o parciales—, facturas y pagos. Lo recibido es lo que entra al stock.',
    permiso: 'purchasing.read',
    icono: 'compras',
    grupo: 'compras',
    fase: 'F6',
    subrutas: [
      { id: 'proveedores', segmento: 'proveedores', titulo: 'Proveedores', fase: 'F6' },
      { id: 'proveedor-detalle', segmento: 'proveedores/[id]', titulo: 'Ficha del proveedor', fase: 'F6' },
      { id: 'ordenes', segmento: 'ordenes', titulo: 'Órdenes de compra', fase: 'F6' },
      { id: 'orden-nueva', segmento: 'ordenes/nueva', titulo: 'Nueva orden de compra', fase: 'F6' },
      { id: 'orden-detalle', segmento: 'ordenes/[id]', titulo: 'Detalle de la orden', fase: 'F6' },
      { id: 'recepciones', segmento: 'recepciones', titulo: 'Recepciones', fase: 'F6' },
      { id: 'recepcion-detalle', segmento: 'recepciones/[id]', titulo: 'Detalle de la recepción', fase: 'F6' },
      { id: 'facturas', segmento: 'facturas', titulo: 'Facturas de compra', fase: 'F6' },
      { id: 'factura-detalle', segmento: 'facturas/[id]', titulo: 'Detalle de la factura', fase: 'F6' },
      { id: 'pagos', segmento: 'pagos', titulo: 'Pagos', fase: 'F6' },
      { id: 'cuenta-corriente', segmento: 'cuenta-corriente', titulo: 'Cuenta corriente', fase: 'F6' },
    ],
  },
  {
    id: 'tesoreria',
    segmento: 'tesoreria',
    titulo: 'Tesorería',
    descripcion:
      'Caja y bancos, cobros y pagos, cartera de cheques por vencimiento y conciliación bancaria. La posición consolidada, en un solo lugar.',
    permiso: 'treasury.read',
    icono: 'tesoreria',
    grupo: 'finanzas',
    fase: 'F6',
    subrutas: [
      { id: 'cuentas', segmento: 'cuentas', titulo: 'Cuentas', fase: 'F6' },
      { id: 'cuenta-detalle', segmento: 'cuentas/[id]', titulo: 'Detalle de la cuenta', fase: 'F6' },
      { id: 'movimientos', segmento: 'movimientos', titulo: 'Movimientos', fase: 'F6' },
      { id: 'cobros', segmento: 'cobros', titulo: 'Cobros', fase: 'F6' },
      { id: 'pagos', segmento: 'pagos', titulo: 'Pagos', fase: 'F6' },
      { id: 'cheques', segmento: 'cheques', titulo: 'Cheques', fase: 'F6' },
      { id: 'conciliaciones', segmento: 'conciliaciones', titulo: 'Conciliaciones', fase: 'F6' },
      { id: 'conciliacion-detalle', segmento: 'conciliaciones/[id]', titulo: 'Detalle de la conciliación', fase: 'F6' },
    ],
  },
  {
    id: 'contabilidad',
    segmento: 'contabilidad',
    titulo: 'Contabilidad',
    descripcion:
      'El libro diario, el plan de cuentas, los períodos y el balance de sumas y saldos. La partida doble la garantiza el motor, no quien escribe.',
    permiso: 'accounting.read',
    icono: 'contabilidad',
    grupo: 'finanzas',
    fase: 'F6',
    subrutas: [
      { id: 'asientos', segmento: 'asientos', titulo: 'Asientos', fase: 'F6' },
      { id: 'asiento-detalle', segmento: 'asientos/[id]', titulo: 'Detalle del asiento', fase: 'F6' },
      { id: 'plan-de-cuentas', segmento: 'plan-de-cuentas', titulo: 'Plan de cuentas', fase: 'F6' },
      { id: 'periodos', segmento: 'periodos', titulo: 'Períodos', fase: 'F6' },
      { id: 'balance', segmento: 'balance', titulo: 'Balance de sumas y saldos', fase: 'F6' },
      { id: 'reglas', segmento: 'reglas', titulo: 'Reglas de imputación', fase: 'F6' },
      { id: 'pendientes', segmento: 'pendientes', titulo: 'Hechos sin asiento', fase: 'F6' },
    ],
  },
  {
    id: 'fiscal',
    segmento: 'fiscal',
    titulo: 'Fiscal',
    descripcion:
      'Posición de IVA, determinación por período, retenciones y los comprobantes propios. Los comprobantes de terceros viven acá, no en facturación.',
    permiso: 'fiscal.read',
    icono: 'fiscal',
    grupo: 'finanzas',
    fase: 'F6',
    subrutas: [
      { id: 'determinacion', segmento: 'determinacion', titulo: 'Determinación de IVA', fase: 'F6' },
      { id: 'retenciones', segmento: 'retenciones', titulo: 'Retenciones', fase: 'F6' },
      { id: 'comprobantes', segmento: 'comprobantes', titulo: 'Comprobantes propios', fase: 'F6' },
      { id: 'comprobante-detalle', segmento: 'comprobantes/[id]', titulo: 'Detalle del comprobante', fase: 'F6' },
      { id: 'alicuotas', segmento: 'alicuotas', titulo: 'Alícuotas', fase: 'F6' },
      { id: 'libros', segmento: 'libros', titulo: 'Libros', fase: 'F6' },
      { id: 'credenciales', segmento: 'credenciales', titulo: 'Credenciales AFIP', fase: 'F6' },
    ],
  },
  {
    id: 'logistica',
    segmento: 'logistica',
    titulo: 'Logística',
    descripcion:
      'La torre de control con el mapa en vivo, los envíos y su máquina de estados, la flota y las confirmaciones de entrega.',
    permiso: 'logistics.read',
    funcionalidad: 'logistics.enabled',
    icono: 'logistica',
    grupo: 'logistica',
    fase: 'F7',
    subrutas: [
      { id: 'torre', segmento: 'torre', titulo: 'Torre de control', fase: 'F7' },
      { id: 'envios', segmento: 'envios', titulo: 'Envíos', fase: 'F7' },
      { id: 'envio-nuevo', segmento: 'envios/nuevo', titulo: 'Nuevo envío', fase: 'F7' },
      { id: 'envio-detalle', segmento: 'envios/[id]', titulo: 'Detalle del envío', fase: 'F7' },
      { id: 'flota', segmento: 'flota', titulo: 'Flota', fase: 'F7' },
      { id: 'transportistas', segmento: 'transportistas', titulo: 'Transportistas', fase: 'F7' },
      { id: 'incidencias', segmento: 'incidencias', titulo: 'Incidencias', fase: 'F7' },
      { id: 'pod', segmento: 'pod', titulo: 'Comprobantes de entrega', fase: 'F7' },
    ],
  },
  {
    id: 'equipo',
    segmento: 'equipo',
    titulo: 'Equipo',
    descripcion:
      'Quién trabaja en esta empresa, con qué rol y con qué permisos. El menú de cada persona sale de acá.',
    permiso: 'team.manage',
    icono: 'equipo',
    grupo: 'gobierno',
    fase: 'F8',
    subrutas: [
      { id: 'miembros', segmento: 'miembros', titulo: 'Miembros', fase: 'F8' },
      { id: 'roles', segmento: 'roles', titulo: 'Roles', fase: 'F8' },
      { id: 'invitaciones', segmento: 'invitaciones', titulo: 'Invitaciones', fase: 'F8' },
    ],
  },
  {
    id: 'configuracion',
    segmento: 'configuracion',
    titulo: 'Configuración',
    descripcion:
      'La identidad de la empresa —logo, colores, tipografía y plantilla—, sus datos fiscales y sus integraciones. El contraste de cada color elegido se muestra acá.',
    permiso: 'tenant.settings',
    icono: 'configuracion',
    grupo: 'gobierno',
    fase: 'F8',
    subrutas: [
      { id: 'identidad', segmento: 'identidad', titulo: 'Identidad y plantillas', fase: 'F8' },
      { id: 'plantillas', segmento: 'plantillas', titulo: 'Plantillas por rubro', fase: 'F8' },
      { id: 'empresa', segmento: 'empresa', titulo: 'Datos de la empresa', fase: 'F8' },
      { id: 'impuestos', segmento: 'impuestos', titulo: 'Impuestos', fase: 'F8' },
      { id: 'integraciones', segmento: 'integraciones', titulo: 'Integraciones', fase: 'F8' },
    ],
  },
  {
    id: 'auditoria',
    segmento: 'auditoria',
    titulo: 'Auditoría',
    descripcion:
      'El registro de todo lo que pasó, con su actor, su momento y su contexto. Es la ventana que responde «quién hizo esto».',
    permiso: 'audit.read',
    icono: 'auditoria',
    grupo: 'gobierno',
    fase: 'F8',
    subrutas: [],
  },
  {
    id: 'tareas',
    segmento: 'tareas',
    titulo: 'Tareas programadas',
    descripcion:
      'Los jobs con su última corrida, su duración y sus atrasos. Sin esta ventana, un job que dejó de correr no se nota hasta que falta un dato.',
    permiso: 'ops.read',
    icono: 'tareas',
    grupo: 'gobierno',
    fase: 'F8',
    subrutas: [
      { id: 'detalle', segmento: '[id]', titulo: 'Detalle de la tarea', fase: 'F8' },
    ],
  },
]

/**
 * Las rutas que viven fuera de la carcasa de una empresa.
 *
 * No tienen permiso ni menú: son el acceso, el tracking público y la consola de
 * plataforma, que va en un dominio aparte porque un owner de empresa nunca entra.
 */
export const RUTAS_FUERA_DE_CARCASA = [
  { id: 'ingreso', ruta: '/ingresar', titulo: 'Ingresar', fase: 'F2' },
  { id: 'ingreso-verificar', ruta: '/ingresar/verificar', titulo: 'Verificar identidad', fase: 'F2' },
  { id: 'recuperar', ruta: '/recuperar', titulo: 'Recuperar acceso', fase: 'F2' },
  { id: 'invitacion', ruta: '/invitacion/[token]', titulo: 'Aceptar invitación', fase: 'F2' },
  { id: 'empresas', ruta: '/empresas', titulo: 'Elegir empresa', fase: 'F2' },
  { id: 'tracking', ruta: '/t/[token]', titulo: 'Seguimiento del envío', fase: 'F7' },
  { id: 'chofer', ruta: '/chofer', titulo: 'Panel del conductor', fase: 'F7' },
  { id: 'chofer-entrega', ruta: '/chofer/entrega/[id]', titulo: 'Entrega', fase: 'F7' },
  { id: 'plataforma-empresas', ruta: '/plataforma/empresas', titulo: 'Empresas', fase: 'F8' },
  { id: 'plataforma-empresa', ruta: '/plataforma/empresas/[id]', titulo: 'Detalle de la empresa', fase: 'F8' },
  { id: 'plataforma-suscripciones', ruta: '/plataforma/suscripciones', titulo: 'Suscripciones', fase: 'F8' },
  { id: 'plataforma-soporte', ruta: '/plataforma/soporte', titulo: 'Soporte', fase: 'F8' },
  { id: 'plataforma-tareas', ruta: '/plataforma/tareas', titulo: 'Tareas de plataforma', fase: 'F8' },
  { id: 'plataforma-salud', ruta: '/plataforma/salud', titulo: 'Salud del sistema', fase: 'F8' },
] as const

export interface RutaResuelta {
  /** La ruta completa, sin el `slug` de la empresa. */
  ruta: string
  /** La ventana a la que pertenece. Ausente en las rutas fuera de la carcasa. */
  ventana?: Ventana
  subruta: Subruta | null
  titulo: string
  fase: Fase
}

/**
 * Todas las rutas de la aplicación, aplanadas.
 *
 * Sirve para la suite: contar, verificar que no haya duplicados y comprobar que cada
 * ruta implementada tenga su archivo de página.
 */
export function todasLasRutas(): RutaResuelta[] {
  const rutas: RutaResuelta[] = []

  for (const ventana of VENTANAS) {
    rutas.push({
      ruta: `/e/[slug]/${ventana.segmento}`,
      ventana,
      subruta: null,
      titulo: ventana.titulo,
      fase: ventana.fase,
    })
    for (const subruta of ventana.subrutas) {
      rutas.push({
        ruta: `/e/[slug]/${ventana.segmento}/${subruta.segmento}`,
        ventana,
        subruta,
        titulo: subruta.titulo,
        fase: subruta.fase,
      })
    }
  }

  for (const fuera of RUTAS_FUERA_DE_CARCASA) {
    rutas.push({
      ruta: fuera.ruta,
      subruta: null,
      titulo: fuera.titulo,
      fase: fuera.fase,
    })
  }

  return rutas
}

/** El total de rutas del mapa, para contrastar contra el plan. */
export const TOTAL_DE_RUTAS =
  VENTANAS.reduce((suma, v) => suma + 1 + v.subrutas.length, 0) + RUTAS_FUERA_DE_CARCASA.length

/**
 * Los permisos que alguna ventana referencia y que no están declarados.
 *
 * Una lista vacía significa que el mapa y el catálogo de permisos coinciden. Si no lo
 * fuera, la ventana quedaría sin guard: visible en el menú para cualquiera y accesible
 * por URL, porque la comprobación de permiso nunca pasaría a verdadero y el filtro del
 * menú la dejaría pasar.
 */
export function permisosDesconocidos(ventanas: readonly Ventana[] = VENTANAS): string[] {
  const conocidos = new Set<string>([...PERMISOS_SEMBRADOS, ...PERMISOS_PENDIENTES])
  return ventanas
    .map((ventana) => ventana.permiso)
    .filter((permiso): permiso is Permiso => permiso !== null && !conocidos.has(permiso))
}

/**
 * Las ventanas que un usuario ve, según sus permisos y las banderas de su empresa.
 *
 * El menú se genera con esto. Es la regla A2: nada de condiciones dispersas en los
 * componentes — si una ventana no aparece, es porque acá no pasó el filtro.
 */
export function ventanasVisibles(
  permisos: readonly string[],
  funcionalidades: Readonly<Record<string, boolean>>,
): Ventana[] {
  return VENTANAS.filter((ventana) => {
    if (ventana.permiso !== null && !permisos.includes(ventana.permiso)) return false
    if (ventana.funcionalidad !== undefined && funcionalidades[ventana.funcionalidad] !== true) {
      return false
    }
    return true
  })
}

/** Agrupa las ventanas para el menú, en el orden declarado de los grupos. */
export function menuPorGrupo(ventanas: readonly Ventana[]): { grupo: Grupo; titulo: string; ventanas: Ventana[] }[] {
  return (Object.keys(GRUPOS) as Grupo[])
    .map((grupo) => ({
      grupo,
      titulo: GRUPOS[grupo],
      ventanas: ventanas.filter((v) => v.grupo === grupo),
    }))
    .filter((bloque) => bloque.ventanas.length > 0)
}

/**
 * Busca una ventana por su id y falla si no existe.
 *
 * Cada página de ventana la usa para obtener su propia definición, así que un id mal
 * escrito rompe en el build en vez de renderizar una página sin título.
 */
export function ventanaPorId(id: string): Ventana {
  const encontrada = VENTANAS.find((ventana) => ventana.id === id)
  if (encontrada === undefined) {
    throw new Error(
      `No existe la ventana «${id}» en el mapa de rutas. Las declaradas son: ${VENTANAS.map((v) => v.id).join(', ')}.`,
    )
  }
  return encontrada
}
