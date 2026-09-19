/**
 * Empresas de demostración.
 *
 * **Esto es un marcador de posición de la fase F1.** En F2 lo reemplaza la sesión
 * real: el servidor resuelve la empresa desde el `slug` de la URL, verifica la
 * membresía del usuario y entrega sus permisos. El cliente nunca decide a qué empresa
 * entra.
 *
 * Mientras tanto, estos datos permiten que la carcasa navegue de verdad y —lo que
 * importa— que el filtrado por permisos y por banderas de funcionalidad sea
 * **observable**: cambiar de empresa cambia el menú, y eso se puede ver.
 *
 * La forma de estos objetos es la que va a tener la respuesta de `GET /empresas/:slug`
 * (ver el anexo B del plan de frontend), así que F2 no cambia los componentes: cambia
 * de dónde vienen los datos.
 */

import { PERMISOS_PENDIENTES, PERMISOS_SEMBRADOS } from './rutas.ts'

export interface Empresa {
  slug: string
  nombre: string
  iniciales: string
  descripcion: string
  rol: string
  /** Los permisos que el usuario tiene en esta empresa. */
  permisos: readonly string[]
  /** El contenido de `tenants.features`. */
  funcionalidades: Readonly<Record<string, boolean>>
}

/**
 * Todos los permisos que el mapa conoce.
 *
 * En el sistema real, el rol `owner` tiene los 33 sembrados y la migración `0026`
 * agrega los 18 pendientes. Acá se unen para que la demostración muestre las catorce
 * ventanas, que es el punto de F1.
 */
const TODOS_LOS_PERMISOS = [...PERMISOS_SEMBRADOS, ...PERMISOS_PENDIENTES]

export const EMPRESAS: readonly Empresa[] = [
  {
    slug: 'andes',
    nombre: 'Andes Trading',
    iniciales: 'AT',
    descripcion: 'Distribuidora · 3 depósitos',
    rol: 'Propietario',
    permisos: TODOS_LOS_PERMISOS,
    funcionalidades: { 'logistics.enabled': true },
  },
  {
    slug: 'pampa',
    nombre: 'Pampa Logística',
    iniciales: 'PL',
    descripcion: 'Transporte · 14 unidades',
    rol: 'Encargado de depósito',
    // El menú de esta empresa es corto a propósito: sirve para ver que el filtrado
    // por permisos funciona y no es una lista estática.
    permisos: ['inventory.read', 'inventory.adjust', 'inventory.transfer', 'inventory.warehouses', 'catalog.read', 'logistics.read'],
    funcionalidades: { 'logistics.enabled': true },
  },
  {
    slug: 'nordico',
    nombre: 'Nórdico Retail',
    iniciales: 'NR',
    descripcion: 'Retail · 1 salón',
    rol: 'Administrador',
    // Sin logística: la ventana no existe para esta empresa, y por eso tampoco aparece
    // en el menú ni se puede alcanzar por URL (regla A4).
    permisos: TODOS_LOS_PERMISOS.filter((p) => !p.startsWith('logistics.')),
    funcionalidades: { 'logistics.enabled': false },
  },
]

export function empresaPorSlug(slug: string): Empresa | undefined {
  return EMPRESAS.find((empresa) => empresa.slug === slug)
}

/** El slug que se usa cuando no hay ninguno en la URL. */
export const EMPRESA_POR_DEFECTO = 'andes'
