-- =============================================================================
-- Control · 0009 · Mantenimiento de particiones con cobertura RLS heredada
-- -----------------------------------------------------------------------------
-- MOTIVO
--
-- `logistics.position_pings` y `audit.events` crecen en el tiempo y necesitan
-- una partición nueva por mes. Si el job que las crea no aplica RLS, la
-- partición nace desprotegida y el defecto corregido en `0008` reaparece en
-- silencio el mes siguiente — que es exactamente cómo se originó el bug
-- original.
--
-- Decisión: la creación de particiones NO se hace con `CREATE TABLE ... PARTITION
-- OF` suelto desde el código de aplicación. Se encapsula en
-- `app.ensure_month_partition()`, que en una sola transacción crea la partición
-- y le transfiere la cobertura RLS del padre. Así, la única forma de crear una
-- partición es la que deja el aislamiento en su lugar.
--
-- Se descartó el enfoque de un trigger DDL sobre `pg_event_trigger`: corre en
-- nombre del usuario que ejecuta el DDL, complica la depuración y no permite
-- fallar la operación de negocio de forma clara.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Crea la partición mensual si no existe y le aplica la cobertura RLS del padre.
-- Idempotente: invocarla dos veces para el mismo mes no hace nada la segunda vez.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ensure_month_partition(
  p_parent_schema text,
  p_parent_table  text,
  p_month         date DEFAULT date_trunc('month', now())::date
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_start   date := date_trunc('month', p_month)::date;
  v_end     date := (v_start + interval '1 month')::date;
  v_suffix  text := to_char(v_start, 'YYYY_MM');
  v_name    text := format('%s_%s', p_parent_table, v_suffix);
  v_parent  text := format('%I.%I', p_parent_schema, p_parent_table);
  v_child   text;
BEGIN
  -- La partición sólo puede crearse sobre una tabla particionada real.
  IF NOT EXISTS (
    SELECT 1 FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_parent_schema AND c.relname = p_parent_table
  ) THEN
    RAISE EXCEPTION '% no es una tabla particionada', v_parent
      USING ERRCODE = '42809';
  END IF;

  v_child := format('%I.%I', p_parent_schema, v_name);

  IF to_regclass(v_child) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      v_child, v_parent, v_start, v_end
    );
    RAISE NOTICE 'Partición creada: %', v_child;
  END IF;

  -- Clave del diseño: la cobertura RLS se aplica en la MISMA llamada que crea
  -- la partición. No hay ventana en la que la tabla exista sin protección.
  PERFORM app.apply_partition_rls(p_parent_schema, p_parent_table);

  RETURN v_child;
END $$;

COMMENT ON FUNCTION app.ensure_month_partition(text, text, date) IS
  'Crea la partición mensual si falta y le aplica las políticas RLS del padre. Idempotente.';

-- -----------------------------------------------------------------------------
-- Anticipa N meses hacia adelante. Se invoca desde el job programado para que
-- una partición siempre exista antes de que llegue su primer dato.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ensure_partitions_ahead(p_months int DEFAULT 2)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  i int;
BEGIN
  IF p_months < 1 OR p_months > 24 THEN
    RAISE EXCEPTION 'p_months fuera de rango razonable (1..24): %', p_months
      USING ERRCODE = '22023';
  END IF;

  FOR i IN 0..p_months LOOP
    PERFORM app.ensure_month_partition(
      'logistics', 'position_pings', (date_trunc('month', now()) + (i || ' months')::interval)::date
    );
    PERFORM app.ensure_month_partition(
      'audit', 'events', (date_trunc('month', now()) + (i || ' months')::interval)::date
    );
  END LOOP;

  -- Las particiones nuevas también deben pasar la aserción.
  PERFORM app.assert_rls_coverage();
END $$;

COMMENT ON FUNCTION app.ensure_partitions_ahead(int) IS
  'Crea las particiones de los próximos N meses y verifica la cobertura RLS al final.';

-- -----------------------------------------------------------------------------
-- Higiene de retención: las posiciones GPS son datos operativos de alta
-- frecuencia, no tienen valor fiscal y su retención es acotada. El audit log,
-- en cambio, NO se purga automáticamente: su retención la define el negocio y
-- la normativa, no un default técnico.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.drop_old_position_partitions(p_keep_months int DEFAULT 6)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  r        record;
  v_drop   int := 0;
  v_cutoff date := (date_trunc('month', now()) - (p_keep_months || ' months')::interval)::date;
BEGIN
  IF p_keep_months < 1 THEN
    RAISE EXCEPTION 'p_keep_months debe ser >= 1: %', p_keep_months
      USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT c.oid::regclass AS rel,
           substring(c.relname from '(\d{4}_\d{2})$') AS suffix
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relispartition
      AND n.nspname = 'logistics'
      AND c.relname LIKE 'position_pings_%'
      AND c.relname <> 'position_pings_default'
  LOOP
    -- Sólo se descartan particiones cuyo mes completo quedó atrás del corte.
    IF r.suffix IS NOT NULL
       AND to_date(r.suffix, 'YYYY_MM') < v_cutoff THEN
      EXECUTE format('DROP TABLE %s', r.rel);
      RAISE NOTICE 'Partición GPS eliminada por retención: %', r.rel;
      v_drop := v_drop + 1;
    END IF;
  END LOOP;

  RETURN v_drop;
END $$;

COMMENT ON FUNCTION app.drop_old_position_partitions(int) IS
  'Descarta particiones GPS más antiguas que el corte. NUNCA toca audit.events.';

REVOKE EXECUTE ON FUNCTION app.ensure_month_partition(text, text, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.ensure_partitions_ahead(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.drop_old_position_partitions(int) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.ensure_month_partition(text, text, date) TO control_platform;
GRANT EXECUTE ON FUNCTION app.ensure_partitions_ahead(int) TO control_platform;
GRANT EXECUTE ON FUNCTION app.drop_old_position_partitions(int) TO control_platform;

COMMIT;
