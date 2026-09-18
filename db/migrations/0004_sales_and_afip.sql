-- =============================================================================
-- Control · 0004 · Ventas, comprobantes y AFIP (WSAA / WSFE)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Certificados y credenciales AFIP por empresa
-- -----------------------------------------------------------------------------
-- El CRT/KEY NUNCA se guarda en claro. Se cifra en la capa de aplicación
-- (AES-256-GCM) con una clave maestra externa (KMS / env). Acá sólo persiste el
-- ciphertext + metadata, más el TA (Ticket de Acceso) cacheado.
CREATE TABLE billing.afip_credentials (
  tenant_id            uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE CASCADE,
  environment          billing.afip_environment NOT NULL,
  cuit                 text NOT NULL,
  -- Certificado X.509 y clave privada, cifrados
  cert_pem_enc         bytea NOT NULL,
  key_pem_enc          bytea NOT NULL,
  key_algorithm        text NOT NULL DEFAULT 'AES-256-GCM',
  key_fingerprint      text,                  -- SHA-256 del cert en claro, para verificación
  cert_subject         text,
  cert_not_before      timestamptz,
  cert_not_after       timestamptz,
  -- Ticket de Acceso WSAA cacheado (12h de validez)
  ta_token_enc         bytea,
  ta_sign_enc          bytea,
  ta_expires_at        timestamptz,
  ta_generated_at      timestamptz,
  -- Último número autorizado por punto de venta y tipo de comprobante
  -- { "1": { "1": 1250, "6": 40, "11": 12 } } => ptoVenta -> cbteTipo -> ultimoNro
  last_authorized      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active            boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT afip_cred_cuit CHECK (cuit ~ '^[0-9]{11}$')
);
COMMENT ON TABLE billing.afip_credentials IS
  'Credenciales AFIP por empresa. CRT/KEY y TA cifrados (AES-256-GCM).';

CREATE TRIGGER trg_afip_credentials_touch BEFORE UPDATE ON billing.afip_credentials
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Órdenes de venta
-- -----------------------------------------------------------------------------
CREATE TABLE billing.sales_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,
  customer_id    uuid NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
                 -- draft|confirmed|invoiced|partially_delivered|delivered|cancelled
  channel        text NOT NULL DEFAULT 'pos',  -- pos|ecommerce|phone|wholesale
  currency       char(3) NOT NULL DEFAULT 'ARS',
  fx_rate        numeric(14,6) NOT NULL DEFAULT 1,
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total      numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  paid_total     numeric(14,2) NOT NULL DEFAULT 0,
  warehouse_id   uuid,
  notes          text,
  placed_at      timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT so_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT so_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT so_customer_fk   FOREIGN KEY (tenant_id, customer_id)
    REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT so_warehouse_fk  FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES app.warehouses(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT so_status_valid  CHECK (status IN
    ('draft','confirmed','invoiced','partially_delivered','delivered','cancelled')),
  CONSTRAINT so_totals_pos    CHECK (subtotal >= 0 AND total >= 0 AND tax_total >= 0)
);

CREATE INDEX idx_so_tenant_placed ON billing.sales_orders(tenant_id, placed_at DESC);
CREATE INDEX idx_so_tenant_status ON billing.sales_orders(tenant_id, status);

CREATE TRIGGER trg_sales_orders_touch BEFORE UPDATE ON billing.sales_orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE billing.sales_order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL,
  variant_id     uuid NOT NULL,
  description    text NOT NULL,             -- snapshot: el nombre puede cambiar luego
  quantity       numeric(14,3) NOT NULL,
  unit_price     numeric(14,2) NOT NULL,
  discount_rate  numeric(5,4) NOT NULL DEFAULT 0,
  tax_rate       numeric(5,4) NOT NULL DEFAULT 0.21,
  line_subtotal  numeric(14,2) NOT NULL DEFAULT 0,
  line_tax       numeric(14,2) NOT NULL DEFAULT 0,
  line_total     numeric(14,2) NOT NULL DEFAULT 0,
  qty_delivered  numeric(14,3) NOT NULL DEFAULT 0,

  CONSTRAINT soi_order_fk   FOREIGN KEY (tenant_id, order_id)   REFERENCES billing.sales_orders(tenant_id, id)     ON DELETE CASCADE,
  CONSTRAINT soi_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES app.product_variants(tenant_id, id)   ON DELETE RESTRICT,
  CONSTRAINT soi_qty_pos    CHECK (quantity > 0)
);

