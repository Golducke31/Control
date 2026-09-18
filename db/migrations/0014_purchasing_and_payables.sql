-- =============================================================================
-- Control · 0014 · Compras y cuentas por pagar (E3)
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- Cierra el hueco del origen del ciclo de negocio. Hasta `0013` el sistema sabía
-- vender y facturar, y por lo tanto sabía de dónde sale la mercadería pero no
-- cómo entró: una entrada de stock sólo podía explicarse como ajuste manual. Eso
-- significa que el sistema no podía decir de dónde vino la mercadería, cuánto
-- costó realmente, ni a quién hay que pagarle.
--
-- El plan lo define en §4.2 y la fase E3 en §7.1, con un gate de salida concreto:
-- **"Recepción parcial integrada con stock y costo"**.
--
-- LAS CUATRO DECISIONES QUE GOBIERNAN ESTE ARCHIVO
--
-- 1. LA RECEPCIÓN NO ESCRIBE STOCK. LLAMA A `apply_stock_movement()`.
--
--    El tipo `purchase_in` ya existía en el enum de `0001` y la función ya
--    actualiza el costo promedio ponderado cuando lo recibe con `unit_cost` no
--    nulo (`0007`). La recepción de una orden es entonces una llamada a código
--    ya escrito y verificado, no una segunda implementación de la aritmética de
--    costeo. Escribir el stock "a mano" desde compras crearía dos caminos de
--    mutación con la misma responsabilidad, y el día que difieran el saldo del
--    depósito dependería de por dónde entró la mercadería.
--
-- 2. EL ESTADO VIVE EN LA LÍNEA, NO SÓLO EN LA CABECERA.
--
--    Es el punto donde más proyectos de compras fallan (§4.2, "Nota de diseño").
--    Hay que poder recibir 60 de 100 unidades sin perder la referencia a las 40
--    pendientes. Con estado sólo en la cabecera, esa información no tiene dónde
--    vivir y termina en un cálculo implícito que se desincroniza en la primera
--    recepción parcial. Acá `received_quantity` es una columna de la línea, el
--    estado de la línea se **deriva** de ella por CHECK, y el de la cabecera se
--    **deriva** de sus líneas por trigger.
--
-- 3. LA SOBRE-RECEPCIÓN LA IMPIDE EL MOTOR, NO LA APLICACIÓN.
--
--    Mismo criterio que el diferencial cero de `0012` y que el índice único
--    parcial de `0013`: la garantía va en el motor. `received_quantity` tiene un
--    CHECK contra `quantity`, así que ningún camino —ni un INSERT crudo que se
--    saltee `receive_supplier_order_line()`— puede recibir más de lo pedido. Una
--    validación en TypeScript se saltea con un script; un CHECK no.
--
-- 4. EL SALDO DEL PROVEEDOR SE CALCULA DESDE LOS DOCUMENTOS.
--
--    No hay columna `balance` en `suppliers`. Un saldo materializado es un dato
--    que puede discrepar de los documentos que dice resumir, y la pregunta "¿por
--    qué dice que le debo esto?" no tendría respuesta. Se expone por vista
--    (`security_invoker`), igual que la antigüedad de saldos.
--
-- AISLAMIENTO
--
-- Las cuatro tablas nuevas llevan `tenant_id` y quedan alcanzadas por la
-- cobertura al final del archivo (`app.assert_rls_coverage()`). Si alguna queda
-- sin FORCE RLS o sin política, la migración se revierte entera. No es opcional:
-- es la barrera que convirtió un defecto real de particiones en un fallo de
-- pipeline (`0008`).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0 · Esquema de compras
-- -----------------------------------------------------------------------------
-- Va acá y no en `0001` porque el módulo nace en esta migración: los esquemas se
-- crean donde se usan por primera vez (`ops` en `0010`, `accounting` en `0012`).
--
-- Sin este `CREATE SCHEMA`, todo lo que sigue falla con «no existe el esquema
-- purchasing», un mensaje que apunta a la primera tabla y no a la causa.
CREATE SCHEMA IF NOT EXISTS purchasing;

-- -----------------------------------------------------------------------------
-- 1 · Proveedores
-- -----------------------------------------------------------------------------
-- Espejo de `app.customers` en lo fiscal —mismo vocabulario de condición frente
-- al IVA y mismo documento normalizado sin guiones— porque un mismo CUIT puede
-- ser cliente y proveedor y las dos fichas tienen que poder cruzarse.
--
-- La diferencia está en lo comercial. Un proveedor no tiene límite de crédito
-- (el límite se lo pone la empresa a sí misma cuando decide a quién le compra a
-- cuenta) y en cambio necesita **condición de pago y datos bancarios**, porque
-- el pago es la operación que sigue y sin CBU/alias el circuito termina fuera
-- del sistema.
CREATE TABLE app.suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code              text NOT NULL,
  legal_name        text NOT NULL,
  trade_name        text,
  doc_type          text NOT NULL DEFAULT 'CUIT',
  doc_number        text,                       -- normalizado, sin guiones
  tax_condition     text NOT NULL DEFAULT 'responsable_inscripto',
  email             citext,
  phone             text,
  address_line      text,
  city              text,
  province          text,
  postal_code       text,
  country           char(2) NOT NULL DEFAULT 'AR',

  -- Condición de pago: en cuántos días vence una factura nueva.
  --
  -- Se modela como días de plazo y no como una fecha: la fecha de vencimiento se
  -- resuelve por factura (`supplier_invoices.due_date`), porque el mismo
  -- proveedor negocia plazos distintos según el rubro y fijar una sola regla en
  -- la ficha obligaría a corregirla a mano en cada factura.
  payment_term_days integer NOT NULL DEFAULT 0,

  -- Datos bancarios. El alias es lo que se usa en Argentina hoy; el CBU queda
  -- para transferencias y para el archivo de pago.
  bank_name         text,
  bank_cbu          text,
  bank_alias        text,

  -- Si el proveedor practica retenciones al cobrar (agente de retención).
  -- La determinación fiscal de retenciones es de E5; acá sólo se registra el
  -- hecho, que es información de la ficha.
  is_withholding_agent boolean NOT NULL DEFAULT false,

  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Clave foránea compuesta: es el destino de los FK de las tablas hijas.
  -- Mismo patrón que `customers` en `0003` — el UNIQUE sobre `(tenant_id, id)`
  -- satisface un FK compuesto exactamente igual que un UNIQUE CONSTRAINT.
  CONSTRAINT suppliers_id_tenant      UNIQUE (tenant_id, id),
  CONSTRAINT suppliers_doc_unique     UNIQUE NULLS NOT DISTINCT (tenant_id, doc_type, doc_number),
  CONSTRAINT suppliers_term_positive  CHECK (payment_term_days >= 0),
  CONSTRAINT suppliers_cbu_format     CHECK (bank_cbu IS NULL OR bank_cbu ~ '^[0-9]{22}$')
);

CREATE UNIQUE INDEX uq_suppliers_code ON app.suppliers(tenant_id, code);

-- Búsqueda por similitud de nombre, igual que clientes.
CREATE INDEX idx_suppliers_tenant_search
  ON app.suppliers USING gin (tenant_id, legal_name gin_trgm_ops);

