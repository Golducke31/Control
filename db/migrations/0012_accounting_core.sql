-- =============================================================================
-- Control · 0012 · Núcleo contable: plan de cuentas, asientos, períodos y saldos
-- -----------------------------------------------------------------------------
-- MOTIVO
--
-- Control registra hechos operativos correctamente —ventas, facturación, stock—
-- pero no tiene un libro que los explique a todos juntos. Puede responder
-- "¿cuántas unidades hay en el depósito 3?" y "¿emitió CAE la factura 145?";
-- no puede responder "¿cuánto gané?" ni "¿cuánto debo?", porque no existe el
-- concepto de acreedor, de asiento ni de ejercicio.
--
-- Esta migración crea ese libro. Las cinco decisiones de diseño están fijadas en
-- `docs/adr/0001-nucleo-contable.md` y se resumen acá:
--
--   1. Asiento = cabecera + líneas. El diferencial cero lo valida un
--      CONSTRAINT TRIGGER DIFERIDO, no la aplicación. Diferido porque al
--      insertar la cabecera todavía no hay líneas: el único momento en que el
--      asiento está completo es el final de la transacción.
--
--   2. Plan mínimo obligatorio de plataforma (tenant_id NULL) + extensión libre
--      por empresa. Las cuentas se COPIAN al crear la empresa, no se referencian:
--      si se referenciaran, renombrar "Caja" en una empresa afectaría a todas.
--
--   3. Saldos materializados en `account_balances`, mantenidos por
--      `post_entry()` en la misma transacción que escribe las líneas. Es el
--      mismo patrón que `app.stock_levels` / `apply_stock_movement()`, que ya
--      está verificado en producción y del que se hereda la decisión de NO
--      autocorregir una divergencia (es un síntoma, no se sabe qué vista miente).
--
--   4. Período mensual, cierre inmutable, reapertura auditada con motivo.
--
--   5. Vocabulario neutral. Acá no aparece la palabra AFIP ni la sigla CAE.
--
-- POR QUÉ LA GARANTÍA VA EN EL MOTOR
--
-- Un balance que no cuadra se descubre tarde —cuando alguien presenta el estado
-- contable y no cierra— y para entonces el asiento descuadrado está mezclado con
-- miles de correctos. Validar en la capa de aplicación significa que cualquier
-- camino que se saltee el servicio (un script, una migración, un `INSERT` a mano
-- en una corrección urgente) escribe un asiento inválido. La restricción diferida
-- no se puede esquivar. Es el mismo criterio que el defecto #11 de `0007`
-- justificó en la práctica: la garantía tiene que estar donde no se pueda rodear.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Esquema contable. Separado de `billing` (que es fiscal, no contable) y de
-- `app` (que es operativo). La separación no es cosmética: `billing` cambia con
-- la normativa de AFIP; `accounting` no debería cambiar cuando cambia AFIP.
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS accounting;

COMMENT ON SCHEMA accounting IS
  'Contabilidad de doble partida: plan de cuentas, asientos, períodos y saldos. Vocabulario neutral, sin nomenclatura fiscal de ningún país.';

-- =============================================================================
-- 1 · Enumeraciones
-- =============================================================================
-- Catálogo cerrado: el motor rechaza un valor fuera de la lista. Un `text` libre
-- permitiría 'activo' en un asiento y 'Activo' en otro, y la consulta por tipo
-- devolvería la mitad de las cuentas sin que nada falle.
-- =============================================================================

