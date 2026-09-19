/**
 * Tipos del dominio de identidad.
 *
 * Son los que produce y consume la capa de sesión. La forma de `Sesion` es la que
 * viaja firmada dentro de la cookie `httpOnly`: el cliente nunca la ve, y el servidor
 * la verifica en cada request. `ContextoEmpresa` es lo que la carcasa necesita para
 * pintar el menú, el selector y la banda de impersonación.
 */

import type { Empresa } from '../empresa.ts'

/** Un usuario del directorio simulado de F2. */
export interface Usuario {
  id: string
  nombre: string
  iniciales: string
  correo: string
  /** Contraseña del directorio simulado. Sólo demostración: el real vive en el backend. */
  contrasena?: string
  /** Si puede ingresar con el botón «Continuar con Google» (simulado). */
  google: boolean
  /** Si debe pasar por verificación en dos pasos tras las credenciales. */
  dosFactores: boolean
  /** Si pertenece a la plataforma y puede impersonar a cualquiera. */
  plataforma: boolean
}

/** La relación de un usuario con una empresa: su rol y los permisos que tiene ahí. */
export interface Membresia {
  usuarioId: string
  empresaSlug: string
  rol: string
  permisos: readonly string[]
}

/**
 * El contenido firmado de la cookie de sesión.
 *
 * `sub` es siempre el usuario real. `imp` sólo aparece durante una impersonación y
 * apunta al usuario objetivo. El servidor resuelve siempre desde `slug` de la URL,
 * nunca desde acá: la empresa activa no vive en la cookie.
 */
export interface Sesion {
  sub: string
  imp?: string
  iat: number
  exp: number
}

/** Lo que la carcasa necesita para pintarse para un (usuario, empresa). */
export interface ContextoEmpresa {
  empresa: Empresa
  /** Permisos efectivos: los del usuario filtrados por los que la empresa habilita. */
  permisos: readonly string[]
  funcionalidades: Readonly<Record<string, boolean>>
  usuario: { id: string; nombre: string; iniciales: string }
  /** Las empresas de las que el usuario es miembro, para el selector. */
  empresas: readonly Empresa[]
  /** Presente sólo durante una impersonación. */
  impersonacion: { por: string; exp: number } | null
}
