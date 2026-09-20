/**
 * Formato de números y fechas, en un solo lugar.
 *
 * Las ventanas de F3 y F4 definían su propio `Intl.NumberFormat` en cada archivo; a
 * partir de F5, con ocho ventanas de inventario, eso era ocho copias de la misma
 * decisión de formato. Los formateadores de `Intl` son caros de construir, así que
 * además conviene que sean una instancia compartida y no una por render.
 */

/** Pesos argentinos sin centavos. El contrato guarda los importes **en centavos**. */
export const formatearPesos = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

/** Importe a partir de un valor del contrato (centavos). */
export function pesos(centavos: number): string {
  return formatearPesos.format(centavos / 100)
}

export const formatearNumero = new Intl.NumberFormat('es-AR')

/** Cantidad con signo explícito, para la columna de netos del libro mayor. */
export function numeroConSigno(valor: number): string {
  return `${valor > 0 ? '+' : valor < 0 ? '−' : ''}${formatearNumero.format(Math.abs(valor))}`
}

export const formatearFecha = (iso: string): string =>
  new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(iso))

export const formatearFechaHora = (iso: string): string =>
  new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
