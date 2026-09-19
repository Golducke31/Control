/**
 * Sobre de firma HMAC para la cookie de sesión.
 *
 * La cookie no es un JWT: es `valor.firma`, donde `firma = HMAC-SHA256(valor)`. Dos
 * propiedades importan para el plan:
 *
 * 1. **El cliente no puede forjarla.** Sin la clave (`SESSION_SECRET`), no hay forma de
 *    producir una firma válida. Si alguien cambia el `valor` (p. ej. `sub` por otro
 *    usuario), la firma no cuadra y `verificarToken` devuelve `null`.
 * 2. **El cliente nunca la lee.** La cookie es `httpOnly`, así que el JavaScript de la
 *    página no accede a ella; el único que la abre es el servidor, que además verifica.
 *
 * Es un módulo puro (sin `next/`), así que la suite lo prueba directamente: falsificar
 * la firma, recortarla o pegar la de otro valor tienen que dar `null`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Nombre de la cookie de sesión. */
export const SESSION_COOKIE = 'control_sesion'

const SEPARADOR = '.'

function claveSecreta(): string {
  // En producción viene del entorno. El valor por defecto sólo sirve para
  // demostración local y queda claramente marcado como tal.
  return process.env.SESSION_SECRET ?? 'secreto-de-desarrollo-control-no-para-produccion'
}

function firmar(texto: string): string {
  return createHmac('sha256', claveSecreta()).update(texto).digest('base64url')
}

/** Envuelve un valor con su firma: `valor.firma`. */
export function emitirToken(valor: string): string {
  return `${valor}${SEPARADOR}${firmar(valor)}`
}

/**
 * Verifica la firma y devuelve el valor si es válido, o `null` si la firma no cuadra,
 * si el formato es incorrecto, o si fue manipulado.
 *
 * La comparación es resistente a ataques de temporización (`timingSafeEqual`); por eso
 * se trabaja con `Buffer` y no con strings directos.
 */
export function verificarToken(token: string): string | null {
  const posicion = token.lastIndexOf(SEPARADOR)
  if (posicion < 0) return null

  const valor = token.slice(0, posicion)
  const firmaRecibida = token.slice(posicion + 1)

  const firmaEsperada = firmar(valor)
  const a = Buffer.from(firmaRecibida)
  const b = Buffer.from(firmaEsperada)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  return valor
}
