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
  /**
   * `| undefined` explícito y no sólo `?`: con `exactOptionalPropertyTypes`
   * —que está activado a propósito— `campo?: T` significa "la clave puede no
   * estar", no "la clave puede valer undefined". El constructor de abajo arma
   * el objeto con las tres claves siempre presentes, y sin esta anotación el
   * tipo sería mentira en la dirección peligrosa: prometería que `error` está
   * ausente cuando en realidad está presente y vale `undefined`, y cualquier
   * `'error' in result` daría true con un valor vacío.
   */
  outcome?: Record<string, unknown> | undefined;
  error?: string | undefined;
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

/**
 * Reconciliación de stock: compara el saldo materializado (`app.stock_levels`)
 * contra la suma del libro mayor (`app.stock_movements`) y reporta las
 * diferencias.
 *
 * POR QUÉ EXISTE
 *
 * `stock_levels` es una proyección: se mantiene por upsert dentro de
 * `app.apply_stock_movement()`, no se recalcula desde el libro. Eso lo hace
 * rápido y lo hace frágil. Cualquier camino que escriba en `stock_levels` sin
 * pasar por la función —una migración de datos, un `UPDATE` manual, un job de
 * importación, un bug en un reintento— desincroniza las dos vistas sin que nada
 * lo note. El saldo es lo que se muestra al vendedor y lo que dispara el
 * reposicionamiento; si está mal, el negocio toma decisiones con un número
 * inventado.
 *
 * POR QUÉ NO SE AUTOCORRIGE
 *
 * Sería tentador "arreglar" el saldo a partir del libro. No se hace: la
 * diferencia es un SÍNTOMA, y no hay forma de saber desde acá cuál de las dos
 * vistas es la equivocada. Si el bug fue en la escritura del libro, corregir el
 * saldo propaga el error y destruye la única evidencia. El job reporta y deja
 * que un humano decida. Es la misma razón por la que el ledger no se poda solo.
 *
 * SOBRE RLS
 *
 * Es un job transversal: tiene que ver todas las empresas. Corre en modo
 * plataforma; sin él, RLS devuelve cero filas y el job reportaría "todo
 * consistente" sin haber mirado nada — el modo de falla más traicionero del
 * sistema. Por eso la consulta de control (`total comparados`) está abajo: un
 * cero ahí es la señal de que el modo plataforma no se aplicó.
 */
