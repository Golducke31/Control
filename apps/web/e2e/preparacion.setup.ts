import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { expect, test as preparar } from '@playwright/test'

/**
 * Prepara la sesión una sola vez y la deja en disco.
 *
 * El ingreso se hace **por la API, no por el formulario**, por dos razones: la primera es
 * que el flujo de ingreso ya tiene su propia prueba en `flujos.spec.ts`, y repetirlo en cada
 * uno de los veinte recorridos de accesibilidad convertiría el gate en un test del formulario
 * de ingreso; la segunda es que la cookie es `httpOnly` y firmada, así que guardarla en el
 * `storageState` es la única forma de que los demás proyectos empiecen ya adentro.
 *
 * Al final se **navega de verdad** y se comprueba la URL: si la cookie no abriera la ventana,
 * el `storageState` guardaría una sesión inservible y todos los tests siguientes fallarían con
 * un 307 a `/ingresar` en vez de decir que el ingreso no funcionó.
 */

const SESION = 'e2e/.estado/sesion.json'

const CORREO = process.env.CONTROL_CORREO ?? 'ana@control.app'
const CLAVE = process.env.CONTROL_CLAVE ?? 'control123'
const CODIGO_2FA = '123456'

/** El código de la empresa que usan las pruebas. */
export const SLUG = 'andes'

preparar('ingresar como la propietaria y guardar la sesión', async ({ page, request }) => {
  const ingreso = await request.post('/api/auth/ingresar', {
    data: { correo: CORREO, contrasena: CLAVE },
  })
  expect(ingreso.status(), 'el primer paso del ingreso').toBe(200)
  const primero = (await ingreso.json()) as { ok: boolean; dosFactores?: boolean; desafio?: string }
  expect(primero.ok).toBe(true)
  expect(primero.dosFactores, 'la propietaria tiene dos factores configurados').toBe(true)

  const segundo = await request.post('/api/auth/verificar-2fa', {
    data: { desafio: primero.desafio, codigo: CODIGO_2FA },
  })
  expect(segundo.status(), 'el segundo paso del ingreso').toBe(200)
  expect((await segundo.json()) as { ok: boolean }).toMatchObject({ ok: true })

  /**
   * La cookie se traslada al navegador **a mano**, y no es un rodeo innecesario.
   *
   * El fixture `request` es un cliente HTTP propio: en esta versión de Playwright **no
   * comparte el almacén de cookies con el contexto del navegador**. Sin esta línea, el
   * ingreso por API devuelve 200, la cookie queda guardada en el cliente de API, y el
   * `page.goto` siguiente llega sin sesión y termina en `/ingresar` — con un mensaje que
   * habla de una URL inesperada y no del motivo.
   */
  await page.context().addCookies((await request.storageState()).cookies)

  // La comprobación que importa: que la cookie abra una ventana de verdad.
  await page.goto(`/e/${SLUG}/panel`)
  await expect(page).toHaveURL(new RegExp(`/e/${SLUG}/panel$`))

  mkdirSync(dirname(SESION), { recursive: true })
  await page.context().storageState({ path: SESION })
})