DO $$
BEGIN
  -- Los cinco tipos clásicos. `orden` define el signo natural: activo y gasto
  -- aumentan por el debe; pasivo, patrimonio e ingreso por el haber.
  CREATE TYPE accounting.account_kind AS ENUM (
    'asset',       -- activo
    'liability',   -- pasivo
    'equity',      -- patrimonio neto
    'income',      -- resultado positivo (ventas)
    'expense'      -- resultado negativo (costos y gastos)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE accounting.entry_source AS ENUM (
    'invoice',        -- comprobante de venta autorizado
    'credit_note',    -- nota de crédito
    'debit_note',     -- nota de débito
    'payment',        -- cobranza
    'purchase',       -- factura de compra (fase E3)
    'supplier_payment',-- pago a proveedor (fase E3)
    'stock_movement', -- movimiento de inventario que afecta valuación
    'payroll',        -- liquidación de sueldos (fase E7)
    'tax',            -- determinación impositiva (fase E5)
    'depreciation',   -- amortización
    'opening',        -- asiento de apertura
    'closing',        -- asiento de cierre
    'manual'          -- asiento manual con aprobación
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE accounting.period_status AS ENUM (
    'open',        -- acepta asientos
    'closing',     -- en proceso de cierre: no acepta nuevos, permite ajustes autorizados
    'closed'       -- inmutable
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- 2 · Plan de cuentas
-- =============================================================================

CREATE TABLE accounting.accounts (
  -- `tenant_id` NULL = cuenta del plan mínimo de la plataforma.
  -- NO se usa un uuid centinela: NULL expresa "no pertenece a ninguna empresa"
  -- y las políticas RLS lo tratan distinto de una empresa concreta.
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES app.tenants(id) ON DELETE CASCADE,

  code           text NOT NULL,             -- '1.1.1.01'
  name           text NOT NULL,             -- 'Caja'
  kind           accounting.account_kind NOT NULL,
  parent_id      uuid,                      -- jerarquía
  -- Marca las cuentas del plan mínimo. Se copian al crear la empresa y no se
  -- pueden eliminar ni recodificar (sí renombrar y subdividir).
  is_template    boolean NOT NULL DEFAULT false,
  -- Cuentas imputables: reciben líneas de asiento. Una cuenta de agrupación
  -- ('1.1' Activo corriente) no recibe movimientos, sólo agrupa.
  is_postable    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true,
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- La clave de unicitad es la parte que hace que el plan mínimo sea compartible:
  -- NULL no colisiona con NULL en un UNIQUE, así que hace falta COALESCE a un
  -- uuid centinela para que "una cuenta '1.1.1.01' de plataforma" sea única
  -- entre sí. Sin esto se podrían crear infinitas '1.1.1.01' con tenant_id NULL.
  CONSTRAINT accounts_code_uniq UNIQUE (
    tenant_id,
    code
  ),
  CONSTRAINT accounts_hierarchy CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT accounts_code_format CHECK (code ~ '^[0-9]+(\.[0-9]+)*$')
);

-- Índice único parcial que cubre el caso del plan de plataforma, donde
-- `tenant_id` es NULL y el UNIQUE normal no deduplica.
CREATE UNIQUE INDEX accounts_template_code_uniq
  ON accounting.accounts(code)
  WHERE tenant_id IS NULL;

-- FK compuesta para la jerarquía. Una cuenta hija no puede apuntar a una
-- cuenta padre de otra empresa: es la misma defensa estructural que usan las
-- tablas de negocio (`(tenant_id, id)`), y acá importa especialmente porque la
-- jerarquía del plan es lo que hace que el balance cierre.
CREATE UNIQUE INDEX accounts_tenant_id_uniq ON accounting.accounts(tenant_id, id);

ALTER TABLE accounting.accounts
  DROP CONSTRAINT IF EXISTS accounts_parent_fk;
ALTER TABLE accounting.accounts
  ADD CONSTRAINT accounts_parent_fk
  FOREIGN KEY (tenant_id, parent_id)
  REFERENCES accounting.accounts(tenant_id, id)
  ON DELETE RESTRICT;

CREATE INDEX idx_accounts_tenant_kind  ON accounting.accounts(tenant_id, kind) WHERE is_active;
CREATE INDEX idx_accounts_parent       ON accounting.accounts(tenant_id, parent_id);
CREATE INDEX idx_accounts_code         ON accounting.accounts(tenant_id, code);

COMMENT ON COLUMN accounting.accounts.tenant_id IS
  'NULL = cuenta del plan mínimo de plataforma (plantilla). UUID = cuenta propia de una empresa.';
COMMENT ON COLUMN accounting.accounts.is_template IS
  'Copia del plan mínimo. No se elimina ni se recodifica; sí se renombra y se subdivide.';

-- =============================================================================
-- 3 · Ejercicios y períodos
-- =============================================================================

CREATE TABLE accounting.fiscal_years (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  status      accounting.period_status NOT NULL DEFAULT 'open',
  closed_at   timestamptz,
  closed_by   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fiscal_years_range CHECK (ends_on > starts_on),
  CONSTRAINT fiscal_years_closed_coherent CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

-- `btree_gist` permite combinar igualdad (tenant_id) con rango en un mismo
-- índice de exclusión. Sin la extensión, la exclusión no puede llevar el
-- tenant_id como columna de igualdad.
--
-- Va acá, incondicional y antes de la primera exclusión, en vez de escondida
-- dentro del `IF NOT EXISTS` de `fiscal_years_no_overlap`: si el constraint ya
-- existiera (reaplicación), el guard saltearía también el CREATE EXTENSION y la
-- exclusión de `periods`, que necesita lo mismo, fallaría con un error sobre
-- una extensión faltante que ya estaba instalada.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Un ejercicio no puede solaparse con otro de la misma empresa. Se resuelve con
-- una exclusión de rango en vez de un chequeo aplicativo: el solapamiento es un
-- error de datos que hay que impedir, no reportar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiscal_years_no_overlap'
  ) THEN
    ALTER TABLE accounting.fiscal_years
      ADD CONSTRAINT fiscal_years_no_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        daterange(starts_on, ends_on, '[]') WITH &&
      );
  END IF;
END $$;

CREATE UNIQUE INDEX fiscal_years_tenant_id_uniq ON accounting.fiscal_years(tenant_id, id);

CREATE TABLE accounting.periods (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  fiscal_year_id uuid NOT NULL,
  period_number  smallint NOT NULL,          -- 1..12
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  status         accounting.period_status NOT NULL DEFAULT 'open',
  closed_at      timestamptz,
  closed_by      uuid,
  -- Reapertura: es una operación con consecuencias (invalida cualquier balance
  -- ya presentado), así que exige motivo y deja rastro. El ADR la declara
  -- irreversible y la somete a permiso.
  reopened_at    timestamptz,
  reopened_by    uuid,
  reopened_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT periods_number_range CHECK (period_number BETWEEN 1 AND 12),
  CONSTRAINT periods_range CHECK (ends_on >= starts_on),
  CONSTRAINT periods_closed_coherent CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  ),
  -- Si hay reapertura, tiene que haber motivo y autor. Un período reabierto sin
  -- registro es exactamente lo que el ADR quiere impedir.
  CONSTRAINT periods_reopen_coherent CHECK (
    (reopened_at IS NULL AND reopened_reason IS NULL)
    OR (reopened_at IS NOT NULL AND reopened_reason IS NOT NULL
        AND reopened_by IS NOT NULL)
  )
);

ALTER TABLE accounting.periods
  ADD CONSTRAINT periods_year_fk
  FOREIGN KEY (tenant_id, fiscal_year_id)
  REFERENCES accounting.fiscal_years(tenant_id, id)
  ON DELETE CASCADE;

CREATE UNIQUE INDEX periods_tenant_id_uniq ON accounting.periods(tenant_id, id);
CREATE UNIQUE INDEX periods_year_number_uniq
  ON accounting.periods(tenant_id, fiscal_year_id, period_number);

-- DEFECTO CORREGIDO: acá había un índice único sobre (tenant_id) WHERE status='open',
-- con el comentario "un solo período abierto por empresa a la vez". Era una regla
-- equivocada, y además contradictoria con el modelo: al crear un ejercicio se
-- insertan los 12 meses con status 'open' por defecto, así que el índice hacía
-- fallar la creación del ejercicio entero con
-- «llave duplicada viola restricción de unicidad periods_one_open_per_tenant».
--
-- El comentario original delataba el error de razonamiento: decía que dos
-- períodos abiertos hacen que "un asiento pueda caer en cualquiera de los dos".
-- Eso es un problema de SOLAPAMIENTO DE FECHAS, no de cantidad: dos períodos
-- abiertos que no se solapan no compiten por ninguna fecha.
--
-- La regla correcta es que los rangos de los períodos ABIERTOS no se solapen.
-- Mismo mecanismo que `fiscal_years_no_overlap`, y por la misma razón: el
-- solapamiento es un error de datos que hay que impedir, no reportar.
-- Obsérvese que la exclusión cubre sólo las filas abiertas: dos períodos
-- cerrados del mismo mes (un recálculo, un cierre corregido) deben poder
-- coexistir sin violar nada, porque un período cerrado no recibe asientos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'periods_open_no_overlap'
  ) THEN
    ALTER TABLE accounting.periods
      ADD CONSTRAINT periods_open_no_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        daterange(starts_on, ends_on, '[]') WITH &&
      ) WHERE (status = 'open');
  END IF;
END $$;

CREATE INDEX idx_periods_tenant_dates ON accounting.periods(tenant_id, starts_on, ends_on);