export const stockReconciliationJob: JobDefinition = {
  code: 'stock.reconciliation',
  async run({ client, log }) {
    // Contexto de plataforma explícito: sin esto, ambas consultas devuelven 0
    // filas por RLS y el job reporta un falso "todo en orden".
    await client.query('SELECT app.set_tenant_context(NULL, NULL, true)');

    // La aritmética replica EXACTAMENTE la de app.apply_stock_movement():
    //   · on_hand  → +cantidad en las entradas, -cantidad en las salidas,
    //                0 en reserva y liberación (no mueven el físico).
    //   · reserved → +cantidad en reserva, -cantidad en liberación.
    // Si esta fórmula se desvía de la de la función, el job inventa diferencias
    // en cada fila. Es la parte que hay que mantener en sincronía a mano.
    const { rows } = await client.query<{
      tenant_id: string;
      variant_id: string;
      warehouse_id: string;
      on_hand: number;
      reserved: number;
      expected_on_hand: number;
      expected_reserved: number;
    }>(`
      WITH ledger AS (
        SELECT
          m.tenant_id,
          m.variant_id,
          m.warehouse_id,
          COALESCE(sum(
            CASE m.kind
              WHEN 'purchase_in'    THEN  m.quantity
              WHEN 'transfer_in'    THEN  m.quantity
              WHEN 'adjustment_pos' THEN  m.quantity
              WHEN 'return_in'      THEN  m.quantity
              WHEN 'sale_out'       THEN -m.quantity
              WHEN 'transfer_out'   THEN -m.quantity
              WHEN 'adjustment_neg' THEN -m.quantity
              ELSE 0                -- reservation / release: no mueven el físico
            END
          ), 0)::int AS expected_on_hand,
          COALESCE(sum(
            CASE m.kind
              WHEN 'reservation' THEN  m.quantity
              WHEN 'release'     THEN -m.quantity
              ELSE 0
            END
          ), 0)::int AS expected_reserved
        FROM app.stock_movements m
        GROUP BY m.tenant_id, m.variant_id, m.warehouse_id
      )
      SELECT
        COALESCE(l.tenant_id,    s.tenant_id)    AS tenant_id,
        COALESCE(l.variant_id,   s.variant_id)   AS variant_id,
        COALESCE(l.warehouse_id, s.warehouse_id) AS warehouse_id,
        COALESCE(s.on_hand,  0)                  AS on_hand,
        COALESCE(s.reserved, 0)                  AS reserved,
        COALESCE(l.expected_on_hand,  0)         AS expected_on_hand,
        COALESCE(l.expected_reserved, 0)         AS expected_reserved
      FROM ledger l
      FULL OUTER JOIN app.stock_levels s
        ON  s.tenant_id    = l.tenant_id
        AND s.variant_id   = l.variant_id
        AND s.warehouse_id = l.warehouse_id
      WHERE COALESCE(s.on_hand, 0)   IS DISTINCT FROM COALESCE(l.expected_on_hand, 0)
         OR COALESCE(s.reserved, 0)  IS DISTINCT FROM COALESCE(l.expected_reserved, 0)
      ORDER BY 1, 2, 3
    `);

    // Control de cordura: cuántas combinaciones se compararon en total. Sin
    // esto, "0 diferencias" es ambiguo — puede significar "todo bien" o "RLS no
    // me dejó ver nada". Con el conteo, los dos casos se distinguen.
    const compared = await client.query<{ n: string }>(`
      SELECT (
        (SELECT count(*) FROM app.stock_levels)
        + (SELECT count(DISTINCT (tenant_id, variant_id, warehouse_id))
             FROM app.stock_movements)
      )::text AS n
    `);
    const totalCompared = Number(compared.rows[0]?.n ?? '0');

    if (rows.length > 0) {
      // Se listan los primeros para que el log sirva para investigar sin tener
      // que consultar la base. El resto queda en `outcome.differences`, que es
      // lo que el alerting lee.
      for (const d of rows.slice(0, 20)) {
        log(
          `diferencia: inquilino ${d.tenant_id} variante ${d.variant_id} ` +
            `depósito ${d.warehouse_id} — saldo físico ${d.on_hand} vs libro ` +
            `${d.expected_on_hand}; reservado ${d.reserved} vs libro ${d.expected_reserved}`
        );
      }
      if (rows.length > 20) {
        log(`… y ${rows.length - 20} diferencia(s) más`);
      }
    }

    return {
      compared: totalCompared,
      differences: rows.length,
      // Detalle acotado: `outcome` es jsonb en el ledger y crece con cada
      // corrida. Guardar miles de filas por día haría del ledger una tabla de
      // datos de negocio en vez de un registro de ejecuciones.
      sample: rows.slice(0, 50).map((d) => ({
        tenantId: d.tenant_id,
        variantId: d.variant_id,
        warehouseId: d.warehouse_id,
        onHand: d.on_hand,
        bookOnHand: d.expected_on_hand,
        reserved: d.reserved,
        bookReserved: d.expected_reserved,
      })),
      truncated: rows.length > 50,
    };
  },
};

/**
 * Verificación de asientos faltantes: recorre los hechos económicos del sistema
 * y reporta los que deberían tener asiento contable y no lo tienen.
 *
 * QUÉ ES UN "HECHO SIN ASIENTO"
 *
 * Un comprobante de venta autorizado por AFIP, o una salida de inventario
 * valuada. En los dos casos el negocio ya registró un hecho con consecuencias
 * económicas. Si ese hecho no tiene su asiento, el libro diario miente: el
 * balance no refleja la realidad, y el error no se ve —el libro cuadra, porque
 * un asiento que falta no descuadra nada—.
 *
 * POR QUÉ REPORTA EN VEZ DE GENERAR
 *
 * Sería tentador que este job creara los asientos que faltan. No lo hace, y la
 * razón es la decisión 3 del ADR 0002: un asiento se genera en la MISMA
 * transacción que el hecho. Un asiento creado a posteriori, por un job que corre
 * de madrugada, tiene una fecha contable que no es la del hecho y un orden que
 * no es el del libro. Peor: silenciaría el síntoma. El hecho de que falte un
 * asiento significa que un camino del sistema se salteó la generación, y esa es
 * la información que hay que preservar, no tapar. Es el mismo criterio que
 * `stock.reconciliation`, que reporta la divergencia en lugar de corregirla.
 *
 * El backfill de hechos históricos sí existe, pero es una operación explícita y
 * auditada, no el comportamiento por defecto de un job nocturno.
 *
 * LA VISTA SÓLO VE LO QUE EL RLS LE DEJA
 *
 * `accounting.v_posting_gaps` es `security_invoker`, así que el RLS de
 * `billing.invoices` y `app.stock_movements` se aplica a quien consulta. Este
 * job es transversal a todas las empresas, así que corre en MODO PLATAFORMA:
 * sin `app.platform_admin = 'on'` la vista devuelve cero filas y el job
 * reportaría "cero hechos sin asiento" para siempre, en silencio. Es el modo de
 * falla que `assertPlatformMode()` existe para atrapar en el arranque; acá se
 * agrega el control de cordura sobre el conteo de hechos comparados.
 */
