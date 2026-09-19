import { NextResponse } from 'next/server'

import { borrarCookieSesion } from '@/sesion'

/** Cierre de sesión: borra la cookie firmada. El cliente navega al ingreso. */
export async function POST() {
  await borrarCookieSesion()
  return NextResponse.json({ ok: true, redirect: '/ingresar' })
}
