-- =============================================================================
-- Control · 0006 · Row Level Security (RLS) — Aislamiento multi-tenant estricto
-- -----------------------------------------------------------------------------
-- Reglas de diseño aplicadas a TODAS las políticas:
--
--  1. ENABLE + FORCE ROW LEVEL SECURITY: FORCE hace que RLS también aplique al
--     owner de la tabla. Sin FORCE, un `SET ROLE app_owner` (o una migración
--     corriendo como owner) vería todos los tenants.
--
--  2. USING (tenant_id = app.current_tenant_id()) => filtro de lectura y de
--     UPDATE/DELETE. WITH CHECK (tenant_id = app.current_tenant_id()) => impide
--     INSERT/UPDATE que "muevan" una fila a otro inquilino.
--
--  3. app.is_platform_admin() se evalúa como OR para soporte de plataforma.
--     Sólo el rol `control_platform` puede setear `app.platform_admin = 'on'`.
--
--  4. Fail-closed: si no hay contexto, app.current_tenant_id() es NULL y
--     `tenant_id = NULL` es NULL => ninguna fila pasa. El sistema niega por
--     defecto en vez de filtrar datos.
--
--  5. Políticas de escritura sensibles (facturación, stock, roles) se restringen
--     además por permiso RBAC con app.has_permission(...).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- MACRO: activar RLS en todas las tablas con columna tenant_id
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind = 'r'
      AND n.nspname IN ('app','billing','logistics','audit')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',  r.schema_name, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE  ROW LEVEL SECURITY',  r.schema_name, r.table_name);
    RAISE NOTICE 'RLS habilitado (FORCE) en %.%', r.schema_name, r.table_name;
  END LOOP;
END $$;

-- =============================================================================
-- POLÍTICA BASE: una política genérica por tabla
-- Nombre uniforme: `tenant_isolation` (FOR ALL).
-- =============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind = 'r'
      AND n.nspname IN ('app','billing','logistics','audit')
  LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I.%I
        AS PERMISSIVE
        FOR ALL
        TO PUBLIC
        USING (
          tenant_id = app.current_tenant_id()
          OR app.is_platform_admin()
        )
        WITH CHECK (
          tenant_id = app.current_tenant_id()
          OR app.is_platform_admin()
        )
    $f$, r.schema_name, r.table_name);
  END LOOP;
END $$;
COMMENT ON POLICY tenant_isolation ON app.products IS
  'Aislamiento por tenant. Fail-closed: sin contexto de sesión no se ve ninguna fila.';

-- =============================================================================
-- POLÍTICAS REFINADAS: separar lectura de escritura donde el negocio lo exige
-- =============================================================================

-- ---------- app.memberships -------------------------------------------------
-- Se elimina la política genérica y se reemplaza por una que impide que un
-- usuario se auto-asigne un rol con más privilegios.
DROP POLICY IF EXISTS tenant_isolation ON app.memberships;

CREATE POLICY memberships_select ON app.memberships
  FOR SELECT TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Un miembro ve/gestiona su propia fila; un admin gestiona las demás.
CREATE POLICY memberships_insert ON app.memberships
  FOR INSERT TO PUBLIC
  WITH CHECK (
    app.is_platform_admin()
    OR (
      tenant_id = app.current_tenant_id()
      AND app.has_permission('team.invite')
    )
  );

CREATE POLICY memberships_update ON app.memberships
  FOR UPDATE TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('team.manage'))
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('team.manage'))
  );

CREATE POLICY memberships_delete ON app.memberships
  FOR DELETE TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('team.manage'))
  );

-- ---------- app.tenants -----------------------------------------------------
-- El propio tenant se ve a sí mismo. Nadie puede auto-modificar su plan/estado.
--
-- IF EXISTS es obligatorio acá: `app.tenants` NO tiene columna `tenant_id` (su
-- clave es `id`, porque la tabla ES el inquilino), así que la macro genérica de
-- más arriba nunca le creó una política `tenant_isolation`. Sin IF EXISTS, este
-- DROP falla con «no existe la política «tenant_isolation» para la tabla
-- «tenants»» y aborta la migración completa.
--
-- El DROP existe para reemplazar la política genérica FOR ALL por políticas
-- específicas por comando, más restrictivas. Donde no hay genérica que
-- reemplazar, no hacer nada es exactamente lo correcto.
DROP POLICY IF EXISTS tenant_isolation ON app.tenants;

