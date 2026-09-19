import { NextResponse } from 'next/server'

import {
  emitirDesafio2FA,
  emitirSesion,
  empresaPorDefecto,
  establecerCookieSesion,
  validarCredenciales,
} from '@/sesion'

/**
 * Ingreso con credenciales.
 *
 * Valida contra el directorio simulado. Si el usuario usa dos factores, no abre la sesión:
 * devuelve un desafío firmado de corta vida que el cliente cambia por la sesión en
 * `/api/auth/verificar-2fa`. El cliente nunca ve la cookie: la firma y la escritura ocurren
 * en el servidor.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { correo?: unknown; contrasena?: unknown }
  if (typeof body.correo !== 'string' || typeof body.contrasena !== 'string') {
    return NextResponse.json({ ok: false, error: 'formato' }, { status: 400 })
  }

  const usuario = validarCredenciales(body.correo, body.contrasena)
  if (usuario === null) {
    return NextResponse.json({ ok: false, error: 'credenciales' }, { status: 401 })
  }

  if (usuario.dosFactores) {
    return NextResponse.json({ ok: true, dosFactores: true, desafio: emitirDesafio2FA(usuario.id) })
  }

  await establecerCookieSesion(emitirSesion(usuario.id))
  const slug = empresaPorDefecto(usuario.id) ?? 'andes'
  return NextResponse.json({ ok: true, redirect: `/e/${slug}/panel` })
}
