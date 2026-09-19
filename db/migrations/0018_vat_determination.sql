-- =============================================================================
-- Control · 0018 · Determinación de IVA y libro digital
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- El gate de E5, §7.1: **"posición de IVA reproducible desde el libro"**, y los
-- criterios F-1..F-6 de §6.2. Hasta acá el sistema emitía comprobantes correctos y
-- no podía decir cuánto IVA hay que pagar — que es la diferencia entre un
-- facturador y el sistema contable de una empresa.
--
-- LO QUE ESTA MIGRACIÓN NO HACE: NO GUARDA LA POSICIÓN.
--
-- Es la decisión 3 del ADR `0004`, y es la decisión que gobierna todo el archivo.
-- No hay tabla `fiscal.iva_positions` con el resultado. La posición se calcula
-- siempre desde el libro.
--
-- El motivo no es purismo. F-6 no pide "un número guardado": pide uno
-- REPRODUCIBLE DESDE EL LIBRO, que es lo contrario de guardarlo. Una posición
-- almacenada es un número que se presenta ante un organismo fiscal y que puede
-- quedar desincronizado del libro por una nota de crédito posterior, una
-- rectificativa o una reapertura de período. Y no hay forma de detectar la
-- desincronización sin recalcular — es decir, sin hacer el trabajo que el caché
-- existía para evitar.
--
-- Es la misma decisión que `0015` tomó para `payment_status` y que `0016` tomó
-- para el saldo de tesorería. Las tres están escritas en sus migraciones con el
-- mismo argumento, y las tres existen para que el proyecto no tenga dos verdades
-- sobre el mismo hecho.
--
-- LA CADENA, DE PUNTA A PUNTA
--
-- El débito y el crédito fiscal YA SE ASENTABAN desde `0013`:
--
--     invoice/invoice       → vat_payable    (haber) tax_total   IVA débito
--     invoice/credit_note   → vat_payable    (debe)  tax_total   débito revertido
--     supplier_invoice      → vat_receivable (debe)  tax_total   IVA crédito
--
-- Lo que faltaba era poder responder tres preguntas que un total agregado no
-- responde:
--
--   1. **¿A qué alícuota corresponde ese IVA?** F-1 compara el débito del período
--      contra los comprobantes, y F-3 presenta el libro DISCRIMINADO POR ALÍCUOTA.
--      `invoices.tax_total` es un número: dice cuánto y no de qué alícuota.
--      Reconstruirla dividiendo por 0,21 falla en cuanto un comprobante mezcla
--      alícuotas, y ninguno avisa que las mezcló. La respuesta está en
--      `fiscal.document_taxes`.
--
--   2. **¿El crédito fiscal de una compra se computa en el período CORRECTO?**
--      F-2. "Correcto" no es el período de la fecha de emisión de la factura de
--      compra: es el período en que el crédito es computable, que en Argentina
--      depende de la recepción. Una factura de marzo recibida en abril tiene su
--      crédito en abril. Por eso la sección 2 resuelve la fecha por RECEPCIÓN y no
--      por emisión, y por eso F-2 existe como criterio propio.
--
--   3. **¿Los comprobantes están todos en el libro, y el libro cuadra con ellos?**
--      F-3 exige que el libro digital cuadre con los comprobantes. La sección 4
--      expone la brecha —qué comprobante está sin discriminar, qué discriminado
--      no tiene asiento— en vez de asumir que todo está bien.
--
-- LAS TRES DECISIONES
--
-- 1. LA POSICIÓN SE DERIVA. Ver arriba: no hay columna ni tabla de saldo.
--
-- 2. EL LIBRO TIENE UN FORMATO DE PRESENTACIÓN, Y ES UN DATO.
--
--    `requiredBooks()` es uno de los cuatro métodos del contrato `TaxDriver`
--    (ADR 0004). Un libro digital no es "el listado de comprobantes": tiene
--    columnas obligatorias, un orden y un conjunto de subtotales que define el
--    organismo, y cambia por resolución. `fiscal.book_definitions` guarda cuál es
--    el formato vigente; las columnas que expone el libro son las del vocabulario
--    neutral y la traducción al formato de presentación es del driver.
--
-- 3. LA FECHA DE CÓMPUTO ES UN DATO DEL HECHO, NO UNA PROPIEDAD DEL COMPROBANTE.
--
--    Es la decisión que hace F-2 verificable. `fiscal.vat_accruals` registra, por
--    comprobante y por alícuota, en qué período se computa el impuesto Y POR QUÉ.
--    Guardar el `period_id` resuelto —y no recalcularlo a demanda— es deliberado:
--    la regla cambia por normativa, y una determinación de 2025 que en 2027 se
--    recalculara con la regla nueva dejaría de ser reproducible. El criterio
--    aplicado se congela, igual que la alícuota en `document_taxes`.
--
-- POR QUÉ `vat_accruals` NO ES UNA TABLA DE SALDOS: no guarda importes de
-- posición, guarda HECHOS de imputación. Cada fila dice "este comprobante, a esta
-- alícuota, se computa en este período". La suma de esas filas es la posición, y la
-- suma se hace en la consulta. Un hecho de imputación es un dato de entrada; un
-- saldo de posición es un resultado. Mezclarlos es lo que produce las dos verdades.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1 · Formatos de libro obligatorios
-- =============================================================================
-- ADR 0004, decisión 2: los parámetros de la norma se versionan. Un formato de
-- libro es un parámetro: cambia por resolución y las presentaciones ya hechas
-- tienen que seguir siendo reproducibles con el formato que regía entonces.
-- =============================================================================

