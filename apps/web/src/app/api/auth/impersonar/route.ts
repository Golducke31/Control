import { NextResponse } from 'next/server'

import {
  emitirSesion,
  empresaPorDefecto,
  esPlataforma,
  establecerCookieSesion,
  primerMiembro,
  sesionActual,
} from '@/sesion'

/**
 * Impersonación (sólo plataforma).
 *
 * `detener=1` vuelve a la sesión real (sin `imp`). Con `slug`, un usuario de plataforma
 * actúa como el primer miembro de esa empresa: la cookie queda con `imp` apuntando a él y la
 * carcasa muestra la banda. El objetivo nunca puede ser otro usuario de plataforma, y quien
 * no es plataforma recibe 403.
 */
export async function POST(req: Request) {
  const sesion = await sesionActual()
  if (sesion === null) {
    return NextResponse.json({ ok: false, error: 'sin-sesion' }, { status: 401 })
  }

  const body = await leerCuerpo(req)

  if (body.detener === true || body.detener === '1') {
    await establecerCookieSesion(emitirSesion(sesion.sub))
    return NextResponse.json({ ok: true, redirect: '/empresas' })
  }

  if (typeof body.slug !== 'string' || !esPlataforma(sesion.sub)) {
    return NextResponse.json({ ok: false, error: 'prohibido' }, { status: 403 })
  }

  const objetivo = primerMiembro(body.slug)
  if (objetivo === null) {
    return NextResponse.json({ ok: false, error: 'empresa' }, { status: 404 })
  }

  await establecerCookieSesion(emitirSesion(sesion.sub, objetivo))
  return NextResponse.json({ ok: true, redirect: `/e/${body.slug}/panel` })
}

/**
 * Acepta tanto JSON como datos de formulario (el banner y el selector usan forms nativos).
 */
async function leerCuerpo(req: Request): Promise<{ detener?: unknown; slug?: unknown }> {
  const tipo = req.headers.get('content-type') ?? ''
  if (tipo.includes('application/json')) {
    return (await req.json().catch(() => ({}))) as { detener?: unknown; slug?: unknown }
  }
  const fd = await req.formData().catch(() => null)
  if (fd === null) return {}
  return { detener: fd.get('detener') ?? undefined, slug: fd.get('slug') ?? undefined }
}
