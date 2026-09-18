-- =============================================================================
-- Control · 0003 · Catálogo, depósitos y stock multi-depósito
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Clientes
-- -----------------------------------------------------------------------------
CREATE TABLE app.customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code           text NOT NULL,
  legal_name     text NOT NULL,
  trade_name     text,
  doc_type       text NOT NULL DEFAULT 'CUIT',
  doc_number     text,                    -- normalizado, sin guiones
  tax_condition  text NOT NULL DEFAULT 'responsable_inscripto',
  email          citext,
  phone          text,
  -- Domicilio estructurado: alimenta el PDF de factura y las rutas de logística
  address_line   text,
  city           text,
  province       text,
  postal_code    text,
  country        char(2) NOT NULL DEFAULT 'AR',
  credit_limit   numeric(14,2),
  -- Geometría para planificación de rutas
  geo            point,
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customers_code_per_tenant UNIQUE (tenant_id, id),
  CONSTRAINT customers_doc_unique      UNIQUE NULLS NOT DISTINCT (tenant_id, doc_type, doc_number),
  CONSTRAINT customers_credit_positive CHECK (credit_limit IS NULL OR credit_limit >= 0)
);

CREATE UNIQUE INDEX uq_customers_code ON app.customers(tenant_id, code);
-- Búsqueda de clientes por similitud de nombre. `gin_trgm_ops` va pegado al
-- nombre de la columna, SIN paréntesis: los paréntesis declaran una expresión, y
-- dentro de una expresión no se puede asociar una clase de operador a una
-- columna. Con `(legal_name gin_trgm_ops)` PostgreSQL responde «error de sintaxis
-- en o cerca de gin_trgm_ops», un mensaje que no menciona ni la extensión ni el
-- paréntesis de más.
CREATE INDEX idx_customers_tenant_search
  ON app.customers USING gin (tenant_id, legal_name gin_trgm_ops);

CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON app.customers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Categorías (árbol auto-referenciado)
-- -----------------------------------------------------------------------------
CREATE TABLE app.categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  parent_id  uuid,
  name       text NOT NULL,
  slug       citext NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,

  CONSTRAINT categories_parent_fk FOREIGN KEY (tenant_id, parent_id)
    REFERENCES app.categories(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT categories_slug_unique UNIQUE (tenant_id, slug),
  CONSTRAINT categories_id_tenant  UNIQUE (tenant_id, id),
  CONSTRAINT categories_no_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX idx_categories_tenant_parent ON app.categories(tenant_id, parent_id);

-- -----------------------------------------------------------------------------
-- Marcas + productos + variantes
-- -----------------------------------------------------------------------------
CREATE TABLE app.brands (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name      text NOT NULL,
  logo_url  text,

  CONSTRAINT brands_name_unique  UNIQUE (tenant_id, name),
  CONSTRAINT brands_id_tenant    UNIQUE (tenant_id, id)
);

CREATE TABLE app.products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  sku           text NOT NULL,               -- SKU del producto padre
  name          text NOT NULL,
  description   text,
  category_id   uuid,
  brand_id      uuid,
  unit          text NOT NULL DEFAULT 'un',
  -- Atributos libres (talle, color, material...) usados para generar variantes
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  track_stock   boolean NOT NULL DEFAULT true,
  tax_rate      numeric(5,4) NOT NULL DEFAULT 0.21,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT products_sku_unique   UNIQUE (tenant_id, sku),
  CONSTRAINT products_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT products_tax_range    CHECK (tax_rate >= 0 AND tax_rate <= 1),
  CONSTRAINT products_category_fk  FOREIGN KEY (tenant_id, category_id)
    REFERENCES app.categories(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT products_brand_fk     FOREIGN KEY (tenant_id, brand_id)
    REFERENCES app.brands(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_products_tenant_active ON app.products(tenant_id) WHERE is_active;
CREATE INDEX idx_products_attributes    ON app.products USING gin (attributes jsonb_path_ops);

CREATE TRIGGER trg_products_touch BEFORE UPDATE ON app.products
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  sku         text NOT NULL,                  -- SKU de la variante (único de venta)
  barcode     text,                           -- EAN-13 / GTIN
  variant_name text,                          -- "Talle L / Negro"
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_price    numeric(14,2) NOT NULL DEFAULT 0,
  list_price    numeric(14,2) NOT NULL DEFAULT 0,
  min_stock     integer NOT NULL DEFAULT 0,   -- umbral de reposición
  weight_grams  integer,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT variants_sku_unique    UNIQUE (tenant_id, sku),
  CONSTRAINT variants_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT variants_barcode_unique UNIQUE NULLS NOT DISTINCT (tenant_id, barcode),
  CONSTRAINT variants_product_fk    FOREIGN KEY (tenant_id, product_id)
    REFERENCES app.products(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT variants_price_coherent CHECK (list_price >= 0 AND cost_price >= 0)
);

CREATE INDEX idx_variants_tenant_product ON app.product_variants(tenant_id, product_id);
CREATE INDEX idx_variants_barcode        ON app.product_variants(tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TRIGGER trg_variants_touch BEFORE UPDATE ON app.product_variants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Listas de precios por empresa (retail, mayorista, distribuidor)
CREATE TABLE app.price_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  currency   char(3) NOT NULL DEFAULT 'ARS',
  multiplier numeric(8,4) NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,

  CONSTRAINT price_lists_unique   UNIQUE (tenant_id, name),
  CONSTRAINT price_lists_id_tenant UNIQUE (tenant_id, id)
);

CREATE TABLE app.price_list_items (
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL,
  variant_id    uuid NOT NULL,
  price         numeric(14,2) NOT NULL,

  PRIMARY KEY (price_list_id, variant_id),
  CONSTRAINT pli_list_fk    FOREIGN KEY (tenant_id, price_list_id)
    REFERENCES app.price_lists(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pli_variant_fk FOREIGN KEY (tenant_id, variant_id)
    REFERENCES app.product_variants(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pli_price_pos  CHECK (price >= 0)
);

-- -----------------------------------------------------------------------------
-- Depósitos
-- -----------------------------------------------------------------------------
CREATE TABLE app.warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  address_line text, city text, province text, postal_code text,
  geo        point,
  is_primary boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT warehouses_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT warehouses_id_tenant   UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX uq_warehouses_primary ON app.warehouses(tenant_id) WHERE is_primary;

CREATE TRIGGER trg_warehouses_touch BEFORE UPDATE ON app.warehouses
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Stock: saldo materializado + libro mayor de movimientos
-- -----------------------------------------------------------------------------
CREATE TABLE app.stock_levels (
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  variant_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  on_hand      integer NOT NULL DEFAULT 0,   -- cantidad física
  reserved     integer NOT NULL DEFAULT 0,   -- comprometida a ventas pendientes
  available    integer GENERATED ALWAYS AS (on_hand - reserved) STORED,
  avg_cost     numeric(14,4) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, variant_id, warehouse_id),
  CONSTRAINT sl_variant_fk   FOREIGN KEY (tenant_id, variant_id)   REFERENCES app.product_variants(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sl_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES app.warehouses(tenant_id, id)       ON DELETE CASCADE,
  CONSTRAINT sl_non_negative CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
);

CREATE INDEX idx_stock_levels_low
  ON app.stock_levels(tenant_id, warehouse_id)
  WHERE available <= 0;

CREATE TRIGGER trg_stock_levels_touch BEFORE UPDATE ON app.stock_levels
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Libro mayor append-only: el saldo se reconstruye desde acá (auditoría total).
CREATE TABLE app.stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  kind          app.stock_move_kind NOT NULL,
  quantity      integer NOT NULL,           -- siempre positivo; el signo lo da `kind`
  unit_cost     numeric(14,4),
  -- Trazabilidad del documento origen
  source_type   text,                       -- 'sale', 'transfer', 'purchase', 'adjustment'
  source_id     uuid,
  -- Transferencias: contraparte
  counterpart_warehouse_id uuid,
  reason        text,
  created_by    uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sm_qty_nonzero CHECK (quantity <> 0),
  CONSTRAINT sm_variant_fk  FOREIGN KEY (tenant_id, variant_id)   REFERENCES app.product_variants(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sm_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES app.warehouses(tenant_id, id)       ON DELETE RESTRICT,
  CONSTRAINT sm_counterpart_fk FOREIGN KEY (tenant_id, counterpart_warehouse_id)
    REFERENCES app.warehouses(tenant_id, id) ON DELETE RESTRICT
);
COMMENT ON TABLE app.stock_movements IS 'Libro mayor append-only de inventario. Nunca se updatea ni se borra.';

CREATE INDEX idx_sm_tenant_created ON app.stock_movements(tenant_id, created_at DESC);
CREATE INDEX idx_sm_variant        ON app.stock_movements(tenant_id, variant_id, created_at DESC);
CREATE INDEX idx_sm_source         ON app.stock_movements(source_type, source_id);

-- Transferencias entre depósitos (documento con estado)
CREATE TABLE app.stock_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id   uuid NOT NULL,
  status            text NOT NULL DEFAULT 'draft',  -- draft|dispatched|received|cancelled
  dispatched_at     timestamptz,
  received_at       timestamptz,
  notes             text,
  created_by        uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT st_code_unique   UNIQUE (tenant_id, code),
  CONSTRAINT st_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT st_from_fk       FOREIGN KEY (tenant_id, from_warehouse_id) REFERENCES app.warehouses(tenant_id, id),
  CONSTRAINT st_to_fk         FOREIGN KEY (tenant_id, to_warehouse_id)   REFERENCES app.warehouses(tenant_id, id),
  CONSTRAINT st_distinct_wr   CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT st_status_valid  CHECK (status IN ('draft','dispatched','received','cancelled'))
);

CREATE TABLE app.stock_transfer_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  transfer_id  uuid NOT NULL,
  variant_id   uuid NOT NULL,
  qty_sent     integer NOT NULL,
  qty_received integer,
  notes        text,

  CONSTRAINT sti_transfer_fk FOREIGN KEY (tenant_id, transfer_id) REFERENCES app.stock_transfers(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sti_variant_fk  FOREIGN KEY (tenant_id, variant_id)  REFERENCES app.product_variants(tenant_id, id),
  CONSTRAINT sti_qty_pos     CHECK (qty_sent > 0 AND (qty_received IS NULL OR qty_received >= 0))
);

CREATE TRIGGER trg_stock_transfers_touch BEFORE UPDATE ON app.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
