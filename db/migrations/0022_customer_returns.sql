-- =============================================================================
-- Control · 0022 · Devolución de cliente: documento propio que revierte stock
--                          y genera la nota de crédito
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- `0015` dejó a `billing.invoices` capaz de representar una nota de crédito
-- (`kind = 'credit_note'`, `related_invoice_id`) y a `billing.apply_credit_note()`
-- capaz de aplicarla al saldo del cliente. Lo que NO existía es el DOCUMENTO que
-- la origina: la devolución de mercadería. Sin él, el camino real de una devolución
-- queda partido en dos operaciones manuales —un ajuste de stock por un lado y una
-- nota de crédito emitida a mano por el otro— sin nada que garantice que:
--
--   1. la mercadería que vuelve es la que efectivamente se facturó, y
--   2. no se devuelve dos veces la misma factura.
--
-- El síntoma concreto: dos devoluciones de 60 sobre una factura de 100 entran las
-- dos, el stock sube 120 unidades que nunca salieron y el cliente queda acreditado
-- por más de lo que compró.
--
-- DECISIÓN (ADR 0006, decisión 3)
--
-- 1. La devolución es un documento propio (`billing.customer_returns` +
--    `billing.customer_return_items`), no una edición de la factura. La
--    contabilidad es inmutable: un comprobante autorizado se revierte con otro
--    comprobante, no corrigiéndolo (Regla 3 del ERP).
-- 2. Ciclo de vida `draft → confirmed → applied` (+ `cancelled`). La garantía de
--    "no devolver de más" es de MOTOR y vive en `apply_customer_return()`, que:
--      (a) valida que la cantidad devuelta por variante no exceda lo facturado en
--          la factura de origen, descontando lo ya devuelto por otras devoluciones
--          YA APLICADAS, y serializa por factura con un lock de asesoría para que
--          dos aplicaciones en paralelo no puedan pasar las dos;
--      (b) revierte el stock con un movimiento `return_in` por
--          `app.apply_stock_movement()` —el único punto de mutación de stock—;
--      (c) emite la nota de crédito como BORRADOR, ligada por `related_invoice_id`.
--    La autorización AFIP y la aplicación al saldo (`billing.apply_credit_note()`)
--    son pasos posteriores, igual que en el camino remito → factura de `0021`.
-- 3. `customer_returns.credit_note_id` guarda la nota de crédito emitida, así que
--    la trazabilidad queda navegable en los dos sentidos: de la devolución a su
--    nota de crédito y a la factura de origen.
--
-- POR QUÉ EL IMPORTE SE CALCULA Y NO SE COPIA
--
-- Los montos de la nota de crédito salen de las líneas de la devolución
-- (`unit_price`, `discount_rate`, `tax_rate`), que son snapshot de lo facturado.
-- No se copian del total de la factura: una devolución parcial tiene que acreditar
-- sólo la parte devuelta.
--
-- POR QUÉ NO SE PASA COSTO AL MOVIMIENTO DE STOCK
--
-- `app.apply_stock_movement()` sólo recalcula `avg_cost` con `purchase_in`; para
-- `return_in` deja el costo promedio intacto, que es el tratamiento correcto (la
-- mercadería vuelve al valor de costo de la empresa, no al precio de venta). Pasar
-- el precio de venta como costo corrompería el libro de movimientos, así que se
-- pasa NULL y la valuación queda en el costo promedio.
--
-- AISLAMIENTO
--
-- RLS FORCE + política de tenant en ambas tablas, FKs compuestas `(tenant_id, id)`
-- y `app.assert_rls_coverage()` al final, como el resto del proyecto. Las funciones
-- son SECURITY INVOKER —no DEFINER— para que RLS y la política de inserción de
-- comprobantes sigan vigentes durante la operación: emitir una nota de crédito
-- exige el permiso `billing.issue_invoice`, y ese control no debe poder saltearse
-- desde una función de base de datos.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1 · Devolución (cabecera)
-- -----------------------------------------------------------------------------
CREATE TABLE billing.customer_returns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,
  customer_id    uuid NOT NULL,
  -- La factura que se devuelve. Es el documento de origen: sin factura no hay
  -- devolución, porque la nota de crédito se aplica contra ella.
  invoice_id     uuid NOT NULL,
  -- A qué depósito vuelve la mercadería.
  warehouse_id   uuid NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
                 -- draft | confirmed | applied | cancelled
  reason         text,
  return_date    date NOT NULL DEFAULT CURRENT_DATE,
  notes          text,
  -- Nota de crédito emitida al aplicar. NULL hasta que se aplica.
  credit_note_id uuid,
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cr_number_unique   UNIQUE (tenant_id, number),
  CONSTRAINT cr_id_tenant       UNIQUE (tenant_id, id),
  CONSTRAINT cr_customer_fk     FOREIGN KEY (tenant_id, customer_id)
    REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cr_invoice_fk      FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cr_warehouse_fk    FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES app.warehouses(tenant_id, id) ON DELETE RESTRICT,
  -- RESTRICT y no SET NULL: `SET NULL` no es compatible con una FK compuesta que
  -- incluye `tenant_id` (columna NOT NULL) — intenta anular la clave entera.
  CONSTRAINT cr_credit_note_fk  FOREIGN KEY (tenant_id, credit_note_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT cr_status_valid    CHECK (status IN ('draft','confirmed','applied','cancelled')),
  -- Una devolución aplicada TIENE que tener su nota de crédito, y una que no lo
  -- está no puede tenerla. Sin esto, una fila `applied` sin comprobante pasaría
  -- como devolución hecha: stock revertido y cliente sin acreditar.
  CONSTRAINT cr_credit_note_state CHECK (
    (status = 'applied' AND credit_note_id IS NOT NULL) OR
    (status <> 'applied' AND credit_note_id IS NULL)
  )
);

