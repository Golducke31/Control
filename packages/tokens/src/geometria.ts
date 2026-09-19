/**
 * Geometría: espaciado, radios, elevación, movimiento y medidas de la carcasa.
 *
 * Documentación: `docs/PLAN-FRONTEND-PRODUCCION.md` §3.7.
 */

/** Espaciado sobre una base de 4px. */
export const ESPACIADO = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const

export const RADIOS = {
  sm: 8,
  /** El radio por defecto de tarjetas y controles. */
  normal: 12,
  lg: 18,
  full: 999,
} as const

/**
 * Elevación.
 *
 * La sombra se tiñe de violeta y no de negro: sobre superficies claras una sombra
 * negra se lee como suciedad. El color base es `#261A66`.
 */
export const SOMBRAS = {
  claro: {
    sm: '0 1px 2px rgba(38, 26, 102, 0.06)',
    normal: '0 2px 8px rgba(38, 26, 102, 0.08)',
    lg: '0 8px 24px rgba(38, 26, 102, 0.12)',
  },
  oscuro: {
    // En el tema oscuro la sombra no puede separar nada: sobre un lienzo casi
    // negro no hay margen. Ahí el separador es el borde, y la sombra sólo aporta
    // profundidad cuando hay algo debajo que iluminar.
    sm: '0 1px 2px rgba(0, 0, 0, 0.4)',
    normal: '0 2px 8px rgba(0, 0, 0, 0.5)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.6)',
  },
} as const

/**
 * Movimiento.
 *
 * Reglas: ninguna transición supera 320ms, todo respeta `prefers-reduced-motion`
 * de forma global, y no se anima nada que el usuario esté leyendo.
 */
export const MOVIMIENTO = {
  rapida: 120,
  normal: 200,
  lenta: 320,
  curva: 'cubic-bezier(0.2, 0, 0, 1)',
  /** El barrido del esqueleto de carga. */
  barridoEsqueleto: 1200,
} as const

export const LAYOUT = {
  anchoCarcasa: 248,
  anchoCarcasaColapsada: 64,
  altoEncabezado: 60,
  anchoMaxContenido: 1600,
  /** Alto mínimo de un objetivo táctil, para pantallas chicas. */
  objetivoTactil: 44,
} as const

/**
 * Densidad por inquilino.
 *
 * Es un multiplicador y no dos juegos de componentes: los rubros de logística y
 * distribución necesitan ver más filas por pantalla, y el retail prefiere el aire.
 */
export const DENSIDAD = {
  compacta: 0.85,
  comoda: 1,
} as const

export type NombreDeDensidad = keyof typeof DENSIDAD

/** Alto de fila y de control, derivados de la densidad. */
export const ALTO = {
  fila: 44,
  control: 38,
  /** Filas por página antes de exigir paginación o virtualización (regla A9). */
  filasSinPaginacion: 60,
} as const
