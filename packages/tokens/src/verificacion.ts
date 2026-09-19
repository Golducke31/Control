/**
 * Verificación de contraste de los roles.
 *
 * El sistema no declara que sus combinaciones son legibles: lo mide. Esta es la
 * lista de pares que la aplicación realmente usa —texto sobre tarjeta, texto sobre
 * el lienzo, tinta sobre el botón, bordes de control, estados— y el nivel que cada
 * uno tiene que alcanzar.
 *
 * La suite corre esto sobre los dos temas. Y para que la verificación no sea
 * decorativa, también la corre sobre una tabla de roles deliberadamente rota y
 * exige que la detecte.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.5.
 */

import type { Exigencia, Nivel } from './contraste.ts'
import { contraste, nivelDe } from './contraste.ts'
import type { NombreDeSemantico } from './escalas.ts'
import { SEMANTICOS } from './escalas.ts'
import type { Rol } from './roles.ts'

export interface ParVerificado {
  descripcion: string
  frente: Rol
  fondo: Rol
  exigido: Exigencia
}

const SEMANTICOS_NOMBRES = Object.keys(SEMANTICOS) as NombreDeSemantico[]

/**
 * Los pares que la interfaz usa, con el mínimo que les corresponde.
 *
 * `AA-texto-grande` (3:1) no es un permiso para aflojar: es el umbral que la
 * recomendación fija para los límites de control y para el texto de titular. Los
 * bordes de un campo y los iconos de estado caen ahí, y por eso aparecen con ese
 * nivel y no con AA.
 */
export const PARES: readonly ParVerificado[] = [
  // Texto sobre la tarjeta: el caso más frecuente de la aplicación.
  { descripcion: 'texto principal sobre tarjeta', frente: 'texto-principal', fondo: 'fondo-tarjeta', exigido: 'AA' },
  { descripcion: 'texto secundario sobre tarjeta', frente: 'texto-secundario', fondo: 'fondo-tarjeta', exigido: 'AA' },
  { descripcion: 'texto terciario sobre tarjeta', frente: 'texto-terciario', fondo: 'fondo-tarjeta', exigido: 'AA' },

  // Texto sobre el lienzo del área de trabajo.
  { descripcion: 'texto principal sobre lienzo', frente: 'texto-principal', fondo: 'fondo-lienzo', exigido: 'AA' },
  { descripcion: 'texto secundario sobre lienzo', frente: 'texto-secundario', fondo: 'fondo-lienzo', exigido: 'AA' },
  { descripcion: 'texto terciario sobre lienzo', frente: 'texto-terciario', fondo: 'fondo-lienzo', exigido: 'AA' },

  // Texto sobre la cebra de tabla.
  { descripcion: 'texto principal sobre fondo sutil', frente: 'texto-principal', fondo: 'fondo-sutil', exigido: 'AA' },
  { descripcion: 'texto secundario sobre fondo sutil', frente: 'texto-secundario', fondo: 'fondo-sutil', exigido: 'AA' },

  // La carcasa, en reposo y en su estado activo.
  { descripcion: 'texto de navegación sobre la carcasa', frente: 'texto-sobre-carcasa', fondo: 'fondo-carcasa', exigido: 'AA' },
  { descripcion: 'texto de navegación sobre el ítem activo', frente: 'texto-sobre-carcasa', fondo: 'fondo-carcasa-sutil', exigido: 'AA' },
  { descripcion: 'texto de navegación en reposo', frente: 'texto-sobre-carcasa-sutil', fondo: 'fondo-carcasa', exigido: 'AA' },
  { descripcion: 'texto de navegación en reposo sobre el ítem activo', frente: 'texto-sobre-carcasa-sutil', fondo: 'fondo-carcasa-sutil', exigido: 'AA' },
  { descripcion: 'barra de acento sobre la carcasa', frente: 'fondo-accion', fondo: 'fondo-carcasa', exigido: 'AA-texto-grande' },

  // El botón primario y el bloque invertido.
  { descripcion: 'tinta del botón primario', frente: 'texto-sobre-accion', fondo: 'fondo-accion', exigido: 'AA' },
  { descripcion: 'tinta del botón de peligro', frente: 'texto-sobre-peligro', fondo: 'estado-peligro-tinta', exigido: 'AA' },
  { descripcion: 'texto sobre el bloque invertido', frente: 'texto-sobre-invertido', fondo: 'fondo-invertido', exigido: 'AAA' },

  // El acento como texto: dos superficies distintas, dos mínimos distintos.
  { descripcion: 'acento como texto sobre tarjeta', frente: 'texto-acento', fondo: 'fondo-tarjeta', exigido: 'AA' },
  { descripcion: 'acento como texto sobre lienzo', frente: 'texto-acento', fondo: 'fondo-lienzo', exigido: 'AA' },

  // Límites de control (WCAG 1.4.11).
  { descripcion: 'borde de campo sobre tarjeta', frente: 'borde-control', fondo: 'fondo-tarjeta', exigido: 'AA-texto-grande' },
  { descripcion: 'borde de campo sobre lienzo', frente: 'borde-control', fondo: 'fondo-lienzo', exigido: 'AA-texto-grande' },
  { descripcion: 'anillo de foco sobre tarjeta', frente: 'foco', fondo: 'fondo-tarjeta', exigido: 'AA-texto-grande' },
  { descripcion: 'anillo de foco sobre lienzo', frente: 'foco', fondo: 'fondo-lienzo', exigido: 'AA-texto-grande' },

  // Estados. El rol que se usa sobre una superficie clara es siempre la TINTA, no
  // la base: medido, el verde de éxito sobre blanco da 2,24:1, el ámbar 1,86:1 y
  // el azul 2,85:1 —ninguno llega a 3:1—. Los colores base están pensados para
  // fondos oscuros, y en el tema oscuro la tinta ES la base, así que el mismo par
  // se verifica bien en los dos temas.
  ...SEMANTICOS_NOMBRES.flatMap((nombre): ParVerificado[] => [
    {
      descripcion: `tinta de ${nombre} sobre su fondo suave`,
      frente: `estado-${nombre}-tinta`,
      fondo: `estado-${nombre}-suave`,
      exigido: 'AA',
    },
    {
      descripcion: `tinta de ${nombre} sobre tarjeta`,
      frente: `estado-${nombre}-tinta`,
      fondo: 'fondo-tarjeta',
      exigido: 'AA-texto-grande',
    },
    {
      descripcion: `tinta de ${nombre} sobre lienzo`,
      frente: `estado-${nombre}-tinta`,
      fondo: 'fondo-lienzo',
      exigido: 'AA-texto-grande',
    },
    {
      descripcion: `icono de ${nombre} sobre la carcasa`,
      frente: `estado-${nombre}`,
      fondo: 'fondo-carcasa',
      exigido: 'AA-texto-grande',
    },
  ]),
]

