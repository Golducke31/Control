import { NextResponse } from 'next/server'

import {
  aceptarInvitacion,
  emitirSesion,
  empresaPorDefecto,
  establecerCookieSesion,
} from '@/sesion'

/**
 * Acepta una invitación: crea el usuario, su membresía y abre sesión.
 *
 * El token de invitación prueba que quien lo presenta fue invitado a esa empresa; al aceptar,
 * se convierte en miembro y entra con su propia sesión. El resto de la app no sabe que entró
 * por invitación: para ella es un ingreso más.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown
    nombre?: unknown
    contrasena?: unknown
  }
  if (
    typeof body.token !== 'string' ||
    typeof body.nombre !== 'string' ||
    typeof body.contrasena !== 'string' ||
    body.contrasena.length < 6
  ) {
    return NextResponse.json({ ok: false, error: 'formato' }, { status: 400 })
  }

  const usuario = aceptarInvitacion(body.token, body.nombre, body.contrasena)
  if (usuario === null) {
    return NextResponse.json({ ok: false, error: 'token' }, { status: 401 })
  }

  await establecerCookieSesion(emitirSesion(usuario.id))
  const slug = empresaPorDefecto(usuario.id) ?? 'andes'
  return NextResponse.json({ ok: true, redirect: `/e/${slug}/panel` })
}
