-- =============================================================================
-- Control · 0010 · Registro de tareas programadas (job ledger)
-- -----------------------------------------------------------------------------
-- MOTIVO
--
-- `0009` implementó la creación y la purga de particiones, pero nada las invoca.
-- Un job que existe y no corre es peor que un job ausente: da la apariencia de
-- estar cubierto. La alerta de certificados del plan (§6.4, a 45/30/15 días)
-- tiene el mismo problema: está especificada y no tiene dónde registrarse.
--
-- Esta migración crea el ledger donde todo job programado deja constancia de
-- cada ejecución. Se eligió una tabla de historial en la base y no un simple
-- log de aplicación porque permite responder "¿cuándo corrió esto por última
-- vez?" con una consulta, y sobrevive al reciclado de logs del contenedor.
--
-- Decisión: el ledger NO se poda automáticamente. El historial de ejecuciones
-- es la evidencia de que la plataforma se mantiene; su retención es una decisión
-- operativa, no un default técnico.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Esquema de operaciones de plataforma. Separado de `app`/`billing`/`logistics`
-- porque no contiene datos de ningún inquilino: es infraestructura.
-- La ausencia de `tenant_id` es deliberada y está declarada como exención en
-- `app.assert_rls_coverage()`.
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ops;

COMMENT ON SCHEMA ops IS
  'Operaciones de plataforma: jobs programados e historial de ejecuciones. Sin datos de inquilinos.';