export interface Violacion {
  descripcion: string
  frente: string
  fondo: string
  relacion: number
  alcanzado: Nivel
  exigido: Exigencia
}

/**
 * Devuelve los pares que no alcanzan su mínimo.
 *
 * Lista vacía significa conforme. Devuelve la lista completa en vez de cortar en el
 * primero: al ajustar una paleta conviene ver todos los problemas de una vez.
 */
export function verificarRoles(
  roles: Record<string, string>,
  pares: readonly ParVerificado[] = PARES,
): Violacion[] {
  const violaciones: Violacion[] = []

  for (const par of pares) {
    const frente = roles[par.frente]
    const fondo = roles[par.fondo]

    if (frente === undefined || fondo === undefined) {
      throw new Error(
        `El par «${par.descripcion}» referencia un rol inexistente ` +
          `(frente: «${par.frente}», fondo: «${par.fondo}»).`,
      )
    }

    const relacion = contraste(frente, fondo)
    const alcanzado = nivelDe(relacion)
    const orden: Record<Nivel, number> = { AAA: 3, AA: 2, 'AA-texto-grande': 1, 'no-cumple': 0 }

    if (orden[alcanzado] < orden[par.exigido]) {
      violaciones.push({
        descripcion: par.descripcion,
        frente,
        fondo,
        relacion,
        alcanzado,
        exigido: par.exigido,
      })
    }
  }

  return violaciones
}

/** Formatea una violación para que el mensaje del test sirva para arreglarla. */
export function describirViolacion(v: Violacion): string {
  return (
    `${v.descripcion}: ${v.frente} sobre ${v.fondo} = ${v.relacion.toFixed(2)}:1 ` +
    `(alcanza ${v.alcanzado}, se exige ${v.exigido})`
  )
}
