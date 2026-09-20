import { esPlataforma } from './directorio.ts'

/**
 * Quién entra a la consola de plataforma.
 *
 * La consola vive en **dominio aparte** y eso no es una convención de nombres: un
 * `owner` de empresa —el rol con todos los permisos de su empresa, el que puede
 * impersonar a su equipo y cambiar la facturación de su cuenta— **no entra**. Son dos
 * niveles de acceso distintos, y confundirlos es la forma más directa de que un cliente
 * vea los datos de otro.
 *
 * El mapa de rutas ya lo expresa: las seis rutas `/plataforma/*` están en
 * `RUTAS_FUERA_DE_CARCASA`, no entre las ventanas, así que no tienen permiso de empresa
 * ni aparecen en el menú. Lo que faltaba era la regla explícita —y su prueba—, porque
 * «está fuera de la carcasa» describe dónde vive, no quién puede entrar.
 *
 * La decisión es una función pura sobre el id del usuario: la resolución de la sesión y
 * del directorio queda afuera, y la prueba puede ejercer el caso del `owner` sin montar
 * una sesión.
 */

export type MotivoDeRechazoDePlataforma = 'sin_sesion' | 'no_es_de_plataforma'

export type ResultadoDeAcceso =
  | { ok: true }
  | { ok: false; motivo: MotivoDeRechazoDePlataforma }

/**
 * Si el usuario puede entrar a la consola de plataforma.
 *
 * Los dos rechazos están separados porque se atienden distinto: sin sesión se manda al
 * ingreso; con sesión pero sin ser de plataforma, a la empresa del usuario. Un solo
 * «no» obligaría a la página a adivinar cuál de las dos cosas pasó.
 */
export function puedeEntrarAPlataforma(usuarioId: string | null): ResultadoDeAcceso {
  if (usuarioId === null) return { ok: false, motivo: 'sin_sesion' }
  if (!esPlataforma(usuarioId)) return { ok: false, motivo: 'no_es_de_plataforma' }
  return { ok: true }
}

/** El prefijo de la consola de plataforma. */
export const PREFIJO_DE_PLATAFORMA = '/plataforma'

/**
 * Si una ruta pertenece a la consola de plataforma.
 *
 * Sirve para la guarda de las páginas y para la prueba de que **ninguna ventana de
 * empresa** vive bajo el prefijo: si una lo hiciera, quedaría fuera de la carcasa y sin
 * permiso, visible para cualquiera que adivine la URL.
 */
export function esRutaDePlataforma(ruta: string): boolean {
  return ruta === PREFIJO_DE_PLATAFORMA || ruta.startsWith(`${PREFIJO_DE_PLATAFORMA}/`)
}
