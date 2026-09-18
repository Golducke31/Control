-- =============================================================================
-- Control · 0015 · Cobros y cuentas por cobrar (E4, parte 1)
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- Hasta acá el sistema sabía emitir una factura y registrar un pago suelto, pero
-- no podía responder la pregunta que sostiene el negocio: **cuánto le debe cada
-- cliente**. `billing.payments` existe desde `0004` y tiene un techo estructural:
-- un pago apunta a UN solo `invoice_id`. Un cliente que transfiere $500.000 para
-- cancelar tres facturas no tiene dónde registrarse, y el saldo se calcula a mano.
--
-- El plan lo define en §4.3 y la fase E4 en §7.1. Los criterios de esta parte son
-- §6.2, bloque "Cobros y tesorería": **T-1** (un cobro imputado a varias facturas
-- deja cada saldo correcto), **T-2** (la nota de crédito aplicada reduce el saldo
-- de su factura origen) y **T-3** (el saldo por cliente cuadra con los documentos
-- abiertos).
--
-- LAS CUATRO DECISIONES QUE GOBIERNAN ESTE ARCHIVO
--
-- 1. EL COBRO SE IMPUTA POR UNA TABLA, NO POR UNA COLUMNA.
--
--    `billing.payments.invoice_id` es una relación 1:1 disfrazada de columna. La
--    imputación real es N:M y vive en `billing.payment_allocations`, calcada de
--    `purchasing.payment_allocations` (`0014`). La columna `invoice_id` se
--    conserva por compatibilidad con lo ya escrito, pero pasa a ser un atajo
--    opcional: cuando un cobro toca una sola factura, se puede seguir cargando
--    así y una trigger crea la imputación. El saldo SIEMPRE se calcula desde la
--    tabla de imputaciones, nunca desde la columna — si hubiera dos fuentes, la
--    discrepancia entre ambas sería cuestión de tiempo.
--
-- 2. LA MECÁNICA DE IMPUTACIÓN NO SE REINVENTA.
--
--    `purchasing.apply_supplier_payment` (`0014`) ya resolvió el problema
--    completo: bloquear la factura con FOR UPDATE, validar que la imputación no
--    exceda el saldo, acumular lo imputado, derivar el estado y exigir que el
--    pago quede íntegramente imputado. `billing.apply_customer_collection` es esa
--    misma función del lado de cobros. El plan (§4.3, "Qué la desbloquea") dice
--    explícitamente que el módulo de compras comparte la mecánica con cobros y
--    que conviene diseñarlos juntos: esto es esa reutilización, no una copia.
--
-- 3. LA NOTA DE CRÉDITO REDUCE EL SALDO DE SU FACTURA ORIGEN.
--
--    `billing.invoices` ya tiene `kind` (`invoice`|`credit_note`|`debit_note`) y
--    `related_invoice_id`, pero nadie los usa para saldar: una nota de crédito
--    autorizada era una fila suelta que no tocaba el saldo de nadie. T-2 exige
--    que la aplique. Se resuelve con una columna `credited_total` en la factura
--    origen, acumulada por la misma función que imputa cobros, y con un CHECK que
--    impide acreditar más de lo facturado.
--
-- 4. EL SALDO SE CALCULA DESDE LOS DOCUMENTOS.
--
--    Igual que el saldo del proveedor en `0014`: sin columna `balance` en
--    `app.customers`. Un saldo materializado puede discrepar de los documentos
--    que dice resumir y no hay forma de auditar la diferencia. Se expone por
--    vistas `security_invoker`: saldo por cliente, antigüedad por tramos y estado
--    de cuenta.
--
-- AISLAMIENTO
--
-- Las tablas nuevas llevan `tenant_id` y quedan alcanzadas por la cobertura al
-- final (`app.assert_rls_coverage()`). Si alguna queda sin FORCE RLS o sin
-- política, la migración se revierte entera.
--
-- OJO CON LAS VISTAS: un `GRANT` sobre tablas NO alcanza a las vistas. Es el
-- defecto que costó la suite de compras entera (`0014`, §13): el rol podía leer
-- todas las tablas y recibía `permiso denegado` al consultar la vista. Acá van
-- explícitas Y en `ALTER DEFAULT PRIVILEGES`.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0 · Extensiones sobre las tablas existentes de facturación
-- -----------------------------------------------------------------------------
-- No se crea un esquema nuevo: cobros vive donde ya viven las facturas que cobra.
-- Un esquema `treasury` para las cuentas de fondos sí se crea, en `0016`.

-- `paid_total` y `credited_total` son acumuladores, y eso merece una justificación
-- porque el archivo de al lado dice que el saldo no se materializa.
--
-- La distinción: el SALDO no se guarda (se deriva de `total - paid_total -
-- credited_total - withheld_total`), pero los COMPONENTES sí. `paid_total` es el
-- resultado de una operación que ya ocurrió —el cobro se registró y sus
-- imputaciones son inmutables—, igual que `received_quantity` en `0014`. Guardarlo
-- evita recorrer todas las imputaciones históricas en cada consulta de saldo, y no
-- crea una segunda fuente de verdad porque se actualiza en la misma transacción
-- que inserta la imputación, bajo el FOR UPDATE de la factura.
ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS paid_total      numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credited_total  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withheld_total  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_date        date,
  ADD COLUMN IF NOT EXISTS payment_status  text;

