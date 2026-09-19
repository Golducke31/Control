/**
 * Resolución de sesión en el servidor.
 *
 * Todo ocurre **en el servidor**, nunca en el cliente: el navegador sólo guarda la cookie
 * `httpOnly` firmada y la envía; el servidor la abre, verifica la firma, la expiración y
 * la membresía antes de renderizar. El cliente no decide a qué empresa entra ni qué puede
 * ver — por eso una empresa que no es tuya da 404, no una pantalla vacía.
 *
 * Estas funciones son puras (no importan `next/`) para que la suite las pruebe con un
 * valor de cookie cualquiera, sin montar un request. Quién lee la cookie de `next/headers`
 * es el layout, y le pasa el string a `leerSesion`.
 */

import { empresaPorSlug } from '../empresa.ts'
import {
  empresasDelUsuario,
  membresia,
  usuarioPorId,
} from './directorio.ts'
import { emitirToken, verificarToken } from './firma.ts'
import type { ContextoEmpresa, Sesion } from './tipos.ts'

const DURACION_SESION_SEG = 60 * 60 * 8

/** Construye el valor de cookie firmado para un usuario (y opcionalmente, impersonación). */
export function emitirSesion(usuarioId: string, impersonadoPor?: string): string {
  const ahora = Math.floor(Date.now() / 1000)
  const payload: Sesion = {
    sub: usuarioId,
    ...(impersonadoPor !== undefined ? { imp: impersonadoPor } : {}),
    iat: ahora,
    exp: ahora + DURACION_SESION_SEG,
  }
  return emitirToken(JSON.stringify(payload))
}

/**
 * Abre y verifica la cookie de sesión.
 *
 * Devuelve `null` si no hay cookie, si la firma no cuadra (manipulada), si el JSON no
 * se parsea, si falta `sub`, o si expiró. Ninguno de esos casos es un error: es «sin
 * sesión», y el llamador redirige al ingreso.
 */
export function leerSesion(cookie: string | undefined): Sesion | null {
  if (cookie === undefined) return null
  const json = verificarToken(cookie)
  if (json === null) return null

  let payload: Sesion
  try {
    payload = JSON.parse(json) as Sesion
  } catch {
    return null
  }

  if (typeof payload.sub !== 'string') return null
  if (typeof payload.exp !== 'number') return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null

  return payload
}

export type ResultadoContexto =
  | { ok: true; contexto: ContextoEmpresa }
  | { ok: false; motivo: 'sin-membresia' }

/**
 * Resuelve el contexto de una empresa para una sesión dada.
 *
 * El sujeto es `imp` si se está impersonando, sino `sub`. Si el sujeto no existe o no es
 * miembro de `slug`, el resultado es `sin-membresia` —el layout lo traduce a 404—. Los
 * permisos efectivos son los del usuario filtrados por los que la empresa habilita.
 */
export function resolverContexto(sesion: Sesion, slug: string): ResultadoContexto {
  const objetivoId = sesion.imp ?? sesion.sub
  const usuario = usuarioPorId(objetivoId)
  if (usuario === undefined) return { ok: false, motivo: 'sin-membresia' }

  const membresiaResuelta = membresia(objetivoId, slug)
  if (membresiaResuelta === undefined) return { ok: false, motivo: 'sin-membresia' }

  const empresa = empresaPorSlug(slug)
  if (empresa === undefined) return { ok: false, motivo: 'sin-membresia' }

  const permisos = membresiaResuelta.permisos.filter((p) => empresa.permisos.includes(p))
  const empresas = empresasDelUsuario(objetivoId)
  const impersonacion = sesion.imp
    ? {
        por: usuarioPorId(sesion.sub)?.nombre ?? sesion.sub,
        exp: sesion.exp,
      }
    : null

  return {
    ok: true,
    contexto: {
      empresa,
      permisos,
      funcionalidades: empresa.funcionalidades,
      usuario: { id: usuario.id, nombre: usuario.nombre, iniciales: usuario.iniciales },
      empresas,
      impersonacion,
    },
  }
}

/**
 * Desafío de dos factores: un token firmado y de corta vida que autoriza a completar el
 * ingreso tras las credenciales. No es una sesión: no abre la aplicación, sólo habilita el
 * segundo paso. Si el código no se verifica en 5 minutos, expira.
 */
export function emitirDesafio2FA(usuarioId: string): string {
  const ahora = Math.floor(Date.now() / 1000)
  return emitirToken(JSON.stringify({ sub: usuarioId, t: '2fa', exp: ahora + 300 }))
}

/** Verifica el desafío y devuelve el id de usuario, o `null` si es inválido o expiró. */
export function verificarDesafio2FA(token: string): string | null {
  const json = verificarToken(token)
  if (json === null) return null

  let payload: { sub: string; t: string; exp: number }
  try {
    payload = JSON.parse(json) as { sub: string; t: string; exp: number }
  } catch {
    return null
  }

  if (payload.t !== '2fa') return null
  if (typeof payload.sub !== 'string') return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null

  return payload.sub
}
