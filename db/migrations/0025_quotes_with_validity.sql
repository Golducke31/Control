-- =============================================================================
-- Control · 0025 · Cotización con validez: oferta que vence y no compromete nada
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- El ADR 0006 nombra tres documentos que en la operación real son distintos:
-- cotización, remito y factura. Los dos últimos existen (`0021`, `0022`). La
-- cotización NO: hoy una oferta con vencimiento no tiene dónde vivir, así que o se
-- manda una orden de venta como si fuera una cotización —comprometiendo stock y
-- quedando en el circuito como un pedido firme— o se cotiza fuera del sistema.
--
-- DECISIÓN (ADR 0006)
--
-- La cotización es un documento propio: una OFERTA CON VALIDEZ, que vence y **no
-- compromete stock ni genera asiento**. Esas dos negaciones son la definición, no un
-- detalle de implementación, y se verifican:
--
--   · No compromete stock: no emite ningún movimiento, ni siquiera una `reservation`.
--     Reservar en la cotización sería comprometer mercadería por una oferta que
--     puede no aceptarse nunca.
--   · No genera asiento: no es un hecho económico. `accounting.v_posting_gaps` sólo
--     mira facturas autorizadas y movimientos de stock valuados, así que una
--     cotización no puede aparecer ahí ni por descuido.
--
-- CICLO DE VIDA
--
--   draft ──issue──> issued ──accept──> accepted
--     │                │  │
--     │                │  └── (valid_until < fecha) ⇒ VENCIDA: requiere reconfirmación
--     │                └──reconfirm──> issued (con nueva validez)
--     └────── cancel ──┴─────────────> cancelled
--                      └──── reject ──> rejected
--
-- POR QUÉ `expired` NO ES UN ESTADO ALMACENADO
--
-- El vencimiento se DERIVA de `valid_until`, no se escribe. Un `status = 'expired'`
-- guardado en la fila exigiría un job que lo ponga, y entre el vencimiento real y la
-- corrida del job la fila mentiría —que es el defecto que el proyecto ya pagó con
-- `payment_status`—. Peor: si el job no corre, miente para siempre. Lo derivado no
-- puede mentir.
--
-- La contrapartida es que la fecha no puede salir de `now()`: por eso las funciones
-- de enforcement (`accept_quote`) RECIBEN la fecha, igual que `fiscal.rates_on()` y
-- `app.price_for()`. La vista `billing.v_quotes` sí usa la fecha de hoy, porque es
-- para listar; el cumplimiento usa la fecha explícita, porque es para decidir.
--
-- PRECIO
--
-- La cotización se cotiza desde una LISTA de precios (`0023`), y `add_quote_item()`
-- resuelve el precio con `app.price_for()` a la fecha indicada. Si no hay precio
-- configurado, FALLA: no se inventa un 0. El `tax_rate` sale del producto y la
-- descripción de la variante, así que la línea es un snapshot y la cotización no
-- cambia si el catálogo cambia después.
--
-- AISLAMIENTO
--
-- Tablas nuevas con RLS FORCE + política de tenant, FKs compuestas `(tenant_id, id)`
-- y `app.assert_rls_coverage()` al final. Las funciones son SECURITY INVOKER: RLS
-- sigue vigente durante toda la operación.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1 · Cotización (cabecera)
-- -----------------------------------------------------------------------------
CREATE TABLE billing.quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number        text NOT NULL,
  customer_id   uuid NOT NULL,
  -- La lista de precios desde la que se cotizó. Es la trazabilidad del precio: sin
  -- esto, re-cotizar la misma oferta no se puede explicar.
  price_list_id uuid NOT NULL,
  status        text NOT NULL DEFAULT 'draft',
                -- draft | issued | accepted | rejected | cancelled
                -- `expired` NO se almacena: se deriva de valid_until (ver cabecera).
  -- La validez. `valid_until` es la fecha hasta la que la oferta se sostiene,
  -- inclusive: el último día en que sigue siendo aceptable.
  valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  valid_until   date NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'ARS',
  fx_rate       numeric(14,6) NOT NULL DEFAULT 1,
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total     numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  notes         text,
  created_by    uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT q_number_unique   UNIQUE (tenant_id, number),
  CONSTRAINT q_id_tenant       UNIQUE (tenant_id, id),
  CONSTRAINT q_customer_fk     FOREIGN KEY (tenant_id, customer_id)
    REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT q_price_list_fk   FOREIGN KEY (tenant_id, price_list_id)
    REFERENCES app.price_lists(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT q_status_valid    CHECK (status IN
    ('draft','issued','accepted','rejected','cancelled')),
  CONSTRAINT q_validity_range  CHECK (valid_until >= valid_from),
  CONSTRAINT q_totals_pos      CHECK (subtotal >= 0 AND total >= 0 AND tax_total >= 0)
);