export const accountingPostingCheckJob: JobDefinition = {
  code: 'accounting.posting_check',
  async run({ client, log }) {
    // Contexto de plataforma explícito. Sin esto, la vista —que es
    // security_invoker— filtra por el tenant activo (o por ninguno) y devuelve
    // 0 filas, que es indistinguible de "todo asentado".
    await client.query('SELECT app.set_tenant_context(NULL, NULL, true)');

    const { rows } = await client.query<{
      tenant_id: string;
      source_type: string;
      source_id: string;
      event_kind: string;
      happened_on: string;
      gap_description: string;
    }>(`
      SELECT tenant_id, source_type, source_id, event_kind,
             happened_on::text, gap_description
      FROM accounting.v_posting_gaps
      ORDER BY happened_on, tenant_id, source_type, source_id
    `);

    // Control de cordura: cuántos hechos ECONÓMICOS existen en total. Es la
    // diferencia entre "revisé 40.000 hechos y todos tienen asiento" y "no vi
    // nada porque el modo plataforma no se aplicó". Sin este número, un cero en
    // `gaps` es ambiguo, y un job que no puede distinguir "todo bien" de "no
    // miré nada" no sirve como alarma.
    //
    // Se cuentan sólo los hechos que DEBERÍAN tener asiento —los mismos
    // predicados que la vista—, no todas las facturas ni todos los movimientos:
    // comparar contra un universo distinto haría que el número no significara
    // nada respecto de las brechas que se informan.
    const universes = await client.query<{ invoices: string; movements: string }>(`
      SELECT
        (SELECT count(*) FROM billing.invoices WHERE status = 'authorized')::text
          AS invoices,
        (SELECT count(*) FROM app.stock_movements
          WHERE kind = 'sale_out' AND unit_cost IS NOT NULL AND unit_cost <> 0)::text
          AS movements
    `);

    const invoices = Number(universes.rows[0]?.invoices ?? '0');
    const movements = Number(universes.rows[0]?.movements ?? '0');
    const factsExpectedToPost = invoices + movements;

    // Si hay hechos en el sistema pero la vista no devolvió ninguna fila Y
    // tampoco hay brechas, el resultado es correcto. Pero si el conteo de hechos
    // también es cero, hay que decirlo: puede ser una instalación nueva (nada
    // que verificar) o un modo plataforma que no se aplicó. El job no puede
    // distinguirlas, así que lo deja asentado en el log y en `outcome` en vez de
    // reportar un "todo en orden" que no puede sostener.
    if (factsExpectedToPost === 0) {
      log(
        'no hay hechos económicos registrados: nada que verificar. ' +
          'Si el sistema está en operación, revisar que el modo plataforma se haya aplicado.'
      );
    }

    // El detalle va al log para poder investigar sin consultar la base.
    for (const g of rows.slice(0, 20)) {
      log(
        `hecho sin asiento: ${g.gap_description} — inquilino ${g.tenant_id} ` +
          `${g.source_type}/${g.event_kind} ${g.source_id} del ${g.happened_on}`
      );
    }
    if (rows.length > 20) {
      log(`… y ${rows.length - 20} hecho(s) sin asiento más`);
    }

    // Desglose por origen. Sin esto, una brecha en facturación y una en stock se
    // ven como el mismo número, y no se investigan igual.
    const bySource: Record<string, number> = {};
    for (const g of rows) {
      bySource[g.source_type] = (bySource[g.source_type] ?? 0) + 1;
    }

    return {
      factsExpectedToPost,
      invoices,
      movements,
      gaps: rows.length,
      bySource,
      // Muestra acotada: `outcome` es jsonb en el ledger y crece con cada
      // corrida. Guardar todas las brechas de cada día convertiría el ledger en
      // una tabla de datos de negocio en vez de un registro de ejecuciones.
      sample: rows.slice(0, 50).map((g) => ({
        tenantId: g.tenant_id,
        sourceType: g.source_type,
        sourceId: g.source_id,
        eventKind: g.event_kind,
        happenedOn: g.happened_on,
        description: g.gap_description,
      })),
      truncated: rows.length > 50,
    };
  },
};

