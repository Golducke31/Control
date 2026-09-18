/**
 * =============================================================================
 * Control · Scheduler de tareas programadas
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Lee `JOB_SCHEDULE` (el espejo en código de `ops.jobs.expected_every`), decide
 * qué jobs están "vencidos" según su propia cadencia y el historial del ledger,
 * y los ejecuta con `JobRunner`. Está pensado para correr como proceso de larga
 * vida (una réplica dedicada) o como invocación puntual desde un CronJob.
 *
 * POR QUÉ NO SE USA UN CRON DEL SISTEMA POR JOB
 *
 * Sería lo obvio: cinco entradas en el crontab, una por job. Se descartó por dos
 * motivos concretos:
 *
 *   1. La cadencia quedaría declarada en DOS lugares —el crontab y
 *      `ops.jobs.expected_every`— y `ops.v_job_health` compara la realidad
 *      contra la segunda. Un crontab desincronizado haría que la vista reporte
 *      atrasos que no existen, o peor: que no reporte los que sí.
 *   2. Un crontab no sabe nada del ledger. La decisión "¿ya corrió hoy?" tiene
 *      que salir del historial, no del reloj: si el job corrió a las 04:05 y el
 *      scheduler murió antes de la siguiente ventana, un cron ciego lo correría
 *      dos veces; éste no.
 *
 * POR QUÉ LA DECISIÓN SALE DEL LEDGER Y NO DE UN TIMER EN MEMORIA
 *
 * Con varias réplicas, cada una con su timer, todas dispararían a la vez. El
 * índice único `uq_job_runs_one_running` lo resolvería, pero convirtiendo un
 * diseño concurrente en una carrera de la que cuatro de cinco instancias salen
 * perdiendo. Consultar la última ejecución exitosa hace que la decisión sea
 * determinista e idéntica en todas: la que llega primero al ledger corre.
 *
 * GARANTÍA DE CIERRE
 *
 * Cada ejecución la cierra `JobRunner` en su `finally`. Este archivo no agrega
 * ningún camino que pueda saltearlo, y si el proceso muere entero,
 * `ops.reap_stuck_job_runs()` (invocado por `outbox.reaper`) destraba el
 * residuo. El orden importa: sin el reaper, un crash deja la fila en `running`
 * y el job queda bloqueado para siempre.
 * =============================================================================
 */

import type { Pool } from 'pg';
import {
  JobRunner,
  JOB_DEFINITIONS,
  JOB_SCHEDULE,
  type JobDefinition,
  type JobRunResult,
} from './job-runner.js';

/**
 * Único nivel de log que el scheduler respeta. Se tipa como el subconjunto de
 * `Console` que realmente se usa para poder inyectar un logger silencioso en
 * los tests sin tener que simular la consola entera.
 */
export type JobLogger = Pick<Console, 'info' | 'error' | 'warn'>;

// -----------------------------------------------------------------------------
// Evaluación de la cadencia
// -----------------------------------------------------------------------------

/**
 * Convierte la cadencia declarada en `JOB_SCHEDULE` a milisegundos.
 *
 * Sólo se soportan las formas que el proyecto realmente usa. No se implementa un
 * parser de cron completo a propósito: un parser a medias da una falsa sensación
 * de generalidad y acepta expresiones que después evalúa mal. Si un job necesita
 * una cadencia que no está acá, se agrega explícitamente — y falla ruidosamente
 * si no, en vez de interpretarla mal en silencio.
 */
