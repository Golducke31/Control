import { NextResponse } from 'next/server'

import {
  emitirSesion,
  empresaPorDefecto,
  establecerCookieSesion,
  establecerContrasena,
  usuarioPorTokenRecuperacion,
} from '@/sesion'

/**
 * Restablece la contraseña con el token de recuperación y abre sesión.
 *
 * El token es de un solo uso en la práctica (el directorio lo guarda en memoria; al reiniciar
 * se pierde). Aquí no lo invalidamos explícitamente porque la demo no persiste, pero el
 * backend sí lo haría tras usarlo.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; contrasena?: unknown }
  if (typeof body.token !== 'string' || typeof body.contrasena !== 'string' || body.contrasena.length < 6) {
    return NextResponse.json({ ok: false, error: 'formato' }, { status: 400 })
  }

  const usuario = usuarioPorTokenRecuperacion(body.token)
  if (usuario === null) {
    return NextResponse.json({ ok: false, error: 'token' }, { status: 401 })
  }

  establecerContrasena(usuario.id, body.contrasena)
  await establecerCookieSesion(emitirSesion(usuario.id))
  const slug = empresaPorDefecto(usuario.id) ?? 'andes'
  return NextResponse.json({ ok: true, redirect: `/e/${slug}/panel` })
}