COMMENT ON TABLE accounting.periods IS
  'Período mensual. El cierre es inmutable; la reapertura exige motivo y queda auditada.';

-- =============================================================================
-- 4 · Asientos: cabecera y líneas
-- =============================================================================

CREATE TABLE accounting.journal_entries (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  period_id     uuid NOT NULL,
  entry_date    date NOT NULL,
  -- Número correlativo por empresa, asignado por `post_entry()`. No se usa una
  -- secuencia global: el número es de la empresa, y una secuencia compartida
  -- filtraría el volumen de operaciones de una empresa a las demás.
  entry_number  bigint NOT NULL,
  memo          text NOT NULL,
  source        accounting.entry_source NOT NULL,
  -- Trazabilidad origen → destino (regla 2 del plan §2.2). `source_type` /
  -- `source_id` permiten navegar del asiento al documento que lo originó:
  -- el contador abre "Ventas: $1.234.500" y llega a las 47 facturas que lo
  -- componen. Sin esto el ERP no sirve para una auditoría.
  source_type   text,
  source_id     uuid,
  -- Reversión: un asiento no se edita, se revierte con un contra-asiento.
  -- `reverses_entry_id` apunta al asiento original; el original nunca se toca.
  reverses_entry_id uuid,
  -- Aprobación de asientos manuales. Los automáticos nacen aprobados.
  approved_at   timestamptz,
  approved_by   uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entries_number_positive CHECK (entry_number > 0),
  CONSTRAINT entries_memo_not_blank CHECK (length(btrim(memo)) > 0),
  -- Un asiento que revierte no puede revertirse a sí mismo.
  CONSTRAINT entries_no_self_reverse CHECK (reverses_entry_id IS DISTINCT FROM id)
);