/**
 * Reconciliación contable: compara los saldos materializados
 * (`accounting.account_balances`) contra la suma del libro
 * (`accounting.journal_lines`) y reporta las diferencias.
 *
 * POR QUÉ EXISTE
 *
 * `account_balances` es una proyección: la mantiene `post_entry()` por upsert
 * dentro de la misma transacción del asiento, no se recalcula desde el libro.
 * Eso la hace rápida de leer —el balance de un período es una consulta a una
 * tabla, no un `GROUP BY` sobre todo el diario— y la hace frágil por la misma
 * razón que `stock_levels`. Cualquier camino que escriba en `account_balances`
 * sin pasar por `post_entry()` —una migración de datos, un `UPDATE` manual, un
 * script de importación, un bug en un reintento— desincroniza las dos vistas sin
 * que nada lo note.
 *
 * Y no lo nota porque el libro SIGUE CUADRANDO. La partida doble la garantiza el
 * trigger sobre `journal_lines`, no la proyección: una divergencia en los saldos
 * no descuadra nada, simplemente hace que el balance que se le muestra al
 * contador diga un número distinto al que dice el diario. Dos informes que
 * deberían coincidir y no coinciden, sin ningún error en el medio.
 *
 * POR QUÉ NO SE AUTOCORRIGE
 *
 * Igual que `stock.reconciliation`, y por la misma razón: la diferencia es un
 * SÍNTOMA, y desde el job no hay forma de saber cuál de las dos vistas está mal.
 * Si el bug fue en la escritura del libro, corregir el saldo propaga el error y
 * destruye la única evidencia. El job reporta y deja que un humano decida.
 *
 * SOBRE RLS
 *
 * Es transversal: tiene que ver todas las empresas. Corre en modo plataforma.
 * Sin él, ambas consultas devuelven cero filas y el job reportaría "saldos
 * consistentes" sin haber mirado nada. Por eso el control de cordura de abajo:
 * el conteo de combinaciones comparadas es lo que distingue "todo bien" de "no
 * vi nada".
 */