CREATE POLICY tenants_select ON app.tenants
  FOR SELECT TO PUBLIC
  USING (id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY tenants_update ON app.tenants
  FOR UPDATE TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (id = app.current_tenant_id() AND app.has_permission('tenant.settings'))
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (id = app.current_tenant_id() AND app.has_permission('tenant.settings'))
  );
-- Sin política INSERT/DELETE para app_user: sólo la plataforma crea empresas.

-- ---------- app.tenant_branding --------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON app.tenant_branding;

CREATE POLICY branding_select ON app.tenant_branding
  FOR SELECT TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY branding_upsert ON app.tenant_branding
  FOR INSERT TO PUBLIC
  WITH CHECK (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('tenant.branding'))
  );

CREATE POLICY branding_update ON app.tenant_branding
  FOR UPDATE TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('tenant.branding'))
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('tenant.branding'))
  );

-- ---------- billing.invoices: inmutables una vez autorizadas ---------------
CREATE POLICY invoices_no_update_authorized ON billing.invoices
  AS RESTRICTIVE
  FOR UPDATE TO PUBLIC
  USING (status <> 'authorized');

CREATE POLICY invoices_no_delete ON billing.invoices
  AS RESTRICTIVE
  FOR DELETE TO PUBLIC
  USING (status IN ('draft','cancelled'));

CREATE POLICY invoices_insert ON billing.invoices
  AS RESTRICTIVE
  FOR INSERT TO PUBLIC
  WITH CHECK (
    app.is_platform_admin()
    OR app.has_permission('billing.issue_invoice')
    OR app.has_permission('billing.manage')
  );
COMMENT ON POLICY invoices_no_update_authorized ON billing.invoices IS
  'Un comprobante autorizado por AFIP es fiscalmente inmutable: sólo se anula con Nota de Crédito.';

-- ---------- billing.afip_credentials: altamente restringido ----------------
DROP POLICY IF EXISTS tenant_isolation ON billing.afip_credentials;

CREATE POLICY afip_cred_select ON billing.afip_credentials
  FOR SELECT TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('billing.afip_credentials'))
  );

CREATE POLICY afip_cred_write ON billing.afip_credentials
  FOR ALL TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('billing.afip_credentials'))
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('billing.afip_credentials'))
  );

-- ---------- app.stock_movements: libro mayor append-only -------------------
CREATE POLICY stock_movements_no_mutate ON app.stock_movements
  AS RESTRICTIVE
  FOR UPDATE TO PUBLIC
  USING (false);

CREATE POLICY stock_movements_no_delete ON app.stock_movements
  AS RESTRICTIVE
  FOR DELETE TO PUBLIC
  USING (false);
COMMENT ON POLICY stock_movements_no_mutate ON app.stock_movements IS
  'El libro mayor de stock es append-only. Los errores se corrigen con un movimiento inverso.';

-- ---------- billing.afip_request_log: append-only --------------------------
CREATE POLICY afip_log_no_mutate ON billing.afip_request_log
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY afip_log_no_delete ON billing.afip_request_log
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

-- ---------- logistics.tracking_events: append-only ------------------------
CREATE POLICY tracking_events_no_mutate ON logistics.tracking_events
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY tracking_events_no_delete ON logistics.tracking_events
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);
COMMENT ON POLICY tracking_events_no_mutate ON logistics.tracking_events IS
  'Los eventos de tracking son evidencia: inmutables.';

-- ---------- logistics.position_pings: APPEND-only, alto volumen -----------
ALTER TABLE logistics.position_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.position_pings FORCE  ROW LEVEL SECURITY;

CREATE POLICY pings_isolation ON logistics.position_pings
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY pings_no_mutate ON logistics.position_pings
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY pings_no_delete ON logistics.position_pings
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

-- ---------- app.roles / role_permissions ---------------------------------
-- Roles de sistema (tenant_id IS NULL) visibles para todos; los custom sólo
-- para su empresa.
DROP POLICY IF EXISTS tenant_isolation ON app.roles;

CREATE POLICY roles_select ON app.roles
  FOR SELECT TO PUBLIC
  USING (
    tenant_id IS NULL                                   -- rol de sistema
    OR tenant_id = app.current_tenant_id()
    OR app.is_platform_admin()
  );

CREATE POLICY roles_write ON app.roles
  FOR ALL TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('team.manage_roles'))
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id() AND app.has_permission('team.manage_roles'))
  );

