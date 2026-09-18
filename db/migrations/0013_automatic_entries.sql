-- =============================================================================
-- Control · 0013 · Motor de asientos automáticos (fase E2)
-- -----------------------------------------------------------------------------
-- MOTIVO
--
-- La migración `0012` dejó un libro contable que funciona pero que hay que
-- alimentar a mano. Control ya registra hechos económicos correctos —facturas
-- autorizadas, movimientos de stock valuados— y ninguno de esos hechos llega al
-- libro. El sistema puede responder "¿cuántas unidades hay?" y "¿emitió CAE la
-- factura 145?"; sigue sin poder responder "¿cuánto gané?" porque la venta no
-- está asentada.
--
-- Esta migración construye el puente. Las cuatro decisiones están fijadas en
-- `docs/adr/0002-motor-asientos-automaticos.md`; el resumen del por qué:
--
--   1. La idempotencia la garantiza un ÍNDICE ÚNICO PARCIAL, no la aplicación.
--      Un hecho con dos asientos no rompe nada visible: el balance sigue
--      cuadrando y lo único que cambia es que la ganancia está duplicada. Es el
--      peor modo de falla posible, y el único que no se puede tolerar.
--
--   2. El mapeo hecho → cuentas es DATO (`mapping_rules`), no código. Un mapeo
--      en código no se puede auditar ni ajustar por empresa sin un despliegue.
--
--   3. El asiento se genera en la MISMA transacción que el hecho. Un job que
--      "completa" los asientos faltantes convierte un error de negocio en una
--      deuda silenciosa y rompe la atomicidad hecho↔asiento.
--
--   4. Un asiento no se edita: se revierte con `reverse_entry()` de `0012`.
--
-- Los tres riesgos que este diseño NO elimina están en la adenda del ADR 0002.
-- =============================================================================

BEGIN;

SET LOCAL client_min_messages TO WARNING;