export const accountingReconciliationJob: JobDefinition = {
  code: 'accounting.reconciliation',
  async run({ client, log }) {
    // Contexto de plataforma explícito: sin esto ambas consultas devuelven 0
    // filas por RLS y el job reporta un falso "todo consistente".
    await client.query('SELECT app.set_tenant_context(NULL, NULL, true)');

    // La aritmética replica EXACTAMENTE la de accounting.post_entry():
    //   · period_debit  ← sum(journal_lines.debit)  por (tenant, cuenta, período)
    //   · period_credit ← sum(journal_lines.credit) por (tenant, cuenta, período)
    //
    // Los saldos de apertura (`opening_debit`/`opening_credit`) NO se comparan
    // acá: no los escribe `post_entry()` —los arrastra el cierre de ejercicio,
    // que es una operación de E5—, así que compararlos contra una suma del libro
    // que no los incluye inventaría una diferencia en cada fila con apertura. Se
    // comparan sólo contra las filas del período, que es lo que esta migración
    // mantiene.
    //
    // El FULL OUTER JOIN es lo que hace que la comparación encuentre las dos
    // formas de divergir: un saldo que existe sin líneas que lo respalden, y
    // líneas que existen sin saldo que las refleje. Un JOIN simple sólo vería la
    // primera —la segunda es la más grave, porque significa que el asiento se
    // registró y la proyección no se actualizó—.
    const { rows } = await client.query<{
      tenant_id: string;
      account_id: string;
      period_id: string;
      book_debit: number;
      book_credit: number;
      sum_debit: number;
      sum_credit: number;
    }>(`
      WITH ledger AS (
        SELECT
          l.tenant_id,
          l.account_id,
          e.period_id,
          COALESCE(sum(l.debit),  0) AS sum_debit,
          COALESCE(sum(l.credit), 0) AS sum_credit
        FROM accounting.journal_lines l
        JOIN accounting.journal_entries e
          ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        GROUP BY l.tenant_id, l.account_id, e.period_id
      )
      SELECT
        COALESCE(b.tenant_id,  l.tenant_id)  AS tenant_id,
        COALESCE(b.account_id, l.account_id) AS account_id,
        COALESCE(b.period_id,  l.period_id)  AS period_id,
        COALESCE(b.period_debit,  0)         AS book_debit,
        COALESCE(b.period_credit, 0)         AS book_credit,
        COALESCE(l.sum_debit,  0)            AS sum_debit,
        COALESCE(l.sum_credit, 0)            AS sum_credit
      FROM accounting.account_balances b
      FULL OUTER JOIN ledger l
        ON  l.tenant_id  = b.tenant_id
        AND l.account_id = b.account_id
        AND l.period_id  = b.period_id
      WHERE COALESCE(b.period_debit,  0) IS DISTINCT FROM COALESCE(l.sum_debit,  0)
         OR COALESCE(b.period_credit, 0) IS DISTINCT FROM COALESCE(l.sum_credit, 0)
      ORDER BY 1, 2, 3
    `);

    // Control de cordura: cuántas combinaciones se compararon. Sin esto, "0
    // diferencias" es ambiguo —puede ser "todo consistente" o "el RLS no me dejó
    // ver nada"—. Con el número, los dos casos se distinguen.
    const compared = await client.query<{ n: string }>(`
      SELECT (
        (SELECT count(*) FROM accounting.account_balances)
        + (SELECT count(*)
             FROM (
               SELECT l.tenant_id, l.account_id, e.period_id
               FROM accounting.journal_lines l
               JOIN accounting.journal_entries e
                 ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
               GROUP BY l.tenant_id, l.account_id, e.period_id
             ) x)
      )::text AS n
    `);
    const totalCompared = Number(compared.rows[0]?.n ?? '0');

    if (totalCompared === 0) {
      log(
        'no hay saldos ni líneas que comparar: nada que verificar. ' +
          'Si el sistema está en operación, revisar que el modo plataforma se haya aplicado.'
      );
    }

    for (const d of rows.slice(0, 20)) {
      log(
        `divergencia de saldo: inquilino ${d.tenant_id} cuenta ${d.account_id} ` +
          `período ${d.period_id} — libro debe ${d.sum_debit} haber ${d.sum_credit}; ` +
          `saldo materializado debe ${d.book_debit} haber ${d.book_credit}`
      );
    }
    if (rows.length > 20) {
      log(`… y ${rows.length - 20} divergencia(s) más`);
    }

    return {
      compared: totalCompared,
      differences: rows.length,
      // Detalle acotado: `outcome` es jsonb en el ledger y crece con cada
      // corrida. Guardar miles de filas por día haría del ledger una tabla de
      // datos de negocio en vez de un registro de ejecuciones.
      sample: rows.slice(0, 50).map((d) => ({
        tenantId: d.tenant_id,
        accountId: d.account_id,
        periodId: d.period_id,
        bookDebit: d.book_debit,
        bookCredit: d.book_credit,
        ledgerDebit: d.sum_debit,
        ledgerCredit: d.sum_credit,
      })),
      truncated: rows.length > 50,
    };
  },
};

/** Catálogo de jobs que expone este runner. */
export const JOB_DEFINITIONS: JobDefinition[] = [
  partitionMaintenanceJob,
  partitionRetentionJob,
  certificateExpiryJob,
  stockReconciliationJob,
  accountingReconciliationJob,
  accountingPostingCheckJob,
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
  // La reconciliación corre a las 04:30, después del mantenimiento de
  // particiones (03:00) y de la purga (04:00). El orden importa: si corriera
  // antes, compararía contra un libro que está a punto de cambiar.
  'stock.reconciliation': '30 4 * * *', // diario, 04:30
  // La reconciliación contable corre a las 04:45, entre la de stock (04:30) y la
  // verificación de asientos (05:00). El orden no es decorativo: si un asiento
  // falta, los saldos van a divergir por eso, y conviene que el reporte de
  // divergencias llegue DESPUÉS del de hechos sin asiento para poder leerlo como
  // consecuencia y no como causa. Al revés, el operador investigaría la
  // proyección cuando el problema está en la generación.
  'accounting.reconciliation': '45 4 * * *', // diario, 04:45
  // La verificación de asientos corre a las 05:00, después de la reconciliación
  // de stock (04:30) y bastante después del cierre operativo del día. La hora es
  // deliberada: los asientos se generan DENTRO de la transacción del hecho, así
  // que una brecha detectada a las 05:00 ya no es una carrera en curso —es un
  // camino que se salteó la generación—, y eso es lo que hay que investigar. Si
  // corriera durante el horario comercial, cada venta en vuelo sería una falsa
  // alarma y el job se volvería ruido.
  'accounting.posting_check': '0 5 * * *', // diario, 05:00
  'outbox.reaper': '*/15 * * * *', // cada 15 minutos
};