export function scheduleIntervalMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Expresión de cadencia no soportada: "${cron}". ` +
        'Se esperan 5 campos (minuto hora día-del-mes mes día-de-semana).'
    );
  }
  const [minute, hour, dom] = parts;

  // `*/N * * * *` → cada N minutos
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === '*' && dom === '*') {
    return Number(everyMinutes[1]) * 60_000;
  }

  // `M H * * *` → una vez por día
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*') {
    return 24 * 60 * 60_000;
  }

  // `M H 1 * *` → una vez por mes
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '1') {
    return 30 * 24 * 60 * 60_000;
  }

  throw new Error(
    `Expresión de cadencia no soportada: "${cron}". ` +
      'Formas válidas: "*/N * * * *", "M H * * *", "M H 1 * *".'
  );
}

export interface DueJob {
  definition: JobDefinition;
  /** Milisegundos desde la última ejecución exitosa, o `null` si nunca corrió. */
  sinceLastSuccessMs: number | null;
  intervalMs: number;
}

export interface SchedulerOptions {
  /** Milisegundos entre barridos. Acota la precisión del disparo. */
  tickMs?: number;
  /** Si es true, corre un solo barrido y termina. */
  once?: boolean;
  /** Filtra por código de job. Sin esto, se consideran todos. */
  only?: string[];
}

/**
 * Decide qué jobs tienen que correr ahora, consultando el ledger.
 *
 * La consulta busca la última ejecución EXITOSA de cada job. Se ignoran las
 * fallidas a propósito: un job que viene fallando todos los días no está "al
 * día" — está roto, y tiene que seguir intentándose. Mirar la última ejecución
 * de cualquier estado haría que un job fallido se considere reciente y deje de
 * reintentarse, que es exactamente lo contrario de lo que hace falta.
 */
export async function findDueJobs(
  pool: Pool,
  options: SchedulerOptions = {}
): Promise<DueJob[]> {
  const definitions = JOB_DEFINITIONS.filter(
    (d) => !options.only || options.only.includes(d.code)
  );
  if (definitions.length === 0) return [];

  const codes = definitions.map((d) => d.code);

  const { rows } = await pool.query<{ job_code: string; seconds_ago: string | null }>(
    `
      SELECT j.code AS job_code,
             EXTRACT(EPOCH FROM (now() - last_run.finished_at))::text AS seconds_ago
      FROM ops.jobs j
      LEFT JOIN LATERAL (
        SELECT r.finished_at
        FROM ops.job_runs r
        WHERE r.job_code = j.code AND r.status = 'succeeded'
        ORDER BY r.finished_at DESC
        LIMIT 1
      ) AS last_run ON true
      WHERE j.code = ANY($1::text[]) AND j.is_active
    `,
    [codes]
  );

  // El LEFT JOIN devuelve una fila por job registrado, con `seconds_ago` nulo
  // si nunca corrió. Eso hace que la ausencia de la clave signifique exactamente
  // "no está en ops.jobs (o está inactivo)", que es lo que hay que distinguir:
  // "nunca corrió" ('null') y "no registrado" (clave ausente) son casos
  // distintos. Tratar 'undefined' como 'null' saltearía jobs válidos que
  // simplemente arrancan por primera vez — el caso más común de todos.
  const registered = new Set(rows.map((r) => r.job_code));
  const lastSuccess = new Map<string, number | null>();
  for (const r of rows) {
    lastSuccess.set(
      r.job_code,
      r.seconds_ago === null ? null : Number(r.seconds_ago) * 1000
    );
  }

  const due: DueJob[] = [];
  for (const definition of definitions) {
    const cron = JOB_SCHEDULE[definition.code];
    if (!cron) {
      // Un job sin cadencia declarada no se dispara: no hay forma de saber
      // cuándo corresponde. Se avisa fuerte porque es casi seguro un olvido.
      console.warn(
        `[scheduler] "${definition.code}" no tiene entrada en JOB_SCHEDULE; no se programa.`
      );
      continue;
    }

    // Un job que no está en `ops.jobs` hará fallar `begin_job_run()` con
    // "Job desconocido o inactivo". Se detecta acá para no gastar el intento.
    if (!registered.has(definition.code)) {
      console.warn(
        `[scheduler] "${definition.code}" no está registrado en ops.jobs (o está inactivo); no se programa.`
      );
      continue;
    }

    const intervalMs = scheduleIntervalMs(cron);
    const elapsed = lastSuccess.get(definition.code) ?? null;

    // `elapsed === null` → nunca corrió: vencido por definición.
    if (elapsed === null || elapsed >= intervalMs) {
      due.push({ definition, sinceLastSuccessMs: elapsed, intervalMs });
    }
  }

  return due;
}

// -----------------------------------------------------------------------------
// Scheduler
// -----------------------------------------------------------------------------
export class JobScheduler {
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly host: string,
    private readonly logger: JobLogger = console
  ) {}

  /** Detiene el bucle después del barrido en curso. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Un barrido: averigua qué está vencido y lo ejecuta en secuencia.
   *
   * En secuencia y no en paralelo: los jobs de este sistema compiten por los
   * mismos recursos (particiones, tabla de stock) y ejecutarlos a la vez
   * produciría contención sin ningún beneficio — sus cadencias son de horas.
   */
  async tick(options: SchedulerOptions = {}): Promise<JobRunResult[]> {
    const due = await findDueJobs(this.pool, options);

    if (due.length === 0) {
      this.logger.info('[scheduler] sin jobs vencidos');
      return [];
    }

    this.logger.info(
      `[scheduler] ${due.length} job(s) vencidos: ${due.map((d) => d.definition.code).join(', ')}`
    );

    const runner = new JobRunner(this.pool, this.host, this.logger as never);
    const results: JobRunResult[] = [];
    for (const d of due) {
      results.push(await runner.runJob(d.definition));
    }

    return results;
  }

  /**
   * Bucle de larga vida. Cada iteración barre y espera `tickMs`.
   *
   * El error de un barrido NO corta el bucle: un job que falla (o una caída
   * transitoria de la base) no debe matar al scheduler entero, porque entonces
   * ningún otro job corre más y el problema pasa de "un job falla" a "ninguno
   * corre". Se registra y se sigue.
   */
  async run(options: SchedulerOptions = {}): Promise<JobRunResult[]> {
    const tickMs = options.tickMs ?? 60_000;

    // Verificación de arranque antes de prometer nada: si el rol de base no
    // puede activar el modo plataforma, todos los jobs transversales leerían
    // cero filas por RLS y reportarían éxito sin hacer nada.
    const runner = new JobRunner(this.pool, this.host, this.logger as never);
    await runner.assertPlatformMode();

    if (options.once) {
      return this.tick(options);
    }

    this.logger.info(`[scheduler] iniciado en ${this.host}; barrido cada ${tickMs} ms`);

    const all: JobRunResult[] = [];
    while (!this.stopped) {
      try {
        all.push(...(await this.tick(options)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`[scheduler] barrido falló, se continúa: ${message}`);
      }

      if (this.stopped || options.once) break;

      // Espera interrumpible: sin esto, `stop()` tardaría hasta `tickMs` en
      // tener efecto y un apagado ordenado se volvería una espera a ciegas.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, tickMs);
        const check = setInterval(() => {
          if (this.stopped) {
            clearTimeout(t);
            clearInterval(check);
            resolve();
          }
        }, Math.min(1000, tickMs));
        // No mantener el proceso vivo sólo por estos timers.
        if (typeof t.unref === 'function') t.unref();
        if (typeof check.unref === 'function') check.unref();
      });
    }

    this.logger.info('[scheduler] detenido');
    return all;
  }
}
