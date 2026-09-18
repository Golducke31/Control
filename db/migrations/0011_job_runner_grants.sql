-- =============================================================================
-- Control · 0011 · Permisos del runner de jobs
-- -----------------------------------------------------------------------------
-- MOTIVO
--
-- `0010` creó el ledger en el esquema `ops`, pero el rol que ejecuta los jobs
-- (`control_platform`, único autorizado al modo plataforma) no tiene permisos
-- sobre él. Sin estos grants, el runner falla al registrar la primera ejecución
-- y el ledger queda vacío — que es indistinguible de "los jobs nunca corrieron",
-- justamente el problema que el ledger existe para resolver.
--
-- Se otorga con criterio mínimo: `control_platform` gestiona el ledger y ejecuta
-- los jobs transversales; `control_readonly` sólo consulta la salud de los jobs
-- para el monitoreo. `control_app` NO recibe acceso al ledger: la aplicación de
-- negocio no tiene por qué escribir en el registro de tareas de plataforma.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- El esquema `ops` es de plataforma: sólo los roles de plataforma lo ven.
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA ops TO control_platform, control_readonly;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;

-- control_platform: dueño operativo del ledger.
GRANT SELECT, INSERT, UPDATE ON ops.jobs, ops.job_runs TO control_platform;
GRANT USAGE, SELECT ON SEQUENCE ops.job_runs_id_seq TO control_platform;
GRANT EXECUTE ON FUNCTION ops.begin_job_run(text, text)          TO control_platform;
GRANT EXECUTE ON FUNCTION ops.finish_job_run(bigint, boolean, jsonb, text) TO control_platform;
GRANT EXECUTE ON FUNCTION ops.reap_stuck_job_runs(interval)      TO control_platform;

-- control_readonly: sólo lectura, para dashboards de monitoreo.
GRANT SELECT ON ops.jobs, ops.job_runs, ops.v_job_health TO control_readonly;

-- La aplicación de negocio no toca el ledger.
REVOKE ALL ON ops.jobs, ops.job_runs FROM control_app;
REVOKE ALL ON ops.v_job_health FROM control_app;

-- -----------------------------------------------------------------------------
-- Permisos de datos que necesitan los jobs transversales.
--
-- `control_platform` debe poder leer credenciales de todos los inquilinos (la
-- política RLS lo permite vía is_platform_admin) y operar la cola AFIP. Es un
-- privilegio acotado a mantenimiento, no acceso general a datos de negocio.
-- -----------------------------------------------------------------------------
GRANT SELECT ON billing.afip_credentials TO control_platform;
GRANT SELECT, UPDATE ON billing.afip_outbox TO control_platform;

-- -----------------------------------------------------------------------------
-- Verificación: el ledger debe existir y estar vacío o con historial coherente.
-- Si algún job quedó en 'running' de una corrida anterior, avisar pero no fallar:
-- el reaper lo destraba. Fallar acá impediría el arranque por un estado que es
-- recuperable.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_running int;
  v_jobs    int;
BEGIN
  SELECT count(*) INTO v_jobs    FROM ops.jobs;
  SELECT count(*) INTO v_running FROM ops.job_runs WHERE status = 'running';

  IF v_jobs = 0 THEN
    RAISE EXCEPTION 'El catálogo ops.jobs quedó vacío: la migración 0010 no insertó los jobs.'
      USING ERRCODE = '02000';
  END IF;

  RAISE NOTICE 'Ledger de jobs listo: % jobs registrados, % ejecuciones colgadas por destrabar.',
               v_jobs, v_running;
END $$;

COMMIT;
