-- =============================================================================
-- Control · 0007 · Hardening: roles, grants, audit y defensa en profundidad
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Roles de base de datos
-- -----------------------------------------------------------------------------
-- control_owner     : dueño del schema, corre migraciones. NO lo usa la app.
-- control_app       : rol de la aplicación. Sin BYPASSRLS. RLS lo alcanza.
-- control_readonly  : BI / reportes. RLS alcanza, sólo SELECT.
-- control_platform  : soporte de plataforma. Único autorizado a setear
--                     app.platform_admin = 'on'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_app') THEN
    CREATE ROLE control_app NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_readonly') THEN
    CREATE ROLE control_readonly NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_platform') THEN
    CREATE ROLE control_platform NOLOGIN;
  END IF;
END $$;

-- Los usuarios de login se crean fuera de las migraciones, con credenciales
-- gestionadas por el secret manager. Ej.:
--   CREATE ROLE app_login LOGIN PASSWORD '...' IN ROLE control_app;
--   CREATE ROLE platform_login LOGIN PASSWORD '...' IN ROLE control_platform;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app, billing, logistics, audit TO control_app, control_readonly;

-- `audit` faltaba en el grant de `control_app` — DEFECTO CORREGIDO.
--
-- El grant original sólo incluía `app, billing, logistics` para el rol de
-- aplicación y reservaba `audit` a lectura para `control_readonly`. La
-- consecuencia no era "la app no puede leer la auditoría" (aceptable) sino algo
-- peor: **la app no puede escribirla**. `audit.events` es donde se registran los
-- intentos de acceso cruzado entre empresas; con cero privilegios, el INSERT
-- del log fallaba y la cadena de auditoría quedaba vacía. Un control de
-- seguridad que no registra nada es indistinguible de un control que no existe,
-- y el sistema reportaba "OK" porque nadie miraba una tabla que no podía leer.
--
-- Se otorga INSERT (y SELECT, para que la app pueda mostrar la auditoría de su
-- propia empresa — la política `audit_select` ya lo limita). El append-only se
-- mantiene donde corresponde: los REVOKE de UPDATE/DELETE de abajo, sobre
-- tablas puntuales.
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, billing, logistics TO control_app;
GRANT SELECT ON ALL TABLES IN SCHEMA app, billing, logistics, audit TO control_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, billing, logistics, audit TO control_app;

-- Novedad: `audit.events` todavía NO existe en este punto del archivo (se crea
-- más abajo, en la sección de auditoría). El REVOKE de UPDATE/DELETE sobre esa
-- tabla va allí, después de su CREATE TABLE: un `REVOKE` sobre una relación que
-- no existe falla con «no existe la relación», mientras que `ALTER DEFAULT
-- PRIVILEGES` —que sí puede declararse antes— ya deja el default correcto.

-- Logs append-only: la aplicación agrega filas, nunca las corrige.
REVOKE UPDATE, DELETE ON billing.afip_request_log FROM control_app;
REVOKE UPDATE, DELETE ON app.stock_movements    FROM control_app;
REVOKE UPDATE, DELETE ON logistics.tracking_events FROM control_app;
REVOKE UPDATE, DELETE ON logistics.position_pings  FROM control_app;

-- Capacidad de impersonar tenant para soporte (sólo control_platform)
GRANT control_platform TO control_app WITH ADMIN OPTION;

-- app.current_tenant_id() es SECURITY INVOKER sobre current_setting:
-- no filtra información, puede quedar accesible.
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION app.current_user_id()   TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION app.is_platform_admin() TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION app.is_member_of(uuid)  TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION app.has_permission(text) TO control_app, control_readonly;
-- Los helpers SECURITY DEFINER se mueven a un schema interno: ninguna app
-- necesita invocarlos directamente, sólo el planner desde las políticas.
REVOKE ALL ON FUNCTION app.is_member_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member_of(uuid) TO control_app;

-- Default privileges para tablas futuras.
--
-- Sin esto, una tabla creada por una migración posterior queda sin grants y el
-- acceso falla con «permiso denegado» — que se confunde con un problema de RLS.
-- Los grants directos ya se dieron arriba para lo que existe hoy; esto cubre lo
-- que se cree después.
ALTER DEFAULT PRIVILEGES IN SCHEMA app, billing, logistics
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, billing, logistics, audit
  GRANT USAGE, SELECT ON SEQUENCES TO control_app;
