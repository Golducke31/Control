-- =============================================================================
-- Control · 0021 · Documentos de venta: remito y facturación parcial sin duplicar
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- Hoy `billing.sales_orders` ya lleva `qty_delivered` y un estado de entrega
-- parcial, y `logistics.shipments` cubre el despacho operativo (tracking + POD).
-- Pero NO hay un documento de REMITO: el que autoriza la salida de la mercadería
-- y es el origen de la facturación. El síntoma es exactamente el del gate de E6
-- (V-2): nada impide facturar la misma mercadería dos veces, ni pasarse de lo
-- despachado. Una factura de 60 y otra de 60 sobre un remito de 100 queda en el
-- sistema como si fueran legítimas.
--
-- DECISIÓN (ADR 0006)
--
-- 1. El remito es un documento propio (`billing.delivery_notes` +
--    `billing.delivery_note_items`), separado de la orden y de la factura.
-- 2. Cada línea de remito lleva `qty_invoiced`. La garantía de "no duplicar" es
--    de motor, en tres capas:
--      (a) CHECK (qty_invoiced <= quantity) en la línea;
--      (b) `billing.invoice_delivery_note(...)` incrementa `qty_invoiced` con la
--          línea bloqueada (FOR UPDATE) y valida antes de escribir;
--      (c) `billing.invoice_items.delivery_note_item_id` liga la factura a la
--          línea de remito, así la trazabilidad origen→destino es navegable.
-- 3. El estado del remito deriva del acumulado (invoiced / partially_invoiced).
--
-- El camino orden→factura legado (sin remito) sigue existiendo; la unificación en
-- un motor de facturación único queda como mejora futura y no bloquea el gate.
--
-- AISLAMIENTO
--
-- Toda tabla de negocio nueva lleva RLS FORCE + política de tenant, y las FKs son
-- compuestas `(tenant_id, id)` como el resto del proyecto. `qty_invoiced` es un
-- acumulador derivado, como `payment_status` en 0015.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1 · Remito (cabecera)
-- -----------------------------------------------------------------------------
CREATE TABLE billing.delivery_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number        text NOT NULL,
  order_id      uuid NOT NULL,
  customer_id   uuid NOT NULL,
  shipment_id   uuid,                       -- despacho operativo (tracking/POD), si lo hay
  warehouse_id  uuid,
  status        text NOT NULL DEFAULT 'draft',
                -- draft | issued | partially_invoiced | invoiced | cancelled
  issue_date    date NOT NULL DEFAULT CURRENT_DATE,
  notes         text,
  created_by    uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dn_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT dn_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT dn_order_fk      FOREIGN KEY (tenant_id, order_id)      REFERENCES billing.sales_orders(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT dn_customer_fk   FOREIGN KEY (tenant_id, customer_id)   REFERENCES app.customers(tenant_id, id)     ON DELETE RESTRICT,
  CONSTRAINT dn_shipment_fk   FOREIGN KEY (tenant_id, shipment_id)   REFERENCES logistics.shipments(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT dn_warehouse_fk  FOREIGN KEY (tenant_id, warehouse_id)  REFERENCES app.warehouses(tenant_id, id)   ON DELETE RESTRICT,
  CONSTRAINT dn_status_valid  CHECK (status IN
    ('draft','issued','partially_invoiced','invoiced','cancelled'))
);

-- Índice que habilita las FKs compuestas desde `invoice_items` y el acumulador.
CREATE UNIQUE INDEX dn_tenant_id_uniq ON billing.delivery_notes(tenant_id, id);

CREATE INDEX idx_dn_tenant_status ON billing.delivery_notes(tenant_id, status);
CREATE INDEX idx_dn_tenant_order   ON billing.delivery_notes(tenant_id, order_id);

COMMENT ON TABLE billing.delivery_notes IS
  'Remito: documento que autoriza la salida de mercadería y es el origen de la '
  'facturación. Separado de la orden (compromete) y de la factura (liquida), por la '
  'misma razón que 0003/0005 separan los vocabularios. El estado deriva del '
  'acumulado facturado de sus líneas (ADR 0006, decisión 2).';

CREATE TRIGGER trg_delivery_notes_touch BEFORE UPDATE ON billing.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2 · Líneas del remito y el acumulador de facturado
-- -----------------------------------------------------------------------------
CREATE TABLE billing.delivery_note_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  delivery_note_id uuid NOT NULL,
  variant_id      uuid,
  description     text NOT NULL,             -- snapshot del nombre de la variante
  quantity        numeric(14,3) NOT NULL,    -- despachado en este remito
  qty_invoiced    numeric(14,3) NOT NULL DEFAULT 0,  -- cuánto de esta línea ya se facturó
  unit_price      numeric(14,2) NOT NULL DEFAULT 0,  -- neto unitario (snapshot de la orden)
  discount_rate   numeric(5,4)  NOT NULL DEFAULT 0,
  tax_rate        numeric(5,4)  NOT NULL DEFAULT 0.21,
  line_total      numeric(14,2) NOT NULL DEFAULT 0,  -- total de la línea completa (neto+iva)

  CONSTRAINT dni_note_fk        FOREIGN KEY (tenant_id, delivery_note_id) REFERENCES billing.delivery_notes(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT dni_variant_fk     FOREIGN KEY (tenant_id, variant_id)      REFERENCES app.product_variants(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT dni_qty_pos        CHECK (quantity > 0 AND qty_invoiced >= 0),
  -- Capa (a) de la garantía: el motor rechaza el sobre-facturado aunque la
  -- aplicación lo pidiera. Es lo que hace que la regla no dependa de quien llama.
  CONSTRAINT dni_qty_invoiced   CHECK (qty_invoiced <= quantity)
);

CREATE UNIQUE INDEX dni_tenant_id_uniq ON billing.delivery_note_items(tenant_id, id);
CREATE INDEX idx_dni_note ON billing.delivery_note_items(tenant_id, delivery_note_id);

COMMENT ON COLUMN billing.delivery_note_items.qty_invoiced IS
  'Acumulador del remito ya facturado. Fuente de verdad de V-2: el motor impide '
  'qty_invoiced > quantity (CHECK) y billing.invoice_delivery_note lo incrementa con '
  'la línea bloqueada. Un remito de 100 facturado en 60 + 40 queda en 100 y un tercer '
  'intento es rechazado (ADR 0006, decisión 2).';

-- NOTA · por qué esta tabla NO lleva trigger `touch_updated_at()`
--
-- Sólo las tablas de cabecera/documento llevan `updated_at` y su trigger:
-- `delivery_notes`, `sales_orders`, `invoices`, `afip_credentials`, `afip_outbox`.
-- Las de líneas (`sales_order_items`, `invoice_items`, `invoice_taxes`) no la llevan,
-- y `delivery_note_items` sigue ese mismo criterio.
--
-- El trigger se había copiado de la cabecera y dejaba la migración inaplicable en la
-- práctica: `app.touch_updated_at()` hace `NEW.updated_at := now()`, la tabla no tiene
-- esa columna, y el primer `UPDATE` de `qty_invoiced` desde
-- `billing.invoice_delivery_note()` abortaba con
-- «el registro new no tiene un campo updated_at». El gate V-2 no podía pasar nunca.
--
-- Es un defecto que sólo aparece al EJECUTAR: la migración aplica bien y los `INSERT`
-- del escenario también. Recién el `UPDATE` del acumulador destapa el problema.

-- -----------------------------------------------------------------------------
-- 3 · Ligar la factura (y sus líneas) al remito, para la trazabilidad
-- -----------------------------------------------------------------------------
-- `billing.invoices` gana `delivery_note_id` (origen de la facturación cuando viene
-- de remito). Sigue permitiendo order_id para el camino legado.
ALTER TABLE billing.invoices ADD COLUMN delivery_note_id uuid;

ALTER TABLE billing.invoices
  ADD CONSTRAINT inv_delivery_note_fk
  FOREIGN KEY (tenant_id, delivery_note_id) REFERENCES billing.delivery_notes(tenant_id, id)
  ON DELETE RESTRICT;

-- `billing.invoice_items` gana `delivery_note_item_id` (línea de origen).
ALTER TABLE billing.invoice_items ADD COLUMN delivery_note_item_id uuid;

ALTER TABLE billing.invoice_items
  ADD CONSTRAINT ii_delivery_note_item_fk
  FOREIGN KEY (tenant_id, delivery_note_item_id) REFERENCES billing.delivery_note_items(tenant_id, id)
  ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 4 · Motor de facturación desde remito (la capa (b) de la garantía)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.invoice_delivery_note(
  p_tenant_id       uuid,
  p_delivery_note_id uuid,
  p_doc_type        billing.doc_type,
  p_point_of_sale   smallint,
  p_number          bigint,
  p_items           jsonb,                  -- [{ "delivery_note_item_id": uuid, "quantity": numeric }]
  p_created_by      uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = billing, app, pg_temp
AS $$
DECLARE
  v_dn      billing.delivery_notes;
  v_inv     uuid;
  v_item    jsonb;
  v_line    billing.delivery_note_items;
  v_qty     numeric;
  v_net     numeric(14,2);
  v_tax     numeric(14,2);
  v_total   numeric(14,2) := 0;
  v_status  text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  -- El remito debe existir en esta empresa y no estar cancelado.
  SELECT * INTO v_dn
  FROM billing.delivery_notes
  WHERE id = p_delivery_note_id AND tenant_id = p_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El remito % no existe en esta empresa', p_delivery_note_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_dn.status = 'cancelled' THEN
    RAISE EXCEPTION 'No se puede facturar un remito cancelado'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_dn.status = 'invoiced' THEN
    RAISE EXCEPTION 'El remito ya está facturado en su totalidad'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Cabecera de la factura (borrador; la autorización AFIP es un paso aparte).
  -- Se crea primero para tener v_inv antes de insertar las líneas.
  INSERT INTO billing.invoices
    (tenant_id, order_id, delivery_note_id, customer_id, kind, doc_type,
     point_of_sale, number, issue_date, receptor_name, currency, fx_rate,
     subtotal, discount_total, tax_total, total, status, created_by, idempotency_key)
  VALUES
    (p_tenant_id, v_dn.order_id, p_delivery_note_id, v_dn.customer_id, 'invoice', p_doc_type,
     p_point_of_sale, p_number, v_dn.issue_date, '', 'ARS', 1,
     0, 0, 0, 0, 'draft', p_created_by, gen_random_uuid())
  RETURNING id INTO v_inv;

  -- Validar y acumular en una sola pasada, con cada línea bloqueada (FOR UPDATE).
  -- Sin el bloqueo, dos facturaciones concurrentes de la misma línea podrían sumar
  -- más que lo despachado: la condición de carrera que V-2 existe para evitar.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_line
    FROM billing.delivery_note_items
    WHERE id = (v_item->>'delivery_note_item_id')::uuid
      AND delivery_note_id = p_delivery_note_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La línea % no pertenece a este remito', v_item->>'delivery_note_item_id'
        USING ERRCODE = 'no_data_found';
    END IF;

    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'La cantidad a facturar debe ser positiva'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Capa (b): se valida antes de escribir. El CHECK (capa a) es la red de fondo.
    IF v_line.qty_invoiced + v_qty > v_line.quantity THEN
      RAISE EXCEPTION
        'La línea % supera lo pendiente de facturar del remito (disponible %)',
        v_line.id, (v_line.quantity - v_line.qty_invoiced)
        USING ERRCODE = 'check_violation';
    END IF;

    -- Montos proporcionales a la porción facturada de la línea.
    v_net := round(v_line.unit_price * v_qty * (1 - v_line.discount_rate), 2);
    v_tax := round(v_net * v_line.tax_rate, 2);
    v_total := v_total + v_net + v_tax;

    -- Actualizar el acumulador de la línea (dentro de la transacción y con el lock).
    UPDATE billing.delivery_note_items
    SET qty_invoiced = qty_invoiced + v_qty
    WHERE id = v_line.id;

    -- Crear la línea de factura ligada a la línea de remito (trazabilidad).
    INSERT INTO billing.invoice_items
      (tenant_id, invoice_id, variant_id, description, quantity,
       unit_price, discount_rate, tax_rate, net_amount, tax_amount, total_amount,
       delivery_note_item_id)
    VALUES
      (p_tenant_id, v_inv, v_line.variant_id, v_line.description, v_qty,
       v_line.unit_price, v_line.discount_rate, v_line.tax_rate, v_net, v_tax, v_net + v_tax,
       v_line.id);
  END LOOP;

  -- Total derivado de las líneas (se asienta después de recorrerlas).
  UPDATE billing.invoices
  SET total = v_total, subtotal = v_total
  WHERE id = v_inv;

  -- Actualizar el estado del remito según el acumulado (derivado, no escrito a mano).
  SELECT CASE
           WHEN bool_and(qty_invoiced >= quantity) THEN 'invoiced'
           ELSE 'partially_invoiced'
         END INTO v_status
  FROM billing.delivery_note_items
  WHERE delivery_note_id = p_delivery_note_id AND tenant_id = p_tenant_id;

  UPDATE billing.delivery_notes
  SET status = v_status, updated_at = now()
  WHERE id = p_delivery_note_id;

  RETURN v_inv;
END $$;

COMMENT ON FUNCTION billing.invoice_delivery_note IS
  'Factura un remito en una o varias partes sin duplicar cantidades (gate V-2). '
  'Incrementa qty_invoiced por línea con la línea bloqueada y valida antes de escribir; '
  'el CHECK (qty_invoiced <= quantity) es la red de motor. El estado del remito deriva '
  'del acumulado. Crea la factura como borrador: la autorización AFIP es un paso aparte.';

GRANT EXECUTE ON FUNCTION billing.invoice_delivery_note(
  uuid, uuid, billing.doc_type, smallint, bigint, jsonb, uuid
) TO control_app;

-- -----------------------------------------------------------------------------
-- 5 · RLS e integridad
-- -----------------------------------------------------------------------------
ALTER TABLE billing.delivery_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.delivery_notes        FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.delivery_note_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.delivery_note_items   FORCE  ROW LEVEL SECURITY;

CREATE POLICY delivery_notes_isolation ON billing.delivery_notes
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY delivery_note_items_isolation ON billing.delivery_note_items
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON billing.delivery_notes       TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.delivery_note_items  TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.invoices            TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.invoice_items       TO control_app;

-- La barrera de integridad: toda tabla de negocio nueva queda cubierta por RLS.
DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