-- -----------------------------------------------------------------------------
-- Catálogo de jobs conocidos. Sin RLS: es configuración de plataforma, no dato
-- de negocio. No lleva tenant_id, así que queda exento de forma explícita.
-- -----------------------------------------------------------------------------
CREATE TABLE ops.jobs (
  code           text PRIMARY KEY,            -- 'partition.maintenance'
  description    text NOT NULL,
  -- Cadencia esperada: si un job no corre dentro de este intervalo, está atrasado.
  expected_every interval NOT NULL,
  -- Cuánto puede atrasarse antes de considerarse una falla operativa.
  grace_period   interval NOT NULL DEFAULT interval '2 hours',
  is_critical    boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.jobs IS
  'Catálogo de tareas programadas. `expected_every` es el contrato de cadencia.';

-- -----------------------------------------------------------------------------
-- Historial de ejecuciones. Append-only: una ejecución no se reescribe.
-- -----------------------------------------------------------------------------
CREATE TABLE ops.job_runs (
  id           bigserial PRIMARY KEY,
  job_code     text NOT NULL REFERENCES ops.jobs(code) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',  -- running|succeeded|failed|skipped
  -- Instancia que ejecutó: en un despliegue con varias réplicas, saber cuál
  -- corrió el job es indispensable para depurar un lock o un efecto duplicado.
  host         text,
  outcome      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,

  CONSTRAINT job_runs_status_valid CHECK (status IN ('running','succeeded','failed','skipped')),
  CONSTRAINT job_runs_finished_consistency
    CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX idx_job_runs_recent ON ops.job_runs(job_code, started_at DESC);

-- Sólo puede haber una ejecución viva por job. Es la garantía a nivel de motor
-- de que dos réplicas no corren el mismo job a la vez, aunque el runner olvide
-- tomar el lock.
CREATE UNIQUE INDEX uq_job_runs_one_running
  ON ops.job_runs(job_code)
  WHERE status = 'running';

COMMENT ON INDEX ops.uq_job_runs_one_running IS
  'Impide dos ejecuciones concurrentes del mismo job, en cualquier instancia.';

-- -----------------------------------------------------------------------------
-- Inicio de una ejecución. Devuelve false si ya hay una corriendo, para que el
-- runner decida saltear en vez de esperar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.begin_job_run(
  p_job_code text,
  p_host     text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.jobs WHERE code = p_job_code AND is_active) THEN
    RAISE EXCEPTION 'Job desconocido o inactivo: %', p_job_code
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO ops.job_runs (job_code, host)
  VALUES (p_job_code, p_host)
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION
  -- unique_violation sobre uq_job_runs_one_running: ya hay una ejecución viva.
  WHEN unique_violation THEN
    RETURN NULL;
END $$;

COMMENT ON FUNCTION ops.begin_job_run(text, text) IS
  'Registra el inicio de una ejecución. Devuelve NULL si ya hay una en curso.';

-- -----------------------------------------------------------------------------
-- Cierre de una ejecución. Sólo cierra la fila que sigue en 'running', así que
-- es idempotente y no puede resucitar una ejecución ya cerrada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.finish_job_run(
  p_run_id    bigint,
  p_succeeded boolean,
  p_outcome   jsonb   DEFAULT '{}'::jsonb,
  p_error     text    DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE ops.job_runs
  SET status      = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
      finished_at = now(),
      outcome     = COALESCE(p_outcome, '{}'::jsonb),
      error       = p_error
  WHERE id = p_run_id
    AND status = 'running';

  -- Cerrar una ejecución ya cerrada no es un error: puede pasar si el runner
  -- registró el cierre y luego se reinició antes de confirmar.
END $$;

COMMENT ON FUNCTION ops.finish_job_run(bigint, boolean, jsonb, text) IS
  'Cierra una ejecución en curso. Idempotente.';

-- -----------------------------------------------------------------------------
-- Ejecuciones colgadas: si un worker muere a mitad de camino, la fila queda en
-- 'running' para siempre y el índice único bloquea todas las corridas futuras
-- del job. Hay que poder destrabarlo de forma explícita y auditable.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.reap_stuck_job_runs(
  p_stale_after interval DEFAULT interval '2 hours'
) RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE ops.job_runs
  SET status      = 'failed',
      finished_at = now(),
      error       = format('Ejecución colgada: sin cierre tras %s. Marcada como fallida por el reaper.',
                           p_stale_after)
  WHERE status = 'running'
    AND started_at < now() - p_stale_after;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION ops.reap_stuck_job_runs(interval) IS
  'Marca como fallidas las ejecuciones sin cierre. Destraba el índice único.';

-- -----------------------------------------------------------------------------
-- Estado de salud de todos los jobs. Es la vista que consume el monitoreo: una
-- consulta responde "¿qué está atrasado o fallando?".
-- -----------------------------------------------------------------------------
CREATE VIEW ops.v_job_health WITH (security_invoker = true) AS
SELECT
  j.code,
  j.description,
  j.is_critical,
  j.expected_every,
  last_run.finished_at                                  AS last_success_at,
  last_run.outcome                                      AS last_outcome,
  running.id IS NOT NULL                                AS is_running,
  -- Un job está atrasado si nunca corrió o si pasó su cadencia + gracia.
  CASE
    WHEN last_run.finished_at IS NULL THEN true
    ELSE now() > last_run.finished_at + j.expected_every + j.grace_period
  END                                                   AS is_overdue,
  EXTRACT(EPOCH FROM (now() - last_run.finished_at))    AS seconds_since_success
FROM ops.jobs j
LEFT JOIN LATERAL (
  SELECT r.* FROM ops.job_runs r
  WHERE r.job_code = j.code AND r.status = 'succeeded'
  ORDER BY r.finished_at DESC
  LIMIT 1
) AS last_run ON true
LEFT JOIN ops.job_runs running
  ON running.job_code = j.code AND running.status = 'running'
WHERE j.is_active;

COMMENT ON VIEW ops.v_job_health IS
  'Salud de los jobs: última ejecución exitosa, atraso y si hay una en curso.';

-- -----------------------------------------------------------------------------
-- Catálogo inicial de jobs. La cadencia declarada acá es el contrato que la
-- vista de salud evalúa contra la realidad.
-- -----------------------------------------------------------------------------
INSERT INTO ops.jobs (code, description, expected_every, grace_period, is_critical) VALUES
  ('partition.maintenance',
   'Crea las particiones de los próximos meses para tracking y auditoría',
   interval '30 days', interval '3 days', true),
  ('partition.retention',
   'Purga particiones de posiciones GPS fuera de la ventana de retención',
   interval '30 days', interval '3 days', false),
  ('certificate.expiry',
   'Alerta de vencimiento de certificados AFIP a 45, 30 y 15 días',
   interval '1 day', interval '6 hours', true),
  ('stock.reconciliation',
   'Compara stock_levels contra la suma de stock_movements y reporta diferencias',
   interval '1 day', interval '12 hours', true),
  ('outbox.reaper',
   'Marca ejecuciones colgadas y reprocesa trabajos muertos de la cola AFIP',
   interval '15 minutes', interval '15 minutes', true)
ON CONFLICT (code) DO NOTHING;

COMMIT;
