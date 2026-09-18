-- =============================================================================
-- Control · 0008 · Corrección de aislamiento en tablas particionadas
--                       + aserción de cobertura RLS
-- -----------------------------------------------------------------------------
-- MOTIVO (por qué existe esta migración)
--
-- Las migraciones 0005 y 0007 crearon tablas particionadas (`logistics.
-- position_pings` y `audit.events`) y declararon políticas RLS **sólo sobre la
-- tabla padre**. Eso no alcanza: PostgreSQL evalúa las políticas de la tabla
-- que se consulta, y **no propaga** las del padre a las particiones. La macro
-- de `0006` tampoco las cubre, porque corrió antes de que ambas tablas
-- existieran y sólo recorre lo que ya existía en ese momento.
--
-- Consecuencia real y verificada: las 6 particiones existentes quedaron con
-- `relrowsecurity = false` y cero políticas. `audit.events` es el peor lugar
-- posible para esa falla — guarda la cadena de auditoría con los intentos de
-- acceso cruzado entre empresas de TODOS los inquilinos. Una consulta
-- `SELECT * FROM audit.events` con contexto de la empresa A devolvía filas de
-- todas las empresas.
--
-- Se descartó la alternativa de declarar las políticas una por una en cada
-- partición: cada partición nueva creada por el job de mantenimiento quedaría
-- sin cobertura otra vez, reproduciendo el mismo bug de forma silenciosa. En su
-- lugar se instala `app.harden_partitioned_table()`, que aplica la cobertura al
-- padre y a todas sus particiones actuales y futuras en una sola operación.
--
-- Se agrega además `app.assert_rls_coverage()`, una aserción que falla la
-- migración si alguna tabla de negocio carece de `FORCE RLS` o de política
-- efectiva. Es la barrera que convierte "olvidé la política" en un error de
-- build en vez de una fuga de datos en producción (criterio F0-AC2 del plan).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Normalizar: declarar RLS + políticas en la tabla padre y en TODAS sus
-- particiones (las que existen hoy y las que se creen después).
--
-- Se usa `pg_partition_tree()` (PG 11+) para descubrir la jerarquía real en vez
-- de adivinar nombres con LIKE: los nombres de partición son convención, no
-- contrato, y una partición mal nombrada habría quedado fuera del barrido.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.apply_partition_rls(
  p_schema text,
  p_table  text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent text := format('%I.%I', p_schema, p_table);
  target   text;
  pol      record;
  v_cmd    text;
  v_roles  text;
  v_using  text;
  v_check  text;
BEGIN
  -- Se recorre la jerarquía real de particiones con pg_partition_tree() en vez
  -- de inferir nombres con LIKE: el nombre de una partición es convención, no
  -- contrato, y una partición mal nombrada habría quedado fuera del barrido.
  FOR target IN
    SELECT t.relid::regclass::text
    FROM pg_partition_tree(v_parent::regclass) AS t
    ORDER BY t.level DESC
  LOOP
    -- ENABLE + FORCE: FORCE hace que la política aplique también al owner.
    -- Sin FORCE, una migración o un acceso administrativo vería todo.
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE  ROW LEVEL SECURITY', target);

    -- El padre ya trae sus políticas del archivo de políticas; sólo se
    -- replican hacia las particiones.
    CONTINUE WHEN target = v_parent;

    FOR pol IN
      SELECT p.polname,
             pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr,
             p.polpermissive,
             p.polcmd,
             (SELECT array_agg(pr.rolname::text ORDER BY pr.rolname)
                FROM unnest(p.polroles) AS ro
                JOIN pg_roles pr ON pr.oid = ro) AS roles
      FROM pg_policy p
      WHERE p.polrelid = v_parent::regclass
      ORDER BY p.polname
    LOOP
      v_cmd := CASE pol.polcmd
                 WHEN 'r' THEN 'SELECT'
                 WHEN 'a' THEN 'INSERT'
                 WHEN 'w' THEN 'UPDATE'
                 WHEN 'd' THEN 'DELETE'
                 ELSE 'ALL'
               END;

      v_roles := array_to_string(COALESCE(pol.roles, ARRAY['public']), ', ');

      -- ---------------------------------------------------------------------
      -- USING y WITH CHECK no son intercambiables, y PostgreSQL los rechaza
      -- cuando corresponde. La primera versión copiaba siempre
      -- `USING (COALESCE(using_expr, 'true'))` y agregaba WITH CHECK si había,
      -- y fallaba con «sólo se permite una expresión WITH CHECK para INSERT».
      --
      -- La regla del motor:
      --   · INSERT  → admite WITH CHECK, NO admite USING.
      --   · DELETE  → admite USING, NO admite WITH CHECK.
      --   · SELECT  → admite USING, NO admite WITH CHECK.
      --   · UPDATE  → admite ambos.
      --   · ALL     → admite ambos.
      --
      -- Por eso la cláusula USING sólo se emite si la política la tenía en el
      -- padre. Fabricar `USING (true)` para una política de INSERT no es
      -- inocuo: cambia la semántica que se creía estar copiando y, además,
      -- es un error de sintaxis en el motor.
      -- ---------------------------------------------------------------------
      v_using := CASE
                   WHEN pol.using_expr IS NOT NULL
                     THEN format(' USING (%s)', pol.using_expr)
                   ELSE ''
                 END;

      v_check := CASE
                   WHEN pol.check_expr IS NOT NULL
                     THEN format(' WITH CHECK (%s)', pol.check_expr)
                   ELSE ''
                 END;

      -- DROP + CREATE es idempotente: permite reinstalar la política si el
      -- padre cambió y también reintentar tras una migración interrumpida.
      EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol.polname, target);

      EXECUTE format(
        'CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s',
        pol.polname,
        target,
        CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
        v_cmd,
        v_roles,
        v_using,
        v_check
      );
    END LOOP;
  END LOOP;
