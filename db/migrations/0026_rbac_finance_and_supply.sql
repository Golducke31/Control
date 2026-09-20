-- =============================================================================
-- 0026 · RBAC de finanzas y abastecimiento · aserción de cobertura
-- =============================================================================
--
-- QUÉ HACE
--
-- Crea `app.assert_permissions_covered()`, que falla si el catálogo de permisos
-- quedó incompleto o mal asignado, y la deja disponible para que la llame el
-- seed al terminar.
--
-- POR QUÉ NO SIEMBRA LOS PERMISOS NI LOS ASIGNA
--
-- Por el orden de ejecución: **las migraciones corren antes que el seed**
-- (`tests/_apply_migrations.mjs` y los jobs del CI aplican `db/migrations` y
-- después `db/seed/0001_system_catalog.sql`). En una base nueva, cuando esta
-- migración corre, `app.permissions` y `app.roles` están VACÍAS: los 33 permisos
-- y los 7 roles de sistema los inserta el seed.
--
-- Un `INSERT INTO app.role_permissions SELECT … FROM app.roles WHERE code = 'owner'`
-- puesto acá no fallaría: no insertaría ninguna fila. El permiso quedaría sin
-- asignar y nada lo diría — el mismo modo de falla silenciosa que la migración
-- `0012` documenta en `assert_period_open()` con su `RETURN NULL`. Por eso los
-- permisos viven en el seed, que es idempotente (`ON CONFLICT DO NOTHING`) y por
-- lo tanto también es la vía de upgrade: volver a ejecutarlo agrega lo nuevo sin
-- tocar lo existente.
--
-- POR QUÉ LA ASERCIÓN NO SE EJECUTA ACÁ
--
-- Por la misma razón: en una base nueva `owner` todavía no existe y no tendría los
-- permisos nuevos, así que la aserción fallaría siempre y el pipeline quedaría
-- rojo por un motivo falso. La llama el seed al final, cuando ya sembró permisos y
-- asignaciones; ahí es una comprobación de verdad.
--
-- QUÉ COMPRUEBA
--
--   1. Los 18 códigos que esta fase necesita están en `app.permissions`.
--   2. Cada código respeta `resource.action` — sin esto, `permisosDesconocidos()`
--      del frontend compara contra una clave que nadie va a encontrar.
--   3. Ningún rol de sistema quedó sin ningún permiso. Es la comprobación que
--      habría delatado el defecto del orden de ejecución descrito arriba.
--   4. `owner` tiene todos los permisos. Es la invariante del rol no eliminable:
--      «acceso total», y se rompe en silencio cada vez que alguien agrega un
--      permiso y olvida re-ejecutar el seed.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.assert_permissions_covered()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- Los 18 permisos que cierran el hueco del RBAC: cuatro módulos que no tenían
  -- permiso propio (compras, tesorería, contabilidad, fiscal) más las tareas
  -- programadas. La lista es explícita a propósito: una aserción que sólo mira
  -- «cada recurso tiene algún permiso» dejaría pasar el caso en que el recurso ya
  -- existía por otro permiso y el nuevo nunca se sembró.
  v_esperados text[] := ARRAY[
    'purchasing.read', 'purchasing.write', 'purchasing.receive', 'purchasing.pay',
    'treasury.read', 'treasury.write', 'treasury.reconcile', 'treasury.checks',
    'accounting.read', 'accounting.post', 'accounting.close', 'accounting.manage_accounts',
    'fiscal.read', 'fiscal.determine', 'fiscal.withholdings', 'fiscal.manage_rates',
    'ops.read', 'ops.run'
  ];
  v_faltantes     text[];
  v_rotos         text[];
  v_sin_permisos  text[];
  v_owner_sin     text[];
BEGIN
  -- 1 · Los códigos esperados están sembrados.
  SELECT array_agg(e ORDER BY e)
  INTO v_faltantes
  FROM unnest(v_esperados) AS e
  WHERE NOT EXISTS (SELECT 1 FROM app.permissions p WHERE p.code = e);

  IF coalesce(array_length(v_faltantes, 1), 0) > 0 THEN
    RAISE EXCEPTION
      'Faltan permisos en app.permissions: %. '
      'Ejecutar db/seed/0001_system_catalog.sql (es idempotente y es la vía de upgrade).',
      array_to_string(v_faltantes, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2 · El código respeta `resource.action`.
  SELECT array_agg(p.code ORDER BY p.code)
  INTO v_rotos
  FROM app.permissions p
  WHERE p.resource IS DISTINCT FROM split_part(p.code, '.', 1)
     OR p.action   IS DISTINCT FROM split_part(p.code, '.', 2);

  IF coalesce(array_length(v_rotos, 1), 0) > 0 THEN
    RAISE EXCEPTION
      'Permisos cuyo código no coincide con resource.action: %.',
      array_to_string(v_rotos, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3 · Ningún rol de sistema quedó sin permisos.
  SELECT array_agg(r.code ORDER BY r.code)
  INTO v_sin_permisos
  FROM app.roles r
  WHERE r.tenant_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.role_id = r.id);

  IF coalesce(array_length(v_sin_permisos, 1), 0) > 0 THEN
    RAISE EXCEPTION
      'Roles de sistema sin ningún permiso asignado: %. '
      'Suele significar que una asignación corrió antes de que existieran los roles.',
      array_to_string(v_sin_permisos, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 4 · `owner` tiene todos los permisos.
  SELECT array_agg(p.code ORDER BY p.code)
  INTO v_owner_sin
  FROM app.permissions p
  WHERE NOT EXISTS (
    SELECT 1
    FROM app.role_permissions rp
    JOIN app.roles r ON r.id = rp.role_id
    WHERE r.tenant_id IS NULL
      AND r.code = 'owner'
      AND rp.permission_code = p.code
  );

  IF coalesce(array_length(v_owner_sin, 1), 0) > 0 THEN
    RAISE EXCEPTION
      'El rol owner no tiene estos permisos: %. '
      'Re-ejecutar db/seed/0001_system_catalog.sql para rehacer la asignación total.',
      array_to_string(v_owner_sin, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMENT ON FUNCTION app.assert_permissions_covered() IS
  'Aserción de build: falla si el catálogo de permisos está incompleto, si un código no respeta resource.action, si un rol de sistema quedó sin permisos o si owner no tiene todos. La llama el seed al terminar.';
