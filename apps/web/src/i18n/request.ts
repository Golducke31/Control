import { getRequestConfig } from 'next-intl/server'

/**
 * Configuración de mensajes de la aplicación.
 *
 * **Un solo idioma y sin enrutado por locale.** No hay `/es/…` ni `/en/…`: el producto se
 * vende en Argentina y una segunda URL por idioma sería una decisión de producto, no de
 * infraestructura. Lo que sí aporta tener `next-intl` desde el principio es que **las
 * cadenas de interfaz dejen de estar dentro de los componentes** — se pueden revisar en un
 * solo archivo, y el lint (`verify:textos`) puede exigirlo.
 *
 * El idioma se declara acá y no se negocia por cabecera: si algún día hay una segunda
 * lengua, el lugar donde se decide es este archivo, y el enrutado se agrega alrededor.
 */
export const IDIOMA = 'es-AR'

export default getRequestConfig(async () => ({
  locale: IDIOMA,
  messages: (await import('../../messages/es.json')).default,
}))