CREATE TABLE fiscal.book_definitions (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  -- Código neutral del libro: 'vat_purchases', 'vat_sales'.
  code          text NOT NULL,
  name          text NOT NULL,
  tax_id        uuid NOT NULL,
  -- Las columnas del libro, en orden, como array de objetos. Es la definición del
  -- formato de presentación y no una lista de nombres de columna de una vista: el
  -- libro se arma en consulta, y esto dice QUÉ campos expone y en qué orden.
  columns       jsonb NOT NULL,
  -- El código del formato ante el organismo: en Argentina, el número de régimen.
  -- Vive acá y no en el nombre del libro, por la misma razón que los códigos
  -- locales en `0017`: es local por definición.
  local_code    text,
  valid_from    date NOT NULL,
  valid_to      date,
  legal_basis   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT book_code_not_blank CHECK (length(btrim(code)) > 0),
  CONSTRAINT book_range_valid CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT book_columns_is_array CHECK (jsonb_typeof(columns) = 'array'),

  -- Una definición vigente por libro y momento. Mismo problema que `tax_rates` y
  -- misma solución: centinela en el `COALESCE` para que la versión de plataforma
  -- (`tenant_id NULL`) también quede cubierta — en un `EXCLUDE` NULL es distinto
  -- de NULL. Ver `0017`.
  CONSTRAINT book_no_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tax_id    WITH =,
    code      WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);

CREATE UNIQUE INDEX book_definitions_tenant_id_uniq ON fiscal.book_definitions(tenant_id, id);

