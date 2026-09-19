import { NextResponse } from 'next/server'

import { emitirSesion, empresaPorDefecto, establecerCookieSesion, verificarDesafio2FA } from '@/sesion'

/**
 * Segundo paso del ingreso: verifica el código contra el desafío firmado.
 *
 * El desafío sólo prueba que quien lo presenta pasó el primer paso y que no expiró; el código
 * es lo que autentica al factor. En la demo cualquier secuencia de 6 dígitos cuenta —el punto
 * de F2 es el flujo y el aislamiento de la sesión, no un TOTP real—.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { desafio?: unknown; codigo?: unknown }
  if (typeof body.desafio !== 'string' || typeof body.codigo !== 'string') {
    return NextResponse.json({ ok: false, error: 'formato' }, { status: 400 })
  }

  const sub = verificarDesafio2FA(body.desafio)
  if (sub === null) {
    return NextResponse.json({ ok: false, error: 'desafio' }, { status: 401 })
  }
  if (!/^\d{6}$/.test(body.codigo)) {
    return NextResponse.json({ ok: false, error: 'codigo' }, { status: 401 })
  }

  await establecerCookieSesion(emitirSesion(sub))
  const slug = empresaPorDefecto(sub) ?? 'andes'
  return NextResponse.json({ ok: true, redirect: `/e/${slug}/panel` })
}