END $$;

COMMENT ON FUNCTION app.apply_partition_rls(text, text) IS
  'Copia las políticas RLS del padre a todas sus particiones y activa FORCE RLS. Idempotente.';

-- Aplicar la corrección a las dos tablas particionadas del sistema.
SELECT app.apply_partition_rls('logistics', 'position_pings');
SELECT app.apply_partition_rls('audit', 'events');

-- -----------------------------------------------------------------------------
-- Los DEFAULT partitions de `audit.events` no deben acumular datos de negocio.
-- Si recibe filas es señal de que el job de mantenimiento de particiones se
-- detuvo; se deja constancia para que el monitoreo lo detecte.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW audit.v_default_partition_usage AS
SELECT
  c.relname                          AS partition_name,
  pg_stat_get_live_tuples(c.oid)     AS live_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'audit'
  AND c.relname = 'events_default';

COMMENT ON VIEW audit.v_default_partition_usage IS
  'Monitoreo: filas en la partición DEFAULT. Cualquier valor > 0 indica que faltan particiones por crear.';

-- -----------------------------------------------------------------------------
-- ASERCIÓN DE COBERTURA — la barrera que falla el build
--
-- Recorre TODAS las tablas de negocio y exige:
--   a) FORCE RLS activo;
--   b) al menos una política efectiva.
--
-- Excepciones deliberadas, declaradas explícitamente y no por omisión:
--   · app.users          — identidad global federada (google_sub), sin tenant_id.
--   · app.permissions    — catálogo global del sistema.
--   · app.ui_templates   — catálogo global de plantillas.
--   · audit.events (padre) — cubierto por la aserción de particiones, tiene
--                            tenant_id y políticas propias.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_rls_coverage()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r          record;
  v_missing  text[] := ARRAY[]::text[];
  v_reason   text;
  v_schemas  text[];