CREATE INDEX idx_soi_order ON billing.sales_order_items(tenant_id, order_id);

-- -----------------------------------------------------------------------------
-- Comprobantes AFIP (cabecera)
-- -----------------------------------------------------------------------------
CREATE TABLE billing.invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  order_id         uuid,
  customer_id      uuid NOT NULL,

  kind             billing.receipt_kind NOT NULL DEFAULT 'invoice',
  doc_type         billing.doc_type     NOT NULL DEFAULT 'B',
  -- Pertenece a la Nota de Crédito/Débito cuando kind <> 'invoice'
  related_invoice_id uuid,

  point_of_sale    smallint NOT NULL,
  number           bigint NOT NULL,               -- correlativo AFIP
  issue_date       date NOT NULL DEFAULT CURRENT_DATE,

  -- Identidad fiscal del receptor (snapshot del cliente al momento de emitir)
  receptor_doc_type   smallint NOT NULL DEFAULT 80,  -- 80=CUIT, 96=DNI, 99=consumidor final
  receptor_doc_number text,
  receptor_name       text NOT NULL,
  receptor_tax_condition text NOT NULL DEFAULT 'responsable_inscripto',
  receptor_address    text,

  currency         char(3) NOT NULL DEFAULT 'ARS',
  fx_rate          numeric(14,6) NOT NULL DEFAULT 1,
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount_total   numeric(14,2) NOT NULL DEFAULT 0,
  tax_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,

  -- Resultado AFIP
  cae              text,                       -- Código de Autorización Electrónico (14 dígitos)
  cae_expires_at   date,
  result           billing.afip_result,
  afip_observation text,
  afip_request     jsonb,                      -- payload enviado (sin secretos)
  afip_response    jsonb,                      -- respuesta cruda de WSFE
  -- Idempotencia: la clave del request FECAESolicitar para no duplicar CAE
  idempotency_key  text NOT NULL,

  -- Artefacto renderizado (PDF con branding de la empresa)
  pdf_url          text,
  pdf_sha256       text,

  status           text NOT NULL DEFAULT 'draft',   -- draft|queued|authorized|rejected|cancelled
  created_by       uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inv_id_tenant    UNIQUE (tenant_id, id),
  -- Correlatividad fiscal: no puede haber dos comprobantes con el mismo número
  CONSTRAINT inv_number_unique UNIQUE (tenant_id, point_of_sale, doc_type, number),
  CONSTRAINT inv_idem_unique   UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT inv_order_fk      FOREIGN KEY (tenant_id, order_id)
    REFERENCES billing.sales_orders(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT inv_customer_fk   FOREIGN KEY (tenant_id, customer_id)
    REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inv_related_fk    FOREIGN KEY (tenant_id, related_invoice_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inv_related_kind  CHECK (
    (kind = 'invoice'      AND related_invoice_id IS NULL) OR
    (kind <> 'invoice'     AND related_invoice_id IS NOT NULL)
  ),
  -- Factura A exige CUIT del receptor; C a consumidor final
  CONSTRAINT inv_doc_type_rules CHECK (
    (doc_type = 'A' AND receptor_doc_type = 80 AND receptor_doc_number ~ '^[0-9]{11}$')
    OR (doc_type <> 'A')
  ),
  CONSTRAINT inv_cae_format   CHECK (cae IS NULL OR cae ~ '^[0-9]{14}$'),
  CONSTRAINT inv_status_valid CHECK (status IN ('draft','queued','authorized','rejected','cancelled')),
  CONSTRAINT inv_authorized_has_cae CHECK (result <> 'approved' OR cae IS NOT NULL),
  CONSTRAINT inv_totals_pos   CHECK (subtotal >= 0 AND total >= 0)
);

CREATE INDEX idx_inv_tenant_issue  ON billing.invoices(tenant_id, issue_date DESC);
CREATE INDEX idx_inv_tenant_status ON billing.invoices(tenant_id, status);
CREATE INDEX idx_inv_pending_queue ON billing.invoices(tenant_id, created_at)
  WHERE status IN ('draft','queued');
CREATE INDEX idx_inv_order ON billing.invoices(tenant_id, order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER trg_invoices_touch BEFORE UPDATE ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Líneas del comprobante (snapshot fiscal inmutable)
CREATE TABLE billing.invoice_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  variant_id    uuid,
  description   text NOT NULL,
  quantity      numeric(14,3) NOT NULL,
  unit_price    numeric(14,2) NOT NULL,
  discount_rate numeric(5,4) NOT NULL DEFAULT 0,
  tax_rate      numeric(5,4) NOT NULL DEFAULT 0.21,
  net_amount    numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total_amount  numeric(14,2) NOT NULL DEFAULT 0,

  CONSTRAINT ii_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ii_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES app.product_variants(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ii_qty_pos    CHECK (quantity > 0)
);

CREATE INDEX idx_ii_invoice ON billing.invoice_items(tenant_id, invoice_id);

-- Desglose de IVA por alícuota (requerido por WSFE: array Iva)
CREATE TABLE billing.invoice_taxes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL,
  vat_id       smallint NOT NULL,     -- 5=21%, 4=10.5%, 3=0%, 6=27%
  base_amount  numeric(14,2) NOT NULL,
  rate         numeric(5,4) NOT NULL,
  tax_amount   numeric(14,2) NOT NULL,

  CONSTRAINT it_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT it_unique     UNIQUE (invoice_id, vat_id)
);

-- Bitácora de llamadas a AFIP: trazabilidad forense de cada request/response
CREATE TABLE billing.afip_request_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  invoice_id   uuid,
  operation    text NOT NULL,            -- 'wsaa.login' | 'wsfe.FECAESolicitar' | 'wsfe.FECompUltimoAutorizado'
  endpoint     text NOT NULL,
  http_status  integer,
  duration_ms  integer,
  succeeded    boolean NOT NULL,
  error_code   text,
  error_message text,
  request_body  jsonb,
  response_body jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_afip_log_tenant ON billing.afip_request_log(tenant_id, created_at DESC);
CREATE INDEX idx_afip_log_errors ON billing.afip_request_log(tenant_id, created_at DESC) WHERE NOT succeeded;

-- Cola de reintentos para emisión de comprobantes (AFIP suele caer en picos)
CREATE TABLE billing.afip_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  payload       jsonb NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 7,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  status        text NOT NULL DEFAULT 'pending',  -- pending|processing|done|dead
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT outbox_status_valid CHECK (status IN ('pending','processing','done','dead'))
);

-- Claim atómico de trabajos (SKIP LOCKED) para workers concurrentes
CREATE INDEX idx_outbox_claimable ON billing.afip_outbox(next_attempt_at)
  WHERE status = 'pending';

CREATE TRIGGER trg_afip_outbox_touch BEFORE UPDATE ON billing.afip_outbox
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Pagos / cobranzas
CREATE TABLE billing.payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  order_id    uuid,
  invoice_id  uuid,
  method      text NOT NULL DEFAULT 'cash',  -- cash|transfer|card|mercadopago|credit
  amount      numeric(14,2) NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'ARS',
  reference   text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pay_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pay_order_fk    FOREIGN KEY (tenant_id, order_id)    REFERENCES billing.sales_orders(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT pay_invoice_fk  FOREIGN KEY (tenant_id, invoice_id)  REFERENCES billing.invoices(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT pay_amount_pos  CHECK (amount > 0)
);

CREATE INDEX idx_pay_tenant ON billing.payments(tenant_id, received_at DESC);

COMMIT;