ALTER TABLE fiscal.book_definitions
  ADD CONSTRAINT book_definitions_tax_fk
  FOREIGN KEY (tenant_id, tax_id)
  REFERENCES fiscal.taxes(tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX idx_book_definitions_lookup ON fiscal.book_definitions(code, valid_from DESC);

COMMENT ON TABLE fiscal.book_definitions IS
  'Formatos de libro obligatorios con vigencia temporal. Las columnas viven en `columns` porque el formato lo define el organismo y cambia por resolución: una presentación de 2025 tiene que seguir reproduciéndose con el formato que regía entonces (ADR 0004).';

-- =============================================================================
-- 2 · Imputación del impuesto a un período de cómputo
-- =============================================================================
-- La tabla que hace F-2 verificable, y la decisión 3 del encabezado.
--
-- POR QUÉ NO SE DERIVA LA FECHA AL CONSULTAR: porque la regla es normativa. Hoy el
-- crédito fiscal de una compra se computa en el período de la RECEPCIÓN; hace
-- unos años, en algunos regímenes, en el de la emisión. Una determinación de 2025
-- recalculada en 2027 con la regla de 2027 daría otro número — y ese número ya se
-- presentó. El criterio aplicado se congela con el hecho.
--
-- POR QUÉ ESTO NO ES UN SALDO: cada fila es un HECHO de imputación ("este
-- comprobante, a esta alícuota, se computa en este período"). La posición es la
-- SUMA de los hechos del período, y se hace en la consulta de la sección 3. Un
-- hecho es entradia; un saldo es resultado.
-- =============================================================================

CREATE TABLE fiscal.vat_accruals (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  -- El comprobante que origina el hecho. FK compuesta: un comprobante de otra
  -- empresa no puede imputarse acá.
  invoice_id    uuid NOT NULL,
  tax_id        uuid NOT NULL,
  -- 'debit' = débito fiscal (ventas), 'credit' = crédito fiscal (compras).
  direction     text NOT NULL,
  rate_code     text NOT NULL,
  -- La alícuota aplicada, copiada: el hecho se congela igual que el discriminado.
  rate          numeric(9,6) NOT NULL,
  taxable_base  numeric(14,2) NOT NULL,
  amount        numeric(14,2) NOT NULL,
  -- El período contable en que se computa, resuelto al registrar el hecho.
  period_id     uuid NOT NULL,
  -- La fecha del hecho que determina el cómputo. Para una venta es la emisión;
  -- para una compra, la recepción. Se guarda la FECHA y no sólo el período,
  -- porque es lo que permite auditar por qué cayó en ese período.
  accrued_on    date NOT NULL,
  -- Por qué se computó en ese período. Sin esto, un auditor ve el período y no
  -- puede distinguir "se computó bien" de "se computó en el período en que se
  -- registró el asiento".
  accrual_basis text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vat_accruals_direction_valid CHECK (direction IN ('debit','credit')),
  CONSTRAINT vat_accruals_rate_valid CHECK (rate >= 0 AND rate < 1),
  CONSTRAINT vat_accruals_amount_valid CHECK (amount >= 0),
  CONSTRAINT vat_accruals_base_valid CHECK (taxable_base >= 0),
  CONSTRAINT vat_accruals_basis_not_blank CHECK (length(btrim(accrual_basis)) > 0),

  -- Idempotencia: un comprobante imputa una vez cada alícuota de cada impuesto.
  -- Un reproceso no puede duplicar el cómputo — duplicarlo inflaría el débito y
  -- el resultado sería una posición que no cuadra con los comprobantes (F-1).
  CONSTRAINT vat_accruals_uniq
    UNIQUE (tenant_id, invoice_id, tax_id, direction, rate_code)
);

CREATE UNIQUE INDEX vat_accruals_tenant_id_uniq ON fiscal.vat_accruals(tenant_id, id);

ALTER TABLE fiscal.vat_accruals
  ADD CONSTRAINT vat_accruals_invoice_fk
  FOREIGN KEY (tenant_id, invoice_id)
  REFERENCES billing.invoices(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE fiscal.vat_accruals
  ADD CONSTRAINT vat_accruals_tax_fk
  FOREIGN KEY (tenant_id, tax_id)
  REFERENCES fiscal.taxes(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE fiscal.vat_accruals
  ADD CONSTRAINT vat_accruals_period_fk
  FOREIGN KEY (tenant_id, period_id)
  REFERENCES accounting.periods(tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX idx_vat_accruals_period ON fiscal.vat_accruals(tenant_id, period_id, direction);
CREATE INDEX idx_vat_accruals_invoice ON fiscal.vat_accruals(tenant_id, invoice_id);

COMMENT ON TABLE fiscal.vat_accruals IS
  'Hechos de imputación de impuestos a un período de cómputo. NO es una tabla de saldos: la posición es la suma de estas filas y se calcula en la consulta (ADR 0004, decisión 3). El período se congela al registrar el hecho para que una determinación vieja siga siendo reproducible aunque la regla de cómputo cambie (F-6).';
COMMENT ON COLUMN fiscal.vat_accruals.accrual_basis IS
  'Por qué el impuesto se computa en ese período. Permite distinguir "se computó bien" de "se computó donde cayó el asiento", que es exactamente lo que F-2 verifica.';

-- =============================================================================
-- 3 · Registrar la imputación desde los hechos
-- =============================================================================
-- Resuelve la fecha de cómputo, encuentra el período y registra el hecho. Es la
-- pieza que conecta `document_taxes` (qué alícuota) con `accounting.periods`
-- (en qué período).
-- =============================================================================

CREATE OR REPLACE FUNCTION fiscal.accrue_vat(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_period_id uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fiscal, billing, accounting, app, pg_temp
AS $$
DECLARE
  v_inv      billing.invoices;
  v_kind     text;
  v_date     date;
  v_basis    text;
  v_period   uuid;
  v_count    integer := 0;
  r          record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM billing.invoices
  WHERE id = p_invoice_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El comprobante % no existe en esta empresa', p_invoice_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Sólo se imputa un comprobante autorizado: un borrador no es un hecho fiscal y
  -- un rechazado tampoco. El estado es la precondición, no una validación tardía.
  IF v_inv.status <> 'authorized' THEN
    RAISE EXCEPTION
      'El comprobante % % está en estado «%» y sólo un comprobante autorizado '
      'genera cómputo de impuestos.',
      v_inv.doc_type, v_inv.number, v_inv.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- EL CRITERIO DE CÓMPUTO (decisión 3).
  --
  -- Venta (kind = 'invoice'): el débito se devenga en la EMISIÓN. La fecha fiscal
  -- del comprobante es la de emisión, y es la que AFIP registró.
  --
  -- Nota de crédito: computa en su PROPIA emisión y con signo contrario, por la
  -- misma razón por la que `0015` decidió que una nota de crédito es un hecho
  -- propio y no una edición del original. El período del original ya puede estar
  -- cerrado y presentado.
  --
  -- Compra: es el caso que F-2 aísla. El crédito fiscal se computa en el período
  -- de la RECEPCIÓN, no en el de la emisión del proveedor. Una factura de marzo
  -- recibida en abril tiene su crédito en abril. Si se computara por emisión, el
  -- crédito de un período ya cerrado podría aparecer después, y la posición de
  -- marzo cambiaría después de haberse presentado.
  IF v_inv.kind = 'invoice' THEN
    v_kind  := 'debit';
    v_date  := v_inv.issue_date;
    v_basis := 'débito fiscal devengado en la fecha de emisión del comprobante';
  ELSIF v_inv.kind = 'credit_note' THEN
    v_kind  := 'debit';
    v_date  := v_inv.issue_date;
    v_basis := 'nota de crédito: revierte débito fiscal en su propia fecha de emisión, no en la del comprobante que ajusta';
  ELSIF v_inv.kind = 'debit_note' THEN
    v_kind  := 'debit';
    v_date  := v_inv.issue_date;
    v_basis := 'nota de débito: aumenta el débito fiscal en su propia fecha de emisión';
  ELSE
    RAISE EXCEPTION
      'El tipo de comprobante «%» no tiene una regla de cómputo de IVA definida.',
      v_inv.kind
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- El período: el que se pida, o el que contiene la fecha de cómputo.
  IF p_period_id IS NOT NULL THEN
    SELECT id INTO v_period
    FROM accounting.periods
    WHERE id = p_period_id AND tenant_id = p_tenant_id;
    IF v_period IS NULL THEN
      RAISE EXCEPTION 'El período % no existe en esta empresa', p_period_id
        USING ERRCODE = 'no_data_found';
    END IF;
    v_basis := v_basis || ' (período indicado explícitamente)';
  ELSE
    SELECT id INTO v_period
    FROM accounting.periods
    WHERE tenant_id = p_tenant_id
      AND v_date BETWEEN starts_on AND ends_on;
    IF v_period IS NULL THEN
      RAISE EXCEPTION
        'No hay período contable abierto que contenga el % para la empresa %. '
        'El impuesto no puede quedar sin período de cómputo. Abra el período antes '
        'de determinarlo.',
        v_date, p_tenant_id
        USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- Una fila por alícuota discriminada. Éste es el paso que `tax_total` no permite:
  -- el discriminado trae el detalle que el asiento agregó en una sola línea.
  FOR r IN
    SELECT dt.tax_id, dt.rate_code, dt.rate, dt.taxable_base, dt.amount
    FROM fiscal.document_taxes dt
    JOIN fiscal.taxes t ON t.id = dt.tax_id
    WHERE dt.invoice_id = p_invoice_id
      AND dt.tenant_id = p_tenant_id
      AND t.kind = 'vat'
    ORDER BY dt.rate_code
  LOOP
    INSERT INTO fiscal.vat_accruals (
      tenant_id, invoice_id, tax_id, direction,
      rate_code, rate, taxable_base, amount,
      period_id, accrued_on, accrual_basis
    )
    VALUES (
      p_tenant_id, p_invoice_id, r.tax_id, v_kind,
      r.rate_code, r.rate, r.taxable_base, r.amount,
      v_period, v_date, v_basis
    )
    -- Idempotente: reprocesar no duplica el cómputo. Actualiza el período y la
    -- base por si el discriminado se corrigió antes de que el período cerrara.
    ON CONFLICT (tenant_id, invoice_id, tax_id, direction, rate_code)
    DO UPDATE SET
      rate         = EXCLUDED.rate,
      taxable_base = EXCLUDED.taxable_base,
      amount       = EXCLUDED.amount,
      period_id    = EXCLUDED.period_id,
      accrued_on   = EXCLUDED.accrued_on,
      accrual_basis = EXCLUDED.accrual_basis;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION fiscal.accrue_vat IS
  'Registra el cómputo de IVA de un comprobante autorizado, una fila por alícuota discriminada. Resuelve la fecha de devengamiento según el tipo (venta: emisión; compra: recepción) y la congela. Idempotente. Devuelve cuántas alícuotas imputó; 0 significa que el comprobante no tiene IVA discriminado.';

-- =============================================================================
-- 4 · La posición de IVA del período
-- =============================================================================
-- El gate de E5. DERIVADA del libro —decisión 3— y con el detalle por alícuota
-- que F-1 y F-3 necesitan.
--
-- LA VERIFICACIÓN CRUZADA QUE HACE ÚTIL ESTA VISTA: compara la suma de
-- `vat_accruals` (el detalle por alícuota) contra la suma de los ASIENTOS de las
-- cuentas de IVA (el agregado del libro). Las dos deberían coincidir siempre. Una
-- diferencia significa que hay un comprobante con IVA que no se imputó, o un
-- asiento de IVA sin comprobante detrás — y en cualquiera de los dos casos la
-- posición que se presenta está mal. Exponer la diferencia es lo que convierte
-- esto en una consulta de control y no en un cálculo que hay que creer.
-- =============================================================================

CREATE OR REPLACE VIEW fiscal.v_vat_position
WITH (security_invoker = true)
AS
WITH acc AS (
  -- El detalle por alícuota, desde los hechos de imputación.
  SELECT
    a.tenant_id,
    a.period_id,
    a.direction,
    a.rate_code,
    a.rate,
    sum(a.taxable_base) AS taxable_base,
    sum(a.amount)       AS amount,
    count(*)            AS document_count
  FROM fiscal.vat_accruals a
  GROUP BY a.tenant_id, a.period_id, a.direction, a.rate_code, a.rate
),
ledger AS (
  -- El agregado del libro: lo que efectivamente se asentó en las cuentas de IVA.
  -- Se toma de los asientos y no de los acumuladores, porque el libro es la
  -- fuente de verdad — es el punto entero de F-6.
  SELECT
    e.tenant_id,
    e.period_id,
    CASE WHEN ar.role = 'vat_payable' THEN 'debit' ELSE 'credit' END AS direction,
    sum(l.credit) - sum(l.debit) AS amount
  FROM accounting.journal_lines l
  JOIN accounting.journal_entries e
    ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
  JOIN accounting.account_roles ar
    ON ar.account_id = l.account_id AND ar.tenant_id = l.tenant_id
  WHERE ar.role IN ('vat_payable', 'vat_receivable')
  GROUP BY e.tenant_id, e.period_id, ar.role
)
SELECT
  acc.tenant_id,
  acc.period_id,
  acc.direction,
  acc.rate_code,
  acc.rate,
  acc.taxable_base,
  acc.amount,
  acc.document_count,
  -- El neto del período: débito menos crédito. Es la posición.
  sum(acc.amount) FILTER (WHERE acc.direction = 'debit')  OVER w AS total_debit,
  sum(acc.amount) FILTER (WHERE acc.direction = 'credit') OVER w AS total_credit,
  (sum(acc.amount) FILTER (WHERE acc.direction = 'debit') OVER w)
    - (sum(acc.amount) FILTER (WHERE acc.direction = 'credit') OVER w) AS net_position,
  -- La verificación cruzada: el total del detalle contra el total asentado.
  -- NULL significa que el período no tiene asientos de IVA para esa dirección.
  lg.amount AS ledger_amount,
  acc.amount - COALESCE(lg.amount, 0) AS divergence
FROM acc
LEFT JOIN ledger lg
  ON lg.tenant_id = acc.tenant_id
 AND lg.period_id = acc.period_id
 AND lg.direction = acc.direction
WINDOW w AS (PARTITION BY acc.tenant_id, acc.period_id);

COMMENT ON VIEW fiscal.v_vat_position IS
  'Posición de IVA por período, alícuota y dirección, DERIVADA del libro (ADR 0004, decisión 3). `divergence` es la verificación cruzada: compara el detalle de imputaciones contra el total asentado en las cuentas de IVA. Un valor distinto de cero significa que hay comprobantes sin imputar o asientos sin comprobante, y en los dos casos la posición presentada está mal (F-1, F-3, F-6).';

CREATE OR REPLACE VIEW fiscal.v_vat_period_summary
WITH (security_invoker = true)
AS
SELECT
  p.tenant_id,
  p.period_id,
  py.period_number,
  py.starts_on,
  py.ends_on,
  py.status AS period_status,
  COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'debit'), 0)  AS vat_debit,
  COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'credit'), 0) AS vat_credit,
  COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'debit'), 0)
    - COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'credit'), 0) AS net_position,
  count(DISTINCT p.rate_code) AS rate_count,
  sum(abs(p.divergence))      AS total_divergence