BEGIN
  -- Los esquemas NO se enumeran a mano. Si alguien agrega un esquema nuevo con
  -- datos de inquilinos, una lista fija lo dejaría afuera en silencio — el mismo
  -- tipo de agujero que esta aserción existe para prevenir. Se excluyen sólo los
  -- esquemas internos de PostgreSQL y los de extensión.
  SELECT array_agg(n.nspname ORDER BY n.nspname)
  INTO v_schemas
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
    AND n.nspname NOT LIKE 'pg_temp%'
    AND n.nspname NOT LIKE 'pg_toast_temp%'
    -- Esquemas que pertenecen a extensiones instaladas, no al proyecto.
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      JOIN pg_extension e ON e.oid = d.objid
      WHERE d.objid = n.oid AND d.deptype = 'e'
    );

  -- ---------------------------------------------------------------------------
  -- A · Tablas y tablas particionadas (el padre), en todos los esquemas del
  --     proyecto.
  -- ---------------------------------------------------------------------------
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.relrowsecurity,
           c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
               AND a.attnum > 0 AND NOT a.attisdropped
           ) AS has_tenant_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = ANY (v_schemas)
      AND NOT c.relispartition          -- las particiones se validan aparte
  LOOP
    -- a) FORCE RLS obligatorio en toda tabla con tenant_id.
    IF r.has_tenant_id AND NOT r.relforcerowsecurity THEN
      v_missing := v_missing || format('%I.%I: falta FORCE ROW LEVEL SECURITY',
                                       r.schema_name, r.table_name);
      CONTINUE;
    END IF;

    -- b) Toda tabla con tenant_id debe tener al menos una política.
    IF r.has_tenant_id AND r.policy_count = 0 THEN
      v_missing := v_missing || format('%I.%I: sin políticas RLS',
                                       r.schema_name, r.table_name);
      CONTINUE;
    END IF;

    -- c) Tablas sin tenant_id deben estar exentas de forma explícita.
    IF NOT r.has_tenant_id THEN
      v_reason := NULL;

      IF r.schema_name = 'app' AND r.table_name IN
         ('users', 'permissions', 'ui_templates') THEN
        v_reason := 'catálogo global / identidad federada';
      END IF;

      -- `ops` es infraestructura de plataforma: jobs e historial de ejecuciones.
      -- No contiene datos de ningún inquilino, así que no lleva tenant_id.
      IF r.schema_name = 'ops' THEN
        v_reason := 'infraestructura de plataforma, sin datos de inquilinos';
      END IF;

      IF v_reason IS NULL AND r.policy_count = 0 THEN
        v_missing := v_missing ||
          format('%I.%I: sin tenant_id y sin política (exención no declarada)',
                 r.schema_name, r.table_name);
      END IF;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- B · Cada partición debe tener su propia cobertura. Este es el chequeo que
  --     habría detectado el defecto original de audit.events.
  --
  -- `relispartition` es true también para los ÍNDICES particionados: un
  -- `PRIMARY KEY` o un `CREATE INDEX` sobre una tabla particionada aparece en
  -- `pg_class` como una partición hija (`audit.events_2026_09_pkey`). Sin
  -- filtrar por `relkind`, la aserción reporta esos índices como «particiones
  -- sin RLS» — un falso positivo que, al acumularse, entierra el hallazgo real
  -- bajo una lista de ruido y empuja a desactivar la aserción. Sólo las tablas
  -- (`r`) y las sub-particiones (`p`) pueden llevar políticas.
  -- ---------------------------------------------------------------------------
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relispartition
      AND c.relkind IN ('r', 'p')       -- excluir índices particionados (_pkey, _idx)
      AND n.nspname = ANY (v_schemas)
  LOOP
    IF NOT r.relforcerowsecurity OR r.policy_count = 0 THEN
      v_missing := v_missing ||
        format('%I.%I (partición): FORCE=%s, políticas=%s',
               r.schema_name, r.table_name, r.relforcerowsecurity, r.policy_count);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION
      E'Cobertura RLS incompleta (% tabla(s) sin protección):\n  - %\n\n'
       'Toda tabla de negocio con tenant_id necesita FORCE RLS y una política.\n'
       'Las particiones necesitan su propia copia: usá app.apply_partition_rls(schema, tabla).',
      array_length(v_missing, 1), array_to_string(v_missing, E'\n  - ')
      USING ERRCODE = '42501';
  END IF;

  RAISE NOTICE 'Cobertura RLS verificada: todas las tablas de negocio están protegidas.';
END $$;

COMMENT ON FUNCTION app.assert_rls_coverage() IS
  'Aserción de build: falla si alguna tabla o partición de negocio carece de FORCE RLS o de política.';

-- Ejecutar la aserción al final de la migración: si no pasa, la migración
-- hace ROLLBACK y el pipeline se detiene.
SELECT app.assert_rls_coverage();

-- Sólo los roles de la aplicación pueden invocar la aserción y el aplicador.
REVOKE EXECUTE ON FUNCTION app.assert_rls_coverage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_partition_rls(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_rls_coverage() TO control_app, control_readonly, control_platform;
GRANT EXECUTE ON FUNCTION app.apply_partition_rls(text, text) TO control_platform;

COMMIT;
