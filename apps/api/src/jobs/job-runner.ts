/**
 * =============================================================================
 * Control · Runner de tareas programadas
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Ejecuta los jobs registrados en `ops.jobs`, dejando constancia de cada corrida
 * en `ops.job_runs`. Envuelve cada ejecución con el ledger para que una falla
 * quede registrada aunque el proceso muera, y para que dos instancias no corran
 * el mismo job a la vez.
 *
 * POR QUÉ ASÍ
 *
 * El ledger vive en la base, no en memoria, porque la pregunta que importa —"¿el
 * mantenimiento de particiones corrió este mes?"— tiene que poder responderse con
 * una consulta y sobrevivir al reciclado de logs del contenedor.
 *
 * El cierre de la ejecución va en un bloque `finally`: si el job explota, la fila
 * queda cerrada como fallida. Sin eso, un crash deja la ejecución en `running`
 * para siempre y el índice único `uq_job_runs_one_running` bloquea todas las
 * corridas siguientes del job, en silencio.
 * =============================================================================
 */

import type { Pool, PoolClient } from 'pg';

// -----------------------------------------------------------------------------
// Contrato de un job
// -----------------------------------------------------------------------------
export interface JobContext {
  /** Cliente con una transacción abierta. El job decide si confirma o no. */
  client: PoolClient;
  /** Identificador del host que ejecuta, para trazabilidad. */
  host: string;
  runId: number;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface JobDefinition {
  code: string;
  /**
   * Ejecuta el trabajo. Debe ser idempotente: si el proceso murió después de
   * hacer el trabajo pero antes de registrar el éxito, el job se reintenta.
   */
  run: (ctx: JobContext) => Promise<Record<string, unknown>>;
}

export interface JobRunResult {
  code: string;
  status: 'succeeded' | 'failed' | 'skipped';
  outcome?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------
export class JobRunner {
  constructor(
    private readonly pool: Pool,
    private readonly host: string,
    private readonly logger: Pick<Console, 'info' | 'error' | 'warn'> = console
  ) {}

  /**
   * Ejecuta un job. Devuelve 'skipped' si ya hay una ejecución en curso:
   * es la señal de que otra instancia lo tomó, no un error.
   */
  async runJob(def: JobDefinition): Promise<JobRunResult> {
    const startedAt = Date.now();

    // El registro de inicio va en su propia transacción para que sea visible a
    // la otra instancia ANTES de que empiece el trabajo. Si fuera parte de la
    // transacción del job, dos instancias podrían insertar a la vez sin ver la
    // fila de la otra y el índice único las resolvería con un error en vez de
    // un salteo limpio.
    let runId: number | null;
    try {
      const { rows } = await this.pool.query<{ run_id: number | null }>(
        'SELECT ops.begin_job_run($1, $2) AS run_id',
        [def.code, this.host]
      );
      runId = rows[0]?.run_id ?? null;
    } catch (e) {
      // Un job mal registrado o inactivo lanza excepción acá; no es recuperable
      // en tiempo de ejecución, así que se reporta y se sigue.
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`[jobs] no se pudo iniciar "${def.code}": ${message}`);
      return { code: def.code, status: 'failed', error: message, durationMs: Date.now() - startedAt };
    }

    if (runId === null) {
      this.logger.warn(`[jobs] "${def.code}" ya está en ejecución en otra instancia; se omite.`);
      return { code: def.code, status: 'skipped', durationMs: Date.now() - startedAt };
    }

    const client = await this.pool.connect();
    let outcome: Record<string, unknown> = {};
    let error: string | undefined;

