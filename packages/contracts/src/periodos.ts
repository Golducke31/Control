import type { Periodo } from './contabilidad.ts'

/**
 * Lógica pura de períodos contables, espejo de `accounting.assert_period_open()`
 * y de la resolución de período de `accounting.post_entry()`.
 *
 * Es lógica **de dominio**, no de presentación: vive en `packages/contracts` y no en
 * un componente porque la regla de la puerta de F6 —«el cierre de período se ve
 * reflejado»— tiene que poder probarse sin renderizar nada, igual que las de F4 y F5.
 *
 * Las fechas se comparan como texto. Funciona porque el contrato las declara ISO
 * (`YYYY-MM-DD`) y en ese formato el orden lexicográfico es el orden cronológico; si
 * alguna vez llega una fecha con hora o con otro formato, esta comparación miente.
 */

/** Las fechas del contrato son ISO sin hora: en ese formato el texto ordena como la fecha. */
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * ¿El período acepta asientos?
 *
 * `closing` **sí** acepta. Es el estado en el que se cargan los ajustes de cierre,
 * que por definición ocurren después del último asiento del mes: tratarlo como
 * cerrado haría imposible cerrar. El motor lo dice con la misma claridad —
 * `assert_period_open()` sólo rechaza `closed`— y su comentario explica por qué.
 */
export function admiteAsientos(periodo: Periodo): boolean {
  return periodo.estado !== 'closed'
}

/** Los períodos cuyo rango contiene la fecha. Puede haber más de uno si se solapan. */
export function periodosQueContienen(periodos: readonly Periodo[], fecha: string): Periodo[] {
  return periodos.filter((periodo) => periodo.desde <= fecha && periodo.hasta >= fecha)
}

export type ResultadoImputacion =
  | { ok: true; periodo: Periodo }
  | { ok: false; motivo: 'periodo_cerrado'; periodo: Periodo }
  | { ok: false; motivo: 'fuera_de_periodo' }

/**
 * Resuelve en qué período se imputa una fecha.
 *
 * Es el espejo exacto de la consulta de `post_entry()`: busca un período que
 * contenga la fecha **y** no esté cerrado. Los dos rechazos están separados a
 * propósito, porque significan cosas distintas y se arreglan distinto:
 *
 * - `periodo_cerrado` — el período existe y está cerrado: hay que reabrirlo (con
 *   motivo y auditoría) o revertir con un contra-asiento en el período abierto.
 * - `fuera_de_periodo` — no hay ningún período que contenga la fecha: falta abrir
 *   el ejercicio o el mes. El motor falla con `no_data_found` y el mismo consejo.
 *
 * Devolver `ok: false` con el período en el primer caso es deliberado: la ventana
 * necesita poder decir **cuál** está cerrado, y desde cuándo.
 */
export function resolverPeriodo(periodos: readonly Periodo[], fecha: string): ResultadoImputacion {
  if (!FECHA_ISO.test(fecha)) {
    throw new Error(`La fecha «${fecha}» no está en formato ISO (YYYY-MM-DD): la comparación sería incorrecta.`)
  }

  const candidatos = periodosQueContienen(periodos, fecha)

  const abierto = candidatos.find(admiteAsientos)
  if (abierto !== undefined) return { ok: true, periodo: abierto }

  const cerrado = candidatos[0]
  if (cerrado !== undefined) return { ok: false, motivo: 'periodo_cerrado', periodo: cerrado }

  return { ok: false, motivo: 'fuera_de_periodo' }
}

export type ResultadoCierre =
  | { ok: true; periodo: Periodo }
  | { ok: false; motivo: 'ya_cerrado' }
  | { ok: false; motivo: 'asientos_pendientes'; cantidad: number }

/**
 * Cierra un período.
 *
 * Rechaza cerrar con asientos en borrador: un período cerrado con asientos sin
 * contabilizar es un período que declara un resultado incompleto, y el error recién
 * se descubre al comparar contra el balance del mes siguiente.
 *
 * El resultado mantiene la coherencia que el motor impone con
 * `periods_closed_coherent`: `closed` y `cerradoEn` van siempre juntos.
 */
export function cerrarPeriodo(
  periodo: Periodo,
  opciones: { fecha: string; autor: string; asientosPendientes: number },
): ResultadoCierre {
  if (periodo.estado === 'closed') return { ok: false, motivo: 'ya_cerrado' }

  if (opciones.asientosPendientes > 0) {
    return { ok: false, motivo: 'asientos_pendientes', cantidad: opciones.asientosPendientes }
  }

  return {
    ok: true,
    periodo: {
      ...periodo,
      estado: 'closed',
      cerradoEn: opciones.fecha,
      cerradoPor: opciones.autor,
      asientosPendientes: 0,
    },
  }
}

export type ResultadoReapertura =
  | { ok: true; periodo: Periodo }
  | { ok: false; motivo: 'no_esta_cerrado' }
  | { ok: false; motivo: 'motivo_requerido' }

/**
 * Reabre un período cerrado.
 *
 * Reabrir invalida cualquier balance ya presentado, así que el motor lo trata como
 * una operación con consecuencias: exige motivo **y** autor, y deja rastro
 * (`periods_reopen_coherent`). Acá se rechaza el motivo vacío en vez de dejar pasar
 * una reapertura sin registro.
 *
 * Al reabrir se limpia el cierre anterior: el período vuelve a `open` y el rastro de
 * la reapertura queda en los campos propios, no pisando los del cierre.
 */
export function reabrirPeriodo(
  periodo: Periodo,
  opciones: { fecha: string; autor: string; motivo: string },
): ResultadoReapertura {
  if (periodo.estado !== 'closed') return { ok: false, motivo: 'no_esta_cerrado' }
  if (opciones.motivo.trim() === '') return { ok: false, motivo: 'motivo_requerido' }

  return {
    ok: true,
    periodo: {
      ...periodo,
      estado: 'open',
      cerradoEn: null,
      cerradoPor: null,
      reabiertoEn: opciones.fecha,
      reabiertoPor: opciones.autor,
      motivoReapertura: opciones.motivo,
    },
  }
}

/** Verdadero cuando el período fue reabierto alguna vez: la ventana lo marca. */
export function fueReabierto(periodo: Periodo): boolean {
  return periodo.reabiertoEn !== null
}