-- El estado de cobro se DERIVA. Un estado escrito a mano sobre una factura que
-- después recibe una nota de crédito queda mintiendo, y nadie lo recalcula.
-- Misma lógica que el estado de línea en `0014`: la columna existe para poder
-- indexar y filtrar, pero su valor no lo elige nadie.
--
-- POR QUÉ UN TRIGGER Y NO UN DEFAULT
--
-- El primer intento fue `DEFAULT billing.derive_payment_status(...)`. No funciona:
-- un DEFAULT se evalúa con los valores POR DEFECTO de las demás columnas, no con
-- los que trae el INSERT. Una factura insertada como `status='authorized'` recibía
-- `'not_applicable'` porque el DEFAULT se calculó con `status='draft'`, y el CHECK
-- la rechazaba. PostgreSQL no puede derivar un valor de otros que todavía no
-- conoce, así que la derivación tiene que ocurrir después de armar la fila: eso es
-- un trigger BEFORE, que sí ve los valores definitivos.
--
-- El trigger también cubre el UPDATE, que es donde el estado realmente cambia:
-- una nota de crédito aplicada, un cobro imputado. Con un DEFAULT en una columna
-- de la misma fila, cada llamador tendría que acordarse de recalcularlo —y el que
-- se olvide deja el estado viejo, que es exactamente el defecto que esto evita.
CREATE OR REPLACE FUNCTION billing.derive_payment_status(
  p_kind      billing.receipt_kind,
  p_status    text,
  p_total     numeric,
  p_paid      numeric,
  p_credited  numeric,
  p_withheld  numeric
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_kind <> 'invoice'                              THEN 'not_applicable'
    WHEN p_status <> 'authorized'                         THEN 'not_applicable'
    WHEN COALESCE(p_paid,0) + COALESCE(p_credited,0) + COALESCE(p_withheld,0) <= 0
                                                          THEN 'pending'
    WHEN COALESCE(p_paid,0) + COALESCE(p_credited,0) + COALESCE(p_withheld,0) < p_total
                                                          THEN 'partial'
    ELSE 'paid'
  END;
$$;

COMMENT ON FUNCTION billing.derive_payment_status IS
  'Estado de cobro derivado de los acumulados. Única fuente de la expresión: la usan el trigger y el CHECK, así no pueden divergir.';

CREATE OR REPLACE FUNCTION billing.trg_set_payment_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.payment_status := billing.derive_payment_status(
    NEW.kind, NEW.status, NEW.total, NEW.paid_total, NEW.credited_total, NEW.withheld_total
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_payment_status ON billing.invoices;
CREATE TRIGGER set_payment_status
  BEFORE INSERT OR UPDATE ON billing.invoices
  FOR EACH ROW EXECUTE FUNCTION billing.trg_set_payment_status();

COMMENT ON FUNCTION billing.trg_set_payment_status IS
  'Fija payment_status en cada INSERT y UPDATE. Va en el motor y no en la aplicación porque un UPDATE crudo —o el que se olvide— dejaría el estado mintiendo.';

ALTER TABLE billing.invoices
  ALTER COLUMN payment_status DROP DEFAULT;

ALTER TABLE billing.invoices
  DROP CONSTRAINT IF EXISTS inv_payment_status_derived;
ALTER TABLE billing.invoices
  ADD CONSTRAINT inv_payment_status_derived CHECK (
    payment_status = billing.derive_payment_status(
      kind, status, total, paid_total, credited_total, withheld_total
    )
  );

-- Puesta al día de las filas existentes: sin esto, toda factura anterior a esta
-- migración quedaría con `payment_status` NULL y la columna nacería inservible
-- justo para el caso más común (el histórico ya facturado).
UPDATE billing.invoices
   SET payment_status = billing.derive_payment_status(
         kind, status, total, paid_total, credited_total, withheld_total
       )
 WHERE payment_status IS NULL;

-- Una factura no puede quedar cobrada por encima de su total, por ninguna vía:
-- ni un UPDATE crudo que saltee la función de imputación puede cruzar esto.
ALTER TABLE billing.invoices
  DROP CONSTRAINT IF EXISTS inv_not_over_settled;
ALTER TABLE billing.invoices
  ADD CONSTRAINT inv_not_over_settled CHECK (
    paid_total     >= 0 AND
    credited_total >= 0 AND
    withheld_total >= 0 AND
    paid_total + credited_total + withheld_total <= total
  );

COMMENT ON COLUMN billing.invoices.paid_total IS
  'Acumulado imputado desde cobros. Se actualiza en la misma transacción que la imputación, bajo FOR UPDATE. El saldo se deriva: total - paid_total - credited_total - withheld_total.';
COMMENT ON COLUMN billing.invoices.credited_total IS
  'Acumulado acreditado por notas de crédito aplicadas a esta factura (T-2).';
COMMENT ON COLUMN billing.invoices.payment_status IS
  'DERIVADO por CHECK. Existe para indexar y filtrar; su valor no lo elige la aplicación.';

-- -----------------------------------------------------------------------------
-- 1 · Imputaciones de cobro
-- -----------------------------------------------------------------------------
-- Calcada de `purchasing.payment_allocations`. La simetría es deliberada: quien
-- entiende una entiende la otra, y las dos suites de tests se leen igual.
-- `billing.payments` se creó en `0004` sin `UNIQUE (tenant_id, id)`, así que no
-- puede ser destino de una clave foránea compuesta. La convención del proyecto
-- exige claves compuestas `(tenant_id, id)` en toda referencia de negocio —es lo
-- que impide apuntar una fila al recurso de otra empresa—, y sin este índice la
-- tabla de imputaciones no puede cumplirla.
--
-- Guardado porque `ADD CONSTRAINT` no es idempotente, a diferencia del resto de
-- este archivo: reaplicar la migración en desarrollo fallaba con «la relación
-- pay_id_tenant ya existe», un error que no dice nada sobre lo que falta.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pay_id_tenant' AND conrelid = 'billing.payments'::regclass
  ) THEN
    ALTER TABLE billing.payments ADD CONSTRAINT pay_id_tenant UNIQUE (tenant_id, id);
  END IF;
END $$;

-- Una imputación de cobro sólo puede apuntar a un pago de la misma empresa.
CREATE TABLE IF NOT EXISTS billing.payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  payment_id  uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  amount      numeric(14,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bac_id_tenant   UNIQUE (tenant_id, id),
  CONSTRAINT bac_payment_fk  FOREIGN KEY (tenant_id, payment_id)
    REFERENCES billing.payments(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT bac_invoice_fk  FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bac_amount_positive CHECK (amount > 0),
  -- Una factura no se puede imputar dos veces desde el mismo cobro. Sin esto, un
  -- reintento del cliente duplica el cobro y el saldo queda negativo, que es la
  -- forma más cara de descubrir la falta del índice.
  CONSTRAINT bac_unique_pair UNIQUE (tenant_id, payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_bac_tenant_payment ON billing.payment_allocations(tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_bac_tenant_invoice ON billing.payment_allocations(tenant_id, invoice_id);

COMMENT ON TABLE billing.payment_allocations IS
  'Imputación de un cobro a facturas. N:M: un cobro puede cancelar varias facturas y una factura puede cobrarse en varios pagos. El saldo por cliente se calcula desde acá, nunca desde billing.payments.invoice_id.';

-- -----------------------------------------------------------------------------
-- 2 · Aplicación de notas de crédito
-- -----------------------------------------------------------------------------
-- T-2: "Nota de crédito aplicada reduce el saldo de la factura origen".
--
-- Podría resolverse con una columna en la nota de crédito, pero una NC también
-- puede aplicarse a varias facturas (una devolución global que se reparte), y el
-- monto aplicado a cada una tiene que quedar registrado para poder revertirlo.
-- Se usa una tabla de aplicaciones, con la misma forma que las imputaciones.
CREATE TABLE IF NOT EXISTS billing.credit_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  credit_note_id   uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  amount           numeric(14,2) NOT NULL,
  applied_on       date NOT NULL DEFAULT CURRENT_DATE,
  created_by       uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ca_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT ca_credit_fk    FOREIGN KEY (tenant_id, credit_note_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ca_invoice_fk   FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ca_amount_pos   CHECK (amount > 0),
  CONSTRAINT ca_unique_pair  UNIQUE (tenant_id, credit_note_id, invoice_id),
  -- Una nota de crédito no se aplica a sí misma.
  CONSTRAINT ca_not_self     CHECK (credit_note_id <> invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_tenant_credit  ON billing.credit_applications(tenant_id, credit_note_id);
CREATE INDEX IF NOT EXISTS idx_ca_tenant_invoice ON billing.credit_applications(tenant_id, invoice_id);

COMMENT ON TABLE billing.credit_applications IS
  'Aplicación de una nota de crédito al saldo de una factura (T-2). Se separa de la NC porque una devolución global puede repartirse entre varias facturas y el monto aplicado a cada una tiene que poder revertirse.';

-- -----------------------------------------------------------------------------
-- 3 · Vistas de saldo, antigüedad y estado de cuenta
-- -----------------------------------------------------------------------------
-- Todas `security_invoker`. Sin la opción, leerían datos de todas las empresas:
-- es el defecto que la convención del proyecto prohíbe y que `0014` documenta.

-- Saldo por cliente, calculado desde documentos (T-3).
--
-- Sólo las facturas de tipo `invoice` y autorizadas generan saldo: un borrador no
-- es exigible y una nota de crédito es un crédito, no una deuda. Incluirla acá la
-- contaría dos veces, porque ya reduce el saldo de su factura origen vía
-- `credited_total`.
CREATE OR REPLACE VIEW billing.v_customer_balances WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.customer_id,
  c.code                                   AS customer_code,
  c.legal_name                             AS customer_name,
  count(*) FILTER (WHERE i.total - i.paid_total - i.credited_total - i.withheld_total > 0)
                                           AS open_invoices,
  COALESCE(sum(i.total), 0)::numeric(14,2)                                   AS total_invoiced,
  COALESCE(sum(i.paid_total), 0)::numeric(14,2)                              AS total_paid,
  COALESCE(sum(i.credited_total), 0)::numeric(14,2)                          AS total_credited,
  COALESCE(sum(i.total - i.paid_total - i.credited_total - i.withheld_total), 0)::numeric(14,2)
                                           AS balance
FROM billing.invoices i
JOIN app.customers c
  ON c.tenant_id = i.tenant_id
 AND c.id = i.customer_id
WHERE i.kind = 'invoice'
  AND i.status = 'authorized'
GROUP BY i.tenant_id, i.customer_id, c.code, c.legal_name;

COMMENT ON VIEW billing.v_customer_balances IS
  'Saldo por cliente calculado desde documentos abiertos (T-3). No hay columna de saldo en customers: un saldo materializado puede discrepar de los documentos que resume.';

-- Antigüedad de saldos por tramos. Los tramos son los del plan §4.3
-- (0-30, 31-60, 61-90, +90) y se miden desde el vencimiento, no desde la emisión:
-- una factura a 60 días no está vencida al día 59.
CREATE OR REPLACE VIEW billing.v_receivables_aging WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.customer_id,
  c.legal_name AS customer_name,
  i.id         AS invoice_id,
  i.doc_type,
  i.point_of_sale,
  i.number,
  i.issue_date,
  COALESCE(i.due_date, i.issue_date) AS effective_due_date,
  (CURRENT_DATE - COALESCE(i.due_date, i.issue_date)) AS days_overdue,
  (i.total - i.paid_total - i.credited_total - i.withheld_total)::numeric(14,2) AS outstanding,
  CASE
    WHEN COALESCE(i.due_date, i.issue_date) >= CURRENT_DATE THEN 'current'
    WHEN CURRENT_DATE - COALESCE(i.due_date, i.issue_date) <= 30 THEN 'bucket_0_30'
    WHEN CURRENT_DATE - COALESCE(i.due_date, i.issue_date) <= 60 THEN 'bucket_31_60'
    WHEN CURRENT_DATE - COALESCE(i.due_date, i.issue_date) <= 90 THEN 'bucket_61_90'
    ELSE 'bucket_over_90'
  END AS aging_bucket
FROM billing.invoices i
JOIN app.customers c
  ON c.tenant_id = i.tenant_id
 AND c.id = i.customer_id
WHERE i.kind = 'invoice'
  AND i.status = 'authorized'
  AND (i.total - i.paid_total - i.credited_total - i.withheld_total) > 0;

COMMENT ON VIEW billing.v_receivables_aging IS
  'Antigüedad de saldos por tramos (0-30, 31-60, 61-90, +90), medida desde el vencimiento. Sólo incluye saldo abierto: una factura cobrada no tiene antigüedad.';

-- Estado de cuenta: todos los documentos que afectan el saldo, en orden
-- cronológico. Es la vista que responde "por qué dice que me debe esto".
CREATE OR REPLACE VIEW billing.v_customer_statement WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.customer_id,
  i.issue_date                              AS happened_on,
  'invoice'::text                           AS document_kind,
  i.id                                      AS document_id,
  i.doc_type || ' ' || lpad(i.point_of_sale::text, 4, '0') || '-' || lpad(i.number::text, 8, '0') AS reference,
  i.total::numeric(14,2)                    AS debit,
  0::numeric(14,2)                          AS credit,
  i.total::numeric(14,2)                    AS running_delta
FROM billing.invoices i
WHERE i.kind = 'invoice' AND i.status = 'authorized'

UNION ALL

-- El cobro entra por su imputación, no por el pago: si un pago se imputó a dos
-- facturas, cada una recibe su parte y la suma de los créditos coincide con el
-- pago. Mostrar el pago completo en una sola factura haría que el estado de
-- cuenta de esa factura no cierre.
SELECT
  a.tenant_id,
  i.customer_id,
  p.received_at::date                        AS happened_on,
  'payment'::text                            AS document_kind,
  p.id                                       AS document_id,
  COALESCE(p.reference, 'COBRO ' || p.id::text) AS reference,
  0::numeric(14,2)                           AS debit,
  a.amount::numeric(14,2)                    AS credit,
  (-a.amount)::numeric(14,2)                 AS running_delta
FROM billing.payment_allocations a
JOIN billing.payments p
  ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
JOIN billing.invoices i
  ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id

UNION ALL

SELECT
  ca.tenant_id,
  i.customer_id,
  ca.applied_on                              AS happened_on,
  'credit_note'::text                        AS document_kind,
  ca.credit_note_id                          AS document_id,
  'NC ' || ca.credit_note_id::text           AS reference,
  0::numeric(14,2)                           AS debit,
  ca.amount::numeric(14,2)                   AS credit,
  (-ca.amount)::numeric(14,2)                AS running_delta
FROM billing.credit_applications ca
JOIN billing.invoices i
  ON i.tenant_id = ca.tenant_id AND i.id = ca.invoice_id;

COMMENT ON VIEW billing.v_customer_statement IS
  'Estado de cuenta del cliente: facturas (débito), cobros imputados y notas de crédito aplicadas (crédito), en orden cronológico. Responde "por qué dice que me debe esto".';

-- -----------------------------------------------------------------------------
-- 4 · Imputación de cobros
-- -----------------------------------------------------------------------------
-- Espejo de `purchasing.apply_supplier_payment` (`0014`). Misma secuencia, mismos
-- bloqueos, mismos mensajes con el mismo criterio: el error le dice al usuario qué
-- pasó y cuánto queda, no que "violó una restricción".
CREATE OR REPLACE FUNCTION billing.apply_customer_collection(
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_received_on date,
  p_method      text,
  p_amount      numeric,
  p_allocations jsonb,
  p_reference   text DEFAULT NULL
) RETURNS billing.payments
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_payment     billing.payments;
  v_alloc       jsonb;
  v_invoice     billing.invoices;
  v_inv_id      uuid;
  v_amount      numeric(14,2);
  v_sum         numeric(14,2) := 0;
  v_outstanding numeric(14,2);
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto del cobro debe ser positivo (se informó %)', p_amount;
  END IF;

  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'El cobro necesita al menos una imputación';
  END IF;

  PERFORM 1 FROM app.customers
  WHERE tenant_id = p_tenant_id AND id = p_customer_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cliente % no existe o no está activo', p_customer_id;
  END IF;

  INSERT INTO billing.payments (
    tenant_id, customer_id, method, amount, reference, received_at, created_by
  ) VALUES (
    p_tenant_id, p_customer_id, p_method, p_amount, p_reference,
    COALESCE(p_received_on, CURRENT_DATE)::timestamptz, app.current_user_id()
  )
  RETURNING * INTO v_payment;

  -- Imputación, una por una, validando que cada factura sea del cliente del cobro.
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_inv_id := (v_alloc ->> 'invoice_id')::uuid;
    v_amount := (v_alloc ->> 'amount')::numeric(14,2);

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Cada imputación necesita un monto positivo (se informó %)', v_amount;
    END IF;

    -- FOR UPDATE serializa dos cobros concurrentes sobre la misma factura. Sin
    -- esto, ambos leen el mismo saldo, ambos pasan la validación y la factura
    -- termina cobrada por encima de su total — o el CHECK la rechaza y el usuario
    -- ve un error que no puede explicar.
    SELECT * INTO v_invoice
    FROM billing.invoices
    WHERE tenant_id = p_tenant_id AND id = v_inv_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La factura % no existe en esta empresa', v_inv_id;
    END IF;

    -- Cobrarle a un cliente la factura de otro es un error de carga, y aceptarlo
    -- haría que el saldo de un cliente se cancelara con la deuda de otro.
    IF v_invoice.customer_id IS DISTINCT FROM p_customer_id THEN
      RAISE EXCEPTION
        'La factura % pertenece a otro cliente: no se puede imputar a un cobro de %',
        v_invoice.id, p_customer_id;
    END IF;

    IF v_invoice.kind <> 'invoice' THEN
      RAISE EXCEPTION
        'El comprobante % es de tipo «%» y no es cobrable: sólo se imputan facturas',
        v_invoice.id, v_invoice.kind;
    END IF;

    IF v_invoice.status <> 'authorized' THEN
      RAISE EXCEPTION
        'La factura % está en estado «%»: sólo se cobran comprobantes autorizados',
        v_invoice.id, v_invoice.status;
    END IF;

    v_outstanding := v_invoice.total - v_invoice.paid_total
                   - v_invoice.credited_total - v_invoice.withheld_total;

    IF v_amount > v_outstanding THEN
      RAISE EXCEPTION
        'Imputación excedida en la factura % %: se intentó imputar % y el saldo es %',
        v_invoice.doc_type, v_invoice.number, v_amount, v_outstanding
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO billing.payment_allocations (tenant_id, payment_id, invoice_id, amount)
    VALUES (p_tenant_id, v_payment.id, v_inv_id, v_amount);

    -- Acumular y derivar. El estado no se elige: lo impone el CHECK
    -- `inv_payment_status_derived` a partir de los acumulados.
    UPDATE billing.invoices
       SET paid_total     = paid_total + v_amount,
           payment_status = CASE
                              WHEN paid_total + v_amount + credited_total + withheld_total
                                   >= total THEN 'paid'
                              ELSE 'partial'
                            END,
           updated_at     = now()
     WHERE tenant_id = p_tenant_id AND id = v_inv_id;

    v_sum := v_sum + v_amount;
  END LOOP;

  -- El cobro tiene que estar íntegramente imputado. Un cobro de $100.000 imputado
  -- por $60.000 deja $40.000 sin destino, y el saldo del cliente sigue diciendo
  -- que debe plata que ya pagó. El "a cuenta" (T-1) se resuelve dejando el pago
  -- sin imputar por un camino explícito, no aceptando una suma incompleta.
  IF v_sum <> p_amount THEN
    RAISE EXCEPTION
      'Las imputaciones suman % y el cobro es de %: el cobro tiene que quedar íntegramente imputado',
      v_sum, p_amount
      USING ERRCODE = '23514';
  END IF;

  RETURN v_payment;
END;
$$;

COMMENT ON FUNCTION billing.apply_customer_collection IS
  'Imputa un cobro a una o varias facturas del cliente (T-1). Misma mecánica que purchasing.apply_supplier_payment: FOR UPDATE por factura, validación de saldo, suma íntegra y estado derivado.';

-- -----------------------------------------------------------------------------
-- 5 · Aplicación de notas de crédito al saldo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.apply_credit_note(
  p_tenant_id     uuid,
  p_credit_note_id uuid,
  p_applications  jsonb,
  p_applied_on    date DEFAULT CURRENT_DATE
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_nc          billing.invoices;
  v_app         jsonb;
  v_inv         billing.invoices;
  v_inv_id      uuid;
  v_amount      numeric(14,2);
  v_sum         numeric(14,2) := 0;
  v_available   numeric(14,2);
  v_outstanding numeric(14,2);
  v_count       integer := 0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_applications) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_applications) = 0 THEN
    RAISE EXCEPTION 'La aplicación necesita al menos una factura destino';
  END IF;

  SELECT * INTO v_nc
  FROM billing.invoices
  WHERE tenant_id = p_tenant_id AND id = p_credit_note_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La nota de crédito % no existe en esta empresa', p_credit_note_id;
  END IF;

  IF v_nc.kind <> 'credit_note' THEN
    RAISE EXCEPTION
      'El comprobante % es de tipo «%»: sólo se aplican notas de crédito',
      p_credit_note_id, v_nc.kind;
  END IF;

  IF v_nc.status <> 'authorized' THEN
    RAISE EXCEPTION
      'La nota de crédito está en estado «%»: sólo se aplican las autorizadas',
      v_nc.status;
  END IF;

  -- Una NC sólo puede aplicarse hasta su importe total, y aplicarla dos veces es
  -- el error caro: acreditaría dos veces la misma devolución.
  SELECT COALESCE(sum(amount), 0) INTO v_sum
  FROM billing.credit_applications
  WHERE tenant_id = p_tenant_id AND credit_note_id = p_credit_note_id;

  v_available := v_nc.total - v_sum;
  IF v_available <= 0 THEN
    RAISE EXCEPTION
      'La nota de crédito % ya está aplicada por completo (% de %)',
      p_credit_note_id, v_sum, v_nc.total
      USING ERRCODE = '23514';
  END IF;

  v_sum := 0;

  FOR v_app IN SELECT * FROM jsonb_array_elements(p_applications) LOOP
    v_inv_id := (v_app ->> 'invoice_id')::uuid;
    v_amount := (v_app ->> 'amount')::numeric(14,2);

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Cada aplicación necesita un monto positivo (se informó %)', v_amount;
    END IF;

    SELECT * INTO v_inv
    FROM billing.invoices
    WHERE tenant_id = p_tenant_id AND id = v_inv_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La factura % no existe en esta empresa', v_inv_id;
    END IF;

    IF v_inv.kind <> 'invoice' THEN
      RAISE EXCEPTION 'El comprobante % no es una factura: no admite notas de crédito', v_inv_id;
    END IF;

    -- La NC y la factura tienen que ser del mismo cliente. Aplicar la devolución
    -- de un cliente a la deuda de otro es un error que ninguna vista detectaría
    -- después: los dos saldos quedarían mal y cuadrarían con los documentos.
    IF v_inv.customer_id IS DISTINCT FROM v_nc.customer_id THEN
      RAISE EXCEPTION
        'La nota de crédito es del cliente % y la factura % es de otro cliente',
        v_nc.customer_id, v_inv_id;
    END IF;

    v_outstanding := v_inv.total - v_inv.paid_total
                   - v_inv.credited_total - v_inv.withheld_total;

    IF v_amount > v_outstanding THEN
      RAISE EXCEPTION
        'Aplicación excedida en la factura % %: se intentó acreditar % y el saldo es %',
        v_inv.doc_type, v_inv.number, v_amount, v_outstanding
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO billing.credit_applications (
      tenant_id, credit_note_id, invoice_id, amount, applied_on, created_by
    ) VALUES (
      p_tenant_id, p_credit_note_id, v_inv_id, v_amount, p_applied_on, app.current_user_id()
    );

    UPDATE billing.invoices
       SET credited_total = credited_total + v_amount,
           payment_status = CASE
                              WHEN paid_total + credited_total + v_amount + withheld_total
                                   >= total THEN 'paid'
                              ELSE 'partial'
                            END,
           updated_at     = now()
     WHERE tenant_id = p_tenant_id AND id = v_inv_id;

    v_sum := v_sum + v_amount;
    v_count := v_count + 1;
  END LOOP;

  IF v_sum > v_available THEN
    RAISE EXCEPTION
      'La aplicación suma % y a la nota de crédito le quedan % por aplicar',
      v_sum, v_available
      USING ERRCODE = '23514';
  END IF;

  -- La NC aplicada por completo pasa a `paid` en su propio vocabulario: ya no le
  -- queda importe por acreditar.
  UPDATE billing.invoices
     SET payment_status = CASE
                            WHEN v_sum >= v_nc.total THEN 'paid'
                            ELSE 'partial'
                          END,
         updated_at     = now()
   WHERE tenant_id = p_tenant_id AND id = p_credit_note_id;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION billing.apply_credit_note IS
  'Aplica una nota de crédito autorizada al saldo de una o varias facturas del mismo cliente (T-2). Impide aplicarla por encima de su importe o dos veces.';

-- -----------------------------------------------------------------------------
-- 6 · Configuración contable de cobros
-- -----------------------------------------------------------------------------
-- Los roles contables de cobros se resuelven contra `accounting.account_roles`.
-- `receivable` y `sales_returns` ya existen desde `0013`; se siembran sólo si
-- faltan para que la función sea idempotente y no pise una configuración propia.
CREATE OR REPLACE FUNCTION billing.seed_tenant_collections_config(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_roles  integer := 0;
  v_reglas integer := 0;
  v_faltan text;
BEGIN
  -- La contrapartida de un cobro es una cuenta de fondos: caja o banco. El rol
  -- `cash` lo siembra compras (`0014`), pero una empresa que sólo cobra y no
  -- compra nunca pasó por ahí. Se siembra acá también para que configurar cobros
  -- no dependa de haber configurado compras antes.
  --
  -- `ON CONFLICT DO UPDATE` y no `DO NOTHING`: si la cuenta de caja ya estaba
  -- configurada con otro código, cobros necesita que apunte a una cuenta de
  -- fondos real. `DO NOTHING` dejaría la configuración vieja en pie y el asiento
  -- saldría contra una cuenta que no es la de tesorería.
  INSERT INTO accounting.account_roles (tenant_id, role, account_id)
  SELECT p_tenant_id, m.role, a.id
  FROM (VALUES
    ('receivable', '1.1.2.01'),   -- Deudores por ventas
    ('cash',       '1.1.1.01')    -- Caja
  ) AS m(role, code)
  JOIN accounting.accounts a
    ON a.tenant_id = p_tenant_id AND a.code = m.code
  ON CONFLICT (tenant_id, role) DO UPDATE
    SET account_id = EXCLUDED.account_id,
        updated_at = now();

  GET DIAGNOSTICS v_roles = ROW_COUNT;

  -- Los códigos tienen que existir en el plan de cuentas de la empresa. Sin esta
  -- verificación, el mapeo queda apuntando a una cuenta inexistente y el error
  -- aparece al asentar, con el hecho ya creado y el usuario mirando una pantalla
  -- de facturación. Es la falla más difícil de diagnosticar de este módulo.
  SELECT string_agg(m.code, ', ') INTO v_faltan
  FROM (VALUES ('1.1.2.01'), ('1.1.1.01')) AS m(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting.accounts a
    WHERE a.tenant_id = p_tenant_id AND a.code = m.code
  );

  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION
      'La empresa % no tiene estas cuentas en su plan: %. Cargá la plantilla contable antes de configurar cobros.',
      p_tenant_id, v_faltan;
  END IF;

  -- Una regla por línea. El mapeo es una fila por línea, no una lista jsonb:
  -- agregar una línea es un INSERT y no una lectura-modificación-escritura, que
  -- es donde dos configuraciones simultáneas se pisan.
  INSERT INTO accounting.mapping_rules
    (tenant_id, source_type, event_kind, line_number, account_role, is_credit_line, amount_key, description)
  VALUES
    -- Cobro: entra el dinero, se reduce la deuda del cliente.
    (p_tenant_id, 'customer_payment', 'customer_payment', 1, 'receivable', false, 'total', 'Cliente: se reduce el saldo por el cobro'),
    (p_tenant_id, 'customer_payment', 'customer_payment', 2, 'cash',       true,  'total', 'Entrada de fondos por el cobro'),

    -- Nota de crédito de venta: se reduce la deuda y se revierte la venta.
    (p_tenant_id, 'credit_note', 'credit_note', 1, 'sales_returns', true,  'subtotal',  'Devolución: se revierte la venta'),
    (p_tenant_id, 'credit_note', 'credit_note', 2, 'vat_payable',   true,  'tax_total', 'Devolución: se revierte el IVA débito'),
    (p_tenant_id, 'credit_note', 'credit_note', 3, 'receivable',    false, 'total',     'Cliente: se reduce el saldo a cobrar')
  ON CONFLICT (tenant_id, source_type, event_kind, line_number) DO UPDATE
    SET account_role   = EXCLUDED.account_role,
        is_credit_line = EXCLUDED.is_credit_line,
        amount_key     = EXCLUDED.amount_key,
        description    = EXCLUDED.description;

  GET DIAGNOSTICS v_reglas = ROW_COUNT;

  RETURN v_roles + v_reglas;
END;
$$;

COMMENT ON FUNCTION billing.seed_tenant_collections_config IS
  'Roles contables y reglas de mapeo de cobros para una empresa. Falla si el plan de cuentas no tiene las cuentas que las reglas referencian.';

-- -----------------------------------------------------------------------------
-- 7 · Aislamiento (RLS) sobre las tablas nuevas
-- -----------------------------------------------------------------------------
-- Mismo macro dinámico que `0012`, `0013` y `0014`, descubriendo tablas desde
-- `pg_class`. ENABLE y FORCE: sin FORCE, el dueño —`postgres`, que corre las
-- migraciones— saltea sus propias políticas.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND c.relispartition = false
      AND n.nspname IN ('billing', 'app')
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      )
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE  ROW LEVEL SECURITY', r.schema_name, r.table_name);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I.%I
        FOR ALL TO PUBLIC
        USING (
          app.is_platform_admin()
          OR tenant_id = app.current_tenant_id()
        )
        WITH CHECK (
          app.is_platform_admin()
          OR tenant_id = app.current_tenant_id()
        )
    $f$, r.schema_name, r.table_name);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8 · Permisos
-- -----------------------------------------------------------------------------
-- Las tablas de facturación ya tienen sus GRANT desde `0004`, pero las que se
-- crean acá no. Y LAS VISTAS NO HEREDAN el GRANT de sus tablas base: es el defecto
-- que costó la suite de compras entera (`0014`). Van explícitas.
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.payment_allocations TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.credit_applications TO control_app;

GRANT SELECT ON billing.payment_allocations  TO control_readonly;
GRANT SELECT ON billing.credit_applications  TO control_readonly;

-- Las vistas, explícitas. `permiso denegado a la vista` con el rol pudiendo leer
-- todas las tablas base es exactamente el síntoma que produce olvidarlas.
GRANT SELECT ON billing.v_customer_balances    TO control_app, control_readonly;
GRANT SELECT ON billing.v_receivables_aging    TO control_app, control_readonly;
GRANT SELECT ON billing.v_customer_statement   TO control_app, control_readonly;

GRANT EXECUTE ON FUNCTION billing.apply_customer_collection(uuid, uuid, date, text, numeric, jsonb, text) TO control_app;
GRANT EXECUTE ON FUNCTION billing.apply_credit_note(uuid, uuid, jsonb, date) TO control_app;
GRANT EXECUTE ON FUNCTION billing.seed_tenant_collections_config(uuid) TO control_app;

-- Por defecto, para lo que se agregue después. `ON TABLES` no cubre vistas ni
-- secuencias, así que se declaran aparte: una vista nueva repetiría el defecto.
ALTER DEFAULT PRIVILEGES IN SCHEMA billing
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing
  GRANT SELECT ON TABLES TO control_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing
  GRANT SELECT ON SEQUENCES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing
  GRANT SELECT ON SEQUENCES TO control_readonly;

-- -----------------------------------------------------------------------------
-- 9 · Verificación de configuración de cobros en el ledger de jobs
-- -----------------------------------------------------------------------------
-- Se reusa el mecanismo de `0013`/`0014`: `v_posting_gaps` descubre los hechos sin
-- asiento y `accounting.posting_check` los reporta. Un cobro sin asiento es un
-- hecho económico que existe y el libro no conoce.
UPDATE ops.jobs
   SET description = 'Detecta cobros a cliente y notas de crédito aplicadas sin asiento contable.'
 WHERE code = 'accounting.posting_check';

-- -----------------------------------------------------------------------------
-- 10 · Extensión de la vista de brechas para cobros
-- -----------------------------------------------------------------------------
-- `CREATE OR REPLACE VIEW` conserva los permisos pero PIERDE `security_invoker` si
-- no se repite la opción: la vista reemplazada leería datos de todas las empresas,
-- en silencio y sin error.
--
-- Se repiten TODAS las ramas anteriores. Quitar una al reemplazar es la forma
-- silenciosa de perder cobertura: la vista seguiría funcionando y dejaría de
-- detectar lo que ya detectaba.
CREATE OR REPLACE VIEW accounting.v_posting_gaps WITH (security_invoker = true) AS
-- Facturas de venta autorizadas sin asiento.
SELECT
  i.tenant_id,
  'invoice'::text     AS source_type,
  i.id                AS source_id,
  'invoice'::text     AS event_kind,
  i.issue_date        AS happened_on,
  'Factura autorizada sin asiento contable'::text AS gap_description
FROM billing.invoices i
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = i.tenant_id
 AND e.source_type = 'invoice'
 AND e.source_id = i.id
WHERE i.status = 'authorized'
  AND i.kind = 'invoice'
  AND e.id IS NULL

UNION ALL

-- Facturas de compra registradas sin asiento. Excluye las anuladas.
SELECT
  si.tenant_id,
  'purchase'::text    AS source_type,
  si.id               AS source_id,
  'purchase'::text    AS event_kind,
  si.issue_date       AS happened_on,
  'Factura de compra sin asiento contable'::text AS gap_description
FROM purchasing.supplier_invoices si
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = si.tenant_id
 AND e.source_type = 'purchase'
 AND e.source_id = si.id
WHERE si.status <> 'cancelled'
  AND e.id IS NULL

UNION ALL

-- Pagos a proveedor sin asiento.
SELECT
  sp.tenant_id,
  'supplier_payment'::text AS source_type,
  sp.id                    AS source_id,
  'supplier_payment'::text AS event_kind,
  sp.paid_on               AS happened_on,
  'Pago a proveedor sin asiento contable'::text AS gap_description
FROM purchasing.supplier_payments sp
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = sp.tenant_id
 AND e.source_type = 'supplier_payment'
 AND e.source_id = sp.id
WHERE e.id IS NULL

UNION ALL

-- Cobros a cliente sin asiento (nuevo en 0015).
SELECT
  p.tenant_id,
  'customer_payment'::text AS source_type,
  p.id                     AS source_id,
  'customer_payment'::text AS event_kind,
  p.received_at::date      AS happened_on,
  'Cobro a cliente sin asiento contable'::text AS gap_description
FROM billing.payments p
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = p.tenant_id
 AND e.source_type = 'customer_payment'
 AND e.source_id = p.id
WHERE e.id IS NULL

UNION ALL

-- Notas de crédito aplicadas sin asiento (nuevo en 0015).
SELECT
  cn.tenant_id,
  'credit_note'::text AS source_type,
  cn.id               AS source_id,
  'credit_note'::text AS event_kind,
  cn.issue_date       AS happened_on,
  'Nota de crédito sin asiento contable'::text AS gap_description
FROM billing.invoices cn
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = cn.tenant_id
 AND e.source_type = 'credit_note'
 AND e.source_id = cn.id
WHERE cn.kind = 'credit_note'
  AND cn.status = 'authorized'
  AND e.id IS NULL

UNION ALL

-- Salidas de stock por venta con costo sin asiento. Se conserva del `0013`
-- original y de `0014`.
SELECT
  m.tenant_id,
  'stock_movement'::text AS source_type,
  m.id                   AS source_id,
  'sale_out'::text       AS event_kind,
  m.created_at::date     AS happened_on,
  'Salida de stock con costo sin asiento'::text AS gap_description
FROM app.stock_movements m
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = m.tenant_id
 AND e.source_type = 'stock_movement'
 AND e.source_id = m.id
WHERE m.kind = 'sale_out'
  AND m.unit_cost IS NOT NULL
  AND m.unit_cost <> 0
  AND e.id IS NULL;

COMMENT ON VIEW accounting.v_posting_gaps IS
  'Hechos económicos sin asiento contable: facturas de venta y compra, cobros a cliente, notas de crédito, pagos a proveedor y salidas de stock con costo. Alimenta accounting.posting_check.';

-- -----------------------------------------------------------------------------
-- 11 · Cierre
-- -----------------------------------------------------------------------------
-- La barrera: si alguna tabla nueva quedó sin política o sin FORCE RLS, esto
-- levanta una excepción y la transacción entera se revierte. No es un aviso.
SELECT app.assert_rls_coverage();

COMMIT;