-- En `audit` la app sólo agrega e lee; el default no otorga UPDATE/DELETE.
ALTER DEFAULT PRIVILEGES IN SCHEMA audit
  GRANT SELECT, INSERT ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, billing, logistics, audit
  GRANT SELECT ON TABLES TO control_readonly;

-- -----------------------------------------------------------------------------
-- Protección del contexto de sesión: sólo control_platform setea platform_admin
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_tenant_context(
  p_tenant_id uuid,
  p_user_id   uuid,
  p_platform  boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF p_platform AND NOT pg_has_role(current_user, 'control_platform', 'MEMBER') THEN
    RAISE EXCEPTION 'No autorizado para habilitar modo plataforma'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.tenant_id',      COALESCE(p_tenant_id::text, ''), true);
  PERFORM set_config('app.user_id',        COALESCE(p_user_id::text, ''),   true);
  PERFORM set_config('app.platform_admin', CASE WHEN p_platform THEN 'on' ELSE 'off' END, true);
END;
$$;
COMMENT ON FUNCTION app.set_tenant_context IS
  'Setea el contexto de sesión de forma transaccional (SET LOCAL). Es el único punto de entrada.';

GRANT EXECUTE ON FUNCTION app.set_tenant_context(uuid, uuid, boolean) TO control_app, control_platform;
REVOKE EXECUTE ON FUNCTION app.set_tenant_context(uuid, uuid, boolean) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Audit log inmutable (hash chain: cada fila encadena la anterior)
-- -----------------------------------------------------------------------------
CREATE TABLE audit.events (
  -- La PK incluye `created_at` (la clave de particionamiento), no sólo `id`.
  -- PostgreSQL exige que toda restricción única en una tabla particionada cubra
  -- todas las columnas de particionamiento: el índice único se construye por
  -- partición, y sin la clave de partición no podría garantizar unicidad global.
  -- Con `id bigserial PRIMARY KEY` a secas, la migración falla con «las
  -- restricciones unique en tablas particionadas deben incluir todas las
  -- columnas de particionamiento».
  --
  -- `logistics.position_pings` (0005) ya usa PRIMARY KEY (id, recorded_at); acá
  -- se había omitido. `id` sigue siendo único por sí solo porque es un bigserial
  -- alimentado por una única secuencia.
  id           bigserial,
  tenant_id    uuid,
  actor_user_id uuid,
  actor_kind   text NOT NULL DEFAULT 'user',
  action       text NOT NULL,               -- 'invoice.issued', 'stock.transfer'
  resource     text NOT NULL,
  resource_id  uuid,
  severity     text NOT NULL DEFAULT 'info', -- info|warning|critical
  ip_address   inet,
  user_agent   text,
  request_id   text,
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Encadenamiento criptográfico para detectar manipulación
  prev_hash    text,
  row_hash     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit.events_2026_09 PARTITION OF audit.events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit.events_2026_10 PARTITION OF audit.events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;

-- -----------------------------------------------------------------------------
-- Grants de `audit.events` — van ACÁ, después del CREATE TABLE.
--
-- El bloque de grants del encabezado de esta migración corre antes de que estas
-- tablas existan: un `GRANT ... ON ALL TABLES IN SCHEMA` sólo alcanza lo que ya
-- está creado, así que `audit.events` y sus particiones quedaban afuera. El
-- `ALTER DEFAULT PRIVILEGES` de allá arriba cubre las tablas de migraciones
-- FUTURAS; éstas se otorgan de forma explícita porque ya existen.
--
-- Se otorga a `control_app` (la aplicación) y no sólo a `control_readonly`. La
-- distinción importa: la app INSERTA eventos de auditoría —es su obligación— y
-- `control_readonly` sólo los consulta para monitoreo.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit.events TO control_app;
GRANT SELECT ON audit.events TO control_readonly;

-- Append-only: la aplicación agrega filas, no las reescribe ni las borra. Es una
-- garantía del motor (privilegio), no una convención del código: si un bug
-- intentara `UPDATE audit.events`, PostgreSQL lo rechaza antes de tocar la fila.
REVOKE UPDATE, DELETE, TRUNCATE ON audit.events FROM control_app;

CREATE INDEX idx_audit_tenant_time ON audit.events(tenant_id, created_at DESC);
CREATE INDEX idx_audit_resource    ON audit.events(resource, resource_id);

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events FORCE  ROW LEVEL SECURITY;

CREATE POLICY audit_select ON audit.events
  FOR SELECT TO PUBLIC
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.current_tenant_id()
        AND app.has_permission('audit.read'))
  );