-- app.permissions es catálogo global de sólo lectura: RLS no aplica (sin tenant_id)
CREATE POLICY permissions_readonly ON app.permissions
  FOR SELECT TO PUBLIC USING (true);
ALTER TABLE app.permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY permissions_no_write ON app.permissions
  AS RESTRICTIVE FOR ALL TO PUBLIC
  USING (true) WITH CHECK (false);

-- ---------- app.role_permissions ---------------------------------------------
-- DEFECTO CORREGIDO. Hasta acá `app.role_permissions` quedaba con RLS APAGADO
-- (`relrowsecurity = false`) y cero políticas: no tenía `tenant_id`, así que
-- tanto el barrido de arriba como el de la migración 0006 la salteaban en
-- silencio — el JOIN que selecciona tablas busca justamente esa columna.
--
-- La ausencia parecía inocua porque el único consumidor es
-- `app.has_permission()`, que es SECURITY DEFINER. Pero eso protege la FUNCIÓN,
-- no la TABLA: un `SELECT role_id, permission_code FROM app.role_permissions`
-- con el rol de la aplicación devolvía el mapa completo de permisos de TODAS
-- las empresas. Y `role_permissions` es hija de `app.roles`, que sí tiene
-- `tenant_id`: el dato es de inquilino, aunque la columna no esté en esta
-- tabla. Es la variante de fuga que la convención «tenant_id como primera
-- columna» no cubre: tablas hijas que heredan el alcance de su padre.
--
-- El alcance se resuelve por el padre: se ve la fila si el rol es de sistema
-- (tenant_id IS NULL, catálogo compartido) o si pertenece a la empresa activa.
-- No se usa `EXISTS (SELECT FROM app.roles ...)` porque sería una lectura
-- recursiva bajo RLS; la subconsulta directa se evalúa con los privilegios de
-- quien consulta y respeta la política de `app.roles` igual.
CREATE POLICY role_permissions_select ON app.role_permissions
  FOR SELECT TO PUBLIC
  USING (
    app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.roles r
      WHERE r.id = app.role_permissions.role_id
        AND (r.tenant_id IS NULL OR r.tenant_id = app.current_tenant_id())
    )
  );
ALTER TABLE app.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions FORCE  ROW LEVEL SECURITY;

-- La escritura la gobierna la misma capacidad que administra roles: asignar un
-- permiso a un rol es tan sensible como crear el rol. Sin esta separación, un
-- miembro con `team.invite` podría ampliarse privilegios por la puerta de atrás.
CREATE POLICY role_permissions_write ON app.role_permissions
  FOR ALL TO PUBLIC
  USING (
    app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.roles r
      WHERE r.id = app.role_permissions.role_id
        AND r.tenant_id = app.current_tenant_id()
        AND app.has_permission('team.manage_roles')
    )
  )
  WITH CHECK (
    app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.roles r
      WHERE r.id = app.role_permissions.role_id
        AND r.tenant_id = app.current_tenant_id()
        AND app.has_permission('team.manage_roles')
    )
  );

-- =============================================================================
-- Tablas globales sin tenant_id: RLS explícito de sólo lectura
-- =============================================================================
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE  ROW LEVEL SECURITY;

-- Un usuario ve su propio registro y los de las empresas donde es miembro.
CREATE POLICY users_select_self_or_tenant ON app.users
  FOR SELECT TO PUBLIC
  USING (
    id = app.current_user_id()
    OR app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = app.users.id
        AND m.tenant_id = app.current_tenant_id()
        AND m.is_active
    )
  );

CREATE POLICY users_update_self ON app.users
  FOR UPDATE TO PUBLIC
  USING (
    id = app.current_user_id()
    OR app.is_platform_admin()
    OR app.has_permission('team.manage')
  )
  WITH CHECK (
    id = app.current_user_id()
    OR app.is_platform_admin()
    OR app.has_permission('team.manage')
  );

ALTER TABLE app.ui_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY ui_templates_read ON app.ui_templates
  FOR SELECT TO PUBLIC USING (is_active OR app.is_platform_admin());
CREATE POLICY ui_templates_no_write ON app.ui_templates
  AS RESTRICTIVE FOR ALL TO PUBLIC USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());

ALTER TABLE app.permissions ENABLE ROW LEVEL SECURITY;

COMMIT;
