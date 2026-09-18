-- =============================================================================
-- Control · 0002 · Tenancy, identidad (Google OAuth) y RBAC
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- tenants: la raíz del aislamiento. Una fila = una empresa.
-- -----------------------------------------------------------------------------
CREATE TABLE app.tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext NOT NULL UNIQUE,
  legal_name      text   NOT NULL,
  display_name    text   NOT NULL,
  tax_id          text,                      -- CUIT: 11 dígitos sin guiones
  vertical        app.industry_vertical NOT NULL DEFAULT 'retail',
  status          app.tenant_status     NOT NULL DEFAULT 'trial',
  plan            text NOT NULL DEFAULT 'starter',
  -- Configuración fiscal AFIP por empresa (el certificado va cifrado, ver 0005)
  afip_environment billing.afip_environment,
  afip_point_of_sale smallint,               -- Punto de venta habilitado
  timezone        text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  locale          text NOT NULL DEFAULT 'es-AR',
  currency        char(3) NOT NULL DEFAULT 'ARS',
  -- Feature flags declarativos: el menú y los guards del frontend se derivan de acá
  features        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenants_tax_id_format CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{11}$'),
  CONSTRAINT tenants_afip_coherent  CHECK (
    (afip_environment IS NULL AND afip_point_of_sale IS NULL)
    OR (afip_environment IS NOT NULL AND afip_point_of_sale BETWEEN 1 AND 9999)
  )
);
COMMENT ON TABLE app.tenants IS 'Empresas (inquilinos). Raíz del aislamiento multi-tenant.';

CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- white-label: identidad visual + plantilla por rubro
-- -----------------------------------------------------------------------------
CREATE TABLE app.tenant_branding (
  tenant_id        uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE CASCADE,
  logo_url         text,
  logo_dark_url    text,
  favicon_url      text,
  -- Tokens semánticos consumidos por Tailwind / CSS custom properties
  color_primary    text NOT NULL DEFAULT '#6D5EF8',
  color_secondary  text NOT NULL DEFAULT '#22D3EE',
  color_accent     text NOT NULL DEFAULT '#F59E0B',
  color_surface    text NOT NULL DEFAULT '#0B1020',
  color_text       text NOT NULL DEFAULT '#E8ECF8',
  font_heading     text NOT NULL DEFAULT 'Inter',
  font_body        text NOT NULL DEFAULT 'Inter',
  template_key     text NOT NULL DEFAULT 'retail-glass',
  -- Config fina por plantilla (radios, densidad, glass intensity, radius, etc.)
  template_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Membretes de documentos: encabezado/pie, leyendas y sellos
  document_header  jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_footer  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT branding_hex_colors CHECK (
    color_primary ~ '^#[0-9A-Fa-f]{6}$'  AND color_secondary ~ '^#[0-9A-Fa-f]{6}$' AND
    color_accent  ~ '^#[0-9A-Fa-f]{6}$'  AND color_surface   ~ '^#[0-9A-Fa-f]{6}$' AND
    color_text    ~ '^#[0-9A-Fa-f]{6}$'
  )
);
COMMENT ON TABLE app.tenant_branding IS 'Identidad visual whitelabel y plantilla de UI por empresa.';

CREATE TRIGGER trg_branding_touch BEFORE UPDATE ON app.tenant_branding
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Catálogo de plantillas disponibles por rubro (lo controla la plataforma)
CREATE TABLE app.ui_templates (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  vertical       app.industry_vertical NOT NULL,
  description    text,
  preview_url    text,
  default_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active      boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE app.ui_templates IS 'Plantillas de interfaz predefinidas por rubro (retail, servicios, distribuidora).';

-- -----------------------------------------------------------------------------
-- users: identidad federada. Sin password: sólo Google OAuth / Workspace.
-- -----------------------------------------------------------------------------
CREATE TABLE app.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'sub' del ID token de Google: identificador estable e inmutable
  google_sub     text NOT NULL UNIQUE,
  email          citext NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  full_name      text,
  avatar_url     text,
  -- Dominio Workspace del usuario; si la empresa exige hosting domain se valida
  hosted_domain  text,
  locale         text DEFAULT 'es-AR',
  last_login_at  timestamptz,
  status         app.user_status NOT NULL DEFAULT 'invited',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- NOTA: `app.users` es una tabla de identidad GLOBAL (no multi-tenant).
-- Un mismo usuario puede pertenecer a varias empresas vía `memberships`.
COMMENT ON TABLE app.users IS 'Identidad federada (Google OAuth). Global, sin tenant_id.';

CREATE TRIGGER trg_users_touch BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- memberships: relación N:N usuario <-> empresa, con rol y alcance
-- -----------------------------------------------------------------------------
CREATE TABLE app.memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app.users(id)   ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES app.roles(id)   ON DELETE RESTRICT,
  -- Alcance opcional: un usuario puede estar limitado a ciertos depósitos
  warehouse_scope uuid[] DEFAULT NULL,
  invited_by  uuid REFERENCES app.users(id) ON DELETE SET NULL,
  is_owner    boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, user_id)
);
COMMENT ON TABLE app.memberships IS 'Pertenencia de un usuario a una empresa, con rol y alcance.';

CREATE INDEX idx_memberships_user_active ON app.memberships(user_id) WHERE is_active;
CREATE INDEX idx_memberships_tenant      ON app.memberships(tenant_id);
-- Sólo un owner por empresa
CREATE UNIQUE INDEX uq_memberships_single_owner ON app.memberships(tenant_id) WHERE is_owner;

CREATE TRIGGER trg_memberships_touch BEFORE UPDATE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- RBAC
-- -----------------------------------------------------------------------------
CREATE TABLE app.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL => rol de sistema, compartido por todas las empresas
  tenant_id   uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Un código único por tenant; para roles de sistema el unique es global
  CONSTRAINT roles_code_unique UNIQUE NULLS NOT DISTINCT (tenant_id, code)
);
COMMENT ON TABLE app.roles IS 'Roles RBAC. tenant_id NULL = rol de sistema (Owner, Admin, ...).';

CREATE TRIGGER trg_roles_touch BEFORE UPDATE ON app.roles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.permissions (
  code        text PRIMARY KEY,          -- 'inventory.transfer', 'billing.issue_invoice'
  resource    text NOT NULL,             -- 'inventory'
  action      text NOT NULL,             -- 'transfer'
  description text NOT NULL
);
COMMENT ON TABLE app.permissions IS 'Catálogo atómico de permisos (resource.action).';

CREATE TABLE app.role_permissions (
  role_id         uuid NOT NULL REFERENCES app.roles(id)       ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES app.permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- -----------------------------------------------------------------------------
-- Helpers RBAC usados por las políticas RLS
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_member_of(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT p_tenant IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM app.memberships m
       WHERE m.tenant_id = p_tenant
         AND m.user_id   = app.current_user_id()
         AND m.is_active
     );
$$;

CREATE OR REPLACE FUNCTION app.has_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT COALESCE(
    EXISTS (
      SELECT 1
      FROM app.memberships m
      JOIN app.role_permissions rp ON rp.role_id = m.role_id
      WHERE m.tenant_id = app.current_tenant_id()
        AND m.user_id   = app.current_user_id()
        AND m.is_active
        AND rp.permission_code = p_permission
    ), false);
$$;

COMMIT;