CREATE POLICY audit_insert ON audit.events
  FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY audit_no_mutate ON audit.events
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false);
CREATE POLICY audit_no_delete ON audit.events
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

CREATE OR REPLACE FUNCTION audit.seal_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
BEGIN
  SELECT row_hash INTO v_prev
  FROM audit.events
  WHERE created_at < NEW.created_at
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  NEW.prev_hash := v_prev;
  NEW.row_hash  := encode(
    digest(
      COALESCE(v_prev,'') ||
      COALESCE(NEW.tenant_id::text,'') ||
      COALESCE(NEW.actor_user_id::text,'') ||
      NEW.action || NEW.resource ||
      COALESCE(NEW.resource_id::text,'') ||
      COALESCE(NEW.after_state::text,'') ||
      NEW.created_at::text,
      'sha256'
    ), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_seal BEFORE INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.seal_event();

-- -----------------------------------------------------------------------------
-- Lógica de stock: se aplica en la DB para que sea imposible evitarla
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.apply_stock_movement(
  p_tenant_id    uuid,
  p_variant_id   uuid,
  p_warehouse_id uuid,
  p_kind         app.stock_move_kind,
  p_quantity     integer,
  p_unit_cost    numeric DEFAULT NULL,
  p_source_type  text DEFAULT NULL,
  p_source_id    uuid DEFAULT NULL,
  p_reason       text DEFAULT NULL
) RETURNS app.stock_levels
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_delta integer;
  v_row   app.stock_levels;
BEGIN
  -- El contexto debe coincidir con el tenant operado
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad debe ser positiva (el signo lo determina el tipo de movimiento)';
  END IF;

  v_delta := CASE p_kind
    WHEN 'purchase_in'   THEN  p_quantity
    WHEN 'transfer_in'   THEN  p_quantity
    WHEN 'adjustment_pos'THEN  p_quantity
    WHEN 'return_in'     THEN  p_quantity
    WHEN 'release'       THEN  0
    WHEN 'reservation'   THEN  0
    ELSE -p_quantity  -- sale_out, transfer_out, adjustment_neg
  END;

  -- ---------------------------------------------------------------------------
  -- Upsert del saldo — DEFECTO CORREGIDO.
  --
  -- La versión anterior construía la fila de INSERT con los deltas ya aplicados:
  --
  --   VALUES (…, GREATEST(v_delta, 0), CASE WHEN kind='reservation' THEN qty…)
  --   ON CONFLICT (tenant_id, variant_id, warehouse_id) DO UPDATE …
  --
  -- y fallaba al reservar sobre una fila existente:
  --   «el nuevo registro para la relación "stock_levels" viola la restricción
  --    check "sl_non_negative"»
  --   fila rechazada: (…, on_hand=0, reserved=25, available=-25, …)
  --
  -- La causa no es el delta sino el ORDEN en que PostgreSQL evalúa. Los CHECK
  -- de la tabla se validan sobre la tupla PROPUESTA por el INSERT **antes** de
  -- resolver el conflicto. Con `reservation`, `v_delta` es 0, así que la tupla
  -- propuesta era `on_hand = GREATEST(0,0) = 0` y `reserved = 25`: viola
  -- `reserved <= on_hand` y el motor aborta antes de llegar al `DO UPDATE`, que
  -- era justamente el camino que iba a hacer lo correcto. En otras palabras: la
  -- fila que el INSERT "proponía" era inválida, aunque nunca se fuera a
  -- insertar.
  --
  -- Reservar stock es una operación de todos los días, y fallaba siempre que
  -- `on_hand` fuera menor que la reserva acumulada. Se descubrió ejecutando.
  --
  -- La corrección propone una tupla que SIEMPRE es válida —la cantidad física
  -- que corresponde al alta de una fila nueva— y deja todo el ajuste al
  -- `DO UPDATE`. El caso "primera vez" no cambia: si no hay fila, `v_delta` ya
  -- es la cantidad correcta salvo que sea negativa, y ahí `GREATEST(…, 0)` deja
  -- el saldo en 0 en vez de violar el CHECK de no-negatividad.
  --
  -- `reserved` en el alta arranca en 0 aunque el movimiento sea una reserva:
  -- una reserva sobre un depósito sin saldo no puede dar `reserved > on_hand`.
  -- ---------------------------------------------------------------------------
  INSERT INTO app.stock_levels (tenant_id, variant_id, warehouse_id, on_hand, reserved, avg_cost)
  VALUES (
    p_tenant_id, p_variant_id, p_warehouse_id,
    GREATEST(v_delta, 0),          -- el alta sólo puede nacer con saldo no negativo
    0,                             -- una fila nueva no tiene nada reservado
    COALESCE(p_unit_cost, 0)
  )
  ON CONFLICT (tenant_id, variant_id, warehouse_id) DO UPDATE
    SET on_hand = app.stock_levels.on_hand + v_delta,
        reserved = app.stock_levels.reserved
          + CASE p_kind WHEN 'reservation' THEN p_quantity
                        WHEN 'release'     THEN -p_quantity
                        ELSE 0 END,
        avg_cost = CASE
          WHEN p_kind = 'purchase_in' AND p_unit_cost IS NOT NULL THEN
            CASE WHEN app.stock_levels.on_hand + v_delta <= 0 THEN p_unit_cost
                 ELSE ((app.stock_levels.avg_cost * app.stock_levels.on_hand)
                       + (p_unit_cost * p_quantity))
                      / (app.stock_levels.on_hand + v_delta)
            END
          ELSE app.stock_levels.avg_cost
        END,
        updated_at = now()
  RETURNING * INTO v_row;

  -- El libro mayor se escribe SIEMPRE, incluso si el saldo no cambia (reservas)
  INSERT INTO app.stock_movements (
    tenant_id, variant_id, warehouse_id, kind, quantity, unit_cost,
    source_type, source_id, reason, created_by
  ) VALUES (
    p_tenant_id, p_variant_id, p_warehouse_id, p_kind, p_quantity, p_unit_cost,
    p_source_type, p_source_id, p_reason, app.current_user_id()
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION app.apply_stock_movement IS
  'Único punto de mutación de stock. Actualiza el saldo materializado y escribe el libro mayor de forma atómica.';

GRANT EXECUTE ON FUNCTION app.apply_stock_movement TO control_app;

-- -----------------------------------------------------------------------------
-- Vistas de reporte (security_invoker => heredan RLS de las tablas base)
-- -----------------------------------------------------------------------------
CREATE VIEW app.v_low_stock WITH (security_invoker = true) AS
SELECT
  sl.tenant_id,
  w.id   AS warehouse_id,
  w.name AS warehouse_name,
  p.id   AS product_id,
  p.name AS product_name,
  v.id   AS variant_id,
  v.sku,
  v.min_stock,
  sl.on_hand,
  sl.reserved,
  sl.available,
  GREATEST(v.min_stock - sl.available, 0) AS shortage
FROM app.stock_levels sl
JOIN app.product_variants v ON v.tenant_id = sl.tenant_id AND v.id = sl.variant_id
JOIN app.products p         ON p.tenant_id = v.tenant_id  AND p.id = v.product_id
JOIN app.warehouses w       ON w.tenant_id = sl.tenant_id AND w.id = sl.warehouse_id
WHERE sl.available <= v.min_stock
  AND v.is_active AND p.is_active;

CREATE VIEW billing.v_sales_daily WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.issue_date,
  i.doc_type,
  count(*)          AS invoice_count,
  sum(i.subtotal)   AS net_total,
  sum(i.tax_total)  AS vat_total,
  sum(i.total)      AS gross_total
FROM billing.invoices i
WHERE i.status = 'authorized'
GROUP BY i.tenant_id, i.issue_date, i.doc_type;

CREATE VIEW logistics.v_shipment_board WITH (security_invoker = true) AS
SELECT
  s.tenant_id,
  s.id,
  s.tracking_code,
  s.status,
  s.priority,
  s.dest_address,
  s.scheduled_from,
  s.scheduled_to,
  c.legal_name AS customer_name,
  car.name     AS carrier_name,
  v.plate      AS vehicle_plate,
  EXTRACT(EPOCH FROM (now() - s.dispatched_at))/3600 AS hours_in_transit,
  (SELECT count(*) FROM logistics.tracking_events te
    WHERE te.tenant_id = s.tenant_id AND te.shipment_id = s.id) AS event_count
FROM logistics.shipments s
JOIN app.customers c        ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
LEFT JOIN logistics.carriers car ON car.tenant_id = s.tenant_id AND car.id = s.carrier_id
LEFT JOIN logistics.vehicles v   ON v.tenant_id = s.tenant_id AND v.id = s.vehicle_id;

COMMIT;
-- =============================================================================
-- NOTA OPERATIVA: `security_invoker = true` (PG 15+) es OBLIGATORIO en toda
-- vista. Sin él la vista corre con los privilegios del owner y bypassea RLS,
-- convirtiéndose en una fuga de datos entre inquilinos.
-- =============================================================================
