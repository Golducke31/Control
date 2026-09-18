-- =============================================================================
-- Control · 0001 · Extensiones, tipos y helpers de sesión (multi-tenant core)
-- -----------------------------------------------------------------------------
-- Estrategia de aislamiento:
--   1. Cada tabla de negocio posee `tenant_id uuid NOT NULL` -> tenants(id).
--   2. RLS se activa con ENABLE + FORCE (FORCE aplica también al owner de tabla).
--   3. El contexto del inquilino se inyecta por sesión con
--      `SET LOCAL app.tenant_id = '<uuid>'` dentro de cada transacción.
--   4. El rol de aplicación NO es superuser y NO es owner de las tablas, por lo
--      que RLS no puede ser evadido desde la app.
--
-- IMPORTANTE (leer antes de correr en producción):
--   PostgreSQL ejecuta las políticas RLS con los privilegios del rol que
--   ejecuta la query. Por eso los helpers de identidad (current_tenant_id,
--   current_user_id) deben ser legibles por `app_user`. La forma limpia es un
--   `SECURITY DEFINER` acotado a un schema interno + REVOKE de acceso público.
--   Ver 0007_hardening.sql.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "citext";     -- emails / slugs case-insensitive
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- índices compuestos GIN

-- -----------------------------------------------------------------------------
-- Schemas
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;      -- helpers de sesión
CREATE SCHEMA IF NOT EXISTS billing;  -- dominio fiscal (AFIP)
CREATE SCHEMA IF NOT EXISTS logistics;-- dominio transporte
CREATE SCHEMA IF NOT EXISTS audit;    -- trazabilidad inmutable

-- -----------------------------------------------------------------------------
-- Tipos enumerados (catálogo cerrado => integridad a nivel de motor)
-- -----------------------------------------------------------------------------
CREATE TYPE app.tenant_status      AS ENUM ('active', 'suspended', 'trial', 'churned');
CREATE TYPE app.industry_vertical  AS ENUM ('retail', 'services', 'distributor', 'logistics', 'mixed');
CREATE TYPE app.user_status        AS ENUM ('invited', 'active', 'suspended');

CREATE TYPE billing.afip_environment AS ENUM ('homologation', 'production');
CREATE TYPE billing.afip_result      AS ENUM ('approved', 'rejected', 'observed', 'error');
CREATE TYPE billing.receipt_kind     AS ENUM ('invoice', 'credit_note', 'debit_note');
CREATE TYPE billing.doc_type         AS ENUM ('A', 'B', 'C', 'E', 'M');

CREATE TYPE logistics.shipment_status AS ENUM (
  'draft',            -- creado, sin despachar
  'preparing',        -- en preparación en depósito
  'ready',            -- listo para despacho
  'in_transit',       -- en tránsito
  'out_for_delivery', -- en reparto (última milla)
  'delivered',        -- entregado
  'incident',         -- incidencia
  'cancelled'
);

CREATE TYPE logistics.stop_kind AS ENUM ('pickup', 'delivery');
CREATE TYPE logistics.stop_state AS ENUM ('pending', 'arrived', 'completed', 'failed', 'skipped');

CREATE TYPE app.stock_move_kind AS ENUM (
  'purchase_in',      -- entrada por compra
  'sale_out',         -- salida por venta
  'transfer_out',     -- salida por transferencia entre depósitos
  'transfer_in',      -- entrada por transferencia entre depósitos
  'adjustment_pos',   -- ajuste positivo (recuento)
  'adjustment_neg',   -- ajuste negativo (merma/rotura)
  'return_in',        -- devolución de cliente
  'reservation',      -- reserva (no afecta cantidad física, afecta disponible)
  'release'           -- liberación de reserva
);

-- -----------------------------------------------------------------------------
-- Contexto de sesión (seteado por el pool de conexiones por request)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

-- true si la request corre en modo plataforma (superadmin de Control).
-- Sólo un rol con privilegio `app.platform_admin` puede setearlo.
CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.platform_admin', true), 'off') = 'on';
$$;

-- Verificación de contexto: falla ruidosamente en vez de filtrar datos.
CREATE OR REPLACE FUNCTION app.assert_tenant_context() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION
      'Tenant context missing: ejecute SET LOCAL app.tenant_id = <uuid> dentro de la transacción'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;
  RETURN v_tenant;
END;
$$;

-- -----------------------------------------------------------------------------
-- Trigger genérico: updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Trigger genérico: coherencia de tenant_id en FKs compuestas.
-- Evita el ataque clásico "apunto una orden al producto de otro inquilino".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'Cross-tenant write blocked on % (tenant_id=%)',
      TG_TABLE_NAME, NEW.tenant_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
