import { NextResponse } from 'next/server'

import { emitirSesion, empresaPorDefecto, establecerCookieSesion, usuarioPorGoogle } from '@/sesion'

/**
 * Ingreso con Google (simulado).
 *
 * En el backend real, el flujo OIDC termina acá con un token de identidad verificado. En la
 * demo no hay IdP: el botón «Continuar con Google» elige la cuenta de demostración y este
 * handler la resuelve como si hubiera venido firmada por Google. La cookie resultado es
 * idéntica a la de credenciales: el resto de la aplicación no distingue el origen.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { correo?: unknown }
  const correo = typeof body.correo === 'string' ? body.correo : 'ana@control.app'
  const usuario = usuarioPorGoogle(correo)
  if (usuario === undefined) {
    return NextResponse.json({ ok: false, error: 'no-google' }, { status: 401 })
  }

  await establecerCookieSesion(emitirSesion(usuario.id))
  const slug = empresaPorDefecto(usuario.id) ?? 'andes'
  return NextResponse.json({ ok: true, redirect: `/e/${slug}/panel` })
}