CREATE INDEX idx_cr_tenant_status  ON billing.customer_returns(tenant_id, status);
CREATE INDEX idx_cr_tenant_invoice ON billing.customer_returns(tenant_id, invoice_id);
CREATE INDEX idx_cr_tenant_date    ON billing.customer_returns(tenant_id, return_date DESC);

COMMENT ON TABLE billing.customer_returns IS
  'Devolución de cliente: documento que revierte stock y origina la nota de crédito. '
  'Es un documento propio y no una edición de la factura, por la misma razón que '
  '0015 decidió que una nota de crédito es un hecho propio (ADR 0006, decisión 3). '
  'El estado aplicada exige la nota de crédito: la restricción cr_credit_note_state '
  'lo impone en el motor.';

-- La cabecera es una tabla de documento: lleva `updated_at` y su trigger.
CREATE TRIGGER trg_customer_returns_touch BEFORE UPDATE ON billing.customer_returns
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2 · Líneas de la devolución
-- -----------------------------------------------------------------------------
CREATE TABLE billing.customer_return_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  customer_return_id uuid NOT NULL,
  variant_id         uuid,
  description        text NOT NULL,             -- snapshot de la variante
  quantity           numeric(14,3) NOT NULL,    -- cuánto vuelve
  unit_price         numeric(14,2) NOT NULL DEFAULT 0,  -- snapshot de lo facturado
  discount_rate      numeric(5,4)  NOT NULL DEFAULT 0,
  tax_rate           numeric(5,4)  NOT NULL DEFAULT 0.21,
  line_total         numeric(14,2) NOT NULL DEFAULT 0,  -- neto + IVA de la línea

  CONSTRAINT cri_return_fk  FOREIGN KEY (tenant_id, customer_return_id)
    REFERENCES billing.customer_returns(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT cri_variant_fk FOREIGN KEY (tenant_id, variant_id)
    REFERENCES app.product_variants(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT cri_qty_pos    CHECK (quantity > 0)
);

CREATE UNIQUE INDEX cri_tenant_id_uniq ON billing.customer_return_items(tenant_id, id);
CREATE INDEX idx_cri_return ON billing.customer_return_items(tenant_id, customer_return_id);

-- NOTA · por qué esta tabla NO lleva `updated_at` ni trigger `touch_updated_at()`
--
-- Es una tabla de LÍNEAS. El criterio del proyecto es que sólo las tablas de
-- cabecera/documento llevan `updated_at` (`customer_returns`, `delivery_notes`,
-- `sales_orders`, `invoices`), no las de detalle (`delivery_note_items`,
-- `sales_order_items`, `invoice_items`). Ponerle el trigger a una tabla sin esa
-- columna rompe el UPDATE: `app.touch_updated_at()` asigna `NEW.updated_at` y el
-- motor aborta con «el registro new no tiene un campo updated_at». Ese defecto
-- existió en `0021` y se corrigió ahí; acá se evita por construcción.

COMMENT ON COLUMN billing.customer_return_items.quantity IS
  'Cantidad que vuelve al depósito. Se valida contra lo facturado por variante en '
  'la factura de origen, descontando lo ya devuelto por otras devoluciones ya '
  'aplicadas (garantía de motor en apply_customer_return).';

-- -----------------------------------------------------------------------------
-- 3 · Confirmación (draft → confirmed)
-- -----------------------------------------------------------------------------
-- La confirmación es el paso de aprobación: deja la devolución lista para aplicar
-- y detecta temprano el caso sin líneas. La validación contra lo facturado NO vive
-- acá sino en `apply_customer_return()`: entre confirmar y aplicar puede haberse
-- aplicado otra devolución de la misma factura, así que el único momento en que la
-- verificación es concluyente es el punto de no retorno.
CREATE OR REPLACE FUNCTION billing.confirm_customer_return(
  p_tenant_id uuid,
  p_return_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_ret   billing.customer_returns;
  v_lines integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ret
  FROM billing.customer_returns
  WHERE tenant_id = p_tenant_id AND id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La devolución % no existe en esta empresa', p_return_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_ret.status = 'confirmed' THEN
    RETURN 'confirmed';                       -- idempotente
  END IF;

  IF v_ret.status <> 'draft' THEN
    RAISE EXCEPTION
      'La devolución % está en estado «%»: sólo se confirma una en borrador',
      p_return_id, v_ret.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_lines
  FROM billing.customer_return_items
  WHERE tenant_id = p_tenant_id AND customer_return_id = p_return_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION
      'La devolución % no tiene líneas: no hay mercadería que devolver', p_return_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE billing.customer_returns
     SET status = 'confirmed'
   WHERE tenant_id = p_tenant_id AND id = p_return_id;

  RETURN 'confirmed';
END $$;

COMMENT ON FUNCTION billing.confirm_customer_return IS
  'Confirma una devolución en borrador (draft → confirmed). Idempotente sobre una ya '
  'confirmada. Falla si no tiene líneas. No valida cantidades contra lo facturado: eso '
  'ocurre en apply_customer_return(), que es el punto de no retorno.';

-- -----------------------------------------------------------------------------
-- 4 · Aplicación (confirmed → applied): stock + nota de crédito
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.apply_customer_return(
  p_tenant_id     uuid,
  p_return_id     uuid,
  p_doc_type      billing.doc_type,
  p_point_of_sale smallint,
  p_number        bigint
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_ret      billing.customer_returns;
  v_inv      billing.invoices;
  v_line     billing.customer_return_items;
  v_nc       uuid;
  v_net      numeric(14,2) := 0;
  v_tax      numeric(14,2) := 0;
  v_line_net numeric(14,2);
  v_invoiced numeric(14,3);
  v_returned numeric(14,3);
  v_lines    integer := 0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ret
  FROM billing.customer_returns
  WHERE tenant_id = p_tenant_id AND id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La devolución % no existe en esta empresa', p_return_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Aplicar dos veces es el error caro: revertiría el stock y emitiría la nota de
  -- crédito dos veces por la misma mercadería.
  IF v_ret.status = 'applied' THEN
    RAISE EXCEPTION
      'La devolución % ya está aplicada (nota de crédito %)',
      p_return_id, v_ret.credit_note_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ret.status <> 'confirmed' THEN
    RAISE EXCEPTION
      'La devolución % está en estado «%»: sólo se aplica una confirmada',
      p_return_id, v_ret.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- La factura de origen tiene que estar autorizada: se devuelve algo que se
  -- facturó de verdad. Un borrador no es un hecho económico y no admite crédito.
  SELECT * INTO v_inv
  FROM billing.invoices
  WHERE tenant_id = p_tenant_id AND id = v_ret.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La factura % no existe en esta empresa', v_ret.invoice_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_inv.status <> 'authorized' THEN
    RAISE EXCEPTION
      'La factura % % está en estado «%»: sólo se devuelve sobre una autorizada',
      v_inv.doc_type, v_inv.number, v_inv.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Serializa las aplicaciones que compiten por la misma factura.
  --
  -- POR QUÉ UN LOCK DE ASESORÍA Y NO `SELECT ... FOR UPDATE` SOBRE LA FACTURA:
  -- `billing.invoices` tiene la política RESTRICTIVE `invoices_no_update_authorized`
  -- (`USING (status <> 'authorized')`), y `FOR UPDATE` exige privilegio de UPDATE y
  -- evalúa ese USING. El único comprobante sobre el que se puede devolver es
  -- justamente el autorizado, así que no se puede bloquear por esa vía. Sin
  -- serialización, dos devoluciones distintas aplicadas en paralelo contra la misma
  -- factura leerían las dos «aplicado = 0» y las dos pasarían.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_tenant_id::text),
    hashtext(v_ret.invoice_id::text)
  );

  -- ---------------------------------------------------------------------------
  -- 4.a · Validar y revertir stock, y acumular los importes a acreditar
  -- ---------------------------------------------------------------------------
  FOR v_line IN
    SELECT * FROM billing.customer_return_items
    WHERE tenant_id = p_tenant_id AND customer_return_id = p_return_id
    ORDER BY id
  LOOP
    v_lines := v_lines + 1;

    IF v_line.variant_id IS NOT NULL THEN
      -- Cuánto se facturó de esta variante en la factura de origen.
      SELECT COALESCE(sum(ii.quantity), 0) INTO v_invoiced
      FROM billing.invoice_items ii
      WHERE ii.tenant_id = p_tenant_id
        AND ii.invoice_id = v_ret.invoice_id
        AND ii.variant_id = v_line.variant_id;

      -- Cuánto se devolvió YA por otras devoluciones de la misma factura.
      --
      -- Sólo cuentan las APLICADAS. Una devolución confirmada pero todavía no
      -- aplicada no revirtió stock ni emitió comprobante, así que no puede bloquear
      -- una devolución legítima: contar las confirmadas hacía que confirmar dos
      -- devoluciones incompatibles dejara a las dos sin poder aplicarse nunca.
      -- La carrera entre dos aplicaciones en paralelo la cierra el lock de asesoría
      -- tomado arriba, no este filtro.
      SELECT COALESCE(sum(cri.quantity), 0) INTO v_returned
      FROM billing.customer_return_items cri
      JOIN billing.customer_returns cr
        ON cr.tenant_id = cri.tenant_id AND cr.id = cri.customer_return_id
      WHERE cri.tenant_id = p_tenant_id
        AND cr.invoice_id = v_ret.invoice_id
        AND cri.variant_id = v_line.variant_id
        AND cr.status = 'applied'
        AND cr.id <> p_return_id;

      IF v_returned + v_line.quantity > v_invoiced THEN
        RAISE EXCEPTION
          'La devolución excede lo facturado de la variante %: facturado %, ya devuelto %, '
          'se intentó devolver %',
          v_line.variant_id, v_invoiced, v_returned, v_line.quantity
          USING ERRCODE = '23514';
      END IF;

      -- El stock de este modelo es entero (`stock_levels.on_hand` es int y
      -- `apply_stock_movement()` recibe `integer`). Truncar en silencio dejaría el
      -- libro mintiendo, así que una cantidad fraccionaria falla explícitamente.
      IF v_line.quantity <> trunc(v_line.quantity) THEN
        RAISE EXCEPTION
          'La cantidad % de la línea % no es entera: el stock se lleva en unidades enteras',
          v_line.quantity, v_line.id
          USING ERRCODE = 'check_violation';
      END IF;

      -- Único punto de mutación de stock. Sin costo: `return_in` no recalcula el
      -- costo promedio (sólo `purchase_in` lo hace) y pasar el precio de venta
      -- corrompería el libro de movimientos.
      PERFORM app.apply_stock_movement(
        p_tenant_id,
        v_line.variant_id,
        v_ret.warehouse_id,
        'return_in',
        v_line.quantity::integer,
        NULL,
        'customer_return',
        p_return_id,
        COALESCE(v_ret.reason, 'Devolución de cliente')
      );
    END IF;

    v_line_net := round(v_line.unit_price * v_line.quantity * (1 - v_line.discount_rate), 2);
    v_net := v_net + v_line_net;
    v_tax := v_tax + round(v_line_net * v_line.tax_rate, 2);
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION
      'La devolución % no tiene líneas: no hay nada que revertir', p_return_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_net + v_tax <= 0 THEN
    RAISE EXCEPTION
      'La devolución % no tiene importe: una nota de crédito de 0 no acredita nada',
      p_return_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 4.b · Nota de crédito, como BORRADOR
  --       La autorización AFIP es un paso aparte, con su propio correlativo, igual
  --       que en el camino remito → factura. El receptor se copia de la factura de
  --       origen: es el mismo destinatario y el mismo snapshot fiscal.
  -- ---------------------------------------------------------------------------
  INSERT INTO billing.invoices (
    tenant_id, customer_id, order_id, kind, related_invoice_id,
    doc_type, point_of_sale, number, issue_date,
    receptor_doc_type, receptor_doc_number, receptor_name, receptor_tax_condition,
    receptor_address, currency, fx_rate,
    subtotal, discount_total, tax_total, total,
    status, created_by, idempotency_key
  ) VALUES (
    p_tenant_id, v_ret.customer_id, v_inv.order_id, 'credit_note', v_inv.id,
    p_doc_type, p_point_of_sale, p_number, v_ret.return_date,
    v_inv.receptor_doc_type, v_inv.receptor_doc_number, v_inv.receptor_name,
    v_inv.receptor_tax_condition, v_inv.receptor_address, v_inv.currency, v_inv.fx_rate,
    v_net, 0, v_tax, v_net + v_tax,
    'draft', app.current_user_id(), gen_random_uuid()
  )
  RETURNING id INTO v_nc;

  -- Detalle de la nota de crédito: snapshot de las líneas devueltas.
  INSERT INTO billing.invoice_items (
    tenant_id, invoice_id, variant_id, description, quantity,
    unit_price, discount_rate, tax_rate, net_amount, tax_amount, total_amount
  )
  SELECT
    p_tenant_id,
    v_nc,
    cri.variant_id,
    cri.description,
    cri.quantity,
    cri.unit_price,
    cri.discount_rate,
    cri.tax_rate,
    round(cri.unit_price * cri.quantity * (1 - cri.discount_rate), 2),
    round(round(cri.unit_price * cri.quantity * (1 - cri.discount_rate), 2) * cri.tax_rate, 2),
    round(cri.unit_price * cri.quantity * (1 - cri.discount_rate), 2)
      + round(round(cri.unit_price * cri.quantity * (1 - cri.discount_rate), 2) * cri.tax_rate, 2)
  FROM billing.customer_return_items cri
  WHERE cri.tenant_id = p_tenant_id AND cri.customer_return_id = p_return_id;

  -- ---------------------------------------------------------------------------
  -- 4.c · Cerrar la devolución
  --       El CHECK `cr_credit_note_state` exige que `applied` tenga nota de
  --       crédito: el estado y el comprobante se escriben en la misma sentencia.
  -- ---------------------------------------------------------------------------
  UPDATE billing.customer_returns
     SET status = 'applied',
         credit_note_id = v_nc
   WHERE tenant_id = p_tenant_id AND id = p_return_id;

  RETURN v_nc;
END $$;

COMMENT ON FUNCTION billing.apply_customer_return IS
  'Aplica una devolución confirmada: revierte el stock con `return_in` por línea y '
  'emite la nota de crédito como borrador ligada por `related_invoice_id`. Valida que '
  'lo devuelto por variante no exceda lo facturado en la factura de origen, descontando '
  'lo ya devuelto por otras devoluciones YA APLICADAS, y serializa por factura con un '
  'lock de asesoría (garantía de motor, ADR 0006 decisión 3). La autorización AFIP y la '
  'aplicación al saldo con `billing.apply_credit_note()` son pasos posteriores. Devuelve '
  'el id de la nota de crédito. SECURITY INVOKER a propósito: RLS y el permiso '
  '`billing.issue_invoice` siguen vigentes durante la emisión.';

-- -----------------------------------------------------------------------------
-- 5 · RLS e integridad
-- -----------------------------------------------------------------------------
ALTER TABLE billing.customer_returns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.customer_returns      FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.customer_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.customer_return_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY customer_returns_isolation ON billing.customer_returns
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY customer_return_items_isolation ON billing.customer_return_items
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Privilegios. `app.apply_stock_movement` ya está otorgada a `control_app` por `0007`
-- y `billing.invoices` / `billing.invoice_items` por `0021`; las funciones nuevas son
-- INVOKER, así que el rol necesita además los privilegios de tabla que ejercen.
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.customer_returns      TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.customer_return_items TO control_app;

GRANT EXECUTE ON FUNCTION billing.confirm_customer_return(uuid, uuid) TO control_app;
GRANT EXECUTE ON FUNCTION billing.apply_customer_return(uuid, uuid, billing.doc_type, smallint, bigint) TO control_app;

-- La barrera de integridad: toda tabla de negocio nueva queda cubierta por RLS.
DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