CREATE TRIGGER trg_suppliers_touch BEFORE UPDATE ON app.suppliers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2 · Órdenes de compra
-- -----------------------------------------------------------------------------
CREATE TABLE purchasing.supplier_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,
  supplier_id    uuid NOT NULL,

  status         text NOT NULL DEFAULT 'draft',
                 -- draft|pending_approval|approved|partially_received|received|cancelled

  -- Aprobación por monto (§4.2). El umbral es un dato de la empresa, no una
  -- constante del código: cada empresa decide a partir de qué monto quiere un
  -- segundo par de ojos, y ese número cambia con el tiempo.
  requires_approval boolean NOT NULL DEFAULT false,
  approved_at    timestamptz,
  approved_by    uuid REFERENCES app.users(id) ON DELETE SET NULL,

  currency       char(3) NOT NULL DEFAULT 'ARS',
  fx_rate        numeric(14,6) NOT NULL DEFAULT 1,
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  tax_total      numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,

  -- Depósito de destino por defecto. Cada línea puede pisarlo: una orden puede
  -- repartir mercadería entre depósitos, y obligar a una orden por depósito
  -- convierte una compra real en tres documentos.
  warehouse_id   uuid,

  expected_on    date,
  notes          text,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT po_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT po_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT po_supplier_fk   FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES app.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT po_warehouse_fk  FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES app.warehouses(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT po_status_valid  CHECK (status IN
    ('draft','pending_approval','approved','partially_received','received','cancelled')),
  CONSTRAINT po_totals_pos    CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0),

  -- Una orden aprobada tiene que registrar quién y cuándo. Sin esto, "aprobada"
  -- es un estado que cualquiera puede escribir sin haber aprobado nada — y la
  -- aprobación por monto deja de ser un control.
  CONSTRAINT po_approval_recorded CHECK (
    status NOT IN ('approved','partially_received','received')
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);

CREATE INDEX idx_po_tenant_issued   ON purchasing.supplier_orders(tenant_id, issued_at DESC);
CREATE INDEX idx_po_tenant_supplier ON purchasing.supplier_orders(tenant_id, supplier_id, status);

