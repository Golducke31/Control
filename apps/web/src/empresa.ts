/**
 * Empresas de demostración.
 *
 * El catálogo de empresas que el servidor resuelve desde el `slug`. En F2 la autorización
 * es **por usuario**: cada empresa habilita todos los módulos (`permisos` = todos los
 * conocidos) y es la **membresía** del usuario —definida en `sesion/directorio.ts`— la que
 * acota qué ve. La bandera `logistics.enabled` sigue siendo el mecanismo de
 * feature-flag por empresa: donde está apagada, la ventana de logística no existe.
 *
 * La forma de `Empresa` es la de la respuesta de `GET /empresas/:slug` (anexo B del plan de
 * frontend), así que cuando llegue el backend los componentes no cambian: cambia de dónde se
 * leen los datos.
 */

import { PERMISOS_PENDIENTES, PERMISOS_SEMBRADOS } from './rutas.ts'

export interface Empresa {
  slug: string
  nombre: string
  iniciales: string
  descripcion: string
  rol: string
  /** Permisos que la empresa habilita. Quien no los tenga por membresía no los ve. */
  permisos: readonly string[]
  /** El contenido de `tenants.features`. */
  funcionalidades: Readonly<Record<string, boolean>>
}

/**
 * Todos los permisos que el mapa conoce. Las empresas de demo los habilitan todos; el
 * recorte real es por membresía de usuario (`sesion/directorio.ts`).
 *
 * En el sistema real, el rol `owner` tiene los 33 sembrados y la migración `0026` agrega
 * los 18 pendientes; la migración los siembra y los asigna a los roles de sistema.
 */
export const TODOS_LOS_PERMISOS = [...PERMISOS_SEMBRADOS, ...PERMISOS_PENDIENTES]

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
    rol: 'Propietario',
    permisos: TODOS_LOS_PERMISOS,
    funcionalidades: { 'logistics.enabled': true },
  },
  {
    slug: 'nordico',
    nombre: 'Nórdico Retail',
    iniciales: 'NR',
    descripcion: 'Retail · 1 salón',
    rol: 'Propietario',
    // Sin logística: la ventana no existe para esta empresa (bandera apagada), y por eso
    // tampoco aparece en el menú ni se puede alcanzar por URL (regla A4).
    permisos: TODOS_LOS_PERMISOS,
    funcionalidades: { 'logistics.enabled': false },
  },
]

export function empresaPorSlug(slug: string): Empresa | undefined {
  return EMPRESAS.find((empresa) => empresa.slug === slug)
}

/** El slug que se usa cuando no hay ninguno en la URL. */
export const EMPRESA_POR_DEFECTO = 'andes'
