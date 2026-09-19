import { NextResponse } from 'next/server'

import { generarTokenRecuperacion } from '@/sesion'

/**
 * Solicitud de recuperación de acceso.
 *
 * En producción el token se envía por correo y nunca vuelve en la respuesta. En la demo se
 * devuelve para poder probar el flujo end-to-end sin un servidor de correo. El resultado
 * `enviado` es `false` tanto si el correo no existe como si existe: no revelamos qué correos
 * están registrados.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { correo?: unknown }
  if (typeof body.correo !== 'string') {
    return NextResponse.json({ ok: false, error: 'formato' }, { status: 400 })
  }

  const token = generarTokenRecuperacion(body.correo)
  if (token === null) {
    return NextResponse.json({ ok: true, enviado: false })
  }
  return NextResponse.json({ ok: true, enviado: true, token })
}