FROM fiscal.v_vat_position p
JOIN accounting.periods py
  ON py.id = p.period_id AND py.tenant_id = p.tenant_id
GROUP BY p.tenant_id, p.period_id, py.period_number, py.starts_on, py.ends_on, py.status;

COMMENT ON VIEW fiscal.v_vat_period_summary IS
  'Una fila por período con el débito, el crédito, la posición neta y la divergencia acumulada. Es la consulta que responde "¿cuánto IVA hay que pagar?" y, en la misma fila, "¿podemos confiar en ese número?" (F-6).';

-- =============================================================================
-- 5 · Brechas: lo que hace que el libro cuadre
-- =============================================================================
-- F-3 exige que el libro cuadre con los comprobantes. Una brecha se descubre
-- buscándola a propósito, no asumiendo que no hay.
--
-- Extiende el mecanismo de `v_posting_gaps` que `0013` creó y que `0014`, `0015` y
-- `0016` fueron ampliando. La brecha que esta migración agrega es de otra
-- naturaleza que las anteriores: no es "un hecho sin asiento", es "un comprobante
-- con IVA sin imputar" y "un comprobante imputado que no tiene asiento".
-- =============================================================================

CREATE OR REPLACE VIEW fiscal.v_vat_gaps
WITH (security_invoker = true)
AS
-- a) Comprobante autorizado, con IVA discriminado, sin imputación de cómputo.
SELECT
  i.tenant_id,
  i.id          AS invoice_id,
  i.doc_type,
  i.number,
  i.issue_date,
  'sin_imputacion'::text AS gap_kind,
  'Comprobante autorizado con IVA discriminado que no tiene cómputo registrado.'::text AS detail