CREATE TRIGGER trg_po_touch BEFORE UPDATE ON purchasing.supplier_orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 3 · Líneas de la orden — acá vive el estado de recepción
-- -----------------------------------------------------------------------------
CREATE TABLE purchasing.supplier_order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  order_id           uuid NOT NULL,
  variant_id         uuid NOT NULL,

  -- Depósito de esta línea. Cae al de la cabecera si es NULL.
  warehouse_id       uuid,

  line_number        integer NOT NULL,
  description        text,

  quantity           numeric(14,3) NOT NULL,
  -- Lo efectivamente recibido, acumulado entre recepciones.
  -- `numeric` y no entero: hay insumos que se compran por peso o por metro.
  received_quantity  numeric(14,3) NOT NULL DEFAULT 0,

  unit_cost          numeric(14,4) NOT NULL DEFAULT 0,
  tax_rate           numeric(5,2)  NOT NULL DEFAULT 21.00,
  discount_rate      numeric(5,2)  NOT NULL DEFAULT 0,

  -- Estado derivado, no almacenado aparte: tener las dos cosas permite que se
  -- contradigan. Es el mismo criterio que `stock_levels.available` en `0003`.
  status             text GENERATED ALWAYS AS (
                       CASE
                         WHEN received_quantity <= 0              THEN 'pending'
                         WHEN received_quantity <  quantity       THEN 'partial'
                         ELSE 'received'
                       END
                     ) STORED,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT poi_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT poi_order_fk     FOREIGN KEY (tenant_id, order_id)
    REFERENCES purchasing.supplier_orders(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT poi_variant_fk   FOREIGN KEY (tenant_id, variant_id)
    REFERENCES app.product_variants(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT poi_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES app.warehouses(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT poi_number_unique UNIQUE (tenant_id, order_id, line_number),

  -- LA GARANTÍA DE LA RECEPCIÓN PARCIAL.
  --
  -- No se puede recibir más de lo pedido, y no se puede recibir una cantidad
  -- negativa. Las dos cosas las impide el motor: un camino que se saltee
  -- `receive_supplier_order_line()` sigue chocando contra este CHECK.
  CONSTRAINT poi_not_over_received CHECK (
    received_quantity >= 0 AND received_quantity <= quantity
  ),
  CONSTRAINT poi_quantity_positive CHECK (quantity > 0),
  CONSTRAINT poi_costs_non_negative CHECK (
    unit_cost >= 0 AND tax_rate >= 0 AND discount_rate >= 0 AND discount_rate <= 100
  )
);

CREATE INDEX idx_poi_tenant_order ON purchasing.supplier_order_items(tenant_id, order_id, line_number);

-- La vista de lo pendiente. Es la consulta que un comprador hace todo el día
-- ("¿qué me falta recibir?"), y por eso se resuelve en el motor en vez de
-- repetirse en cada pantalla. `security_invoker` para que RLS siga aplicando:
-- sin eso la vista vería los pendientes de todas las empresas.
CREATE VIEW purchasing.v_pending_receipts WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  o.id                          AS order_id,
  o.number                      AS order_number,
  o.supplier_id,
  s.legal_name                  AS supplier_name,
  i.id                          AS order_item_id,
  i.line_number,
  i.variant_id,
  v.sku,
  COALESCE(i.warehouse_id, o.warehouse_id) AS warehouse_id,
  o.expected_on,
  i.quantity,
  i.received_quantity,
  i.quantity - i.received_quantity AS pending_quantity,
  i.unit_cost
FROM purchasing.supplier_order_items i
JOIN purchasing.supplier_orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
JOIN app.suppliers s              ON s.tenant_id = o.tenant_id AND s.id = o.supplier_id
JOIN app.product_variants v       ON v.tenant_id = i.tenant_id AND v.id = i.variant_id
WHERE i.received_quantity < i.quantity
  AND o.status NOT IN ('cancelled', 'draft');

COMMENT ON VIEW purchasing.v_pending_receipts IS
  'Líneas de orden de compra con cantidad pendiente de recibir. Es la consulta diaria del comprador.';

-- -----------------------------------------------------------------------------
-- 4 · Recepciones de mercadería
-- -----------------------------------------------------------------------------
-- Una recepción es un documento con fecha y responsable, no un cambio de estado.
-- Recebir 60 y después 40 son dos hechos distintos, con dos remitos distintos
-- del proveedor, y tienen que quedar como dos filas.
CREATE TABLE purchasing.goods_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,
  order_id       uuid NOT NULL,

  -- Número de remito del proveedor: es el documento que viaja con la
  -- mercadería y el que se coteja cuando aparece una diferencia de cantidad.
  supplier_doc_number text,
  received_on    date NOT NULL DEFAULT CURRENT_DATE,
  notes          text,

  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gr_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT gr_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT gr_order_fk      FOREIGN KEY (tenant_id, order_id)
    REFERENCES purchasing.supplier_orders(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_gr_tenant_order ON purchasing.goods_receipts(tenant_id, order_id, received_on DESC);

CREATE TABLE purchasing.goods_receipt_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  receipt_id      uuid NOT NULL,
  order_item_id   uuid NOT NULL,

  quantity        numeric(14,3) NOT NULL,
  unit_cost       numeric(14,4) NOT NULL,

  -- El movimiento de stock que esta línea generó.
  --
  -- Es la trazabilidad de la recepción hacia el libro de stock: permite
  -- responder "¿de qué recepción vino esta entrada?" y, al revés, dado un
  -- movimiento, encontrar el documento. Sin esta columna la recepción y el
  -- movimiento son dos hechos que sólo comparten un timestamp.
  stock_movement_id uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gri_id_tenant      UNIQUE (tenant_id, id),
  CONSTRAINT gri_receipt_fk     FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES purchasing.goods_receipts(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT gri_order_item_fk  FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES purchasing.supplier_order_items(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT gri_quantity_positive CHECK (quantity > 0),
  CONSTRAINT gri_cost_non_negative CHECK (unit_cost >= 0)
);

CREATE INDEX idx_gri_tenant_receipt   ON purchasing.goods_receipt_items(tenant_id, receipt_id);
CREATE INDEX idx_gri_tenant_orderline ON purchasing.goods_receipt_items(tenant_id, order_item_id);

-- -----------------------------------------------------------------------------
-- 5 · Facturas de compra — el crédito fiscal
-- -----------------------------------------------------------------------------
-- Es lo que habilita la determinación de IVA de E5: sin factura de compra, el
-- cálculo de IVA sólo tendría el débito fiscal de las ventas.
CREATE TABLE purchasing.supplier_invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  -- Correlativo INTERNO del sistema, distinto del número del proveedor.
  --
  -- Son dos cosas diferentes: `number` es el identificador con el que Control se
  -- refiere a la factura internamente (y el que aparece en un listado o en un
  -- asiento), y `doc_type`/`point_of_sale`/`doc_number` son los del comprobante
  -- que emitió el proveedor. Confundirlos obligaría a usar un número ajeno para
  -- referirse a un documento propio, y el día que el proveedor se equivoque de
  -- numeración habría que reescribir el correlativo.
  number         text NOT NULL,
  supplier_id    uuid NOT NULL,
  order_id       uuid,

  -- Datos del comprobante del proveedor. `doc_type` reusa el vocabulario de AFIP
  -- ('A','B','C') en vez de inventar uno propio: una factura B de proveedor se
  -- carga igual que se emite, y la determinación de IVA necesita distinguirlas
  -- porque sólo las A discriminan crédito fiscal.
  doc_type       billing.doc_type NOT NULL,
  point_of_sale  integer NOT NULL,
  doc_number     bigint NOT NULL,

  issue_date     date NOT NULL,
  -- Vencimiento propio de esta factura, resuelto al cargarla desde la condición
  -- de pago del proveedor pero corregible: el proveedor a veces acuerda otra cosa.
  due_date       date NOT NULL,

  currency       char(3) NOT NULL DEFAULT 'ARS',
  fx_rate        numeric(14,6) NOT NULL DEFAULT 1,
  subtotal       numeric(14,2) NOT NULL DEFAULT 0,
  tax_total      numeric(14,2) NOT NULL DEFAULT 0,
  total          numeric(14,2) NOT NULL DEFAULT 0,

  -- Lo imputado por pagos. Se mantiene por `apply_supplier_payment()`.
  paid_total     numeric(14,2) NOT NULL DEFAULT 0,

  -- Retenciones sufridas, informadas por el proveedor en la factura.
  -- No se calculan acá: el cálculo es de E5. Acá se registra lo que llegó.
  withheld_total numeric(14,2) NOT NULL DEFAULT 0,

  status         text NOT NULL DEFAULT 'pending',
                 -- pending|partial|paid|cancelled

  -- Idempotencia de la carga.
  --
  -- Un mismo comprobante de proveedor no puede entrar dos veces. La garantía NO
  -- vive en la aplicación: es un índice único parcial, igual que
  -- `inv_idem_unique` de `0004` y `uq_job_runs_one_running` de `0010`.
  --
  -- El índice es sobre `source_id` cuando existe, que es el caso de la carga
  -- automática desde un origen externo (importación, integración). Ese es el
  -- camino que se reintenta y el que puede duplicar.
  source_type    text,
  source_id      uuid,

  notes          text,
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT si_id_tenant    UNIQUE (tenant_id, id),
  -- El correlativo interno es único por empresa. Es el que garantiza que dos
  -- cargas concurrentes no se pisen el número.
  CONSTRAINT si_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT si_supplier_fk  FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES app.suppliers(tenant_id, id) ON DELETE RESTRICT,
  -- RESTRICT y no SET NULL: `order_id` es nullable, pero una factura no debería
  -- perder la referencia a su orden por un borrado. Igual que en el resto de las
  -- tablas de negocio, un documento no se borra.
  CONSTRAINT si_order_fk     FOREIGN KEY (tenant_id, order_id)
    REFERENCES purchasing.supplier_orders(tenant_id, id) ON DELETE RESTRICT,

  -- El número de comprobante del proveedor es único por empresa: dos facturas
  -- con el mismo tipo, punto de venta y número son la misma factura. Es la
  -- garantía de que la carga manual tampoco duplica.
  CONSTRAINT si_comprobante_unique
    UNIQUE (tenant_id, supplier_id, doc_type, point_of_sale, doc_number),

  CONSTRAINT si_doc_number_positive CHECK (doc_number > 0 AND point_of_sale >= 0 AND point_of_sale <= 99999),
  CONSTRAINT si_totals_non_negative CHECK (
    subtotal >= 0 AND tax_total >= 0 AND total >= 0
    AND paid_total >= 0 AND withheld_total >= 0
  ),
  -- No se puede pagar más de lo que la factura dice, ni dejar el saldo negativo.
  CONSTRAINT si_paid_within_total CHECK (paid_total <= total),
  CONSTRAINT si_status_valid CHECK (status IN ('pending','partial','paid','cancelled')),
  -- Coherencia entre el estado y el monto pagado: un estado que contradice el
  -- número es la forma más barata de que un listado y un saldo discrepen.
  CONSTRAINT si_status_matches_paid CHECK (
    (status = 'paid'    AND paid_total = total) OR
    (status = 'partial' AND paid_total > 0 AND paid_total < total) OR
    (status = 'pending' AND paid_total = 0) OR
    (status = 'cancelled')
  )
);

-- LA GARANTÍA DE IDEMPOTENCIA. Índice único parcial condicionado a que haya
-- `source_id`: una carga manual (source_id NULL) no queda restringida por acá
-- porque su garantía es el UNIQUE del comprobante de arriba. Las dos cubren
-- caminos distintos y por eso conviven.
CREATE UNIQUE INDEX si_source_idem_unique
  ON purchasing.supplier_invoices (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX idx_si_tenant_supplier ON purchasing.supplier_invoices(tenant_id, supplier_id, issue_date DESC);
CREATE INDEX idx_si_tenant_due      ON purchasing.supplier_invoices(tenant_id, due_date)
  WHERE status IN ('pending', 'partial');

CREATE TRIGGER trg_si_touch BEFORE UPDATE ON purchasing.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE purchasing.supplier_invoice_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  variant_id    uuid,
  description   text,

  quantity      numeric(14,3) NOT NULL,
  unit_cost     numeric(14,4) NOT NULL,
  tax_rate      numeric(5,2)  NOT NULL DEFAULT 21.00,
  discount_rate numeric(5,2)  NOT NULL DEFAULT 0,

  -- Importes por línea, calculados por el motor al insertar.
  net_amount    numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total_amount  numeric(14,2) NOT NULL DEFAULT 0,

  order_item_id uuid,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sii_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT sii_invoice_fk   FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES purchasing.supplier_invoices(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sii_variant_fk   FOREIGN KEY (tenant_id, variant_id)
    REFERENCES app.product_variants(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sii_orderitem_fk FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES purchasing.supplier_order_items(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT sii_quantity_positive CHECK (quantity > 0),
  CONSTRAINT sii_amounts_non_negative CHECK (
    unit_cost >= 0 AND net_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
  ),
  CONSTRAINT sii_discount_range CHECK (discount_rate >= 0 AND discount_rate <= 100)
);

CREATE INDEX idx_sii_tenant_invoice ON purchasing.supplier_invoice_items(tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- 6 · Pagos a proveedores con imputación
-- -----------------------------------------------------------------------------
-- El pago y su imputación son dos cosas: un pago puede cubrir varias facturas y
-- una factura puede cubrirse con varios pagos. Modelarlos en una sola fila obliga
-- a duplicar el pago para repartirlo.
CREATE TABLE purchasing.supplier_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  number         text NOT NULL,
  supplier_id    uuid NOT NULL,

  paid_on        date NOT NULL DEFAULT CURRENT_DATE,
  method         text NOT NULL DEFAULT 'transfer',
                 -- cash|transfer|cheque|card|other
  -- Referencia externa: número de transferencia, de cheque, de cupón.
  reference      text,
  amount         numeric(14,2) NOT NULL,

  currency       char(3) NOT NULL DEFAULT 'ARS',
  fx_rate        numeric(14,6) NOT NULL DEFAULT 1,

  notes          text,
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sp_number_unique UNIQUE (tenant_id, number),
  CONSTRAINT sp_id_tenant     UNIQUE (tenant_id, id),
  CONSTRAINT sp_supplier_fk   FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES app.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sp_amount_positive CHECK (amount > 0),
  CONSTRAINT sp_method_valid CHECK (method IN ('cash','transfer','cheque','card','other'))
);

CREATE INDEX idx_sp_tenant_supplier ON purchasing.supplier_payments(tenant_id, supplier_id, paid_on DESC);

CREATE TRIGGER trg_sp_touch BEFORE UPDATE ON purchasing.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Imputación del pago a la factura. Es la tabla que permite pagos parciales y
-- pagos a cuenta.
CREATE TABLE purchasing.payment_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  payment_id    uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  amount        numeric(14,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pa_id_tenant   UNIQUE (tenant_id, id),
  CONSTRAINT pa_payment_fk  FOREIGN KEY (tenant_id, payment_id)
    REFERENCES purchasing.supplier_payments(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pa_invoice_fk  FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES purchasing.supplier_invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pa_amount_positive CHECK (amount > 0),
  -- Una factura no se puede imputar dos veces desde el mismo pago.
  CONSTRAINT pa_unique_pair UNIQUE (tenant_id, payment_id, invoice_id)
);

CREATE INDEX idx_pa_tenant_payment ON purchasing.payment_allocations(tenant_id, payment_id);
CREATE INDEX idx_pa_tenant_invoice ON purchasing.payment_allocations(tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- 7 · Saldo y antigüedad del proveedor — calculados, no almacenados
-- -----------------------------------------------------------------------------
-- La decisión 4 del encabezado, hecha vista. El saldo se deriva de los
-- documentos cada vez; no hay columna que pueda discrepar de ellos.
--
-- `total` menos lo imputado y menos lo retenido: la retención la sufre el
-- proveedor (cobra menos) pero la deuda se cancela igual, así que se descuenta.
CREATE VIEW purchasing.v_supplier_balances WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.supplier_id,
  s.legal_name AS supplier_name,
  count(*)                                              AS invoice_count,
  sum(i.total)                                          AS invoiced_total,
  sum(i.paid_total + i.withheld_total)                  AS settled_total,
  sum(i.total - i.paid_total - i.withheld_total)        AS outstanding_total,
  sum(CASE WHEN i.total - i.paid_total - i.withheld_total > 0
           THEN 1 ELSE 0 END)                           AS open_invoice_count
FROM purchasing.supplier_invoices i
JOIN app.suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
WHERE i.status <> 'cancelled'
GROUP BY i.tenant_id, i.supplier_id, s.legal_name;

COMMENT ON VIEW purchasing.v_supplier_balances IS
  'Saldo por proveedor derivado de los documentos. No hay columna de saldo: un saldo materializado puede discrepar de lo que resume.';

-- Antigüedad de saldos por tramos. Los cortes (30/60/90) son los que usa la
-- práctica comercial argentina y son los que el plan pide en §4.3.
--
-- El tramo se calcula contra `CURRENT_DATE`: una factura vencida hace 45 días
-- está en el tramo 31-60 aunque su vencimiento sea reciente.
CREATE VIEW purchasing.v_payables_aging WITH (security_invoker = true) AS
SELECT
  i.tenant_id,
  i.supplier_id,
  s.legal_name AS supplier_name,
  sum(CASE WHEN CURRENT_DATE - i.due_date <= 0  THEN i.total - i.paid_total - i.withheld_total ELSE 0 END) AS current_amount,
  sum(CASE WHEN CURRENT_DATE - i.due_date BETWEEN 1  AND 30  THEN i.total - i.paid_total - i.withheld_total ELSE 0 END) AS bucket_0_30,
  sum(CASE WHEN CURRENT_DATE - i.due_date BETWEEN 31 AND 60  THEN i.total - i.paid_total - i.withheld_total ELSE 0 END) AS bucket_31_60,
  sum(CASE WHEN CURRENT_DATE - i.due_date BETWEEN 61 AND 90  THEN i.total - i.paid_total - i.withheld_total ELSE 0 END) AS bucket_61_90,
  sum(CASE WHEN CURRENT_DATE - i.due_date >  90              THEN i.total - i.paid_total - i.withheld_total ELSE 0 END) AS bucket_over_90,
  sum(i.total - i.paid_total - i.withheld_total) AS total_outstanding
FROM purchasing.supplier_invoices i
JOIN app.suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
WHERE i.status IN ('pending', 'partial')
  AND i.total - i.paid_total - i.withheld_total > 0
GROUP BY i.tenant_id, i.supplier_id, s.legal_name;

-- -----------------------------------------------------------------------------
-- 8 · Recepción: el único camino de entrada de stock por compra
-- -----------------------------------------------------------------------------
-- La decisión 1 del encabezado. Esta función NO escribe `stock_levels` ni
-- `stock_movements`: delega en `apply_stock_movement()`, que es el único punto
-- de mutación de stock del sistema y ya sabe actualizar el costo promedio.
--
-- POR QUÉ EL ESTADO DE LA CABECERA SE RECALCULA Y NO SE ACUMULA
--
-- `supplier_orders.status` se **deriva** de las líneas con un `SELECT` sobre
-- `supplier_order_items`. Poner `status = 'partially_received'` a mano parece más
-- barato y es la semilla de la desincronización: la primera anulación de una
-- línea deja la cabecera diciendo algo que sus líneas no respaldan. Derivar
-- cuesta un `SELECT` y no puede quedar mal.
CREATE OR REPLACE FUNCTION purchasing.receive_order_line(
  p_tenant_id     uuid,
  p_order_item_id uuid,
  p_quantity      numeric,
  p_unit_cost     numeric DEFAULT NULL,
  p_receipt_id    uuid  DEFAULT NULL,
  p_supplier_doc  text  DEFAULT NULL
) RETURNS purchasing.goods_receipt_items
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_item        purchasing.supplier_order_items;
  v_order       purchasing.supplier_orders;
  v_receipt_id  uuid;
  v_warehouse   uuid;
  v_cost        numeric(14,4);
  v_level       app.stock_levels;
  v_movement_id uuid;
  v_row         purchasing.goods_receipt_items;
  v_pending     numeric(14,3);
BEGIN
  -- El contexto debe coincidir con el tenant operado (mismo guardia que
  -- `apply_stock_movement`).
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad recibida debe ser positiva (se recibió %)', p_quantity;
  END IF;

  SELECT * INTO v_item
  FROM purchasing.supplier_order_items
  WHERE tenant_id = p_tenant_id AND id = p_order_item_id
  FOR UPDATE;                       -- serializa dos recepciones simultáneas sobre la misma línea

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La línea de orden % no existe en esta empresa', p_order_item_id;
  END IF;

  SELECT * INTO v_order
  FROM purchasing.supplier_orders
  WHERE tenant_id = p_tenant_id AND id = v_item.order_id;

  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'No se puede recibir mercadería de una orden cancelada (orden %)', v_order.number;
  END IF;

  -- EL MENSAJE ÚTIL.
  --
  -- El CHECK `poi_not_over_received` ya impide la sobre-recepción, pero su
  -- mensaje es «el nuevo registro viola la restricción check
  -- poi_not_over_received»: dice QUÉ falló, no CUÁNTO se puede recibir. En una
  -- recepción real el operador está con el remito en la mano y necesita el número
  -- que le falta, así que la comprobación previa existe para poder decirlo.
  --
  -- No reemplaza al CHECK: el CHECK sigue estando abajo y es el que garantiza
  -- que ningún camino directo lo saltee. Esto es sólo la parte del mensaje.
  v_pending := v_item.quantity - v_item.received_quantity;

  IF p_quantity > v_pending THEN
    RAISE EXCEPTION
      'Recepción excedida en la línea %: se intentó recibir % y quedan % pendientes (pedido %, ya recibido %)',
      v_item.line_number, p_quantity, v_pending, v_item.quantity, v_item.received_quantity
      USING ERRCODE = '23514';
  END IF;

  -- Depósito: el de la línea, o el de la cabecera. Si ninguno está definido no se
  -- puede recibir: el stock tiene que entrar a algún lado.
  v_warehouse := COALESCE(v_item.warehouse_id, v_order.warehouse_id);
  IF v_warehouse IS NULL THEN
    RAISE EXCEPTION
      'La línea % no tiene depósito de destino (ni propio ni en la orden %)',
      v_item.line_number, v_order.number;
  END IF;

  -- Costo de esta recepción: el informado, o el pactado en la línea.
  v_cost := COALESCE(p_unit_cost, v_item.unit_cost);

  -- La recepción: se reusa la existente o se crea una nueva.
  IF p_receipt_id IS NOT NULL THEN
    SELECT id INTO v_receipt_id
    FROM purchasing.goods_receipts
    WHERE tenant_id = p_tenant_id AND id = p_receipt_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La recepción % no existe en esta empresa', p_receipt_id;
    END IF;
  ELSE
    INSERT INTO purchasing.goods_receipts (
      tenant_id, number, order_id, supplier_doc_number, received_on, created_by
    ) VALUES (
      p_tenant_id,
      purchasing.next_receipt_number(p_tenant_id),
      v_item.order_id,
      p_supplier_doc,
      CURRENT_DATE,
      app.current_user_id()
    )
    RETURNING id INTO v_receipt_id;
  END IF;

  -- EL STOCK ENTRA POR LA MISMA FUNCIÓN QUE TODO LO DEMÁS.
  --
  -- `apply_stock_movement` devuelve `app.stock_levels` y no el id del movimiento,
  -- así que la trazabilidad al movimiento se recupera por `source_type`/`source_id`
  -- del libro, que es donde efectivamente quedó escrito. Se usa el `id` de la
  -- recepción como `source_id`: es la referencia estable del documento.
  v_level := app.apply_stock_movement(
    p_tenant_id,
    v_item.variant_id,
    v_warehouse,
    'purchase_in'::app.stock_move_kind,
    p_quantity::integer,            -- `stock_movements.quantity` es integer
    v_cost,
    'goods_receipt',
    v_receipt_id,
    'Recepción de la orden ' || v_order.number
  );

  SELECT m.id INTO v_movement_id
  FROM app.stock_movements m
  WHERE m.tenant_id = p_tenant_id
    AND m.source_type = 'goods_receipt'
    AND m.source_id = v_receipt_id
    AND m.variant_id = v_item.variant_id
    AND m.warehouse_id = v_warehouse
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1;

  -- Acumular lo recibido. El CHECK de la tabla es el que impide pasarse; si esta
  -- suma lo hiciera, el UPDATE aborta y con él toda la transacción, incluyendo el
  -- movimiento de stock recién escrito. Recepción y stock suben o bajan juntos.
  UPDATE purchasing.supplier_order_items
     SET received_quantity = received_quantity + p_quantity
   WHERE tenant_id = p_tenant_id AND id = p_order_item_id;

  INSERT INTO purchasing.goods_receipt_items (
    tenant_id, receipt_id, order_item_id, quantity, unit_cost, stock_movement_id
  ) VALUES (
    p_tenant_id, v_receipt_id, p_order_item_id, p_quantity, v_cost, v_movement_id
  )
  RETURNING * INTO v_row;

  PERFORM purchasing.refresh_order_status(p_tenant_id, v_item.order_id);

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION purchasing.receive_order_line IS
  'Recepciona total o parcialmente una línea de orden de compra. Delega el stock en apply_stock_movement() y actualiza el estado de la cabecera.';

-- Recalcula el estado de la cabecera a partir de sus líneas.
--
-- Se llama desde `receive_order_line` y desde el trigger de las líneas, para que
-- modificar una línea por cualquier camino deje la cabecera coherente.
CREATE OR REPLACE FUNCTION purchasing.refresh_order_status(
  p_tenant_id uuid,
  p_order_id  uuid
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_status text;
  v_new    text;
BEGIN
  SELECT status INTO v_status
  FROM purchasing.supplier_orders
  WHERE tenant_id = p_tenant_id AND id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Una orden cancelada, en borrador o esperando aprobación no se recalcula: su
  -- estado lo gobierna el flujo de aprobación, no la recepción.
  IF v_status IN ('cancelled', 'draft', 'pending_approval') THEN
    RETURN v_status;
  END IF;

  -- Derivado de las líneas, sin acumular. `count(*) = 0` -una orden sin líneas-
  -- se trata como aprobada, que es el estado que tenía antes de recibir nada.
  SELECT
    CASE
      WHEN count(*) = 0 THEN 'approved'
      WHEN bool_and(received_quantity >= quantity) THEN 'received'
      WHEN bool_or(received_quantity > 0)          THEN 'partially_received'
      ELSE 'approved'
    END
  INTO v_new
  FROM purchasing.supplier_order_items
  WHERE tenant_id = p_tenant_id AND order_id = p_order_id;

  IF v_new IS DISTINCT FROM v_status THEN
    UPDATE purchasing.supplier_orders
       SET status = v_new
     WHERE tenant_id = p_tenant_id AND id = p_order_id;
  END IF;

  RETURN v_new;
END;
$$;

-- Correlativo de la recepción. Mismo patrón que el resto de los correlativos del
-- proyecto: se toma un lock por empresa para que dos recepciones concurrentes no
-- se asignen el mismo número. El lock es transaccional (`_xact_`), así que se
-- libera solo al terminar la transacción, incluso en un ROLLBACK.
CREATE OR REPLACE FUNCTION purchasing.next_receipt_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':goods_receipt', 0));

  SELECT COALESCE(max(NULLIF(regexp_replace(number, '^REC-', ''), '')::integer), 0) + 1
  INTO v_next
  FROM purchasing.goods_receipts
  WHERE tenant_id = p_tenant_id AND number ~ '^REC-[0-9]+$';

  RETURN 'REC-' || lpad(v_next::text, 8, '0');
END;
$$;

-- -----------------------------------------------------------------------------
-- 9 · Imputación de pagos
-- -----------------------------------------------------------------------------
-- Registra un pago y lo imputa a una o más facturas. El monto del pago tiene que
-- coincidir con la suma de sus imputaciones: un pago del que sólo una parte tiene
-- destino es un dato que no cuadra contra nada.
--
-- `p_allocations` es un jsonb `[{"invoice_id": "...", "amount": 100}, ...]`, mismo
-- patrón que `entry_lines_for()` de `0013`: las líneas variables entran por jsonb
-- y la función las valida una por una en vez de exigir N llamadas desde la
-- aplicación.
CREATE OR REPLACE FUNCTION purchasing.apply_supplier_payment(
  p_tenant_id   uuid,
  p_supplier_id uuid,
  p_paid_on     date,
  p_method      text,
  p_amount      numeric,
  p_allocations jsonb,
  p_reference   text DEFAULT NULL,
  p_notes       text DEFAULT NULL
) RETURNS purchasing.supplier_payments
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_payment    purchasing.supplier_payments;
  v_alloc      jsonb;
  v_invoice    purchasing.supplier_invoices;
  v_inv_id     uuid;
  v_amount     numeric(14,2);
  v_sum        numeric(14,2) := 0;
  v_outstanding numeric(14,2);
  v_next       integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto del pago debe ser positivo (se informó %)', p_amount;
  END IF;

  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'El pago necesita al menos una imputación';
  END IF;

  PERFORM 1 FROM app.suppliers
  WHERE tenant_id = p_tenant_id AND id = p_supplier_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El proveedor % no existe o no está activo', p_supplier_id;
  END IF;

  -- Correlativo del pago.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':supplier_payment', 0));
  SELECT COALESCE(max(NULLIF(regexp_replace(number, '^PAGO-', ''), '')::integer), 0) + 1
  INTO v_next
  FROM purchasing.supplier_payments
  WHERE tenant_id = p_tenant_id AND number ~ '^PAGO-[0-9]+$';

  INSERT INTO purchasing.supplier_payments (
    tenant_id, number, supplier_id, paid_on, method, reference, amount, created_by
  ) VALUES (
    p_tenant_id, 'PAGO-' || lpad(v_next::text, 8, '0'), p_supplier_id,
    p_paid_on, p_method, p_reference, p_amount, app.current_user_id()
  )
  RETURNING * INTO v_payment;

  -- Imputación, una por una, validando cada factura contra el proveedor del pago.
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_inv_id := (v_alloc ->> 'invoice_id')::uuid;
    v_amount := (v_alloc ->> 'amount')::numeric(14,2);

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Cada imputación necesita un monto positivo (se informó %)', v_amount;
    END IF;

    SELECT * INTO v_invoice
    FROM purchasing.supplier_invoices
    WHERE tenant_id = p_tenant_id AND id = v_inv_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La factura % no existe en esta empresa', v_inv_id;
    END IF;

    -- Una factura de otro proveedor es un error de carga, y aceptarlo haría que el
    -- saldo de un proveedor se cancelara con la deuda de otro. El motor lo impide.
    IF v_invoice.supplier_id IS DISTINCT FROM p_supplier_id THEN
      RAISE EXCEPTION
        'La factura % pertenece a otro proveedor: no se puede imputar a un pago de %',
        v_invoice.id, p_supplier_id;
    END IF;

    IF v_invoice.status = 'cancelled' THEN
      RAISE EXCEPTION 'La factura % está anulada y no admite imputaciones', v_invoice.id;
    END IF;

    v_outstanding := v_invoice.total - v_invoice.paid_total - v_invoice.withheld_total;
    IF v_amount > v_outstanding THEN
      RAISE EXCEPTION
        'Imputación excedida en la factura % %: se intentó imputar % y el saldo es %',
        v_invoice.doc_type, v_invoice.doc_number, v_amount, v_outstanding
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO purchasing.payment_allocations (tenant_id, payment_id, invoice_id, amount)
    VALUES (p_tenant_id, v_payment.id, v_inv_id, v_amount);

    -- Acumular lo pagado y derivar el estado. Igual que en las órdenes: el estado
    -- se recalcula desde el número, no se escribe a mano.
    UPDATE purchasing.supplier_invoices
       SET paid_total = paid_total + v_amount,
           status = CASE
                      WHEN paid_total + v_amount >= total - withheld_total THEN 'paid'
                      ELSE 'partial'
                    END
     WHERE tenant_id = p_tenant_id AND id = v_inv_id;

    v_sum := v_sum + v_amount;
  END LOOP;

  -- El pago tiene que estar íntegramente imputado. Si un pago de $1000 se imputa
  -- por $600, hay $400 cuyo destino se desconoce, y el saldo del proveedor queda
  -- diciendo que se le debe algo que ya se le pagó.
  IF v_sum <> p_amount THEN
    RAISE EXCEPTION
      'Las imputaciones suman % y el pago es de %: el pago tiene que quedar íntegramente imputado',
      v_sum, p_amount
      USING ERRCODE = '23514';
  END IF;

  RETURN v_payment;
END;
$$;

COMMENT ON FUNCTION purchasing.apply_supplier_payment IS
  'Registra un pago a proveedor y lo imputa a facturas. Exige que las imputaciones sumen el total del pago.';

-- -----------------------------------------------------------------------------
-- 10 · Asientos automáticos de compras (E2 → E3)
-- -----------------------------------------------------------------------------
-- Las reglas de mapeo y los roles contables de compras. `0013` dejó el motor
-- listo y el enum `entry_source` ya tenía `purchase` y `supplier_payment`
-- definidos desde `0012` —con el comentario "fase E3"— así que acá sólo se
-- agregan las reglas que faltaban.
--
-- Se hace con `ON CONFLICT DO UPDATE` y no `DO NOTHING`: el seed de `0013` corre
-- para cada empresa, y una regla de compras que ya exista tiene que quedar con
-- los valores de esta migración, no con los de una versión anterior.
--
-- Las cuentas destino ya existen en la plantilla de `0012`:
--   2.1.1.01  Proveedores              (pasivo)
--   1.1.4.01  IVA crédito fiscal       (activo)
--   5.1.1.01  Costo de mercadería vendida (gasto) — se usa para el neto de compra
--   1.1.3.01  Deudores por ventas      (activo, para el reverso)
CREATE OR REPLACE FUNCTION purchasing.seed_tenant_purchasing_config(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_cuentas integer := 0;
  v_roles   integer := 0;
  v_reglas  integer := 0;
  v_faltan  text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  -- El plan de la empresa se copia si todavía no existe.
  --
  -- Sin esto, el seed de compras no tendría contra qué resolver los códigos: la
  -- plantilla del plan mínimo vive con `tenant_id IS NULL` y cada empresa tiene
  -- su copia. Se intenta sólo si la empresa no tiene ninguna cuenta, porque la
  -- función de copia aborta —con razón— si ya hay un plan cargado.
  IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE tenant_id = p_tenant_id) THEN
    v_cuentas := accounting.seed_tenant_chart_of_accounts(p_tenant_id);
  END IF;

  -- Se resuelven por código y, si falta alguna, se dice CUÁL. Un mensaje que
  -- nombra la cuenta que falta es accionable; uno que dice "faltan cuentas" obliga
  -- a averiguar cuáles.
  SELECT string_agg(m.code, ', ') INTO v_faltan
  FROM (VALUES ('2.1.1.01'), ('1.1.4.01'), ('5.1.1.01'), ('1.1.5.01'), ('1.1.1.01')) AS m(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting.accounts a
    WHERE a.tenant_id = p_tenant_id AND a.code = m.code
  );

  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION
      'La empresa % no tiene las cuentas que compras necesita: %. '
      'Ejecutá accounting.seed_tenant_chart_of_accounts() y accounting.seed_tenant_accounting_config() primero.',
      p_tenant_id, v_faltan
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Roles que NECESITA el motor de compras.
  --
  -- `payable`, `vat_receivable`, `cash` e `inventory` están en la lista de
  -- `0013`, pero se repiten acá a propósito: `seed_tenant_accounting_config` los
  -- inserta con `DO NOTHING` sobre el conjunto que conoce, y esta función tiene
  -- que poder garantizar por sí sola que TODOS los roles que sus reglas nombran
  -- existan. Un rol que una regla referencia y la tabla no resuelve no falla al
  -- configurar: falla al asentar, con el hecho ya creado.
  INSERT INTO accounting.account_roles (tenant_id, role, account_id)
  SELECT p_tenant_id, m.role, a.id
  FROM (VALUES
    ('purchase_expense', '5.1.1.01'),   -- Costo de mercadería vendida
    ('payable',          '2.1.1.01'),   -- Cuentas a pagar proveedores
    ('vat_receivable',   '1.1.4.01'),   -- IVA crédito fiscal
    ('inventory',        '1.1.5.01'),   -- Inventario de mercaderías
    ('cash',             '1.1.1.01')    -- Caja (contrapartida del pago)
  ) AS m(role, code)
  JOIN accounting.accounts a
    ON a.tenant_id = p_tenant_id AND a.code = m.code
  ON CONFLICT (tenant_id, role) DO UPDATE
    SET account_id = EXCLUDED.account_id,
        updated_at = now();

  -- Reglas de mapeo hecho → asiento.
  --
  -- Mismo esquema que `0013`: UNA FILA POR LÍNEA, con `line_number` que fija el
  -- orden, `account_role` que nombra el rol (no la cuenta), `is_credit_line` que
  -- define el lado y `amount_key` que nombra el importe del hecho a usar.
  --
  -- POR QUÉ POR LÍNEA Y NO UN JSONB CON LA LISTA
  --
  -- Porque el `UNIQUE (tenant_id, source_type, event_kind, line_number)` hace
  -- que agregar una línea a un mapeo existente sea un INSERT y no un read-modify-
  -- write sobre un documento. Con un jsonb, dos migraciones concurrentes que
  -- toquen el mismo mapeo se pisan.
  INSERT INTO accounting.mapping_rules
    (tenant_id, source_type, event_kind, line_number, account_role, is_credit_line, amount_key, description)
  VALUES
    -- Factura de compra: es el espejo de la factura de venta.
    --
    -- El neto va al costo, el IVA a crédito fiscal (activo, aumenta al debe) y
    -- el proveedor al haber (pasivo, aumenta al haber). La suma de las dos patas
    -- del debe tiene que igualar al haber, y por eso el neto y el IVA se derivan
    -- de `total`: usar `total` en el debe y descomponerlo en el haber es lo que
    -- garantiza el cuadre incluso si la factura trae percepciones.
    (p_tenant_id, 'purchase', 'purchase',       1, 'purchase_expense', false, 'subtotal',  'Mercadería recibida (neto de impuestos)'),
    (p_tenant_id, 'purchase', 'purchase',       2, 'vat_receivable',   false, 'tax_total', 'IVA crédito fiscal de la compra'),
    (p_tenant_id, 'purchase', 'purchase',       3, 'payable',          true,  'total',     'Deuda con el proveedor'),

    -- Nota de crédito de proveedor: revierte la factura. Se asienta como hecho
    -- propio con su propio asiento, igual que la nota de crédito de venta.
    (p_tenant_id, 'purchase', 'credit_note',    1, 'payable',          false, 'total',     'Proveedor: se reduce la deuda'),
    (p_tenant_id, 'purchase', 'credit_note',    2, 'purchase_expense', true,  'subtotal',  'Reverso del costo de la compra'),
    (p_tenant_id, 'purchase', 'credit_note',    3, 'vat_receivable',   true,  'tax_total', 'IVA crédito fiscal revertido'),

    -- Recepción de mercadería: entra el inventario contra la deuda.
    --
    -- Es el asiento que pide la decisión contable de que el hecho económico sea
    -- la recepción y no la factura: la mercadería entra al patrimonio cuando
    -- llega físicamente, y la deuda nace con ella. La factura después ajusta el
    -- IVA y confirma el importe.
    --
    -- Se asienta con `cost_amount` —el costo total de lo recibido— que es la
    -- misma clave que usa la salida de stock, y por eso el costo de venta y el
    -- costo de compra se miden con el mismo criterio.
    (p_tenant_id, 'goods_receipt', 'goods_receipt', 1, 'inventory',    false, 'cost_amount', 'Inventario recibido, valuado al costo'),
    (p_tenant_id, 'goods_receipt', 'goods_receipt', 2, 'payable',      true,  'cost_amount', 'Deuda con el proveedor por la recepción'),

    -- Pago a proveedor: baja la deuda contra caja.
    --
    -- El importe del pago entra como `total` y no como una clave `amount`: el
    -- CHECK `mapping_amount_key_known` de `0013` fija el vocabulario permitido
    -- —`total`, `subtotal`, `tax_total`, `line_amount`, `cost_amount`,
    -- `tax_amount`— y el generador resuelve las claves contra el jsonb de
    -- importes del hecho. La aplicación pasa `{"total": <monto del pago>}`.
    --
    -- La pata contra caja usa el rol `cash`, que ya siembra `0013`. El mapeo a
    -- banco y a cheques —con su ciclo de vida propio— es de E4; acá se deja la
    -- pata de caja para que el asiento de un pago en efectivo cierre hoy.
    (p_tenant_id, 'supplier_payment', 'supplier_payment', 1, 'payable', false, 'total', 'Proveedor: se reduce la deuda por el pago'),
    (p_tenant_id, 'supplier_payment', 'supplier_payment', 2, 'cash',    true,  'total', 'Salida de caja por el pago')
  ON CONFLICT (tenant_id, source_type, event_kind, line_number) DO UPDATE
    SET account_role   = EXCLUDED.account_role,
        is_credit_line = EXCLUDED.is_credit_line,
        amount_key     = EXCLUDED.amount_key,
        description    = EXCLUDED.description;

  GET DIAGNOSTICS v_roles  = ROW_COUNT;

  SELECT count(*) INTO v_reglas
  FROM accounting.mapping_rules
  WHERE tenant_id = p_tenant_id AND source_type IN ('purchase', 'goods_receipt', 'supplier_payment');

  RETURN v_cuentas + v_roles + v_reglas;
END;
$$;

COMMENT ON FUNCTION purchasing.seed_tenant_purchasing_config IS
  'Roles contables y reglas de mapeo de compras para una empresa. Requiere la plantilla de accounting.seed_tenant_accounting_config().';

-- -----------------------------------------------------------------------------
-- 11 · Orden de las líneas y correlativos faltantes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purchasing.next_order_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':supplier_order', 0));

  SELECT COALESCE(max(NULLIF(regexp_replace(number, '^OC-', ''), '')::integer), 0) + 1
  INTO v_next
  FROM purchasing.supplier_orders
  WHERE tenant_id = p_tenant_id AND number ~ '^OC-[0-9]+$';

  RETURN 'OC-' || lpad(v_next::text, 8, '0');
END;
$$;

CREATE OR REPLACE FUNCTION purchasing.next_invoice_number(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':supplier_invoice', 0));

  SELECT COALESCE(max(NULLIF(regexp_replace(number, '^FC-C-', ''), '')::integer), 0) + 1
  INTO v_next
  FROM purchasing.supplier_invoices
  WHERE tenant_id = p_tenant_id AND number ~ '^FC-C-[0-9]+$';

  RETURN 'FC-C-' || lpad(v_next::text, 8, '0');
END;
$$;

-- -----------------------------------------------------------------------------
-- 12 · Aislamiento (RLS) sobre las tablas nuevas
-- -----------------------------------------------------------------------------
-- Mismo macro dinámico que `0012` y `0013`, descubriendo tablas desde
-- `pg_class`: una lista escrita a mano se desactualiza en silencio y deja de
-- proteger (regla 9 de la convención del proyecto).
--
-- ENABLE y FORCE. `FORCE` es el que importa: sin él, el dueño de la tabla
-- —`postgres`, que es quien corre las migraciones— saltea sus propias políticas.
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
      AND n.nspname IN ('purchasing', 'app')
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      )
      -- Sólo las tablas de esta migración: `app` tiene decenas de tablas ya
      -- cubiertas por `0006`, y volver a aplicarlas sería redundante. Se filtra
      -- por las que todavía no tienen política.
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
-- 13 · Permisos
-- -----------------------------------------------------------------------------
-- `GRANT USAGE ON SCHEMA` va primero y explícito. Es el defecto que costó la
-- migración `0012` entera: sin él PostgreSQL rechaza el acceso ANTES de evaluar
-- los privilegios de tabla, y los GRANT de abajo quedan inertes —un archivo que
-- parece completo y una aplicación que no puede leer nada.
--
-- OJO: las tablas de `purchasing` dependen de un `CREATE SCHEMA` previo, que va
-- antes en este archivo.
GRANT USAGE ON SCHEMA purchasing TO control_app, control_readonly;

-- `control_app` opera compras completa: crear órdenes, recibir, facturar, pagar.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.suppliers                    TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.supplier_orders       TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.supplier_order_items  TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.goods_receipts        TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.goods_receipt_items   TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.supplier_invoices     TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.supplier_invoice_items TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.supplier_payments     TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.payment_allocations   TO control_app;

GRANT SELECT ON app.suppliers                  TO control_readonly;
GRANT SELECT ON purchasing.supplier_orders     TO control_readonly;
GRANT SELECT ON purchasing.supplier_order_items TO control_readonly;
GRANT SELECT ON purchasing.goods_receipts      TO control_readonly;
GRANT SELECT ON purchasing.goods_receipt_items TO control_readonly;
GRANT SELECT ON purchasing.supplier_invoices   TO control_readonly;
GRANT SELECT ON purchasing.supplier_invoice_items TO control_readonly;
GRANT SELECT ON purchasing.supplier_payments   TO control_readonly;
GRANT SELECT ON purchasing.payment_allocations TO control_readonly;

-- Las vistas son objetos de pleno derecho y NO quedan cubiertas por el GRANT de
-- las tablas de las que dependen. Una vista sin `GRANT SELECT` devuelve
-- `permiso denegado` aunque el rol pueda leer todas sus tablas base — y ese error
-- aparece recién cuando alguien consulta la vista, no al aplicar la migración.
-- Por eso van explícitas acá y también en `ALTER DEFAULT PRIVILEGES` de abajo:
-- una vista nueva en `purchasing` no debería requerir acordarse de este bloque.
GRANT SELECT ON purchasing.v_pending_receipts  TO control_app, control_readonly;
GRANT SELECT ON purchasing.v_supplier_balances TO control_app, control_readonly;
GRANT SELECT ON purchasing.v_payables_aging    TO control_app, control_readonly;

GRANT EXECUTE ON FUNCTION purchasing.receive_order_line(uuid, uuid, numeric, numeric, uuid, text) TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.refresh_order_status(uuid, uuid)          TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.apply_supplier_payment(uuid, uuid, date, text, numeric, jsonb, text, text) TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.next_order_number(uuid)                   TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.next_receipt_number(uuid)                 TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.next_invoice_number(uuid)                 TO control_app;
GRANT EXECUTE ON FUNCTION purchasing.seed_tenant_purchasing_config(uuid)       TO control_app;

-- Por defecto, para las tablas que se agreguen a `purchasing` en el futuro. Sin
-- esto, cada tabla nueva requiere acordarse de los GRANT — y olvidarlo se
-- manifiesta como un error de permisos en producción, no en los tests.
--
-- Las vistas se declaran aparte porque son un tipo de objeto distinto: un GRANT
-- sobre `TABLES` no alcanza a las vistas, y una vista creada después de esta
-- migración quedaría sin acceso con el mismo síntoma silencioso.
ALTER DEFAULT PRIVILEGES IN SCHEMA purchasing
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA purchasing
  GRANT SELECT ON TABLES TO control_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA purchasing
  GRANT SELECT ON SEQUENCES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA purchasing
  GRANT SELECT ON SEQUENCES TO control_readonly;

-- -----------------------------------------------------------------------------
-- 14 · Job de verificación de asientos de compras
-- -----------------------------------------------------------------------------
-- Se reusa el mecanismo de `0013`: `v_posting_gaps` descubre los hechos sin
-- asiento a partir de las tablas de origen, y `accounting.posting_check` los
-- reporta. Acá sólo hay que registrar el job de compras para que el ledger sepa
-- que existe y tenga cadencia.
--
-- La consulta de brechas NO se duplica: extender `v_posting_gaps` para cubrir
-- compras es una migración de `0013`-style (`CREATE OR REPLACE VIEW`), y se hace
-- abajo para que `accounting.posting_check` la vea sin cambios.
INSERT INTO ops.jobs (code, description, expected_every)
VALUES (
  'purchasing.receivables_check',
  'Verifica que las compras concilien con los pagos imputados: toda factura pagada tiene que estar saldada y ningún pago puede quedar sin imputar.',
  interval '1 day'
)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 15 · Extensión de la vista de brechas para compras
-- -----------------------------------------------------------------------------
-- `0013` definió `v_posting_gaps` para ventas y stock. Extenderla para compras es
-- la razón por la que el plan pone compras después de E2: el patrón ya existe, se
-- replica.
--
-- `CREATE OR REPLACE VIEW` conserva los permisos y el `security_invoker` de la
-- definición nueva: la opción se repite acá porque una vista reemplazada sin
-- `security_invoker` perdería el RLS heredado y vería datos de todas las
-- empresas. Es exactamente el defecto que la convención del proyecto prohíbe.
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
  AND e.id IS NULL

UNION ALL

-- Facturas de compra registradas sin asiento. Excluye las anuladas: una factura
-- cancelada no genera asiento, así que su ausencia no es una brecha.
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

-- Salidas de stock por venta con costo sin asiento de costo de mercadería.
-- Se conserva del `0013` original: quitar ramas al reemplazar una vista es la
-- forma silenciosa de perder cobertura.
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
  'Hechos económicos sin asiento contable: facturas de venta y compra, pagos a proveedor y salidas de stock con costo. Alimenta accounting.posting_check.';

-- -----------------------------------------------------------------------------
-- 16 · Cierre
-- -----------------------------------------------------------------------------
-- La barrera. Si alguna tabla de esta migración quedó sin FORCE RLS o sin
-- política, esta llamada falla y la migración se revierte entera. Un PR con una
-- tabla sin cobertura no llega a producción.
SELECT app.assert_rls_coverage();

COMMIT;
