import { z } from 'zod'
import { coleccionSchema } from './comun.ts'

/**
 * Tareas programadas, espejo de `ops.jobs` y `ops.job_runs`.
 *
 * **Por qué no alcanza con mirar si la última corrida falló.** El motor declara un
 * contrato de cadencia (`expected_every`) y una tolerancia (`grace_period`), y la
 * distinción importa: un job que falló avisa; un job que **dejó de correr** no avisa
 * nada, y el hueco se descubre cuando falta un dato —una partición que no se creó, una
 * retención que no purgó—. Por eso el estado se deriva de las dos cosas: del resultado
 * de la última corrida **y** de cuánto hace que empezó.
 *
 * Las dos coherencias del motor están en el contrato:
 *
 * - `job_runs_finished_consistency`: una corrida `running` **no** tiene `terminadaEn`, y
 *   cualquier otra sí. Es lo que permite calcular la duración sin adivinar.
 * - `uq_job_runs_one_running`: sólo hay una corrida viva por job. El contrato lo respeta
 *   porque la corrida se modela como **una** —la última—, no como una lista donde dos
 *   podrían estar vivas.
 */

/** El resultado de una corrida, espejo del CHECK `job_runs_status_valid`. */
export const EstadoDeCorridaSchema = z.enum(['running', 'succeeded', 'failed', 'skipped'])
export type EstadoDeCorrida = z.infer<typeof EstadoDeCorridaSchema>

/**
 * Una corrida.
 *
 * `terminadaEn` es `null` exactamente cuando el estado es `running`: es la coherencia que
 * el motor impone y la que permite decir «lleva 20 minutos corriendo» en vez de «no se
 * sabe».
 */
export const CorridaSchema = z.object({
  iniciadaEn: z.string(),
  terminadaEn: z.string().nullable(),
  estado: EstadoDeCorridaSchema,
  /** La instancia que la ejecutó: con varias réplicas, sin esto no se depura un lock. */
  host: z.string().nullable(),
  error: z.string().nullable(),
})
export type Corrida = z.infer<typeof CorridaSchema>

/**
 * Un job del catálogo.
 *
 * `cadenciaMs` y `toleranciaMs` son milisegundos y no el `interval` de PostgreSQL: el
 * frontend no puede parsear un intervalo, y traducirlo en cada ventana sería traducirlo
 * distinto en cada una. El motor guarda el intervalo; el contrato lo expone ya medido.
 */
export const TrabajoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  cadenciaMs: z.number().int().positive(),
  toleranciaMs: z.number().int().nonnegative(),
  critico: z.boolean(),
  activo: z.boolean(),
  /** La última corrida, o `null` si nunca corrió. */
  ultimaCorrida: CorridaSchema.nullable(),
})
export type Trabajo = z.infer<typeof TrabajoSchema>

export const TrabajoListadoSchema = coleccionSchema(TrabajoSchema)
export type TrabajoListado = z.infer<typeof TrabajoListadoSchema>

// ---------------------------------------------------------------------------
// El estado derivado
// ---------------------------------------------------------------------------

/**
 * El estado de un job, tal como lo ve la ventana.
 *
 * Ocho estados en el motor se reducen a seis acá, y los dos que importan son los que
 * **no** son un error: `atrasado` y `sin_correr`. Un job que falla deja un error; un job
 * que dejó de correr no deja nada, y es el que rompe el sistema en silencio.
 */
export type EstadoDeTrabajo =
  | 'inactivo'
  | 'sin_correr'
  | 'corriendo'
  | 'fallando'
  | 'atrasado'
  | 'al_dia'

/**
 * Deriva el estado de un job.
 *
 * La fecha entra **por parámetro** en milisegundos: nada lee el reloj, así que el estado
 * es reproducible y la prueba puede forzar «hace tres días que no corre» sin esperar tres
 * días. Es el mismo criterio que el «hoy» de `cadenas.ts` y la versión de `inventario.ts`.
 */
export function estadoDeTrabajo(trabajo: Trabajo, ahoraMs: number): EstadoDeTrabajo {
  if (!trabajo.activo) return 'inactivo'

  const corrida = trabajo.ultimaCorrida
  if (corrida === null) return 'sin_correr'

  // Una corrida viva manda sobre todo lo demás: mientras corre, no está atrasado.
  if (corrida.estado === 'running') return 'corriendo'

  if (corrida.estado === 'failed') return 'fallando'

  // El atraso se mide desde que **empezó** la última corrida, no desde que terminó: un
  // job que terminó hace un rato pero no volvió a arrancar está atrasado igual.
  const desdeMs = Date.parse(corrida.iniciadaEn)
  const limiteMs = trabajo.cadenciaMs + trabajo.toleranciaMs
  return ahoraMs - desdeMs > limiteMs ? 'atrasado' : 'al_dia'
}

