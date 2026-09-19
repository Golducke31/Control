/**
 * Directorio simulado de identidad.
 *
 * **Esto es lo que reemplaza el backend en F2.** En F9, `leerSesion` y `resolverContexto`
 * seguirán existiendo con la misma firma; lo que cambia es de dónde vienen estos datos:
 * de la base y de la respuesta de `GET /empresas/:slug`, no de este objeto en memoria.
 *
 * La forma de `Usuario`, `Membresia` y `Empresa` es la que tendrá la respuesta real, así
 * que los componentes no cambian cuando llegue el backend: cambia de dónde se leen.
 *
 * Las contraseñas viven en texto plano **sólo porque no hay backend**: jamás se haría así
 * en producción. Los tokens de recuperación e invitación se guardan en memoria y se pierden
 * al reiniciar el servidor —suficiente para demostrar el flujo—.
 */

import { EMPRESAS, TODOS_LOS_PERMISOS, empresaPorSlug } from '../empresa.ts'
import type { Empresa } from '../empresa.ts'
import type { Membresia, Usuario } from './tipos.ts'

const USUARIOS: Usuario[] = [
  {
    id: 'u_ana',
    nombre: 'Ana Ortega',
    iniciales: 'AO',
    correo: 'ana@control.app',
    contrasena: 'control123',
    google: true,
    dosFactores: true,
    plataforma: false,
  },
  {
    id: 'u_beto',
    nombre: 'Beto Ramírez',
    iniciales: 'BR',
    correo: 'beto@control.app',
    contrasena: 'control123',
    google: true,
    dosFactores: false,
    plataforma: false,
  },
  {
    id: 'u_carla',
    nombre: 'Carla Núñez',
    iniciales: 'CN',
    correo: 'carla@control.app',
    // Sin contraseña local: sólo ingresa por la consola de plataforma (impersonación).
    google: true,
    dosFactores: false,
    plataforma: true,
  },
]

const MEMBRESIAS: Membresia[] = [
  { usuarioId: 'u_ana', empresaSlug: 'andes', rol: 'Propietario', permisos: TODOS_LOS_PERMISOS },
  { usuarioId: 'u_ana', empresaSlug: 'pampa', rol: 'Propietario', permisos: TODOS_LOS_PERMISOS },
  { usuarioId: 'u_ana', empresaSlug: 'nordico', rol: 'Propietario', permisos: TODOS_LOS_PERMISOS },
  {
    // Un encargado de depósito: pocos permisos a propósito, para que el filtrado por
    // usuario sea observable y no una lista estática. Es la única membresía de Beto.
    usuarioId: 'u_beto',
    empresaSlug: 'pampa',
    rol: 'Encargado de depósito',
    permisos: [
      'inventory.read',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.warehouses',
      'catalog.read',
      'logistics.read',
    ],
  },
]

/** token de recuperación → id de usuario. En memoria; se pierde al reiniciar. */
const TOKENS_RECUPERACION = new Map<string, string>()

/** token de invitación → datos pendientes. Sembrado con una invitación de demostración. */
const INVITACIONES = new Map<string, { correo: string; empresaSlug: string; rol: string; permisos: string[] }>()
INVITACIONES.set('inv-atiende', {
  correo: 'diego@control.app',
  empresaSlug: 'pampa',
  rol: 'Atención',
  permisos: ['sales.read', 'sales.write', 'customers.read', 'catalog.read'],
})

export function usuarioPorId(id: string): Usuario | undefined {
  return USUARIOS.find((u) => u.id === id)
}

export function usuarioPorCorreo(correo: string): Usuario | undefined {
  const normalizado = correo.trim().toLowerCase()
  return USUARIOS.find((u) => u.correo.toLowerCase() === normalizado)
}

export function usuarioPorGoogle(correo: string): Usuario | undefined {
  const usuario = usuarioPorCorreo(correo)
  return usuario?.google === true ? usuario : undefined
}

/** Si el usuario pertenece a la plataforma y puede impersonar. */
export function esPlataforma(usuarioId: string): boolean {
  return usuarioPorId(usuarioId)?.plataforma === true
}

/** El primer miembro de una empresa: el objetivo por defecto al impersonar. */
export function primerMiembro(slug: string): string | null {
  return MEMBRESIAS.find((m) => m.empresaSlug === slug)?.usuarioId ?? null
}

export function membresia(usuarioId: string, slug: string): Membresia | undefined {
  return MEMBRESIAS.find((m) => m.usuarioId === usuarioId && m.empresaSlug === slug)
}

/**
 * Valida credenciales. Devuelve el usuario si coinciden, o `null`.
 *
 * No revela si el correo existe: en ambos casos (correo ausente y contraseña mala)
 * devuelve `null`. Quién arma el mensaje de error es la página, no esta función.
 */
export function validarCredenciales(correo: string, contrasena: string): Usuario | null {
  const usuario = usuarioPorCorreo(correo)
  if (usuario === undefined || usuario.contrasena === undefined) return null
  if (usuario.contrasena !== contrasena) return null
  return usuario
}

/** La primera empresa del usuario, para redirigir tras el ingreso. */
export function empresaPorDefecto(usuarioId: string): string | null {
  return MEMBRESIAS.find((m) => m.usuarioId === usuarioId)?.empresaSlug ?? null
}

/** Las empresas de las que el usuario es miembro, como `Empresa[]` para el selector. */
export function empresasDelUsuario(usuarioId: string): Empresa[] {
  const slugs = new Set(MEMBRESIAS.filter((m) => m.usuarioId === usuarioId).map((m) => m.empresaSlug))
  return EMPRESAS.filter((e) => slugs.has(e.slug))
}

/** Emite un token de recuperación para un correo existente. */
export function generarTokenRecuperacion(correo: string): string | null {
  const usuario = usuarioPorCorreo(correo)
  if (usuario === undefined) return null
  const token = `rec-${usuario.id}-${Math.random().toString(36).slice(2, 10)}`
  TOKENS_RECUPERACION.set(token, usuario.id)
  return token
}

export function usuarioPorTokenRecuperacion(token: string): Usuario | null {
  const id = TOKENS_RECUPERACION.get(token)
  if (id === undefined) return null
  return usuarioPorId(id) ?? null
}

export function establecerContrasena(usuarioId: string, contrasena: string): void {
  const usuario = usuarioPorId(usuarioId)
  if (usuario !== undefined) usuario.contrasena = contrasena
}

export function invitacionPorToken(token: string) {
  return INVITACIONES.get(token)
}

/** Acepta una invitación: crea el usuario y su membresía, y consume el token. */
export function aceptarInvitacion(token: string, nombre: string, contrasena: string): Usuario | null {
  const invitacion = INVITACIONES.get(token)
  if (invitacion === undefined) return null
  if (empresaPorSlug(invitacion.empresaSlug) === undefined) return null

  const id = `u_${invitacion.correo.split('@')[0]}`
  const usuario: Usuario = {
    id,
    nombre,
    iniciales: inicialesDe(nombre),
    correo: invitacion.correo,
    contrasena,
    google: false,
    dosFactores: false,
    plataforma: false,
  }
  USUARIOS.push(usuario)
  MEMBRESIAS.push({
    usuarioId: id,
    empresaSlug: invitacion.empresaSlug,
    rol: invitacion.rol,
    permisos: invitacion.permisos,
  })
  INVITACIONES.delete(token)
  return usuario
}

function inicialesDe(nombre: string): string {
  return nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}