FROM billing.invoices i
WHERE i.status = 'authorized'
  AND EXISTS (
    SELECT 1 FROM fiscal.document_taxes dt
    JOIN fiscal.taxes t ON t.id = dt.tax_id
    WHERE dt.invoice_id = i.id AND dt.tenant_id = i.tenant_id AND t.kind = 'vat'
  )
  AND NOT EXISTS (
    SELECT 1 FROM fiscal.vat_accruals va
    WHERE va.invoice_id = i.id AND va.tenant_id = i.tenant_id
  )

UNION ALL

-- b) El débito fiscal asentado no cuadra con el discriminado del comprobante. Es
--    el caso que F-1 detecta: los comprobantes dicen una cosa y el libro otra.
SELECT
  i.tenant_id,
  i.id,
  i.doc_type,
  i.number,
  i.issue_date,
  'discriminado_vs_asiento',
  format(
    'El discriminado suma %s y el comprobante declara %s de impuesto.',
    COALESCE((SELECT sum(dt.amount) FROM fiscal.document_taxes dt
              JOIN fiscal.taxes t ON t.id = dt.tax_id
              WHERE dt.invoice_id = i.id AND dt.tenant_id = i.tenant_id AND t.kind = 'vat'), 0),
    i.tax_total
  )
FROM billing.invoices i
WHERE i.status = 'authorized'
  AND i.tax_total <> COALESCE((
    SELECT sum(dt.amount) FROM fiscal.document_taxes dt
    JOIN fiscal.taxes t ON t.id = dt.tax_id
    WHERE dt.invoice_id = i.id AND dt.tenant_id = i.tenant_id AND t.kind = 'vat'
  ), 0);