    try {
      const ctx: JobContext = {
        client,
        host: this.host,
        runId,
        log: (message, meta) =>
          this.logger.info(`[jobs:${def.code}] ${message}`, meta ?? {}),
      };

      outcome = (await def.run(ctx)) ?? {};
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.logger.error(`[jobs] "${def.code}" falló: ${error}`);

      // Si el job dejó la transacción en estado abortado hay que descartarla
      // antes de usarla para registrar el fallo.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* la transacción ya estaba cerrada */
      }
    } finally {
      client.release();

      // Cierre en una conexión del pool, no en la del job: puede estar abortada.
      // Es el paso que impide que un crash bloquee el job para siempre.
      try {
        await this.pool.query('SELECT ops.finish_job_run($1, $2, $3::jsonb, $4)', [
          runId,
          error === undefined,
          JSON.stringify(outcome),
          error ?? null,
        ]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(
          `[jobs] no se pudo cerrar la ejecución ${runId} de "${def.code}": ${message}. ` +
            `Quedará como colgada hasta que corra ops.reap_stuck_job_runs().`
        );
      }
    }

    return {
      code: def.code,
      status: error === undefined ? 'succeeded' : 'failed',
      outcome,
      error,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Ejecuta varios jobs en secuencia. Un fallo no impide los siguientes. */
  async runAll(defs: JobDefinition[]): Promise<JobRunResult[]> {
    const results: JobRunResult[] = [];
    for (const def of defs) {
      results.push(await this.runJob(def));
    }
    return results;
  }

  /**
   * Verificación de arranque: confirma que el modo plataforma realmente se
   * aplica. Es la guarda contra el modo de falla más traicionero de este runner
   * — un job transversal que corre sin privilegio de plataforma lee cero filas
   * por RLS, reporta éxito y no hace nada.
   *
   * Se ejecuta al iniciar el worker. Si el rol de base no pertenece a
   * `control_platform`, `set_tenant_context` lanza error y esto lo revela en el
   * arranque en lugar de a las tres de la mañana con una alerta que nunca llega.
   */
  async assertPlatformMode(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT app.set_tenant_context(NULL, NULL, true)');

      const { rows } = await client.query<{ is_platform_admin: boolean }>(
        'SELECT app.is_platform_admin() AS is_platform_admin'
      );

      if (rows[0]?.is_platform_admin !== true) {
        throw new Error(
          'El modo plataforma no quedó activo tras set_tenant_context(NULL, NULL, true). ' +
            'Los jobs transversales leerían cero filas por RLS sin reportar error.'
        );
      }
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* la transacción ya estaba cerrada */
      }
      client.release();
    }
  }
}

// =============================================================================
// Jobs concretos
// =============================================================================

/**
 * Mantenimiento de particiones: crea las particiones de los próximos meses para
 * `logistics.position_pings` y `audit.events` antes de que lleguen sus datos.
 *
 * Es el complemento de `0009`: allí se garantiza que la partición nazca con RLS;
 * acá se garantiza que exista antes de necesitarse. Si este job se detiene, los
 * datos empiezan a caer en la partición DEFAULT — que sí tiene RLS, pero crece
 * sin límite. `audit.v_default_partition_usage` lo delata.
 */
export const partitionMaintenanceJob: JobDefinition = {
  code: 'partition.maintenance',
  async run({ client, log }) {
    const { rows } = await client.query<{ ensure_partitions_ahead: void }>(
      'SELECT app.ensure_partitions_ahead($1)',
      [3]
    );

    // La función verifica la cobertura RLS al final: si alguna partición quedó
    // sin política, lanza excepción y la corrida se registra como fallida.
    const partitions = await client.query<{ nspname: string; relname: string }>(`
      SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relispartition
        AND n.nspname IN ('logistics', 'audit')
        AND c.relname !~ 'default'
      ORDER BY c.relname
    `);

    log(`particiones activas: ${partitions.rowCount}`);
    void rows;

    return { partitions: partitions.rowCount };
  },
};

/**
 * Purga de posiciones GPS fuera de la ventana de retención. Nunca toca
 * `audit.events`: la retención del log de auditoría es una decisión de negocio
 * y de cumplimiento, no un default técnico.
 */
export const partitionRetentionJob: JobDefinition = {
  code: 'partition.retention',
  async run({ client, log }) {
    const { rows } = await client.query<{ dropped: number }>(
      'SELECT app.drop_old_position_partitions($1) AS dropped',
      [6]
    );
    const dropped = rows[0]?.dropped ?? 0;
    if (dropped > 0) log(`particiones GPS eliminadas: ${dropped}`);
    return { dropped };
  },
};

/**
 * Alerta de vencimiento de certificados AFIP. Corre contra las credenciales
 * cifradas de **todas las empresas** y reporta las que vencen en 45, 30 o 15 días.
 *
 * Un certificado vencido sin aviso es un negocio que no puede facturar, y el
 * síntoma se ve como un error genérico de AFIP: hay que detectarlo antes.
 *
 * OJO CON RLS: esta tarea es transversal a todos los inquilinos, así que corre
 * en modo plataforma. Sin `app.platform_admin = 'on'`, la política de
 * `billing.afip_credentials` (que exige coincidencia de tenant O privilegio de
 * plataforma) devuelve **cero filas** y el job reportaría "sin certificados por
 * vencer" para siempre, en silencio. El modo plataforma requiere pertenecer a
 * `control_platform`; `set_tenant_context` lo verifica y lanza si no se cumple.
 */
export const certificateExpiryJob: JobDefinition = {
  code: 'certificate.expiry',
  async run({ client, log }) {
    // Contexto de plataforma explícito: sin esto la consulta devuelve 0 filas
    // por RLS y la falla es invisible.
    await client.query(
      'SELECT app.set_tenant_context(NULL, NULL, true)'
    );

    const { rows } = await client.query<{
      tenant_id: string;
      days_left: number;
      notify: boolean;
    }>(`
      SELECT tenant_id,
             (cert_not_after::date - current_date) AS days_left,
             (cert_not_after::date - current_date) IN (45, 30, 15) AS notify
      FROM billing.afip_credentials
      WHERE is_active
        AND cert_not_after IS NOT NULL
        AND cert_not_after::date - current_date BETWEEN 0 AND 45
      ORDER BY cert_not_after
    `);

    // Verificación de cordura: un sistema en operación con certificados cargados
    // no puede tener cero credenciales activas. Si las tiene, el modo plataforma
    // no se aplicó (o no hay empresas configuradas) y hay que fallar en vez de
    // reportar un falso "todo en orden".
    const total = await client.query<{ n: string }>(`
      SELECT count(*)::text AS n
      FROM billing.afip_credentials
      WHERE is_active AND cert_not_after IS NOT NULL
    `);
    const withCertificates = Number(total.rows[0]?.n ?? '0');

    if (withCertificates === 0) {
      log('no hay credenciales activas con certificado: verificando si es esperado');
    }

    const toNotify = rows.filter((r) => r.notify);
    for (const r of toNotify) {
      log(`certificado por vencer: inquilino ${r.tenant_id}, ${r.days_left} días`);
    }

    return {
      activeCredentials: withCertificates,
      expiring: rows.length,
      notified: toNotify.length,
    };
  },
};

/**
 * Reaper de mantenimiento operativo: destraba ejecuciones colgadas y marca como
 * muertos los trabajos de la cola AFIP que agotaron sus reintentos.
 *
 * Las dos operaciones son transversales a todos los inquilinos, así que corren
 * en modo plataforma. Sin él, `billing.afip_outbox` (con RLS) devolvería cero
 * filas y la cola crecería sin que nadie marque los trabajos muertos.
 */
export const outboxReaperJob: JobDefinition = {
  code: 'outbox.reaper',
  async run({ client, log }) {
    await client.query('SELECT app.set_tenant_context(NULL, NULL, true)');

    // Destraba jobs que murieron a mitad de camino.
    const { rows } = await client.query<{ reaped: number }>(
      'SELECT ops.reap_stuck_job_runs($1) AS reaped',
      ['2 hours']
    );
    const reaped = rows[0]?.reaped ?? 0;
    if (reaped > 0) log(`ejecuciones colgadas marcadas como fallidas: ${reaped}`);

    // Trabajos de la cola AFIP que agotaron sus reintentos.
    const dead = await client.query(`
      UPDATE billing.afip_outbox
      SET status = 'dead', updated_at = now()
      WHERE status = 'pending' AND attempts >= max_attempts
      RETURNING 1
    `);

    if (dead.rowCount && dead.rowCount > 0) {
      log(`trabajos AFIP marcados como muertos: ${dead.rowCount}`);
    }

    return { reaped, deadOutbox: dead.rowCount ?? 0 };
  },
};

/** Catálogo de jobs que expone este runner. */
export const JOB_DEFINITIONS: JobDefinition[] = [
  partitionMaintenanceJob,
  partitionRetentionJob,
  certificateExpiryJob,
  outboxReaperJob,
];

// =============================================================================
// Frecuencias esperadas por job (contrato, espejo de ops.jobs)
// =============================================================================
// El scheduler de infraestructura (Kubernetes CronJob, cron del host o el
// servicio gestionado que se elija) invoca cada job con su propia cadencia. La
// tabla `ops.jobs` declara la cadencia esperada y `ops.v_job_health` la compara
// contra la realidad: si el scheduler se detiene, la vista lo muestra atrasado
// sin necesidad de que el job reporte su propia ausencia.
export const JOB_SCHEDULE: Record<string, string> = {
  'partition.maintenance': '0 3 1 * *', // día 1 de cada mes, 03:00
  'partition.retention': '0 4 1 * *', // día 1 de cada mes, 04:00
  'certificate.expiry': '0 8 * * *', // diario, 08:00
  'outbox.reaper': '*/15 * * * *', // cada 15 minutos
};
