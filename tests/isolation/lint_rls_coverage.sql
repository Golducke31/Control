-- =============================================================================
-- Control · lint_rls_coverage.sql
-- -----------------------------------------------------------------------------
-- Chequeo de PR: se ejecuta contra el esquema migrado y FALLA si alguna tabla de
-- negocio no está protegida. Es la versión "sin datos" de la suite de
-- aislamiento: corre rápido, no necesita inquilinos de prueba y detecta el caso
-- que importa — un dev agregó una tabla y olvidó la política (F0-AC2).
--
-- Devuelve 0 filas si todo está bien. Cualquier fila es un defecto a corregir.
--
-- Uso:
--   psql "$DATABASE_URL" -f tests/isolation/lint_rls_coverage.sql
-- =============================================================================

\pset pager off

-- Los esquemas se descubren, no se enumeran: la versión SQL de la aserción debe
-- fallar por el mismo motivo que `app.assert_rls_coverage()`. Si acá hubiera una
-- lista fija y allá descubrimiento, un esquema nuevo daría resultados distintos
-- según cuál de los dos controles se mire.
CREATE TEMP VIEW _project_schemas AS
SELECT n.nspname
FROM pg_namespace n
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
  AND n.nspname NOT LIKE 'pg_temp%'
  AND n.nspname NOT LIKE 'pg_toast_temp%'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.objid
    WHERE d.objid = n.oid AND d.deptype = 'e'
  );

WITH business_tables AS (
  SELECT
    n.nspname                                   AS schema_name,
    c.relname                                   AS table_name,
    c.relkind                                   AS rel_kind,
    c.relispartition                            AS is_partition,
    c.relrowsecurity                            AS rls_enabled,
    c.relforcerowsecurity                       AS rls_forced,
    (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
    EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid
        AND a.attname = 'tenant_id'
        AND a.attnum > 0
        AND NOT a.attisdropped
    )                                            AS has_tenant_id
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname IN (SELECT nspname FROM _project_schemas)
),
violations AS (
  -- 1. Tabla con tenant_id sin FORCE RLS.
  SELECT schema_name, table_name, is_partition,
         'falta FORCE ROW LEVEL SECURITY'::text AS defect
  FROM business_tables
  WHERE has_tenant_id AND NOT rls_forced

  UNION ALL

  -- 2. Tabla con tenant_id sin ninguna política.
  SELECT schema_name, table_name, is_partition,
         'sin politicas RLS'
  FROM business_tables
  WHERE has_tenant_id AND policy_count = 0

  UNION ALL

  -- 3. Política permisiva incondicional: el conteo no la delata, hay que mirar
  --    la expresión. Una PERMISSIVE con USING (true) abre la tabla entera.
  SELECT n.nspname, c.relname, c.relispartition,
         'politica permisiva con USING (true): ' || p.polname
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN (SELECT nspname FROM _project_schemas)
    AND p.polpermissive
    AND pg_get_expr(p.polqual, p.polrelid) = 'true'

  UNION ALL

  -- 4. Tabla sin tenant_id y sin política, en un esquema que no está declarado
  --    como exento. Detecta el esquema nuevo con datos de inquilinos.
  SELECT schema_name, table_name, is_partition,
         'sin tenant_id y sin politica (exencion no declarada)'
  FROM business_tables
  WHERE NOT has_tenant_id
    AND policy_count = 0
    AND NOT (schema_name = 'app' AND table_name IN ('users', 'permissions', 'ui_templates'))
    AND schema_name <> 'ops'
)
SELECT
  schema_name,
  table_name,
  CASE WHEN is_partition THEN 'particion' ELSE 'tabla' END AS kind,
  defect
FROM violations
ORDER BY schema_name, table_name, defect;

-- Recordatorio del invariante que este lint protege.
\echo ''
\echo 'Recordatorio: toda tabla con tenant_id necesita FORCE RLS + politica.'
\echo 'Las particiones NO heredan las politicas del padre: usar app.apply_partition_rls().'