CREATE INDEX idx_q_tenant_status  ON billing.quotes(tenant_id, status);
CREATE INDEX idx_q_tenant_valid   ON billing.quotes(tenant_id, valid_until);
CREATE INDEX idx_q_tenant_customer ON billing.quotes(tenant_id, customer_id);

COMMENT ON TABLE billing.quotes IS
  'Cotización: oferta con validez que NO compromete stock ni genera asiento. '
  '`expired` no se almacena —se derivaría mal y entre el vencimiento y la corrida de un '
  'job la fila mentiría—: se deriva de valid_until, y accept_quote() lo hace cumplir '
  'recibiendo la fecha de forma explícita (ADR 0006).';
COMMENT ON COLUMN billing.quotes.valid_until IS
  'Último día en que la oferta se sostiene, inclusive. Pasada esa fecha la cotización '
  'está vencida y aceptarla exige reconfirmar primero: es el criterio V-1 del plan.';

-- La cabecera es una tabla de documento: `updated_at` y su trigger.
CREATE TRIGGER trg_quotes_touch BEFORE UPDATE ON billing.quotes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2 · Líneas de la cotización
-- -----------------------------------------------------------------------------
CREATE TABLE billing.quote_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  quote_id      uuid NOT NULL,
  variant_id    uuid,
  description   text NOT NULL,               -- snapshot del nombre al cotizar
  quantity      numeric(14,3) NOT NULL,
  unit_price    numeric(14,2) NOT NULL DEFAULT 0,
  discount_rate numeric(5,4)  NOT NULL DEFAULT 0,
  tax_rate      numeric(5,4)  NOT NULL DEFAULT 0.21,
  line_total    numeric(14,2) NOT NULL DEFAULT 0,  -- neto + IVA de la línea

  CONSTRAINT qi_quote_fk   FOREIGN KEY (tenant_id, quote_id)
    REFERENCES billing.quotes(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT qi_variant_fk FOREIGN KEY (tenant_id, variant_id)
    REFERENCES app.product_variants(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT qi_qty_pos    CHECK (quantity > 0),
  CONSTRAINT qi_price_pos  CHECK (unit_price >= 0 AND line_total >= 0)
);

CREATE UNIQUE INDEX qi_tenant_id_uniq ON billing.quote_items(tenant_id, id);
CREATE INDEX idx_qi_quote ON billing.quote_items(tenant_id, quote_id);

-- NOTA · esta tabla de LÍNEAS no lleva `updated_at` ni trigger `touch_updated_at()`.
-- El criterio del proyecto es que sólo las tablas de cabecera/documento la llevan
-- (`quotes`, `sales_orders`, `invoices`, `delivery_notes`, `customer_returns`).
-- Poner el trigger sobre una tabla sin la columna rompe el primer UPDATE: es el
-- defecto que tuvo `0021`.

-- -----------------------------------------------------------------------------
-- 3 · Cargar una línea resolviendo el precio de la lista
-- -----------------------------------------------------------------------------
-- El precio sale de `app.price_for()` (`0023`) a la fecha indicada, no de un número
-- que mande el cliente. Si la lista no tiene precio para esa variante a esa cantidad
-- y esa fecha, FALLA: no se cotiza un 0.
CREATE OR REPLACE FUNCTION billing.add_quote_item(
  p_tenant_id  uuid,
  p_quote_id   uuid,
  p_variant_id uuid,
  p_quantity   numeric,
  p_on_date    date DEFAULT CURRENT_DATE
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_quote       billing.quotes;
  v_price       numeric(14,2);
  v_tax_rate    numeric(5,4);
  v_description text;
  v_net         numeric(14,2);
  v_tax         numeric(14,2);
  v_item        uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad a cotizar debe ser positiva (se informó %)', p_quantity
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_quote
  FROM billing.quotes
  WHERE tenant_id = p_tenant_id AND id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cotización % no existe en esta empresa', p_quote_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Sólo se carga una cotización en borrador: una vez emitida es una oferta que se
  -- le entregó al cliente y no se edita.
  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION
      'La cotización % está en estado «%»: sólo se le agregan líneas en borrador',
      p_quote_id, v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Precio de la lista, a la fecha pedida. `price_for` devuelve 0 o 1 fila.
  SELECT p.price INTO v_price
  FROM app.price_for(p_tenant_id, v_quote.price_list_id, p_variant_id, p_quantity, p_on_date) AS p;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'La lista % no tiene precio para la variante % con cantidad % al %: '
      'configure el precio antes de cotizar (no se cotiza un 0)',
      v_quote.price_list_id, p_variant_id, p_quantity, p_on_date
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Snapshot: el IVA del producto y el nombre de la variante al momento de cotizar.
  SELECT p.tax_rate, COALESCE(v.variant_name, p.name)
    INTO v_tax_rate, v_description
  FROM app.product_variants v
  JOIN app.products p
    ON p.tenant_id = v.tenant_id AND p.id = v.product_id
  WHERE v.tenant_id = p_tenant_id AND v.id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La variante % no existe en esta empresa', p_variant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_net := round(v_price * p_quantity, 2);
  v_tax := round(v_net * v_tax_rate, 2);

  INSERT INTO billing.quote_items (
    tenant_id, quote_id, variant_id, description, quantity,
    unit_price, discount_rate, tax_rate, line_total
  ) VALUES (
    p_tenant_id, p_quote_id, p_variant_id, v_description, p_quantity,
    v_price, 0, v_tax_rate, v_net + v_tax
  )
  RETURNING id INTO v_item;

  RETURN v_item;
END $$;

COMMENT ON FUNCTION billing.add_quote_item IS
  'Agrega una línea a una cotización en borrador resolviendo el precio con '
  'app.price_for() a la fecha indicada. Falla si la lista no tiene precio: no se cotiza '
  'un 0. Guarda un snapshot del nombre y del IVA, así la cotización no cambia si el '
  'catálogo cambia después.';

-- -----------------------------------------------------------------------------
-- 4 · Emitir (draft → issued)
-- -----------------------------------------------------------------------------
-- Al emitir se RECALCULAN los totales desde las líneas. La cabecera no los elige
-- nadie: son la suma de lo cotizado. Mismo criterio que `invoice_delivery_note()`.
CREATE OR REPLACE FUNCTION billing.issue_quote(
  p_tenant_id uuid,
  p_quote_id  uuid
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_quote    billing.quotes;
  v_lines    integer;
  v_net      numeric(14,2);
  v_tax      numeric(14,2);
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote
  FROM billing.quotes
  WHERE tenant_id = p_tenant_id AND id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cotización % no existe en esta empresa', p_quote_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_quote.status = 'issued' THEN
    RETURN 'issued';                            -- idempotente
  END IF;

  IF v_quote.status <> 'draft' THEN
    RAISE EXCEPTION
      'La cotización % está en estado «%»: sólo se emite una en borrador',
      p_quote_id, v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*),
         COALESCE(sum(round(unit_price * quantity * (1 - discount_rate), 2)), 0),
         COALESCE(sum(round(round(unit_price * quantity * (1 - discount_rate), 2) * tax_rate, 2)), 0)
    INTO v_lines, v_net, v_tax
  FROM billing.quote_items
  WHERE tenant_id = p_tenant_id AND quote_id = p_quote_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'La cotización % no tiene líneas: no hay nada que ofrecer', p_quote_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_net + v_tax <= 0 THEN
    RAISE EXCEPTION 'La cotización % no tiene importe', p_quote_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE billing.quotes
     SET status         = 'issued',
         subtotal       = v_net,
         discount_total = 0,
         tax_total      = v_tax,
         total          = v_net + v_tax
   WHERE tenant_id = p_tenant_id AND id = p_quote_id;

  RETURN 'issued';
END $$;

COMMENT ON FUNCTION billing.issue_quote IS
  'Emite una cotización en borrador (draft → issued) recalculando subtotal, IVA y total '
  'desde sus líneas: la cabecera no elige los importes. Idempotente sobre una ya emitida. '
  'Exige al menos una línea y un total mayor que cero.';

-- -----------------------------------------------------------------------------
-- 5 · Aceptar (issued → accepted), con el vencimiento como barrera
-- -----------------------------------------------------------------------------
-- Éste es el criterio V-1 del plan: «Cotización con validez; vencida, requiere
-- reconfirmación». La fecha entra por parámetro y no de `now()` para que el
-- cumplimiento sea reproducible y verificable (misma forma que `rates_on`).
CREATE OR REPLACE FUNCTION billing.accept_quote(
  p_tenant_id uuid,
  p_quote_id  uuid,
  p_on_date   date DEFAULT CURRENT_DATE
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_quote billing.quotes;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote
  FROM billing.quotes
  WHERE tenant_id = p_tenant_id AND id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cotización % no existe en esta empresa', p_quote_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_quote.status = 'accepted' THEN
    RETURN 'accepted';                          -- idempotente
  END IF;

  IF v_quote.status <> 'issued' THEN
    RAISE EXCEPTION
      'La cotización % está en estado «%»: sólo se acepta una emitida',
      p_quote_id, v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- La barrera. El mensaje dice qué hacer, no sólo qué falló.
  IF p_on_date > v_quote.valid_until THEN
    RAISE EXCEPTION
      'La cotización % venció el % (se intentó aceptar el %): '
      'reconfírmela con billing.reconfirm_quote() antes de aceptarla',
      p_quote_id, v_quote.valid_until, p_on_date
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE billing.quotes
     SET status = 'accepted'
   WHERE tenant_id = p_tenant_id AND id = p_quote_id;

  RETURN 'accepted';
END $$;

COMMENT ON FUNCTION billing.accept_quote IS
  'Acepta una cotización emitida (issued → accepted). RECHAZA una vencida: si la fecha '
  'indicada supera valid_until, exige reconfirmar antes (criterio V-1). Recibe la fecha '
  'en vez de usar now() para que el cumplimiento sea reproducible. Idempotente.';

-- -----------------------------------------------------------------------------
-- 6 · Reconfirmar la validez (issued → issued, con nueva fecha)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.reconfirm_quote(
  p_tenant_id      uuid,
  p_quote_id       uuid,
  p_new_valid_until date,
  p_on_date        date DEFAULT CURRENT_DATE
) RETURNS date
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_quote billing.quotes;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote
  FROM billing.quotes
  WHERE tenant_id = p_tenant_id AND id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cotización % no existe en esta empresa', p_quote_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Una cotización aceptada ya está cerrada: no se le corre la validez.
  IF v_quote.status <> 'issued' THEN
    RAISE EXCEPTION
      'La cotización % está en estado «%»: sólo se reconfirma una emitida',
      p_quote_id, v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reconfirmar «hacia el pasado» no reconfirma nada: la oferta nacería vencida.
  IF p_new_valid_until < p_on_date THEN
    RAISE EXCEPTION
      'La nueva validez (%) es anterior a la fecha de reconfirmación (%): '
      'reconfirmar tiene que extender la oferta hacia adelante',
      p_new_valid_until, p_on_date
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE billing.quotes
     SET valid_until = p_new_valid_until
   WHERE tenant_id = p_tenant_id AND id = p_quote_id;

  RETURN p_new_valid_until;
END $$;

COMMENT ON FUNCTION billing.reconfirm_quote IS
  'Extiende la validez de una cotización emitida. Es el paso que exige accept_quote() '
  'cuando la oferta venció. La nueva validez no puede ser anterior a la fecha de '
  'reconfirmación: una oferta que nace vencida no es una oferta.';

-- -----------------------------------------------------------------------------
-- 7 · Vista con el estado efectivo (el vencimiento derivado)
-- -----------------------------------------------------------------------------
-- Para listar y para la UI: el estado efectivo HOY. El cumplimiento no usa esta
-- vista sino la fecha explícita de `accept_quote()`.
CREATE OR REPLACE VIEW billing.v_quotes WITH (security_invoker = true) AS
SELECT
  q.id,
  q.tenant_id,
  q.number,
  q.customer_id,
  q.price_list_id,
  q.status,
  q.valid_from,
  q.valid_until,
  q.total,
  q.currency,
  -- `expired` se deriva acá y no se guarda: un estado almacenado necesitaría un job
  -- que lo ponga al día, y entre el vencimiento y la corrida del job la fila mentiría.
  CASE
    WHEN q.status = 'issued' AND q.valid_until < CURRENT_DATE THEN 'expired'
    ELSE q.status
  END AS effective_status,
  (q.status = 'issued' AND q.valid_until < CURRENT_DATE) AS is_expired,
  q.created_at,
  q.updated_at
FROM billing.quotes q;

COMMENT ON VIEW billing.v_quotes IS
  'Cotizaciones con su estado efectivo HOY: una emitida cuya valid_until ya pasó figura '
  'como «expired». El vencimiento se deriva y no se almacena. Para decidir se usa la '
  'fecha explícita de accept_quote(), no esta vista.';

-- -----------------------------------------------------------------------------
-- 8 · RLS e integridad
-- -----------------------------------------------------------------------------
ALTER TABLE billing.quotes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.quotes      FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.quote_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY quotes_isolation ON billing.quotes
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY quote_items_isolation ON billing.quote_items
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON billing.quotes      TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.quote_items TO control_app;

GRANT EXECUTE ON FUNCTION billing.add_quote_item(uuid, uuid, uuid, numeric, date) TO control_app;
GRANT EXECUTE ON FUNCTION billing.issue_quote(uuid, uuid) TO control_app;
GRANT EXECUTE ON FUNCTION billing.accept_quote(uuid, uuid, date) TO control_app;
GRANT EXECUTE ON FUNCTION billing.reconfirm_quote(uuid, uuid, date, date) TO control_app;

-- La barrera de integridad: toda tabla de negocio nueva queda cubierta por RLS.
DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