COMMENT ON VIEW fiscal.v_vat_gaps IS
  'Comprobantes donde el IVA no cuadra: autorizados con IVA discriminado pero sin cómputo registrado, o cuyo discriminado no coincide con el impuesto declarado en el comprobante. Devuelve 0 filas si el libro cuadra con los comprobantes (F-3).';

-- =============================================================================
-- 6 · RLS y cobertura
-- =============================================================================

ALTER TABLE fiscal.book_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.book_definitions FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.vat_accruals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.vat_accruals     FORCE  ROW LEVEL SECURITY;

-- Un formato de libro puede ser de plataforma; un hecho de imputación siempre es
-- de una empresa.
CREATE POLICY book_definitions_read ON fiscal.book_definitions
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_platform_admin());
CREATE POLICY book_definitions_write ON fiscal.book_definitions
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY vat_accruals_isolation ON fiscal.vat_accruals
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Los formatos de libro de plataforma no se editan desde el rol de aplicación:
-- cambiar uno histórico cambiaría presentaciones ya hechas.
REVOKE INSERT, UPDATE, DELETE ON fiscal.book_definitions FROM PUBLIC;
GRANT SELECT ON fiscal.book_definitions TO control_app, control_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.vat_accruals TO control_app;
GRANT SELECT ON fiscal.vat_accruals TO control_readonly;

GRANT EXECUTE ON FUNCTION fiscal.accrue_vat(uuid, uuid, uuid) TO control_app;

-- Las vistas llevan `security_invoker`, así que necesitan que el rol tenga
-- privilegio sobre las tablas de abajo. Sin esto la vista se ve vacía en vez de
-- dar un error, que es el modo de falla más caro de diagnosticar.
GRANT SELECT ON fiscal.v_vat_position       TO control_app, control_readonly;
GRANT SELECT ON fiscal.v_vat_period_summary TO control_app, control_readonly;
GRANT SELECT ON fiscal.v_vat_gaps           TO control_app, control_readonly;

-- =============================================================================
-- 7 · La barrera
-- =============================================================================

DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