/** La duración de una corrida, o `null` mientras sigue viva. */
export function duracionDeCorrida(corrida: Corrida): number | null {
  if (corrida.terminadaEn === null) return null
  return Date.parse(corrida.terminadaEn) - Date.parse(corrida.iniciadaEn)
}

/**
 * Coherencia de una corrida, espejo de `job_runs_finished_consistency`.
 *
 * `running` ⟺ `terminadaEn === null`. Una corrida marcada como viva pero con hora de
 * fin haría que la ventana informara una duración de algo que dice estar corriendo.
 */
export function corridaCoherente(corrida: Corrida): boolean {
  return (corrida.estado === 'running') === (corrida.terminadaEn === null)
}

/** Los jobs que exigen atención: los que fallan, los atrasados y los que nunca corrieron. */
export function trabajosQuePreocupan(trabajos: readonly Trabajo[], ahoraMs: number): Trabajo[] {
  return trabajos.filter((trabajo) => {
    const estado = estadoDeTrabajo(trabajo, ahoraMs)
    return estado === 'fallando' || estado === 'atrasado' || estado === 'sin_correr'
  })
}

/**
 * Un escenario de simulación: el catálogo del job más **hace cuánto** corrió.
 *
 * Los datos simulados no pueden guardar la última corrida como una fecha fija: un
 * fixture con fecha del 20 de septiembre mostraría **todos** los jobs atrasados apenas
 * pasa esa fecha, y la ventana perdería el sentido. Guardar el desfase y materializarlo
 * contra el reloj de quien mira hace que el mundo simulado esté siempre «vivo», que es lo
 * que se espera de un adaptador simulado.
 */
export const EscenarioDeTrabajoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  cadenciaMs: z.number().int().positive(),
  toleranciaMs: z.number().int().nonnegative(),
  critico: z.boolean(),
  activo: z.boolean(),
  /** Hace cuánto **empezó** la última corrida. `null` significa que nunca corrió. */
  ultimaCorridaHaceMs: z.number().int().nonnegative().nullable(),
  /** Cuánto duró. `null` mientras está corriendo. */
  duracionMs: z.number().int().nonnegative().nullable(),
  estadoDeLaUltimaCorrida: EstadoDeCorridaSchema,
  host: z.string().nullable(),
  error: z.string().nullable(),
})
export type EscenarioDeTrabajo = z.infer<typeof EscenarioDeTrabajoSchema>

/** Convierte un escenario en un job con fechas absolutas, contra el reloj que se le pase. */
export function materializarTrabajo(escenario: EscenarioDeTrabajo, ahoraMs: number): Trabajo {
  const corrida: Corrida | null =
    escenario.ultimaCorridaHaceMs === null
      ? null
      : {
          iniciadaEn: new Date(ahoraMs - escenario.ultimaCorridaHaceMs).toISOString(),
          // La coherencia del motor: `running` ⟺ sin hora de fin. La duración del
          // escenario sólo se usa cuando la corrida terminó.
          terminadaEn:
            escenario.estadoDeLaUltimaCorrida === 'running' || escenario.duracionMs === null
              ? null
              : new Date(ahoraMs - escenario.ultimaCorridaHaceMs + escenario.duracionMs).toISOString(),
          estado: escenario.estadoDeLaUltimaCorrida,
          host: escenario.host,
          error: escenario.error,
        }

  return {
    codigo: escenario.codigo,
    descripcion: escenario.descripcion,
    cadenciaMs: escenario.cadenciaMs,
    toleranciaMs: escenario.toleranciaMs,
    critico: escenario.critico,
    activo: escenario.activo,
    ultimaCorrida: corrida,
  }
}

/**
 * El orden del tablero: primero lo que preocupa, después lo crítico, después el resto.
 *
 * Un job crítico al día no tiene por qué estar arriba de uno no crítico que dejó de
 * correr: la criticidad dice cuánto duele que falle, y el estado dice si está fallando.
 */
export function ordenarTrabajos(trabajos: readonly Trabajo[], ahoraMs: number): Trabajo[] {
  const peso: Record<EstadoDeTrabajo, number> = {
    fallando: 0,
    atrasado: 1,
    sin_correr: 2,
    corriendo: 3,
    al_dia: 4,
    inactivo: 5,
  }
  return [...trabajos].sort((a, b) => {
    const porEstado = peso[estadoDeTrabajo(a, ahoraMs)] - peso[estadoDeTrabajo(b, ahoraMs)]
    if (porEstado !== 0) return porEstado
    if (a.critico !== b.critico) return a.critico ? -1 : 1
    return a.codigo.localeCompare(b.codigo)
  })
}
