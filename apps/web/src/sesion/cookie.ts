/**
 * Acceso a la cookie de sesión desde el servidor.
 *
 * Capa delgada sobre `next/headers` para no esparcir `cookies()` por todos lados. Sólo
 * se usa en el servidor (layout, páginas, manejadores de ruta); el cliente nunca toca esto.
 */

import { cookies } from 'next/headers'

import { SESSION_COOKIE } from './firma.ts'
import { leerSesion } from './servidor.ts'
import type { Sesion } from './tipos.ts'

/** Lee y verifica la sesión del request actual. `null` si no hay o es inválida. */
export async function sesionActual(): Promise<Sesion | null> {
  const store = await cookies()
  return leerSesion(store.get(SESSION_COOKIE)?.value)
}

/** Escribe la cookie de sesión firmada. `httpOnly`, `SameSite=Lax`; `Secure` en producción. */
export async function establecerCookieSesion(valor: string): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, valor, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  })
}

/** Borra la cookie de sesión (cierre de sesión). */
export async function borrarCookieSesion(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}