ALTER TABLE accounting.journal_entries
  ADD CONSTRAINT entries_period_fk
  FOREIGN KEY (tenant_id, period_id)
  REFERENCES accounting.periods(tenant_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX journal_entries_tenant_id_uniq
  ON accounting.journal_entries(tenant_id, id);
CREATE UNIQUE INDEX journal_entries_tenant_number_uniq
  ON accounting.journal_entries(tenant_id, entry_number);
CREATE INDEX idx_entries_period        ON accounting.journal_entries(tenant_id, period_id);
CREATE INDEX idx_entries_date          ON accounting.journal_entries(tenant_id, entry_date);
-- Índice para la consulta de trazabilidad inversa: "qué asientos generó este documento".
CREATE INDEX idx_entries_source        ON accounting.journal_entries(tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX idx_entries_reverses      ON accounting.journal_entries(reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

COMMENT ON COLUMN accounting.journal_entries.source_type IS
  'Tipo del documento de origen («invoice», «payment», ...). Junto con source_id da la trazabilidad contable.';
COMMENT ON COLUMN accounting.journal_entries.reverses_entry_id IS
  'Contra-asiento: apunta al asiento que revierte. El original nunca se modifica ni se borra.';

CREATE TABLE accounting.journal_lines (
  id          bigserial,
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  entry_id    uuid NOT NULL,
  line_number smallint NOT NULL,
  account_id  uuid NOT NULL,
  -- Débito y crédito como columnas separadas y no un `amount` con signo.
  -- Motivo: con un solo campo con signo, "¿cuál es el total del debe?" deja de
  -- ser una suma y pasa a ser una suma condicionada, y toda consulta tiene que
  -- recordar la convención. Con dos columnas, la aritmética es directa y el
  -- CHECK de abajo hace imposible el estado ambiguo.
  debit       numeric(18,2) NOT NULL DEFAULT 0,
  credit      numeric(18,2) NOT NULL DEFAULT 0,
  -- Dimensiones analíticas. Opcionales, pero `cost_center` y `customer_id` son
  -- los cortes que el plan declara como reportes obligatorios (§4.7): margen por
  -- cliente y por centro de costo. Si no se capturan en la línea, después no se
  -- pueden reconstruir.
  --
  -- DEFECTO CORREGIDO: acá decía `REFERENCES app.customers(id)` y
  -- `REFERENCES app.products(id)` — FK SIMPLES contra tablas que tienen
  -- tenant_id. Una FK simple no falla y no avisa: permite que una línea de la
  -- empresa A apunte al cliente de la empresa B, y el margen por cliente que el
  -- plan declara como reporte obligatorio quedaría contaminado entre empresas.
  -- Es el defecto #2 que documenta `tools/check-composite-fks.mjs`. Las FK
  -- compuestas van abajo, junto a las otras, siguiendo el patrón del proyecto.
  cost_center text,
  customer_id uuid,
  product_id  uuid,
  memo        text,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lines_number_positive CHECK (line_number > 0),
  -- Una línea es de débito o de crédito, nunca de los dos, nunca de ninguno.
  CONSTRAINT lines_one_side CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  ),
  CONSTRAINT lines_non_negative CHECK (debit >= 0 AND credit >= 0)
);

-- FK compuestas para las dimensiones analíticas. Exigen que la fila referida
-- sea de la MISMA empresa: sin esto, una línea de la empresa A podía apuntar al
-- cliente de la empresa B y el margen por cliente se contaminaba en silencio.
--
-- ON DELETE RESTRICT y NO ON DELETE SET NULL, aunque la intención original era
-- conservar la línea al borrar el cliente. El motivo es mecánico y se verificó
-- contra el motor: en una FK compuesta, `SET NULL` intenta anular TODAS las
-- columnas de la clave, incluido `tenant_id`, que es NOT NULL. El DELETE falla
-- con «el valor nulo en la columna tenant_id viola la restricción de no nulo»
-- —un error sobre la columna equivocada, que no menciona ni el cliente ni la FK.
-- RESTRICT es además la semántica correcta para contabilidad: un cliente con
-- asientos no se borra, porque borrarlo destruiría la trazabilidad que el plan
-- exige para auditar. Se lo da de baja lógica, no se lo elimina.
ALTER TABLE accounting.journal_lines
  ADD CONSTRAINT lines_customer_fk
  FOREIGN KEY (tenant_id, customer_id)
  REFERENCES app.customers(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE accounting.journal_lines
  ADD CONSTRAINT lines_product_fk
  FOREIGN KEY (tenant_id, product_id)
  REFERENCES app.products(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE accounting.journal_lines
  ADD CONSTRAINT lines_entry_fk
  FOREIGN KEY (tenant_id, entry_id)
  REFERENCES accounting.journal_entries(tenant_id, id)
  ON DELETE CASCADE;

-- FK compuesta a la cuenta: impide imputar una línea a una cuenta de otra
-- empresa. Es la misma defensa que las claves compuestas de negocio.
ALTER TABLE accounting.journal_lines
  ADD CONSTRAINT lines_account_fk
  FOREIGN KEY (tenant_id, account_id)
  REFERENCES accounting.accounts(tenant_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX journal_lines_tenant_id_uniq
  ON accounting.journal_lines(tenant_id, id);
CREATE UNIQUE INDEX journal_lines_entry_number_uniq
  ON accounting.journal_lines(tenant_id, entry_id, line_number);
CREATE INDEX idx_lines_account   ON accounting.journal_lines(tenant_id, account_id);
CREATE INDEX idx_lines_entry     ON accounting.journal_lines(tenant_id, entry_id);
CREATE INDEX idx_lines_customer  ON accounting.journal_lines(tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON TABLE accounting.journal_lines IS
  'Líneas del asiento. El diferencial cero lo verifica trg_journal_balanced (diferido).';

-- =============================================================================
-- 5 · Saldos materializados
-- =============================================================================
-- Proyección de journal_lines. Se materializa porque el balance de una empresa
-- con años de historia suma millones de líneas en cada consulta. Es el mismo
-- patrón que app.stock_levels: una proyección escrita por función, no por INSERT
-- directo, con un job que verifica la consistencia y NO autocorrige.
-- =============================================================================

CREATE TABLE accounting.account_balances (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL,
  period_id      uuid NOT NULL,
  -- Saldo acumulado al cierre del período: es un saldo "de arrastre", no el
  -- movimiento del mes. Guardar sólo el movimiento obligaría a sumar todos los
  -- períodos anteriores para responder el saldo actual.
  opening_debit  numeric(18,2) NOT NULL DEFAULT 0,
  opening_credit numeric(18,2) NOT NULL DEFAULT 0,
  period_debit   numeric(18,2) NOT NULL DEFAULT 0,
  period_credit  numeric(18,2) NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE accounting.account_balances
  ADD CONSTRAINT balances_account_fk
  FOREIGN KEY (tenant_id, account_id)
  REFERENCES accounting.accounts(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE accounting.account_balances
  ADD CONSTRAINT balances_period_fk
  FOREIGN KEY (tenant_id, period_id)
  REFERENCES accounting.periods(tenant_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX account_balances_tenant_id_uniq
  ON accounting.account_balances(tenant_id, id);
CREATE UNIQUE INDEX account_balances_unique
  ON accounting.account_balances(tenant_id, account_id, period_id);
CREATE INDEX idx_balances_period ON accounting.account_balances(tenant_id, period_id);

COMMENT ON TABLE accounting.account_balances IS
  'Proyección materializada de journal_lines por cuenta y período. La escribe post_entry(). El job accounting.reconciliation verifica y reporta sin corregir.';

-- =============================================================================
-- 6 · Garantía de partida doble — EN EL MOTOR
-- =============================================================================
-- Ésta es la pieza central de la migración. Va como CONSTRAINT TRIGGER DIFERIDO
-- y no como CHECK por una razón de mecánica de PostgreSQL: un CHECK se evalúa
-- sobre la tupla que se inserta, y en el momento en que se inserta la primera
-- línea del asiento las demás todavía no existen. No hay forma de que una línea
-- aislada sepa si el asiento cierra.
--
-- DIFERIDO significa que la verificación ocurre al COMMIT, cuando ya están todas
-- las líneas. Es el único punto en el que la pregunta "¿este asiento cierra?"
-- tiene una respuesta con sentido.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.assert_entry_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_id uuid;
  v_tenant   uuid;
  v_debit    numeric(18,2);
  v_credit   numeric(18,2);
  v_lines    integer;
BEGIN
  -- El trigger corre en DELETE también, así que no se puede confiar en NEW.
  -- Se usa COALESCE(NEW, OLD) para obtener la fila afectada en cualquier caso.
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
  v_tenant   := COALESCE(NEW.tenant_id, OLD.tenant_id);

  -- Si la entrada desapareció (CASCADE de la cabecera borrada), no hay nada que
  -- verificar: el asiento completo se fue.
  IF NOT EXISTS (
    SELECT 1 FROM accounting.journal_entries e
    WHERE e.id = v_entry_id AND e.tenant_id = v_tenant
  ) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(l.debit), 0),
         COALESCE(sum(l.credit), 0),
         count(*)
  INTO v_debit, v_credit, v_lines
  FROM accounting.journal_lines l
  WHERE l.entry_id = v_entry_id AND l.tenant_id = v_tenant;

  -- Un asiento sin líneas no es un asiento: es una cabecera huérfana que
  -- aparecería en el libro diario sin explicar nada.
  IF v_lines = 0 THEN
    RAISE EXCEPTION
      'El asiento % no tiene líneas. Un asiento vacío no es un hecho económico.',
      v_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- La comparación es sobre numeric, no sobre float: 0.01 de tolerancia
  -- absorbería un error real de redondeo acumulado. `numeric(18,2)` es exacto,
  -- así que la igualdad también lo es.
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'El asiento % no cierra: débitos % vs créditos % (diferencia %). '
      'Un asiento descuadrado no se puede guardar, ni siquiera parcialmente.',
      v_entry_id, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

COMMENT ON FUNCTION accounting.assert_entry_balanced() IS
  'Verifica partida doble al COMMIT. Diferido porque al insertar la cabecera todavía no hay líneas.';

DROP TRIGGER IF EXISTS trg_journal_balanced ON accounting.journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON accounting.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION accounting.assert_entry_balanced();

-- =============================================================================
-- 7 · Inmutabilidad del período cerrado
-- =============================================================================
-- El ORDER de esta validación importa y es la razón por la que es un trigger
-- aparte del de balance: un asiento sobre un período cerrado tiene que ser
-- rechazado ANTES de tocar el saldo (riesgo declarado en la adenda del ADR).
-- Si el saldo se actualizara primero y la validación fallara después, la
-- actualización quedaría escrita y el saldo mentiría sin que nada falle.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.assert_period_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status accounting.period_status;
  v_period uuid;
BEGIN
  v_period := COALESCE(NEW.period_id, OLD.period_id);
  SELECT p.status INTO v_status
  FROM accounting.periods p
  WHERE p.id = v_period AND p.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id);

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'El asiento apunta a un período inexistente (%).', v_period
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- `closing` se acepta: es el estado en el que se cargan los ajustes de cierre,
  -- que por definición ocurren después del último asiento del mes.
  IF v_status = 'closed' THEN
    RAISE EXCEPTION
      'El período % está cerrado y no acepta asientos. '
      'Para corregirlo hay que reabrirlo (requiere motivo y queda auditado) '
      'o revertir con un contra-asiento en el período abierto.',
      v_period
      USING ERRCODE = 'check_violation';
  END IF;

  -- DEFECTO CORREGIDO — el más grave de la migración.
  --
  -- Acá decía `RETURN NULL`. En un trigger BEFORE ... FOR EACH ROW, `RETURN NULL`
  -- significa "saltear esta fila": PostgreSQL CANCELA la operación en silencio,
  -- sin error ni excepción. Consecuencia real: TODO `INSERT` en journal_entries
  -- se descartaba. El asiento no se escribía, `RETURNING` no devolvía nada
  -- (`v_entry.id` quedaba NULL), y las líneas fallaban después con un violación
  -- de no-nulo sobre `entry_id`.
  --
  -- Lo peligroso no es que fallara, sino CÓMO fallaba: el INSERT de la cabecera
  -- no lanzaba ningún error. Si `post_entry()` no hubiera insertado líneas
  -- después, el sistema habría reportado "asiento registrado" sin haber
  -- guardado nada, y la contabilidad quedaba vacía sin que nada fallara. Es el
  -- mismo patrón que el defecto del `DELETE` filtrado por RLS de `0007`: una
  -- operación que no hace nada y no avisa.
  --
  -- Un trigger BEFORE SÍ puede descartar una fila a propósito, pero eso es una
  -- decisión explícita que acá no existe: la validación rechaza con EXCEPTION o
  -- deja pasar. Dejar pasar es devolver NEW.
  RETURN NEW;
END $$;

-- NO diferido: la inmutabilidad del período es una precondición, no una
-- consecuencia. Se verifica antes de que la fila exista.
DROP TRIGGER IF EXISTS trg_entries_period_open ON accounting.journal_entries;
CREATE TRIGGER trg_entries_period_open
  BEFORE INSERT OR UPDATE ON accounting.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION accounting.assert_period_open();

-- =============================================================================
-- 8 · Numeración correlativa por empresa
-- =============================================================================
-- Se asigna en el motor y no en la aplicación por la misma razón que el
-- correlativo fiscal: un número calculado en la aplicación es una condición de
-- carrera entre dos transacciones concurrentes. `pg_advisory_xact_lock` serializa
-- por empresa sin bloquear a las demás, y el lock se libera solo al terminar la
-- transacción aunque aborte.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.next_entry_number(p_tenant uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_next bigint;
BEGIN
  -- Lock por empresa: dos asientos de la misma empresa se serializan; dos de
  -- empresas distintas no se ven entre sí. `hashtext` da la clave del lock.
  PERFORM pg_advisory_xact_lock(hashtext('accounting.entry_number'), hashtext(p_tenant::text));

  SELECT COALESCE(max(e.entry_number), 0) + 1
  INTO v_next
  FROM accounting.journal_entries e
  WHERE e.tenant_id = p_tenant;

  RETURN v_next;
END $$;

-- =============================================================================
-- 9 · Escritura de asientos: post_entry()
-- =============================================================================
-- Punto de entrada único. La aplicación no hace INSERT directo en
-- journal_entries/journal_lines: el mismo criterio que `apply_stock_movement()`.
-- Escribir directo permitiría saltear la actualización de saldos y dejar la
-- proyección mintiendo.
--
-- `SECURITY DEFINER` con `search_path` fijo: la función tiene que poder escribir
-- en accounting y en audit aunque el rol que la invoca no tenga esos permisos
-- directos, y el search_path fijo evita el ataque clásico de resolución de
-- nombres.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.post_entry(
  p_tenant_id   uuid,
  p_entry_date  date,
  p_memo        text,
  p_source      accounting.entry_source,
  p_lines       jsonb,                    -- [{"accountId":..,"debit":..,"credit":..,"memo":..}, ...]
  p_source_type text DEFAULT NULL,
  p_source_id   uuid DEFAULT NULL,
  p_created_by  uuid DEFAULT NULL
)
RETURNS accounting.journal_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = accounting, app, pg_temp
AS $$
DECLARE
  v_period   uuid;
  v_number   bigint;
  v_entry    accounting.journal_entries;
  v_line     jsonb;
  v_index    smallint := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION
      'Un asiento necesita al menos dos líneas (partida doble). Recibidas: %.',
      COALESCE(jsonb_array_length(p_lines), 0)
      USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Resolver el período. Falla si la fecha cae fuera de todo período abierto:
  --    es preferible un error explícito a un asiento en el período equivocado.
  SELECT p.id INTO v_period
  FROM accounting.periods p
  WHERE p.tenant_id = p_tenant_id
    AND p.starts_on <= p_entry_date
    AND p.ends_on   >= p_entry_date
    AND p.status <> 'closed'
  LIMIT 1;

  IF v_period IS NULL THEN
    RAISE EXCEPTION
      'No hay un período abierto que contenga la fecha %. '
      'Verificar el ejercicio y el estado del período.',
      p_entry_date
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Correlativo, con lock por empresa.
  v_number := accounting.next_entry_number(p_tenant_id);

  -- 3. Cabecera.
  INSERT INTO accounting.journal_entries (
    tenant_id, period_id, entry_date, entry_number, memo, source,
    source_type, source_id, created_by
  ) VALUES (
    p_tenant_id, v_period, p_entry_date, v_number, p_memo, p_source,
    p_source_type, p_source_id, p_created_by
  ) RETURNING * INTO v_entry;

  -- 4. Líneas. El trigger diferido no valida acá: valida al COMMIT.
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_index := v_index + 1;

    INSERT INTO accounting.journal_lines (
      tenant_id, entry_id, line_number, account_id,
      debit, credit, memo, cost_center, customer_id, product_id
    ) VALUES (
      p_tenant_id,
      v_entry.id,
      v_index,
      (v_line->>'accountId')::uuid,
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      v_line->>'memo',
      v_line->>'costCenter',
      NULLIF(v_line->>'customerId', '')::uuid,
      NULLIF(v_line->>'productId', '')::uuid
    );
  END LOOP;

  -- 5. Saldos. Se actualizan DESPUÉS de las líneas, en la misma transacción.
  --    Si el commit falla —por diferencial, por período cerrado, por lo que
  --    sea— el ROLLBACK deshace también esta proyección, así que el saldo no
  --    puede quedar por delante del libro.
  --
  --    Nota: antes acá se calculaban v_debit/v_credit con una consulta aparte
  --    que nadie usaba. Se eliminó: la suma que importa la hace el propio
  --    INSERT ... SELECT de abajo, y mantener una segunda suma era una
  --    invitación a que las dos divergieran.
  INSERT INTO accounting.account_balances (
    tenant_id, account_id, period_id, period_debit, period_credit
  )
  SELECT
    p_tenant_id,
    (l->>'accountId')::uuid,
    v_period,
    COALESCE(sum((l->>'debit')::numeric), 0),
    COALESCE(sum((l->>'credit')::numeric), 0)
  FROM jsonb_array_elements(p_lines) l
  GROUP BY (l->>'accountId')::uuid
  ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE
    SET period_debit  = accounting.account_balances.period_debit  + EXCLUDED.period_debit,
        period_credit = accounting.account_balances.period_credit + EXCLUDED.period_credit,
        updated_at    = now();

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION accounting.post_entry IS
  'Único punto de escritura de asientos. Resuelve período, numera, inserta cabecera y líneas, y actualiza saldos en la misma transacción.';

-- =============================================================================
-- 10 · Reversión: un asiento no se edita, se revierte
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.reverse_entry(
  p_tenant_id uuid,
  p_entry_id  uuid,
  p_reason    text,
  p_created_by uuid DEFAULT NULL
)
RETURNS accounting.journal_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = accounting, app, pg_temp
AS $$
DECLARE
  v_original accounting.journal_entries;
  v_lines    jsonb;
  v_entry    accounting.journal_entries;
BEGIN
  SELECT * INTO v_original
  FROM accounting.journal_entries
  WHERE id = p_entry_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe el asiento % para esta empresa.', p_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_original.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION
      'El asiento % ya es una reversión. Un contra-asiento no se revierte con otro contra-asiento: '
      'corregir la reversión original.', p_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Las líneas se invierten: el debe pasa al haber y viceversa. Es la definición
  -- de contra-asiento. Se conserva la cuenta y el orden.
  SELECT jsonb_agg(jsonb_build_object(
           'accountId', l.account_id,
           'debit',     l.credit,      -- invertido
           'credit',    l.debit,       -- invertido
           'memo',      COALESCE(l.memo, '') || ' (reversión)',
           'costCenter', l.cost_center,
           'customerId', l.customer_id,
           'productId',  l.product_id
         ) ORDER BY l.line_number)
  INTO v_lines
  FROM accounting.journal_lines l
  WHERE l.entry_id = p_entry_id AND l.tenant_id = p_tenant_id;

  v_entry := accounting.post_entry(
    p_tenant_id,
    CURRENT_DATE,
    format('Reversión del asiento #%s: %s', v_original.entry_number, p_reason),
    v_original.source,
    v_lines,
    v_original.source_type,
    v_original.source_id,
    p_created_by
  );

  UPDATE accounting.journal_entries
  SET reverses_entry_id = p_entry_id
  WHERE id = v_entry.id AND tenant_id = p_tenant_id
  RETURNING * INTO v_entry;

  RETURN v_entry;
END $$;

-- =============================================================================
-- 11 · Plan mínimo obligatorio de plataforma (decisión 2 del ADR)
-- =============================================================================
-- Cuentas con `tenant_id IS NULL`. Se copian a cada empresa nueva. Sin un
-- vocabulario común, ninguna consulta agregada entre empresas es posible, y esa
-- correspondencia no se puede recuperar a posteriori: los códigos ya estarían
-- en el histórico.
-- =============================================================================

INSERT INTO accounting.accounts (tenant_id, code, name, kind, is_template, is_postable)
VALUES
  -- ACTIVO
  (NULL, '1',        'Activo',                          'asset',     true, false),
  (NULL, '1.1',      'Activo corriente',                'asset',     true, false),
  (NULL, '1.1.1',    'Caja y bancos',                   'asset',     true, false),
  (NULL, '1.1.1.01', 'Caja',                            'asset',     true, true),
  (NULL, '1.1.1.02', 'Caja chica',                      'asset',     true, true),
  (NULL, '1.1.2',    'Bancos',                          'asset',     true, false),
  (NULL, '1.1.2.01', 'Banco cuenta corriente',          'asset',     true, true),
  (NULL, '1.1.2.02', 'Banco caja de ahorro',            'asset',     true, true),
  (NULL, '1.1.3',    'Créditos por ventas',             'asset',     true, false),
  (NULL, '1.1.3.01', 'Cuentas a cobrar clientes',       'asset',     true, true),
  (NULL, '1.1.3.02', 'Deudores morosos',                'asset',     true, true),
  (NULL, '1.1.4',    'Otros créditos',                  'asset',     true, false),
  (NULL, '1.1.4.01', 'IVA crédito fiscal',              'asset',     true, true),
  (NULL, '1.1.4.02', 'IVA saldo a favor',               'asset',     true, true),
  (NULL, '1.1.4.03', 'Anticipos a proveedores',         'asset',     true, true),
  (NULL, '1.1.5',    'Bienes de cambio',                'asset',     true, false),
  (NULL, '1.1.5.01', 'Inventario de mercaderías',       'asset',     true, true),
  (NULL, '1.2',      'Activo no corriente',             'asset',     true, false),
  (NULL, '1.2.1',    'Bienes de uso',                   'asset',     true, false),
  (NULL, '1.2.1.01', 'Rodados',                         'asset',     true, true),
  (NULL, '1.2.1.02', 'Muebles y útiles',                'asset',     true, true),
  (NULL, '1.2.1.03', 'Equipos de computación',          'asset',     true, true),
  (NULL, '1.2.2',    'Amortizaciones acumuladas',       'asset',     true, false),
  (NULL, '1.2.2.01', 'Amortización acumulada rodados',  'asset',     true, true),

  -- PASIVO
  (NULL, '2',        'Pasivo',                          'liability', true, false),
  (NULL, '2.1',      'Pasivo corriente',                'liability', true, false),
  (NULL, '2.1.1',    'Deudas comerciales',              'liability', true, false),
  (NULL, '2.1.1.01', 'Cuentas a pagar proveedores',     'liability', true, true),
  (NULL, '2.1.2',    'Deudas fiscales',                 'liability', true, false),
  (NULL, '2.1.2.01', 'IVA débito fiscal',               'liability', true, true),
  (NULL, '2.1.2.02', 'IVA a pagar',                     'liability', true, true),
  (NULL, '2.1.2.03', 'Ingresos brutos a pagar',         'liability', true, true),
  (NULL, '2.1.2.04', 'Retenciones a depositar',         'liability', true, true),
  (NULL, '2.1.3',    'Deudas sociales',                 'liability', true, false),
  (NULL, '2.1.3.01', 'Sueldos a pagar',                 'liability', true, true),
  (NULL, '2.1.3.02', 'Cargas sociales a pagar',         'liability', true, true),
  (NULL, '2.1.4',    'Otras deudas',                    'liability', true, false),
  (NULL, '2.1.4.01', 'Proveedores a pagar',             'liability', true, true),

  -- PATRIMONIO NETO
  (NULL, '3',        'Patrimonio neto',                 'equity',    true, false),
  (NULL, '3.1',      'Capital',                         'equity',    true, false),
  (NULL, '3.1.1.01', 'Capital social',                  'equity',    true, true),
  (NULL, '3.2',      'Resultados',                      'equity',    true, false),
  (NULL, '3.2.1.01', 'Resultados acumulados',           'equity',    true, true),
  (NULL, '3.2.1.02', 'Resultado del ejercicio',         'equity',    true, true),

  -- RESULTADOS POSITIVOS
  (NULL, '4',        'Ingresos',                        'income',    true, false),
  (NULL, '4.1',      'Ingresos por ventas',             'income',    true, false),
  (NULL, '4.1.1.01', 'Ventas',                          'income',    true, true),
  (NULL, '4.1.1.02', 'Ventas de servicios',             'income',    true, true),
  (NULL, '4.1.1.03', 'Devoluciones y bonificaciones',   'income',    true, true),
  (NULL, '4.2',      'Otros ingresos',                  'income',    true, false),
  (NULL, '4.2.1.01', 'Intereses ganados',               'income',    true, true),
  (NULL, '4.2.1.02', 'Otros ingresos operativos',       'income',    true, true),

  -- RESULTADOS NEGATIVOS
  (NULL, '5',        'Costos',                          'expense',   true, false),
  (NULL, '5.1',      'Costo de ventas',                 'expense',   true, false),
  (NULL, '5.1.1.01', 'Costo de mercadería vendida',     'expense',   true, true),
  (NULL, '5.1.1.02', 'Costo de servicios prestados',    'expense',   true, true),
  (NULL, '6',        'Gastos',                          'expense',   true, false),
  (NULL, '6.1',      'Gastos de personal',              'expense',   true, false),
  (NULL, '6.1.1.01', 'Sueldos y jornales',              'expense',   true, true),
  (NULL, '6.1.1.02', 'Cargas sociales',                 'expense',   true, true),
  (NULL, '6.1.1.03', 'Beneficios al personal',          'expense',   true, true),
  (NULL, '6.2',      'Gastos de comercialización',      'expense',   true, false),
  (NULL, '6.2.1.01', 'Fletes y logística',              'expense',   true, true),
  (NULL, '6.2.1.02', 'Comisiones',                      'expense',   true, true),
  (NULL, '6.2.1.03', 'Publicidad y marketing',          'expense',   true, true),
  (NULL, '6.3',      'Gastos de administración',        'expense',   true, false),
  (NULL, '6.3.1.01', 'Alquileres',                      'expense',   true, true),
  (NULL, '6.3.1.02', 'Servicios (luz, agua, internet)', 'expense',   true, true),
  (NULL, '6.3.1.03', 'Honorarios profesionales',        'expense',   true, true),
  (NULL, '6.3.1.04', 'Impuestos y tasas',               'expense',   true, true),
  (NULL, '6.3.1.05', 'Gastos bancarios',                'expense',   true, true),
  (NULL, '6.4',      'Gastos financieros',              'expense',   true, false),
  (NULL, '6.4.1.01', 'Intereses y comisiones',          'expense',   true, true),
  (NULL, '6.4.1.02', 'Diferencia de cambio',            'expense',   true, true),
  (NULL, '7',        'Resultados varios',               'expense',   true, false),
  (NULL, '7.1.1.01', 'Resultados por tenencia',         'expense',   true, true)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 12 · Copia del plan mínimo al crear una empresa
-- =============================================================================
-- Se COPIAN, no se referencian. Si se referenciaran, renombrar una cuenta en una
-- empresa afectaría a todas las demás: la personalización filtraría entre
-- inquilinos, que es exactamente el modo de falla que el aislamiento del resto
-- del sistema previene.
--
-- La jerarquía se reconstruye resolviendo los padres por código, porque los
-- uuid de las cuentas copiadas son nuevos.
-- =============================================================================

CREATE OR REPLACE FUNCTION accounting.seed_tenant_chart_of_accounts(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = accounting, app, pg_temp
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Se requiere el id de la empresa.' USING ERRCODE = 'not_null_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM accounting.accounts WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION
      'La empresa % ya tiene un plan de cuentas. No se re-inicializa: '
      'sobrescribirlo destruiría las cuentas propias que se hayan agregado.',
      p_tenant_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Primera pasada: todas las cuentas sin padre.
  INSERT INTO accounting.accounts (tenant_id, code, name, kind, is_template, is_postable, parent_id)
  SELECT p_tenant_id, t.code, t.name, t.kind, true, t.is_postable, NULL
  FROM accounting.accounts t
  WHERE t.tenant_id IS NULL
  ORDER BY length(t.code);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Segunda pasada: resolver la jerarquía por prefijo de código.
  -- El padre de '1.1.1.01' es '1.1.1'. Se busca la cuenta cuyo código sea el
  -- prefijo. Se ordena por longitud de código para que los padres existan antes
  -- de asignar a los hijos.
  UPDATE accounting.accounts hijo
  SET parent_id = padre.id
  FROM accounting.accounts padre
  WHERE hijo.tenant_id = p_tenant_id
    AND padre.tenant_id = p_tenant_id
    AND padre.code <> hijo.code
    AND hijo.code LIKE padre.code || '.%'
    -- Sólo el prefijo inmediato: si hay dos candidatos ('1.1' y '1.1.1' para
    -- '1.1.1.01'), gana el más largo, que es el padre directo.
    AND length(padre.code) = (
      SELECT max(length(p2.code))
      FROM accounting.accounts p2
      WHERE p2.tenant_id = p_tenant_id
        AND p2.code <> hijo.code
        AND hijo.code LIKE p2.code || '.%'
    );

  RETURN v_count;
END $$;

COMMENT ON FUNCTION accounting.seed_tenant_chart_of_accounts IS
  'Copia el plan mínimo de plataforma a una empresa nueva y reconstruye la jerarquía. Falla si ya hay cuentas, para no pisar personalizaciones.';

-- =============================================================================
-- 13 · Vistas contables
-- =============================================================================

CREATE OR REPLACE VIEW accounting.v_trial_balance
WITH (security_invoker = true)
AS
SELECT
  b.tenant_id,
  b.period_id,
  p.period_number,
  p.starts_on,
  p.ends_on,
  a.id                AS account_id,
  a.code              AS account_code,
  a.name              AS account_name,
  a.kind              AS account_kind,
  b.opening_debit,
  b.opening_credit,
  b.period_debit,
  b.period_credit,
  -- Saldo deudor/acreedor: la convención contable, ya resuelta acá para que
  -- ningún consumidor tenga que recordarla.
  (b.opening_debit + b.period_debit)
    - (b.opening_credit + b.period_credit) AS balance
FROM accounting.account_balances b
JOIN accounting.accounts a ON a.id = b.account_id AND a.tenant_id = b.tenant_id
JOIN accounting.periods  p ON p.id = b.period_id AND p.tenant_id = b.tenant_id;

COMMENT ON VIEW accounting.v_trial_balance IS
  'Balance de sumas y saldos por cuenta y período. security_invoker para que la RLS del inquilino siga aplicándose.';

CREATE OR REPLACE VIEW accounting.v_journal
WITH (security_invoker = true)
AS
SELECT
  e.tenant_id,
  e.id            AS entry_id,
  e.entry_number,
  e.entry_date,
  e.memo,
  e.source,
  e.source_type,
  e.source_id,
  e.reverses_entry_id,
  e.approved_at IS NOT NULL AS is_approved,
  l.line_number,
  l.account_id,
  a.code          AS account_code,
  a.name          AS account_name,
  l.debit,
  l.credit,
  l.cost_center,
  l.customer_id,
  l.product_id,
  l.memo          AS line_memo,
  e.created_by,
  e.created_at
FROM accounting.journal_entries e
JOIN accounting.journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
JOIN accounting.accounts      a ON a.id = l.account_id AND a.tenant_id = l.tenant_id;

COMMENT ON VIEW accounting.v_journal IS
  'Libro diario aplanado: una fila por línea, con la cabecera repetida. security_invoker.';

-- =============================================================================
-- 14 · RLS, permisos y cobertura
-- =============================================================================

-- La macro de `0006` tenía el listado de esquemas escrito a mano
-- (`app`, `billing`, `logistics`, `audit`). Un esquema nuevo quedaba afuera en
-- silencio — el mismo tipo de agujero que el descubrimiento dinámico de
-- `assert_rls_coverage()` existe para prevenir. Se replica el criterio dinámico.
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

-- Política de aislamiento para las tablas contables de empresa.
-- El patrón es el mismo de `0006`, con una diferencia importante: `accounts`
-- tiene filas con `tenant_id IS NULL` (el plan mínimo). Un `tenant_id =
-- current_tenant_id()` a secas las haría invisibles, y ninguna empresa podría
-- ver el plan de plataforma del que copió sus cuentas.
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
          -- La plantilla del plan mínimo es de lectura para todos, pero sólo
          -- de lectura: la política de escritura de abajo es la que lo exige.
          OR %s
        )
        WITH CHECK (
          app.is_platform_admin()
          OR tenant_id = app.current_tenant_id()
        )
    $f$,
      r.table_name,
      CASE WHEN r.table_name = 'accounts'
           THEN 'tenant_id IS NULL'
           ELSE 'false' END
    );
  END LOOP;
END $$;

-- La restricción de escritura sobre la plantilla se expresa como una política
-- separada y restrictiva. `AS RESTRICTIVE` es lo que la hace sumar en vez de
-- competir: todas las políticas permisivas aplican en OR, y las restrictivas en
-- AND. Sin `RESTRICTIVE`, una segunda política permisiva ampliaría el acceso en
-- lugar de acotarlo.
DROP POLICY IF EXISTS accounts_template_readonly ON accounting.accounts;
CREATE POLICY accounts_template_readonly ON accounting.accounts
  AS RESTRICTIVE
  FOR ALL TO PUBLIC
  USING (true)
  WITH CHECK (
    app.is_platform_admin()
    OR tenant_id IS NOT NULL        -- nadie escribe la plantilla desde una empresa
  );

-- Grants. El rol de aplicación necesita operar; el de lectura, sólo leer.
--
-- DEFECTO CORREGIDO: falta `GRANT USAGE ON SCHEMA accounting`. Sin el USAGE
-- sobre el esquema, PostgreSQL rechaza cualquier acceso ANTES de evaluar los
-- privilegios de tabla: los GRANT sobre tablas y funciones de abajo quedaban
-- inertes y `app_login` recibía "permiso denegado al esquema accounting" al
-- primer SELECT. Los grants se veían completos, que es lo que hace peligroso
-- este defecto. Es el mismo patrón que `0007` (línea 36) y `0011` (línea 23).
GRANT USAGE ON SCHEMA accounting TO control_app, control_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA accounting TO control_app;
GRANT SELECT ON ALL TABLES IN SCHEMA accounting TO control_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA accounting TO control_app;

-- Las tablas de este esquema se crearon con `post_entry()` como punto de
-- escritura, pero el rol necesita además poder ejecutar las funciones.
GRANT EXECUTE ON FUNCTION accounting.post_entry     TO control_app;
GRANT EXECUTE ON FUNCTION accounting.reverse_entry  TO control_app;
GRANT EXECUTE ON FUNCTION accounting.next_entry_number TO control_app;
GRANT EXECUTE ON FUNCTION accounting.seed_tenant_chart_of_accounts TO control_app;

-- ALTER DEFAULT PRIVILEGES para las tablas y secuencias que se agreguen después.
-- `GRANT ... ON ALL TABLES` sólo alcanza a lo que ya existía al momento del
-- grant; sin esto, una tabla contable nueva quedaría sin permisos y el error
-- aparecería recién en producción. Es el mismo defecto #10 de `0007`.
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting
  GRANT SELECT ON TABLES TO control_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting
  GRANT USAGE, SELECT ON SEQUENCES TO control_app;

-- Registro del job de verificación. El ledger es de plataforma y no lleva
-- tenant_id, así que queda exento de RLS como los demás de `ops`.
INSERT INTO ops.jobs (code, description, expected_every)
VALUES (
  'accounting.reconciliation',
  'Verifica que los saldos materializados coincidan con la suma del libro. Reporta sin corregir.',
  interval '1 day'
)
ON CONFLICT (code) DO NOTHING;

-- La barrera de cobertura. Si alguna tabla de `accounting` quedó sin FORCE RLS
-- o sin política, esto falla y la migración se revierte entera.
SELECT app.assert_rls_coverage();

COMMIT;