-- =============================================================================
-- 1 · Idempotencia del asiento automático
-- =============================================================================
-- Este índice es la pieza central de la migración. Todo lo demás es derivable;
-- esto es la garantía.
--
-- PARCIAL y no total, por dos razones:
--   · Los asientos manuales tienen `source_id` NULL y muchos pueden coexistir.
--     Un único total sobre (tenant_id, source_type, source_id) los trataría a
--     todos como el mismo y admitiría un solo asiento manual por empresa.
--   · El `WHERE` documenta la intención: la unicidad aplica a los asientos
--     automáticos, que son los que tienen origen identificable.
--
-- `source_type` es NOT NULL para los automáticos (lo exige el generador), así
-- que el índice cubre exactamente el conjunto que debe cubrir.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_per_source
  ON accounting.journal_entries (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON INDEX accounting.journal_entries_one_per_source IS
  'Un hecho económico tiene exactamente un asiento. Garantía del motor: un reproceso no puede duplicar la ganancia.';

-- =============================================================================
-- 2 · Reglas de mapeo hecho → cuentas
-- =============================================================================
-- El mapeo es dato por empresa (decisión 2 del ADR 0002). Cada fila dice: para
-- este tipo de hecho, debitá el rol X y acreditá el rol Y.
--
-- Se guardan ROLES y no `account_id` directo. El motivo es el que el ADR 0001
-- ya fijó: las cuentas se COPIAN a cada empresa, así que el mismo hecho necesita
-- una cuenta distinta por empresa; y los códigos son la convención estable que
-- permite resolver el rol. Guardar `account_id` obligaría a duplicar la regla
-- por empresa y a mantenerla sincronizada a mano.
--
-- `is_credit_line = false` → la línea va al DEBE; `true` → al HABER. Se modela
-- por rol y no por signo porque un importe con signo en contabilidad es
-- exactamente lo que la migración `0012` evitó al separar débito y crédito.
-- =============================================================================

CREATE TABLE accounting.mapping_rules (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  source_type  text NOT NULL,
  event_kind   text NOT NULL,
  line_number  smallint NOT NULL,
  account_role text NOT NULL,
  is_credit_line boolean NOT NULL,
  -- El importe puede venir de una columna distinta según el caso (total, neto,
  -- impuesto, costo). `amount_expr` es una clave lógica que el generador
  -- resuelve, NO SQL libre: aceptar SQL en una tabla de configuración sería una
  -- inyección almacenada y un agujero de aislamiento entre empresas.
  amount_key   text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mapping_line_positive CHECK (line_number > 0),
  CONSTRAINT mapping_source_not_blank CHECK (length(btrim(source_type)) > 0),
  CONSTRAINT mapping_event_not_blank CHECK (length(btrim(event_kind)) > 0),
  CONSTRAINT mapping_role_not_blank CHECK (length(btrim(account_role)) > 0),
  CONSTRAINT mapping_amount_key_known CHECK (
    amount_key IN ('total', 'subtotal', 'tax_total', 'line_amount', 'cost_amount', 'tax_amount')
  )
);

CREATE UNIQUE INDEX mapping_rules_tenant_id_uniq
  ON accounting.mapping_rules(tenant_id, id);
-- Una sola definición por línea de cada tipo de hecho: dos reglas para la misma
-- línea producirían dos asientos distintos para el mismo hecho y el índice único
-- de la sección 1 haría fallar el segundo — un error en tiempo de ejecución que
-- se evita en tiempo de configuración.
CREATE UNIQUE INDEX mapping_rules_event_line_uniq
  ON accounting.mapping_rules(tenant_id, source_type, event_kind, line_number);
CREATE INDEX idx_mapping_rules_lookup
  ON accounting.mapping_rules(tenant_id, source_type, event_kind);

COMMENT ON TABLE accounting.mapping_rules IS
  'Mapeo hecho → cuentas por rol. Dato por empresa, no código: el contador ajusta su imputación sin un despliegue.';
COMMENT ON COLUMN accounting.mapping_rules.amount_key IS
  'Clave lógica de importe (total, subtotal, tax_total, cost_amount...). No es SQL: se resuelve en el generador.';

-- =============================================================================
-- 3 · Roles contables y su resolución a cuentas
-- =============================================================================
-- El puente entre una regla (que nombra un rol) y una cuenta (que tiene un
-- código). Se materializa por empresa al copiar el plan.
--
-- POR QUÉ UNA TABLA Y NO UNA CONSTANTE EN EL GENERADOR
--
-- Porque la resolución tiene que poder fallar de forma explícita y accionable:
-- "falta la cuenta para el rol 'receivable'" es un error que un operador puede
-- arreglar; "column account_id is null" no. Y porque una empresa puede renombrar
-- sus cuentas (el ADR 0001 lo permite) sin que la plataforma deje de saber cuál
-- es su cuenta de clientes.
-- =============================================================================

CREATE TABLE accounting.account_roles (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  role       text NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_roles_role_not_blank CHECK (length(btrim(role)) > 0)
);

ALTER TABLE accounting.account_roles
  ADD CONSTRAINT account_roles_account_fk
  FOREIGN KEY (tenant_id, account_id)
  REFERENCES accounting.accounts(tenant_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX account_roles_tenant_id_uniq
  ON accounting.account_roles(tenant_id, id);
CREATE UNIQUE INDEX account_roles_tenant_role_uniq
  ON accounting.account_roles(tenant_id, role);

COMMENT ON TABLE accounting.account_roles IS
  'Resolución rol contable → cuenta de la empresa. Permite renombrar cuentas sin romper el mapeo.';

-- =============================================================================
-- 4 · Resolución de un rol a una cuenta
-- =============================================================================
-- Falla con un mensaje accionable en vez de devolver NULL. Un NULL aguas abajo
-- produciría un asiento con una línea menos —y por lo tanto descuadrado— o una
-- violación de no-nulo sobre una columna interna. Ninguna de las dos dice lo que
-- realmente pasa, que es que falta configurar un rol.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.resolve_role(
  p_tenant_id uuid,
  p_role      text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT ar.account_id INTO v_account
  FROM accounting.account_roles ar
  WHERE ar.tenant_id = p_tenant_id AND ar.role = p_role;

  IF v_account IS NULL THEN
    RAISE EXCEPTION
      'La empresa % no tiene configurada el rol contable «%». '
      'Sin ese rol no se puede determinar a qué cuenta imputar el hecho. '
      'Se configura en accounting.account_roles (rol → cuenta del plan).',
      p_tenant_id, p_role
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_account;
END $$;

COMMENT ON FUNCTION accounting.resolve_role IS
  'Resuelve un rol contable a la cuenta de la empresa. Falla explícitamente si falta: un NULL aguas abajo daría un asiento incompleto.';

-- =============================================================================
-- 5 · Traducción de un hecho a líneas de asiento
-- =============================================================================
-- Devuelve el jsonb que consume `accounting.post_entry()`. Todo el conocimiento
-- de "qué cuentas y por qué importes" vive acá; el generador de la sección 6
-- sólo aporta los importes del hecho.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.entry_lines_for(
  p_tenant_id uuid,
  p_source_type text,
  p_event_kind  text,
  p_amounts     jsonb       -- {"total": 1210.00, "tax_total": 210.00, ...}
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r        record;
  v_acct   uuid;
  v_amount numeric(18,2);
  v_lines  jsonb := '[]'::jsonb;
  v_count  integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM accounting.mapping_rules mr
    WHERE mr.tenant_id = p_tenant_id
      AND mr.source_type = p_source_type
      AND mr.event_kind = p_event_kind
    ORDER BY mr.line_number
  LOOP
    v_acct := accounting.resolve_role(p_tenant_id, r.account_role);

    IF NOT (p_amounts ? r.amount_key) THEN
      RAISE EXCEPTION
        'El hecho %/% no aporta el importe «%» que la regla de la línea % espera.',
        p_source_type, p_event_kind, r.amount_key, r.line_number
        USING ERRCODE = 'no_data_found';
    END IF;

    v_amount := (p_amounts ->> r.amount_key)::numeric;

    -- Un importe en cero NO se convierte en línea: `lines_one_side` de `0012`
    -- exige débito > 0 o crédito > 0, y una línea de cero no es un hecho
    -- contable. Es el caso del IVA 0% (AFIP rechaza el Id 3): la operación es
    -- "no alcanzada", que es distinto de "alcanzada al 0%".
    IF v_amount = 0 THEN
      CONTINUE;
    END IF;

    IF v_amount < 0 THEN
      RAISE EXCEPTION
        'El importe «%» del hecho %/% es negativo (%). '
        'Un asiento con importes negativos invierte el sentido de las cuentas: '
        'la reversión se hace con un contra-asiento, no con un signo.',
        r.amount_key, p_source_type, p_event_kind, v_amount
        USING ERRCODE = 'check_violation';
    END IF;

    v_count := v_count + 1;
    v_lines := v_lines || jsonb_build_object(
      'accountId', v_acct,
      'debit',     CASE WHEN r.is_credit_line THEN 0 ELSE v_amount END,
      'credit',    CASE WHEN r.is_credit_line THEN v_amount ELSE 0 END,
      'memo',      COALESCE(r.description, r.account_role)
    );
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'No hay reglas de mapeo para el hecho %/% de la empresa %. '
      'Sin reglas no hay asiento, y un hecho sin asiento rompe el objetivo de '
      'integridad contable del plan.',
      p_source_type, p_event_kind, p_tenant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Defensa: un asiento de una sola línea no puede cerrar (debe ≠ haber). Es
  -- preferible un error acá, que nombra la causa, a un descuadre detectado por
  -- el constraint diferido al COMMIT, que no dice qué regla falta.
  IF v_count < 2 THEN
    RAISE EXCEPTION
      'El mapeo de %/% resuelve una sola línea con importe distinto de cero. '
      'Un asiento de una línea no puede cuadrar: falta una pata en el mapeo.',
      p_source_type, p_event_kind
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_lines;
END $$;

COMMENT ON FUNCTION accounting.entry_lines_for IS
  'Traduce un hecho a las líneas del asiento usando mapping_rules. Omite importes cero (IVA no alcanzado) y rechaza negativos.';

-- =============================================================================
-- 6 · Generación idempotente del asiento de un hecho
-- =============================================================================
-- Punto de entrada del motor. Es IDEMPOTENTE: llamarlo dos veces para el mismo
-- hecho devuelve el mismo asiento, no crea un segundo.
--
-- CÓMO SE LOGRAN LAS DOS COSAS A LA VEZ
--
-- El índice único parcial de la sección 1 es la garantía (no se puede esquivar),
-- y el `ON CONFLICT DO NOTHING` es la tolerancia (un reproceso no es un error).
-- Ninguna de las dos alcanza sola:
--   · Sin el índice, el DO NOTHING no tendría conflicto que detectar.
--   · Sin el DO NOTHING, el índice haría fallar el reproceso legítimo de un job.
-- El patrón es el que el proyecto ya usa en `begin_job_run()` y en la emisión de
-- comprobantes: la garantía en el motor, la tolerancia en el llamador.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.post_entry_for_source(
  p_tenant_id   uuid,
  p_source_type text,
  p_source_id   uuid,
  p_event_kind  text,
  p_entry_date  date,
  p_memo        text,
  p_amounts     jsonb,
  p_created_by  uuid DEFAULT NULL
) RETURNS accounting.journal_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = accounting, app, pg_temp
AS $$
DECLARE
  v_existing accounting.journal_entries;
  v_entry    accounting.journal_entries;
  v_lines    jsonb;
  v_source_entry_source accounting.entry_source;
BEGIN
  -- 0. Traducir el tipo de hecho al valor del enum `entry_source`.
  --    La correspondencia es directa porque el enum nombra el hecho, y el
  --    vocabulario de `source_type` se eligió para coincidir con él. Se
  --    resuelve con una tabla explícita y no con un cast ciego: un
  --    `p_source_type::accounting.entry_source` funcionaría hoy y explotaría
  --    con un mensaje incomprensible el día que alguien agregue un tipo de
  --    hecho que el enum no prevea.
  v_source_entry_source := CASE p_source_type
    WHEN 'invoice'        THEN 'invoice'::accounting.entry_source
    WHEN 'credit_note'    THEN 'credit_note'::accounting.entry_source
    WHEN 'debit_note'     THEN 'debit_note'::accounting.entry_source
    WHEN 'payment'        THEN 'payment'::accounting.entry_source
    WHEN 'purchase'       THEN 'purchase'::accounting.entry_source
    WHEN 'supplier_payment' THEN 'supplier_payment'::accounting.entry_source
    WHEN 'stock_movement' THEN 'stock_movement'::accounting.entry_source
    WHEN 'payroll'        THEN 'payroll'::accounting.entry_source
    WHEN 'tax'            THEN 'tax'::accounting.entry_source
    WHEN 'depreciation'   THEN 'depreciation'::accounting.entry_source
    WHEN 'opening'        THEN 'opening'::accounting.entry_source
    WHEN 'closing'        THEN 'closing'::accounting.entry_source
    -- Último recurso: un hecho que el vocabulario del enum no nombra se asienta
    -- como `manual`. Preferimos que quede el asiento —auditable, con su
    -- `source_id` para rastrearlo— antes que abortar la operación de negocio por
    -- una etiqueta. `source_type` conserva el nombre real del hecho.
    ELSE 'manual'::accounting.entry_source
  END;

  -- 1. ¿Ya está asentado? Se devuelve el asiento existente. Éste es el camino
  --    normal de un reproceso, y tiene que ser barato y silencioso.
  SELECT * INTO v_existing
  FROM accounting.journal_entries e
  WHERE e.tenant_id = p_tenant_id
    AND e.source_type = p_source_type
    AND e.source_id = p_source_id;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Traducir el hecho a líneas. Falla si el mapeo está incompleto: es
  --    preferible que el hecho no se confirme a que quede sin asiento.
  v_lines := accounting.entry_lines_for(
    p_tenant_id, p_source_type, p_event_kind, p_amounts
  );

  -- 3. Asentar por el camino único de `0012`. No se duplica la lógica de
  --    numeración, resolución de período ni actualización de saldos.
  --
  --    DEFECTO CORREGIDO: acá decía `'automatic'`, que no es un valor del enum
  --    `accounting.entry_source` de `0012`. El motor lo rechazaba con
  --    «la sintaxis de entrada no es válida para el enum entry_source».
  --    El enum describe el ORIGEN DEL HECHO, no quién lo asentó: un asiento
  --    nacido de una factura autorizada es de origen `invoice`, lo haya escrito
  --    una persona o este generador. La distinción automático/manual no va acá:
  --    ya la da `source_id IS NOT NULL` (un asiento automático siempre tiene
  --    hecho de origen; uno manual, salvo ajustes explícitos, no).
  --    El enum es de `0012` y no se toca desde `0013`: agregarle un valor acá
  --    haría que la migración dependa del orden de ejecución para algo que se
  --    resuelve traduciendo, no ampliando el vocabulario.
  v_entry := accounting.post_entry(
    p_tenant_id,
    p_entry_date,
    p_memo,
    v_source_entry_source,
    v_lines,
    p_source_type,
    p_source_id,
    p_created_by
  );

  RETURN v_entry;

EXCEPTION
  -- Carrera entre dos transacciones concurrentes que generan el asiento del
  -- mismo hecho: las dos pasaron el SELECT del paso 1, una gana el índice único
  -- y la otra llega acá. No es un error — el asiento existe y es el correcto.
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM accounting.journal_entries e
    WHERE e.tenant_id = p_tenant_id
      AND e.source_type = p_source_type
      AND e.source_id = p_source_id;

    IF FOUND THEN
      RETURN v_existing;
    END IF;

    -- Si no se encuentra, el unique_violation vino de otra restricción
    -- (el correlativo, por ejemplo) y ocultarlo sería un error grave.
    RAISE;
END $$;

COMMENT ON FUNCTION accounting.post_entry_for_source IS
  'Genera el asiento de un hecho. Idempotente: un reproceso devuelve el asiento existente en vez de duplicarlo.';

-- =============================================================================
-- 7 · Verificación: hechos con asiento y hechos sin asiento
-- =============================================================================
-- Alimenta el job `accounting.posting_check` y la consulta de control 2 de §6.3
-- del plan ("hechos económicos sin asiento").
--
-- El estado del hecho se consulta del ORIGEN, no se infiere del libro: la
-- pregunta es "¿este hecho debería tener asiento y no lo tiene?", y eso sólo lo
-- sabe el origen.
-- =============================================================================

CREATE OR REPLACE VIEW accounting.v_posting_gaps
WITH (security_invoker = true)
AS
-- Facturas autorizadas sin asiento. `authorized` es el único estado en el que
-- el comprobante es un hecho económico: `draft` no existe, `rejected` no existe,
-- y `cancelled` es un hecho que se revierte, no que se asienta.
SELECT
  i.tenant_id,
  'invoice'::text              AS source_type,
  i.id                         AS source_id,
  i.kind::text                 AS event_kind,
  i.issue_date                 AS happened_on,
  'Factura autorizada sin asiento contable'::text AS gap_description
FROM billing.invoices i
WHERE i.status = 'authorized'
  AND NOT EXISTS (
    SELECT 1 FROM accounting.journal_entries e
    WHERE e.tenant_id = i.tenant_id
      AND e.source_type = 'invoice'
      AND e.source_id = i.id
  )

UNION ALL

-- Movimientos de stock que mueven valor sin asiento. Sólo los que tienen costo
-- y significan una salida de inventario: un `reservation` no mueve cantidad
-- física ni valor, y un `transfer_*` mueve entre depósitos de la misma empresa,
-- así que ninguno genera asiento.
SELECT
  m.tenant_id,
  'stock_movement'::text       AS source_type,
  m.id                         AS source_id,
  m.kind::text                 AS event_kind,
  m.created_at::date           AS happened_on,
  'Movimiento de stock valuado sin asiento contable'::text AS gap_description
FROM app.stock_movements m
WHERE m.kind = 'sale_out'
  AND m.unit_cost IS NOT NULL
  AND m.unit_cost <> 0
  AND NOT EXISTS (
    SELECT 1 FROM accounting.journal_entries e
    WHERE e.tenant_id = m.tenant_id
      AND e.source_type = 'stock_movement'
      AND e.source_id = m.id
  );

COMMENT ON VIEW accounting.v_posting_gaps IS
  'Hechos económicos que deberían tener asiento y no lo tienen. Es la consulta de control 2 de §6.3 del plan.';

-- =============================================================================
-- 8 · Semilla de roles contables y reglas de mapeo
-- =============================================================================
-- POR QUÉ UN SEMBRADO POR EMPRESA Y NO UNA PLANTILLA DE PLATAFORMA
--
-- Los roles resuelven a `account_id`, y las cuentas son por empresa (ADR 0001:
-- se copian). Una plantilla de plataforma no podría apuntar a las cuentas de
-- cada empresa. Así que la semilla corre en el mismo momento en que se copia el
-- plan de cuentas: `seed_tenant_chart_of_accounts()` de `0012` se extiende acá.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.seed_tenant_accounting_config(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = accounting, app, pg_temp
AS $$
DECLARE
  v_roles integer := 0;
  v_rules integer := 0;
BEGIN
  -- Los roles apuntan a los códigos normalizados del plan mínimo. Si la empresa
  -- recodificó su plan, esta resolución lo detecta y falla: es preferible a
  -- dejar un rol apuntando a una cuenta sin sentido.
  INSERT INTO accounting.account_roles (tenant_id, role, account_id)
  SELECT p_tenant_id, m.role, a.id
  FROM (VALUES
    ('receivable',      '1.1.3.01'),   -- Cuentas a cobrar clientes
    ('cash',            '1.1.1.01'),   -- Caja
    ('bank',            '1.1.2.01'),   -- Banco cuenta corriente
    ('inventory',       '1.1.5.01'),   -- Inventario de mercaderías
    ('vat_receivable',  '1.1.4.01'),   -- IVA crédito fiscal
    ('payable',         '2.1.1.01'),   -- Cuentas a pagar proveedores
    ('vat_payable',     '2.1.2.01'),   -- IVA débito fiscal
    ('sales',           '4.1.1.01'),   -- Ventas
    ('sales_returns',   '4.1.1.03'),   -- Devoluciones y bonificaciones
    ('cost_of_goods',   '5.1.1.01'),   -- Costo de mercadería vendida
    ('purchase_expense','6.3.1.04')    -- Impuestos y tasas (gasto genérico)
  ) AS m(role, code)
  JOIN accounting.accounts a
    ON a.tenant_id = p_tenant_id AND a.code = m.code
  ON CONFLICT (tenant_id, role) DO NOTHING;

  GET DIAGNOSTICS v_roles = ROW_COUNT;

  -- Factura de venta: el cliente debe el total; el neto es ingreso y el IVA es
  -- débito fiscal. La suma de las dos patas del haber iguala al débito.
  --
  -- El IVA se asienta con `tax_total`, y `entry_lines_for` OMITE la línea si es
  -- cero. Por eso una factura sin IVA genera un asiento de dos líneas correcto
  -- en vez de tres con una en cero.
  INSERT INTO accounting.mapping_rules
    (tenant_id, source_type, event_kind, line_number, account_role, is_credit_line, amount_key, description)
  VALUES
    (p_tenant_id, 'invoice', 'invoice',           1, 'receivable',    false, 'total',     'Clientes a cobrar por la venta'),
    (p_tenant_id, 'invoice', 'invoice',           2, 'sales',         true,  'subtotal',  'Ingreso por venta (neto de impuestos)'),
    (p_tenant_id, 'invoice', 'invoice',           3, 'vat_payable',   true,  'tax_total', 'IVA débito fiscal'),
    -- Nota de crédito: revierte el sentido de la factura. Se asienta como hecho
    -- propio con su propio asiento (decisión 4), no editando el original.
    (p_tenant_id, 'invoice', 'credit_note',       1, 'sales_returns', false, 'subtotal',  'Devolución que reduce el ingreso'),
    (p_tenant_id, 'invoice', 'credit_note',       2, 'vat_payable',   false, 'tax_total', 'IVA débito fiscal revertido'),
    (p_tenant_id, 'invoice', 'credit_note',       3, 'receivable',    true,  'total',     'Clientes: se reduce el crédito'),
    -- Nota de débito: mismo sentido que la factura (aumenta el crédito).
    (p_tenant_id, 'invoice', 'debit_note',        1, 'receivable',    false, 'total',     'Clientes a cobrar por nota de débito'),
    (p_tenant_id, 'invoice', 'debit_note',        2, 'sales',         true,  'subtotal',  'Ingreso adicional'),
    (p_tenant_id, 'invoice', 'debit_note',        3, 'vat_payable',   true,  'tax_total', 'IVA débito fiscal'),
    -- Costo de venta: la salida de inventario valuada al costo del movimiento.
    (p_tenant_id, 'stock_movement', 'sale_out',   1, 'cost_of_goods', false, 'cost_amount', 'Costo de la mercadería vendida'),
    (p_tenant_id, 'stock_movement', 'sale_out',   2, 'inventory',     true,  'cost_amount', 'Salida de inventario valuada al costo')
  ON CONFLICT (tenant_id, source_type, event_kind, line_number) DO NOTHING;

  GET DIAGNOSTICS v_rules = ROW_COUNT;

  RETURN v_roles + v_rules;
END $$;

COMMENT ON FUNCTION accounting.seed_tenant_accounting_config IS
  'Siembra los roles contables y las reglas de mapeo de una empresa. Idempotente.';

-- Siembra retroactiva: las empresas que ya existen (con su plan copiado por
-- `0012`) reciben su configuración contable. Sin esto, toda empresa creada antes
-- de esta migración quedaría sin mapeo y ningún hecho podría asentarse — que es
-- precisamente el estado que esta migración viene a corregir.
--
-- La condición es NOT EXISTS, y no EXISTS: se siembra a quien NO tiene la
-- configuración. Escrito al revés, el bloque no haría nada y parecería correcto
-- porque no falla.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.tenant_id
    FROM accounting.accounts a
    WHERE a.tenant_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM accounting.account_roles ar WHERE ar.tenant_id = a.tenant_id
      )
  LOOP
    PERFORM accounting.seed_tenant_accounting_config(r.tenant_id);
  END LOOP;
END $$;

-- =============================================================================
-- 9 · RLS, permisos y cobertura
-- =============================================================================
-- Se replica el criterio dinámico de `0012`: se descubre desde `pg_class`, no
-- desde una lista escrita a mano. Una lista manual se desactualiza en silencio.
-- =============================================================================

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
      AND n.nspname = 'accounting'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      )
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE  ROW LEVEL SECURITY', r.schema_name, r.table_name);
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND c.relispartition = false
      AND n.nspname = 'accounting'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON accounting.%I
        FOR ALL TO PUBLIC
        USING (
          app.is_platform_admin()
          OR tenant_id = app.current_tenant_id()
          OR %s
        )
        WITH CHECK (
          app.is_platform_admin()
          OR tenant_id = app.current_tenant_id()
        )
    $f$,
      r.table_name,
      CASE WHEN r.table_name IN ('accounts')
           THEN 'tenant_id IS NULL'
           ELSE 'false' END
    );
  END LOOP;
END $$;

-- Los permisos del esquema y de las tablas nuevas.
--
-- `GRANT USAGE ON SCHEMA` va explícito y primero: es el defecto que costó la
-- migración `0012` entera. Sin él, PostgreSQL rechaza el acceso ANTES de
-- evaluar los privilegios de tabla y los GRANT de abajo quedan inertes, con un
-- archivo que parece completo.
GRANT USAGE ON SCHEMA accounting TO control_app, control_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting.mapping_rules TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting.account_roles TO control_app;
GRANT SELECT ON accounting.mapping_rules TO control_readonly;
GRANT SELECT ON accounting.account_roles TO control_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA accounting TO control_app;

GRANT EXECUTE ON FUNCTION accounting.resolve_role(uuid, text)        TO control_app;
GRANT EXECUTE ON FUNCTION accounting.entry_lines_for(uuid, text, text, jsonb) TO control_app;
GRANT EXECUTE ON FUNCTION accounting.post_entry_for_source(uuid, text, uuid, text, date, text, jsonb, uuid) TO control_app;
GRANT EXECUTE ON FUNCTION accounting.seed_tenant_accounting_config(uuid) TO control_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA accounting
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting
  GRANT SELECT ON TABLES TO control_readonly;

-- =============================================================================
-- 10 · Job de verificación
-- =============================================================================
-- Detecta y REPORTA. No genera asientos: esa es la decisión 3 del ADR 0002, y la
-- razón por la que este job alimenta una alarma en lugar de una red.
-- =============================================================================

INSERT INTO ops.jobs (code, description, expected_every)
VALUES (
  'accounting.posting_check',
  'Verifica que todo hecho económico tenga su asiento. Reporta los que faltan sin generarlos.',
  interval '1 day'
)
ON CONFLICT (code) DO NOTHING;

-- La barrera de cobertura de `0012`. Si alguna tabla de esta migración quedó sin
-- FORCE RLS o sin política, esto falla y la migración se revierte entera.
SELECT app.assert_rls_coverage();

COMMIT;
