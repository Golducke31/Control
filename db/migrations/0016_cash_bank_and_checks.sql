-- =============================================================================
-- Control · 0016 · Caja, banco y cheques (E4, parte 2)
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- `0015` dejó el cobro imputado a las facturas, pero el dinero todavía no tiene
-- dónde estar. Un cobro dice "entraron $150.000" y no dice en qué caja, en qué
-- cuenta bancaria, ni si el medio fue un cheque que quizá rebote.
--
-- El gate de la fase E4 en §7.1 del plan es **"Saldo de tesorería cuadra con
-- movimientos"**. Eso es exactamente lo que este archivo hace posible y
-- verificable: la sección 5 mide que el saldo derivado de una cuenta sea igual a
-- la suma de sus movimientos, en las dos direcciones (cargo suma, descargo
-- resta), y que ninguna columna guardada pueda discrepar.
--
-- Los criterios de §6.2, bloque "Cobros y tesorería", que cubre esta parte:
-- **T-4** (un cheque rechazado revierte el movimiento de fondos), **T-5** (un
-- cheque depositado y no acreditado no aumenta el saldo disponible), **T-6** (la
-- conciliación bancaria cuadra el extracto contra los movimientos) y **T-7** (el
-- saldo de tesorería cuadra con los movimientos).
--
-- LAS CINCO DECISIONES QUE GOBIERNAN ESTE ARCHIVO
--
-- 1. UN CHEQUE NO ES UN MÉTODO DE PAGO.
--
--    Hoy `billing.payments.method` es `text` y acepta `'cheque'` como string.
--    Alcanza para anotar "pagaron con cheque", y no sirve para nada más: no hay
--    número de cheque, no hay fecha de acreditación, no hay estado. Un cheque
--    tiene un CICLO DE VIDA —cartera → depositado → acreditado, con rechazado y
--    endosado como salidas— y el ciclo es lo que decide si el dinero existe.
--
--    `treasury.checks` es una entidad con máquina de estados propia. El método
--    de pago sigue siendo `text` para los medio que NO tienen ciclo (efectivo,
--    transferencia, tarjeta): agregarles una tabla sería modelar un ciclo de vida
--    que no tienen.
--
-- 2. EL CHEQUE EN CARTERA NO ES DINERO DISPONIBLE.
--
--    Es el corazón de T-5. Un cheque recibido y no depositado, o depositado y no
--    acreditado, es un activo contingente: si el librador no tiene fondos, no
--    cobra nadie. Lo que decide cuándo el cheque se convierte en fondos es la
--    transición a `acreditado`, y es ESA transición la que emite el movimiento de
--    fondos. Nunca el alta del cheque.
--
--    El cobro, igual, se registra al recibir el cheque —el cliente pagó, su deuda
--    se extingue— pero el movimiento de tesorería espera a la acreditación. Son
--    dos hechos económicos distintos y por eso son dos asientos distintos.
--
-- 3. EL SALDO NO SE GUARDA. OTRA VEZ.
--
--    Misma regla que el saldo por cliente (`0015`) y por proveedor (`0014`):
--    `treasury.accounts` NO tiene columna `balance`. Se deriva de sus
--    movimientos. Un saldo materializado puede discrepar de los movimientos que
--    dice resumir, y esa discrepancia es indetectable sin una auditoría completa.
--
--    Con una excepción deliberada y acotada: `opening_balance`. No es un saldo, es
--    el SALDO INICIAL —el punto de partida de la serie— y sin él los movimientos
--    de una cuenta que ya existía antes de adoptar el sistema no cuadrarían con
--    nada. Se modela como un movimiento más (`kind = 'opening'`), no como una
--    columna, para que la suma sea uniforme y no haya un caso especial en cada
--    consulta. Ver sección 1.
--
-- 4. EL MOVIMIENTO DE FONDOS ES INMUTABLE Y LLEVA SU SIGNO.
--
--    Un movimiento que se puede editar no puede auditarse. `treasury.movements`
--    rechaza el UPDATE; lo que se corrige se corrige con un contramovimiento, que
--    es lo que hace un extracto bancario real. El signo se guarda en `direction`
--    y no en el monto, porque un monto negativo invita a olvidar el signo en una
--    suma y descubrirlo tarde: `sum(amount)` sobre montos con signo implícito es
--    el origen clásico del descuadre que este gate tiene que detectar.
--
-- 5. LA CONCILIACIÓN ES UN HECHO, NO UN ESTADO.
--
--    T-6 pide que la conciliación cuadre el extracto contra los movimientos. Una
--    columna `reconciled boolean` en el movimiento no alcanza: no dice contra qué
--    documento, cuándo, ni por quién, y no puede quedar parcial. Se modela como
--    `treasury.reconciliations` (una por período y cuenta) más
--    `treasury.reconciliation_lines` (qué movimiento queda conciliado contra qué
--    referencia del extracto), con un CHECK que impide conciliar una cuenta que
--    no es la del período.
--
-- AISLAMIENTO
--
-- Esquema `treasury`, nuevo. Las tablas llevan `tenant_id` y quedan alcanzadas
-- por la cobertura al final (`app.assert_rls_coverage()`), que descubre esquemas
-- desde `pg_namespace` —no desde una lista fija— justamente para que un esquema
-- nuevo no quede afuera en silencio.
--
-- El esquema nuevo necesita `GRANT USAGE`: sin él PostgreSQL rechaza cualquier
-- acceso ANTES de evaluar los privilegios de tabla, y los GRANT de abajo quedan
-- inertes con un "permiso denegado al esquema" que no menciona la tabla. Es el
-- defecto que documenta `0012` y que costó la suite de compras.
--
-- OJO CON `accounting.accounts`: su `tenant_id` es NULLABLE (NULL = cuenta del
-- plan mínimo de plataforma, compartida por todas las empresas). El macro
-- dinámico de este archivo NO la toca —filtra por esquema `treasury`— y eso es
-- deliberado: una política `tenant_id = app.current_tenant_id()` sobre una tabla
-- con tenant_id NULL escondería la plantilla de todas las empresas y haría
-- fallar la copia del plan de cuentas de una forma muy difícil de leer.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS treasury;

-- =============================================================================
-- 1 · Cuentas de fondos
-- =============================================================================
-- Una cuenta de tesorería es una caja chica, una caja, o una cuenta bancaria. La
-- distinción importa porque cambia lo que se puede hacer con ella: una caja se
-- arquea y no se concilia contra extracto; un banco se concilia y tiene CBU.
--
-- `kind` es un enum y no un `text` con CHECK: el tipo tiene que existir para que
-- una función pueda exigirlo en su firma. Es la misma lección de
-- `billing.receipt_kind` en `0015` —una función declarada con `text` no resuelve
-- cuando se la llama con la columna del enum.
DO $$
BEGIN
  CREATE TYPE treasury.account_kind AS ENUM ('cash', 'bank');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS treasury.accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,

  code            text NOT NULL,           -- 'CAJA-01', 'BBVA-CC'
  name            text NOT NULL,           -- 'Caja principal', 'Banco BBVA cta. cte.'
  kind            treasury.account_kind NOT NULL,

  currency        char(3) NOT NULL DEFAULT 'ARS',

  -- Datos bancarios. NULL para una caja. No se vuelven NOT NULL por `kind` con
  -- un CHECK: una cuenta bancaria puede estar configurada por código de cuenta
  -- interno y completar el CBU después, sin que eso sea un error. Exigirlos acá
  -- obligaría a inventar un CBU para poder dar de alta la cuenta.
  bank_name       text,
  cbu             text,
  alias           text,

  -- Saldo inicial como MOVIMIENTO, no como columna. Ver sección 4.
  -- La columna de acá es el monto declarado; el movimiento lo emite el trigger
  -- de siembra de abajo, para que la suma de movimientos incluya el punto de
  -- partida sin ningún caso especial.
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  opened_on       date NOT NULL DEFAULT CURRENT_DATE,

  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Toda tabla referenciada por FK compuesta necesita declarar el UNIQUE
  -- `(tenant_id, id)`. Sin esto, `ADD CONSTRAINT ... FOREIGN KEY (tenant_id, x)`
  -- no resuelve, y el validador `tools/check-composite-fks.mjs` lo reporta.
  CONSTRAINT tac_id_tenant  UNIQUE (tenant_id, id),
  CONSTRAINT tac_code_uniq  UNIQUE (tenant_id, code),

  CONSTRAINT tac_code_format CHECK (code ~ '^[A-Za-z0-9._-]{2,32}$'),
  CONSTRAINT tac_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  -- Un CBU argentino son 22 dígitos. Se acepta NULL, no un formato libre: un CBU
  -- mal tipeado que entra y después no concilia es más caro que un rechazo al
  -- cargarlo.
  CONSTRAINT tac_cbu_format CHECK (cbu IS NULL OR cbu ~ '^[0-9]{22}$'),
  -- El saldo inicial puede ser negativo (un descubierto inicial es un dato real).
  CONSTRAINT tac_opening_finite CHECK (opening_balance IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tac_tenant_active ON treasury.accounts(tenant_id, is_active);

CREATE TRIGGER trg_tac_touch BEFORE UPDATE ON treasury.accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE treasury.accounts IS
  'Cuentas de fondos de la empresa: cajas y cuentas bancarias. El saldo NO se guarda: se deriva de treasury.movements.';
COMMENT ON COLUMN treasury.accounts.opening_balance IS
  'Saldo inicial declarado. Se materializa como un movimiento (kind=opening) para que la suma de movimientos sea uniforme.';

-- =============================================================================
-- 2 · Máquina de estados del cheque
-- =============================================================================
-- Los estados y las transiciones permitidas. Se declaran como tabla y no como
-- una cadena de IFs dentro de una función, por la misma razón por la que la
-- cobertura RLS se descubre desde `pg_class`: una regla que vive en el código de
-- una función se puede saltear llamando a otra cosa, y una que vive en una tabla
-- la puede consultar cualquier consumidor —incluida la suite de invariantes— sin
-- reimplementar la lógica.
--
-- La tabla es de PLATAFORMA (sin `tenant_id`): las transiciones de un cheque son
-- las mismas para todas las empresas. Es una regla del dominio, no un dato del
-- inquilino, y por eso el `assert_rls_coverage` la exime con una razón declarada
-- (ver el bloque de exenciones que extiende la sección 8).
DO $$
BEGIN
  CREATE TYPE treasury.check_state AS ENUM (
    'in_portfolio',   -- en cartera: recibido, no depositado
    'deposited',      -- depositado: en el banco, todavía no acreditado
    'cleared',        -- acreditado: el dinero está disponible
    'rejected',       -- rechazado: sin fondos, el dinero NO existe
    'endorsed',       -- endosado a un tercero: salió de la empresa
    'cancelled'       -- anulado antes de depositar
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS treasury.check_state_transitions (
  from_state  treasury.check_state NOT NULL,
  to_state    treasury.check_state NOT NULL,
  description text NOT NULL,

  PRIMARY KEY (from_state, to_state),
  CONSTRAINT tcst_no_self CHECK (from_state <> to_state)
);

-- Se siembra idempotente. `DO UPDATE` para que corregir una descripción no exija
-- borrar la fila —y `DO NOTHING` en las que el código no debe volver a decidir.
--
-- Los literales de las dos primeras columnas llevan CAST explícito al enum. Es la
-- misma trampa que documenta el trigger del saldo inicial: en un `INSERT ...
-- VALUES`, una tupla con literales de texto no se coacciona al tipo enum de la
-- columna destino, y sin el CAST el INSERT falla nombrando una incompatibilidad de
-- tipos que no dice nada sobre el cheque.
INSERT INTO treasury.check_state_transitions (from_state, to_state, description) VALUES
  -- El camino feliz.
  ('in_portfolio'::treasury.check_state, 'deposited'::treasury.check_state, 'Se deposita en el banco; todavía no acreditado'),
  ('in_portfolio'::treasury.check_state, 'endorsed'::treasury.check_state,  'Se endosa a un tercero: sale de la empresa'),
  ('in_portfolio'::treasury.check_state, 'cancelled'::treasury.check_state, 'Se anula antes de depositarlo'),
  ('deposited'::treasury.check_state,    'cleared'::treasury.check_state,   'El banco lo acredita: el dinero pasa a estar disponible'),
  ('deposited'::treasury.check_state,    'rejected'::treasury.check_state,  'El banco lo rechaza: el librador no tenía fondos'),
  -- ACÁ ESTABA EL DEFECTO QUE DESTAPÓ LA PRUEBA DE T-4.
  --
  -- La primera versión de esta tabla sólo permitía rechazar un cheque que estaba
  -- `deposited`. Pero T-4 dice literalmente "un cheque rechazado revierte el
  -- movimiento de fondos", y para revertir un movimiento tiene que haber uno: o
  -- sea que el cheque YA estaba `cleared`. Sin esta arista, el caso que el
  -- criterio pide medir era imposible de ejecutar y el motor respondía "las
  -- transiciones válidas desde «cleared» son: (ninguna)".
  --
  -- Y es un caso real, no una hipótesis: un cheque acreditado y después devuelto
  -- ocurre cuando el banco acredita en firme y más tarde descubre el problema
  -- —cuenta cerrada, firma adulterada, orden judicial— y lo debita del saldo. La
  -- acreditación existió, el dinero se contó, y después dejó de estar: hay que
  -- revertirlo.
  --
  -- Lo que NO se permite es `cleared → endorsed`: endosar un cheque cuyo dinero ya
  -- está cobrado sería vender un activo que ya no existe. Esa arista sigue
  -- ausente a propósito, y el motor da un mensaje específico si alguien la intenta.
  ('cleared'::treasury.check_state,      'rejected'::treasury.check_state,  'El banco lo devuelve después de haberlo acreditado: se revierten los fondos'),
  -- Un cheque rechazado puede re-presentarse: es un caso real y frecuente en
  -- Argentina (el librador cubre el saldo y se deposita de nuevo). Se permite
  -- volver a `deposited` y NO directo a `cleared`: tiene que pasar otra vez por
  -- el banco, que es donde se determina si hay fondos.
  ('rejected'::treasury.check_state,     'deposited'::treasury.check_state, 'Se re-presenta al cobro después de rechazado'),
  ('rejected'::treasury.check_state,     'endorsed'::treasury.check_state,  'Se entrega endosado aun sin acreditar')
ON CONFLICT (from_state, to_state) DO UPDATE
  SET description = EXCLUDED.description;

COMMENT ON TABLE treasury.check_state_transitions IS
  'Transiciones válidas del ciclo de vida de un cheque. La consulta el motor antes de aceptar un cambio de estado; es la fuente de la máquina de estados.';

-- =============================================================================
-- 3 · Cheques
-- =============================================================================
-- Un cheque RECIBIDO de un cliente. La tabla es la del activo, con el ciclo de
-- vida como columna: el estado no se guarda "a mano" en el sentido de que
-- cualquiera lo elige —sólo `treasury.transition_check()` lo cambia, y sólo por
-- una arista declarada en la tabla de arriba.
CREATE TABLE IF NOT EXISTS treasury.checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,

  -- Quién lo entregó. Un cheque puede venir de un cliente (cobranza) o de un
  -- tercero. `customer_id` NULL significa "librador externo".
  customer_id      uuid,
  -- El comprobante de venta que salda, si corresponde. Se conserva además de las
  -- imputaciones de `billing.payment_allocations`: acá es el motivo del alta, no
  -- el detalle de la aplicación.
  invoice_id       uuid,

  check_number     text NOT NULL,
  -- El librador es quien FIRMA el cheque. Para un cheque de un cliente es el
  -- cliente, pero puede ser un tercero (un cheque de terceros que el cliente
  -- endosa). Se guarda siempre, porque es lo que el banco necesita para
  -- reclamar.
  drawer_name      text NOT NULL,
  drawer_doc_number text,

  branch_code      text,                    -- sucursal
  check_account    text,                    -- cuenta corriente del librador

  amount           numeric(14,2) NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'ARS',

  -- Fechas del ciclo. `due_date` es la fecha del cheque (puede ser a plazo, lo
  -- que se llama "cheque diferido"), `received_on` cuándo lo entregaron.
  issue_date       date,
  due_date         date NOT NULL,
  received_on      date NOT NULL DEFAULT CURRENT_DATE,

  state            treasury.check_state NOT NULL DEFAULT 'in_portfolio',
  -- Fecha en que se depositó en el banco. La exige el estado, ver el CHECK.
  deposited_on     date,
  -- Fecha de acreditación efectiva. Es la que habilita el movimiento de fondos.
  cleared_on       date,
  rejected_on      date,
  -- Motivo del rechazo, tal como lo informa el banco ('sin fondos', 'cuenta
  -- cerrada', 'firma no registrada'). No se normaliza a un enum: los motivos que
  -- informa un banco no son un conjunto cerrado y perder el texto original es
  -- perder la información que se necesita para reclamar.
  rejection_reason text,

  -- La cuenta de tesorería donde se depositó. NULL mientras está en cartera.
  account_id       uuid,
  -- El movimiento de fondos que esta acreditación emitió. NULL hasta que se
  -- acredita. Es la trazabilidad en un solo sentido: cheque → movimiento.
  movement_id      uuid,
  -- El cobro que originó el alta del cheque, si vino de una cobranza.
  payment_id       uuid,

  notes            text,
  created_by       uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tchk_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT tchk_customer_fk  FOREIGN KEY (tenant_id, customer_id)
    REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tchk_invoice_fk   FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES billing.invoices(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tchk_account_fk   FOREIGN KEY (tenant_id, account_id)
    REFERENCES treasury.accounts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tchk_payment_fk   FOREIGN KEY (tenant_id, payment_id)
    REFERENCES billing.payments(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT tchk_amount_pos   CHECK (amount > 0),
  CONSTRAINT tchk_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT tchk_fechas       CHECK (issue_date IS NULL OR issue_date <= due_date),

  -- COHERENCIA ESTADO ↔ FECHAS.
  --
  -- Cada estado exige las fechas que le corresponden, y eso es lo que impide que
  -- una fila quede en un estado que sus propios datos contradicen. Un cheque
  -- "acreditado" sin fecha de acreditación es una fila que nadie puede auditar.
  CONSTRAINT tchk_state_dates CHECK (
    CASE state
      WHEN 'in_portfolio' THEN deposited_on IS NULL AND cleared_on IS NULL
                           AND rejected_on IS NULL AND movement_id IS NULL
      WHEN 'deposited'    THEN deposited_on IS NOT NULL AND cleared_on IS NULL
                           AND rejected_on IS NULL AND movement_id IS NULL
      WHEN 'cleared'      THEN cleared_on IS NOT NULL AND movement_id IS NOT NULL
                           AND account_id IS NOT NULL
      WHEN 'rejected'     THEN rejected_on IS NOT NULL AND rejection_reason IS NOT NULL
                           AND movement_id IS NULL
      WHEN 'endorsed'     THEN movement_id IS NULL
      WHEN 'cancelled'    THEN movement_id IS NULL
    END
  ),
  -- `cleared` es el único estado que implica fondos, así que es el único que
  -- exige cuenta y movimiento. Los demás los llevan opcionales (un cheque en
  -- cartera puede tener ya la cuenta donde se va a depositar).

  -- Un cheque rechazado ya no está depósito: la fecha se limpia para que un
  -- re-depósito no arrastre la fecha vieja. La coherencia la cubre el CHECK de
  -- arriba, que prohíbe `deposited_on` en `rejected`.
  CONSTRAINT tchk_rejected_reason CHECK (
    rejection_reason IS NULL OR state = 'rejected'
  )
);

CREATE INDEX IF NOT EXISTS idx_tchk_tenant_state ON treasury.checks(tenant_id, state, due_date);
CREATE INDEX IF NOT EXISTS idx_tchk_tenant_cust  ON treasury.checks(tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tchk_account      ON treasury.checks(tenant_id, account_id)
  WHERE account_id IS NOT NULL;
-- Un mismo número de cheque del mismo librador no puede entrar dos veces: es el
-- error de carga más común y el más caro, porque duplica un activo que no existe.
CREATE UNIQUE INDEX IF NOT EXISTS tchk_number_unique
  ON treasury.checks(tenant_id, drawer_name, check_number);

CREATE TRIGGER trg_tchk_touch BEFORE UPDATE ON treasury.checks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE treasury.checks IS
  'Cheques recibidos, con ciclo de vida propio. Sólo un cheque acreditado genera movimiento de fondos.';
COMMENT ON COLUMN treasury.checks.movement_id IS
  'Movimiento de fondos emitido por la acreditación. NULL en todos los demás estados: es la prueba de que el cheque no toca el saldo antes de acreditarse.';

-- =============================================================================
-- 4 · Cuentas de fondos: movimientos
-- =============================================================================
-- El libro de tesorería. Todo lo que cambia el saldo de una cuenta pasa por acá,
-- sin excepción — incluido el saldo inicial, que es un movimiento de tipo
-- `opening`.
--
-- POR QUÉ `direction` Y NO UN MONTO CON SIGNO
--
-- Un monto con signo implícito (`-1500.00`) se suma bien mientras todo el mundo
-- recuerde que el signo está adentro. El día que alguien hace `abs()` para
-- mostrarlo en un listado, o suma cantidades en vez de montos, el descuadre
-- aparece sin ruido. `direction` es explícito, se puede agrupar por él para
-- obtener entradas y salidas por separado —que es lo que pide cualquier extracto—
-- y el CHECK de abajo obliga a que el monto sea siempre positivo, así que el signo
-- no puede perderse ni duplicarse.
DO $$
BEGIN
  CREATE TYPE treasury.movement_direction AS ENUM ('credit', 'debit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- El tipo de hecho que originó el movimiento. Es lo que permite responder "¿de
-- dónde salió este dinero?" sin recorrer cinco tablas. `opening` existe para el
-- saldo inicial; `check_cleared` para la acreditación de un cheque;
-- `check_rejected` para la reversión de un cheque que se había acreditado.
DO $$
BEGIN
  CREATE TYPE treasury.movement_kind AS ENUM (
    'opening',          -- saldo inicial de la cuenta
    'customer_payment', -- cobranza en efectivo o transferencia
    'check_cleared',    -- acreditación de un cheque
    'check_rejected',   -- reversión por rechazo de un cheque ya acreditado
    'supplier_payment', -- pago a proveedor
    'transfer_in',      -- transferencia entre cuentas propias: entra
    'transfer_out',     -- transferencia entre cuentas propias: sale
    'bank_fee',         -- comisión o gasto bancario
    'deposit',          -- depósito de efectivo en banco
    'withdrawal',       -- extracción de efectivo
    'adjustment',       -- ajuste de arqueo o conciliación
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS treasury.movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL,

  kind           treasury.movement_kind NOT NULL,
  direction      treasury.movement_direction NOT NULL,

  -- SIEMPRE positivo. El signo vive en `direction`. Ver el encabezado.
  amount         numeric(14,2) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'ARS',

  happened_on    date NOT NULL DEFAULT CURRENT_DATE,

  -- Origen del hecho. Polimórfico a propósito: el movimiento es el mismo para
  -- todas las fuentes y no tiene por qué conocer la forma de cada una.
  source_type    text,
  source_id      uuid,

  -- Contramovimiento: un movimiento que existe para anular a otro. Es la forma de
  -- corregir sin editar, dado que el UPDATE está prohibido (sección 5).
  reverses_id    uuid,

  description    text,
  created_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tmov_id_tenant  UNIQUE (tenant_id, id),
  CONSTRAINT tmov_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES treasury.accounts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tmov_reverses_fk FOREIGN KEY (tenant_id, reverses_id)
    REFERENCES treasury.movements(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT tmov_amount_pos CHECK (amount > 0),
  CONSTRAINT tmov_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  -- Un movimiento no puede anularse a sí mismo.
  CONSTRAINT tmov_no_self_reverse CHECK (reverses_id IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS idx_tmov_account_date ON treasury.movements(tenant_id, account_id, happened_on, created_at);
CREATE INDEX IF NOT EXISTS idx_tmov_source       ON treasury.movements(tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

COMMENT ON TABLE treasury.movements IS
  'Libro de tesorería. Todo cambio de saldo pasa por acá, incluido el saldo inicial. Inmutable: se corrige con un contramovimiento.';
COMMENT ON COLUMN treasury.movements.direction IS
  'credit = entra dinero a la cuenta, debit = sale. El monto es siempre positivo; el signo está acá y sólo acá.';

-- -----------------------------------------------------------------------------
-- 4b · El movimiento es inmutable
-- -----------------------------------------------------------------------------
-- Un libro que se puede editar no es un libro. El UPDATE se rechaza con una
-- excepción que dice QUÉ hacer en su lugar: un mensaje que sólo dice "no se
-- puede" obliga a adivinar, y lo que se hace cuando no se sabe es tocar la base
-- a mano.
CREATE OR REPLACE FUNCTION treasury.trg_movements_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Un movimiento de tesorería no se modifica (id %). Para corregirlo, '
    'registrá un contramovimiento que lo anule: treasury.reverse_movement(%).',
    OLD.id, OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER IF EXISTS trg_movements_immutable ON treasury.movements;
CREATE TRIGGER trg_movements_immutable
  BEFORE UPDATE ON treasury.movements
  FOR EACH ROW EXECUTE FUNCTION treasury.trg_movements_immutable();

-- El DELETE sí se permite y es deliberado: la limpieza de un escenario de prueba
-- y la purga por retención de una empresa dada de baja son operaciones legítimas,
-- y ninguna de las dos es una edición del pasado. Lo que no se puede es cambiar
-- lo que decía.

-- -----------------------------------------------------------------------------
-- 4c · El saldo inicial se materializa como movimiento
-- -----------------------------------------------------------------------------
-- DECISIÓN: `opening_balance` es la única forma en que un saldo entra al sistema
-- sin un movimiento de origen. Si se dejara como columna y las consultas sumaran
-- `opening_balance + sum(movements)`, cada consulta tendría un caso especial y el
-- gate "el saldo cuadra con los movimientos" tendría una excepción —que es
-- exactamente el agujero por el que se escapa un descuadre. Materializándolo como
-- movimiento, el gate es una igualdad simple sin excepciones.
CREATE OR REPLACE FUNCTION treasury.trg_seed_opening_movement()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Sólo si el saldo inicial es distinto de cero. Un movimiento de $0,00 en cada
  -- cuenta recién creada ensucia el libro y hace que "cuántos movimientos tiene
  -- esta cuenta" deje de ser una pregunta útil.
  IF NEW.opening_balance IS NOT NULL AND NEW.opening_balance <> 0 THEN
    INSERT INTO treasury.movements (
      tenant_id, account_id, kind, direction, amount, currency,
      happened_on, source_type, description
    ) VALUES (
      NEW.tenant_id,
      NEW.id,
      'opening',
      -- Un saldo inicial negativo es un descubierto: sale dinero de la cuenta.
      --
      -- El CAST es obligatorio y no cosmético: en un `INSERT ... VALUES`,
      -- PostgreSQL resuelve cada literal por su tipo propio y **no** coacciona una
      -- expresión `CASE` al tipo de la columna destino. Sin el CAST, los dos
      -- literales son `text` y el INSERT falla con "la columna «direction» es de
      -- tipo treasury.movement_direction pero la expresión es de tipo text". En un
      -- `INSERT ... SELECT` la resolución es distinta y sí coacciona, así que el
      -- mismo CASE funcionaría ahí y no acá —que es la clase de detalle que hace
      -- que este archivo no se pueda validar sólo leyéndolo.
      CASE WHEN NEW.opening_balance >= 0 THEN 'credit'::treasury.movement_direction
           ELSE 'debit'::treasury.movement_direction END,
      abs(NEW.opening_balance),
      NEW.currency,
      NEW.opened_on,
      'opening',
      'Saldo inicial de la cuenta ' || NEW.code
    );
  END IF;
  RETURN NEW;
END $$;

-- AFTER y no BEFORE: el movimiento referencia `NEW.id` por FK compuesta
-- `(tenant_id, account_id)`, así que la cuenta tiene que existir ya. Con un
-- trigger BEFORE la FK fallaría.
DROP TRIGGER IF EXISTS trg_tac_seed_opening ON treasury.accounts;
CREATE TRIGGER trg_tac_seed_opening
  AFTER INSERT ON treasury.accounts
  FOR EACH ROW EXECUTE FUNCTION treasury.trg_seed_opening_movement();

-- =============================================================================
-- 5 · El saldo derivado, y el gate de la fase
-- =============================================================================
-- CÓMO SE REDONDEA EN SQL
--
-- `apps/api` tiene un helper `money()` (en `wsfe.client.ts`) que corrige el épsilon
-- de la aritmética de punto flotante antes de comparar o emitir. Ese helper NO
-- existe del lado de la base: el SQL del proyecto redondea con el CAST a
-- `numeric(N,2)`, que aplica la escala de forma determinística.
--
-- Un `numeric` en PostgreSQL es decimal exacto, no flotante, así que la
-- comparación de saldos no tiene el problema de épsilon que sí tiene el doble
-- binario: `0.1 + 0.2 <> 0.3` es falso para `numeric` y verdadero para `float8`.
-- Aun así se normaliza cada lado con el CAST antes de comparar, porque una suma de
-- `numeric` puede quedar con más de dos decimales si algún operando los tiene, y
-- comparar un derivado de escala 2 contra un valor de escala 4 fallaría por un
-- residuo que no es un descuadre real.
--
-- ÉSTA ES LA FUNCIÓN QUE MIDE EL GATE "Saldo de tesorería cuadra con movimientos".
--
-- Devuelve el saldo derivado de los movimientos, en la dirección correcta. Es la
-- ÚNICA definición del saldo: la vista de abajo y cualquier consumidor la usan,
-- así que no puede haber dos aritméticas que discrepen.
CREATE OR REPLACE FUNCTION treasury.round_money(p_value numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT round(COALESCE(p_value, 0), 2);
$$;

COMMENT ON FUNCTION treasury.round_money IS
  'Normaliza un importe a dos decimales para compararlo. Equivalente SQL del helper money() de la API: evita que un residuo de escala se lea como un descuadre.';

CREATE OR REPLACE FUNCTION treasury.account_balance(
  p_tenant_id  uuid,
  p_account_id uuid
) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    SUM(
      CASE m.direction
        WHEN 'credit' THEN m.amount
        WHEN 'debit'  THEN -m.amount
      END
    ),
    0
  )::numeric(14,2)
  FROM treasury.movements m
  WHERE m.tenant_id = p_tenant_id
    AND m.account_id = p_account_id;
$$;

COMMENT ON FUNCTION treasury.account_balance IS
  'Saldo derivado de una cuenta de fondos: suma los cargos y resta los descargos. Es la definición única del saldo; no existe columna que pueda discrepar.';

-- Verificación del gate. No es un aviso: si un saldo materializado apareciera, o
-- si una cuenta no cuadrara con sus movimientos, esto levanta una excepción.
--
-- Se implementa como consulta y no como trigger porque el desbalance no es un
-- evento —es un ESTADO— y un trigger sólo mira la fila que se está escribiendo.
-- Un cheque acreditado en una cuenta y el movimiento faltante en otra serían
-- invisibles para un trigger de fila.
CREATE OR REPLACE FUNCTION treasury.assert_balances_reconcile(p_tenant_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_desc  text;
  v_count integer := 0;
BEGIN
  -- a) No puede existir una columna `balance` en treasury.accounts. Si alguien la
  --    agrega más adelante "para no recalcular", esta aserción lo detecta: es la
  --    forma en que el saldo materializado vuelve al sistema después de haber
  --    sido diseñado afuera.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'treasury.accounts'::regclass
      AND a.attname IN ('balance', 'current_balance', 'saldo')
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION
      'treasury.accounts tiene una columna de saldo materializado. El saldo se '
      'deriva de los movimientos (treasury.account_balance); una columna acumulada '
      'puede discrepar de ellos y el descuadre es indetectable.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- b) El movimiento de apertura de cada cuenta tiene que coincidir con el saldo
  --    inicial declarado.
  --
  --    ESTA COMPARACIÓN ES LA CORRECTA, Y AL PRINCIPIO ESTABA MAL.
  --
  --    El primer intento comparaba `accounts.opening_balance` contra la SUMA DE
  --    TODOS los movimientos. Eso es incorrecto y lo destapó la prueba: en una
  --    cuenta con saldo inicial 0 que después recibe una acreditación de 50.000, el
  --    saldo derivado es 50.000 y el declarado 0 —y la aserción fallaba sobre datos
  --    perfectamente válidos. `opening_balance` es el PUNTO DE PARTIDA de la serie,
  --    no el resultado: sólo coincide con la suma total mientras no haya ningún
  --    otro movimiento. Una invariante que se rompe cuando el sistema funciona no
  --    es una invariante; es un defecto, y habría hecho fallar CI en el primer cobro
  --    real de cualquier empresa.
  --
  --    Lo que sí tiene que cumplirse siempre es que el movimiento de tipo
  --    `opening` —el que materializa el punto de partida— sea igual al saldo inicial
  --    declarado. Si alguien edita uno y no el otro, o si el trigger de siembra no
  --    corrió, acá se ve.
  --
  --    El conteo y la lista salen de UN SOLO `SELECT`, y no de dos consultas
  --    parecidas: repetir el predicado en el filtro y en el mensaje es pedir que las
  --    dos versiones se desincronicen, y la que quede distinta reporta un conteo que
  --    no coincide con la lista que muestra —que es peor que no reportar nada.
  --
  --    No se usa `CREATE TEMP TABLE`: la función es `STABLE` —una promesa de que no
  --    escribe— y crear una tabla temporal la viola. Además de que PostgreSQL lo
  --    rechazaría en una función `STABLE`, una aserción que escribe no se puede
  --    correr en una transacción de sólo lectura, que es donde más se la necesita.
  WITH aperturas AS (
    SELECT
      a.code,
      a.id                    AS account_id,
      a.opening_balance       AS declarado,
      COALESCE(o.monto, 0)    AS en_movimientos,
      o.cuenta_movs           AS cuantos
    FROM treasury.accounts a
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE m.direction WHEN 'credit' THEN m.amount ELSE -m.amount END)::numeric
          AS monto,
        count(*)::integer AS cuenta_movs
      FROM treasury.movements m
      WHERE m.tenant_id = a.tenant_id AND m.account_id = a.id
        AND m.kind = 'opening'
    ) o ON true
    WHERE (p_tenant_id IS NULL OR a.tenant_id = p_tenant_id)
      AND (
        -- El monto del movimiento de apertura tiene que ser el declarado.
        treasury.round_money(COALESCE(o.monto, 0)) <> treasury.round_money(a.opening_balance)
        -- Y no puede haber más de un movimiento de apertura: dos puntos de partida
        -- duplican el saldo inicial sin que ninguna otra cuenta lo note.
        OR COALESCE(o.cuenta_movs, 0) > 1
      )
  )
  SELECT
    count(*)::integer,
    string_agg(format('%s (%s): saldo inicial declarado %s, movimiento de apertura %s (%s movimiento(s))',
                      d.code, d.account_id, d.declarado, d.en_movimientos, d.cuantos), E'\n  - ')
  INTO v_count, v_desc
  FROM aperturas d;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      E'El saldo inicial de tesorería no cuadra con su movimiento de apertura (% cuenta(s)):\n  - %',
      v_count, v_desc
      USING ERRCODE = 'check_violation';
  END IF;

  -- b2) Y la definición de saldo tiene que ser UNA. Si `account_balance()` y la
  --     suma corrida del extracto divergieran, dos pantallas mostrarían dos
  --     números distintos para la misma cuenta y ninguna sería "la correcta". Se
  --     verifica contra la vista, que es lo que ve el consumidor.
  WITH divergentes AS (
    SELECT v.code, v.account_id, v.balance AS desde_funcion, s.total AS desde_extracto
    FROM treasury.v_account_balances v
    LEFT JOIN LATERAL (
      SELECT SUM(CASE m.direction WHEN 'credit' THEN m.amount ELSE -m.amount END)::numeric
               AS total
      FROM treasury.movements m
      WHERE m.tenant_id = v.tenant_id AND m.account_id = v.account_id
    ) s ON true
    WHERE (p_tenant_id IS NULL OR v.tenant_id = p_tenant_id)
      AND treasury.round_money(v.balance) <> treasury.round_money(COALESCE(s.total, 0))
  )
  SELECT
    count(*)::integer,
    string_agg(format('%s (%s): función %s, extracto %s',
                      d.code, d.account_id, d.desde_funcion, d.desde_extracto), E'\n  - ')
  INTO v_count, v_desc
  FROM divergentes d;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      E'El saldo de tesorería no cuadra con la suma de sus movimientos (% cuenta(s)):\n  - %',
      v_count, v_desc
      USING ERRCODE = 'check_violation';
  END IF;

  -- c) Un cheque acreditado sin movimiento de fondos es la contradicción que este
  --    gate existe para atrapar: dice que el dinero está disponible y no hay
  --    ningún movimiento que lo respalde.
  SELECT count(*) INTO v_count
  FROM treasury.checks c
  WHERE (p_tenant_id IS NULL OR c.tenant_id = p_tenant_id)
    AND c.state = 'cleared'
    AND (c.movement_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM treasury.movements m
      WHERE m.tenant_id = c.tenant_id AND m.id = c.movement_id
    ));

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Hay % cheque(s) acreditado(s) sin movimiento de fondos. Un cheque acreditado '
      'afirma que el dinero está disponible: si no hay movimiento, el saldo miente.',
      v_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMENT ON FUNCTION treasury.assert_balances_reconcile IS
  'Gate de E4. Verifica que no exista una columna de saldo materializado, que el movimiento de apertura coincida con el saldo inicial declarado, que el saldo derivado coincida con la suma de los movimientos, y que ningún cheque acreditado esté sin movimiento de fondos.';

-- =============================================================================
-- 6 · Motor de la máquina de estados del cheque
-- =============================================================================
-- `transition_check` es el ÚNICO camino para mover un cheque de estado. Valida la
-- arista contra `treasury.check_state_transitions` y ejecuta los efectos
-- contables/patrimoniales que el nuevo estado implica.
--
-- El efecto que importa es el de `cleared`: emite el movimiento de fondos. Y el de
-- `rejected` cuando el cheque YA estaba acreditado: emite el contramovimiento, que
-- es la "reversión del movimiento de fondos" de T-4. Un cheque rechazado desde
-- `deposited` no revierte nada porque todavía no había movido nada —revertir un
-- movimiento inexistente inventaría dinero.
CREATE OR REPLACE FUNCTION treasury.transition_check(
  p_tenant_id  uuid,
  p_check_id   uuid,
  p_to_state   treasury.check_state,
  p_on_date    date DEFAULT CURRENT_DATE,
  p_account_id uuid DEFAULT NULL,
  p_reason     text DEFAULT NULL
) RETURNS treasury.checks
LANGUAGE plpgsql AS $$
DECLARE
  v_check     treasury.checks;
  v_permitida boolean;
  v_movement  uuid;
  v_reversal  uuid;
BEGIN
  -- El `FOR UPDATE` serializa dos intentos de transición sobre el mismo cheque.
  -- Sin él, dos sesiones podrían leer `in_portfolio` a la vez y depositar dos
  -- veces: el segundo UPDATE pisaría al primero sin error, porque ambos escriben
  -- el mismo valor de estado.
  SELECT * INTO v_check FROM treasury.checks
  WHERE tenant_id = p_tenant_id AND id = p_check_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cheque % no existe en esta empresa.', p_check_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_check.state = p_to_state THEN
    RAISE EXCEPTION
      'El cheque % ya está en estado «%». No hay transición que hacer.',
      v_check.check_number, p_to_state
      USING ERRCODE = 'check_violation';
  END IF;

  -- LA MÁQUINA DE ESTADOS ES LOS DATOS, NO ESTE CÓDIGO. La consulta a la tabla
  -- es el único lugar donde se decide qué transición es válida: agregar una
  -- arista es un INSERT y no un cambio de función.
  SELECT EXISTS (
    SELECT 1 FROM treasury.check_state_transitions t
    WHERE t.from_state = v_check.state AND t.to_state = p_to_state
  ) INTO v_permitida;

  IF NOT v_permitida THEN
    RAISE EXCEPTION
      'No se puede pasar un cheque de «%» a «%» (cheque %). Las transiciones '
      'válidas desde «%» son: %.',
      v_check.state, p_to_state, v_check.check_number, v_check.state,
      COALESCE((SELECT string_agg(t.to_state::text, ', ' ORDER BY t.to_state::text)
                FROM treasury.check_state_transitions t
                WHERE t.from_state = v_check.state), '(ninguna)')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------------------------------------------------------- deposited
  IF p_to_state = 'deposited' THEN
    -- Un cheque diferido no se puede depositar antes de su fecha: el banco lo
    -- rechaza, y anotarlo como depositado antes de tiempo deja un activo con una
    -- fecha que no ocurrió.
    IF p_on_date < v_check.due_date THEN
      RAISE EXCEPTION
        'El cheque % vence el % y no se puede depositar el %.',
        v_check.check_number, v_check.due_date, p_on_date
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE treasury.checks
    SET state        = 'deposited',
        deposited_on = p_on_date,
        account_id   = COALESCE(p_account_id, account_id),
        -- Si venía de un rechazo, se limpia el motivo: la fila tiene que
        -- describir el estado en el que está, no el historial por el que pasó.
        rejection_reason = NULL,
        rejected_on      = NULL
    WHERE tenant_id = p_tenant_id AND id = p_check_id
    RETURNING * INTO v_check;

  -- ------------------------------------------------------------------ cleared
  ELSIF p_to_state = 'cleared' THEN
    IF COALESCE(p_account_id, v_check.account_id) IS NULL THEN
      RAISE EXCEPTION
        'Para acreditar el cheque % hay que indicar en qué cuenta de tesorería entró.',
        v_check.check_number
        USING ERRCODE = 'check_violation';
    END IF;

    -- ACÁ NACE EL DINERO. Y sólo acá. Un cheque en cartera o depositado no toca
    -- el saldo; el estado `cleared` es el único que emite un movimiento.
    INSERT INTO treasury.movements (
      tenant_id, account_id, kind, direction, amount, currency,
      happened_on, source_type, source_id, description
    ) VALUES (
      p_tenant_id,
      COALESCE(p_account_id, v_check.account_id),
      'check_cleared'::treasury.movement_kind,
      'credit'::treasury.movement_direction,
      v_check.amount,
      v_check.currency,
      p_on_date,
      'check',
      v_check.id,
      'Acreditación del cheque ' || v_check.check_number || ' de ' || v_check.drawer_name
    )
    RETURNING id INTO v_movement;

    UPDATE treasury.checks
    SET state       = 'cleared',
        cleared_on  = p_on_date,
        account_id  = COALESCE(p_account_id, v_check.account_id),
        movement_id = v_movement
    WHERE tenant_id = p_tenant_id AND id = p_check_id
    RETURNING * INTO v_check;

  -- ----------------------------------------------------------------- rejected
  ELSIF p_to_state = 'rejected' THEN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION
        'Hay que indicar el motivo del rechazo del cheque %.',
        v_check.check_number
        USING ERRCODE = 'check_violation';
    END IF;

    -- T-4. Si el cheque YA estaba acreditado, el movimiento de fondos existe y
    -- hay que revertirlo: el dinero que se había dado por disponible no está. Se
    -- emite un CONTRAMOVIMIENTO en la misma cuenta y por el mismo monto, con
    -- `reverses_id` apuntando al original. No se edita el movimiento original
    -- —es inmutable— ni se lo borra: el extracto tiene que mostrar las dos
    -- operaciones, porque las dos ocurrieron.
    IF v_check.movement_id IS NOT NULL THEN
      INSERT INTO treasury.movements (
        tenant_id, account_id, kind, direction, amount, currency,
        happened_on, source_type, source_id, reverses_id, description
      ) VALUES (
        p_tenant_id,
        v_check.account_id,
        'check_rejected'::treasury.movement_kind,
        'debit'::treasury.movement_direction,
        v_check.amount,
        v_check.currency,
        p_on_date,
        'check',
        v_check.id,
        v_check.movement_id,
        'Reversión por rechazo del cheque ' || v_check.check_number || ': ' || p_reason
      )
      RETURNING id INTO v_reversal;
    END IF;

    UPDATE treasury.checks
    SET state            = 'rejected',
        rejected_on      = p_on_date,
        rejection_reason = p_reason,
        cleared_on       = NULL,
        -- `deposited_on` se limpia: el CHECK prohíbe la fecha en estado
        -- rechazado, y además un re-depósito tiene que registrar su propia
        -- fecha y no arrastrar la del intento fallido.
        deposited_on     = NULL,
        -- `movement_id` se limpia: apuntaría al movimiento ya revertido, y un
        -- cheque rechazado sin movimiento es exactamente lo que afirma el CHECK
        -- de coherencia. La trazabilidad la conserva el contramovimiento, que
        -- guarda `reverses_id` y `source_id`.
        movement_id      = NULL
    WHERE tenant_id = p_tenant_id AND id = p_check_id
    RETURNING * INTO v_check;

  -- ------------------------------------------------------------ endorsed / cancelled
  ELSIF p_to_state IN ('endorsed', 'cancelled') THEN
    -- Endosar un cheque que ya acreditó es vender un dinero que la empresa ya
    -- cobró. El estado `cleared` no tiene arista hacia acá, así que la máquina ya
    -- lo impide; este chequeo explícito existe porque el error es caro y merece un
    -- mensaje que explique por qué, en vez del genérico "transición no válida".
    IF v_check.movement_id IS NOT NULL THEN
      RAISE EXCEPTION
        'El cheque % ya está acreditado y su dinero está en la cuenta. Para sacarlo '
        'de la cuenta, registrá el movimiento de salida que corresponda.',
        v_check.check_number
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE treasury.checks
    SET state = p_to_state
    WHERE tenant_id = p_tenant_id AND id = p_check_id
    RETURNING * INTO v_check;
  END IF;

  RETURN v_check;
END $$;

COMMENT ON FUNCTION treasury.transition_check IS
  'Único camino para cambiar el estado de un cheque. Valida la arista contra treasury.check_state_transitions y emite (o revierte) el movimiento de fondos.';

-- =============================================================================
-- 7 · Registro de movimientos de caja y banco
-- =============================================================================
-- Los movimientos que NO nacen de un cheque: cobranza en efectivo o
-- transferencia, pago a proveedor, transferencia entre cuentas propias, comisión
-- bancaria, depósito, extracción.
--
-- POR QUÉ NO HAY UNA FUNCIÓN POR TIPO
--
-- Sería tentador escribir `record_transfer()`, `record_fee()`, y así. Pero cada
-- una repetiría la misma validación —rol, cuenta activa, monto positivo— y la
-- que se olvide una queda como puerta abierta. Una función con el `kind` como
-- parámetro valida una sola vez, y el CHECK del enum acota los valores posibles.
CREATE OR REPLACE FUNCTION treasury.record_movement(
  p_tenant_id   uuid,
  p_account_id  uuid,
  p_kind        treasury.movement_kind,
  p_direction   treasury.movement_direction,
  p_amount      numeric,
  p_happened_on date DEFAULT CURRENT_DATE,
  p_description text DEFAULT NULL,
  p_source_type text DEFAULT NULL,
  p_source_id   uuid DEFAULT NULL,
  p_created_by  uuid DEFAULT NULL
) RETURNS treasury.movements
LANGUAGE plpgsql AS $$
DECLARE
  v_account  treasury.accounts;
  v_movement treasury.movements;
BEGIN
  SELECT * INTO v_account FROM treasury.accounts
  WHERE tenant_id = p_tenant_id AND id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuenta de tesorería % no existe en esta empresa.', p_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT v_account.is_active THEN
    RAISE EXCEPTION
      'La cuenta «%» está inactiva: no admite movimientos. Reactivala si hay que operar con ella.',
      v_account.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION
      'El monto de un movimiento tiene que ser positivo (recibido: %). El signo lo '
      'determina la dirección (credit/debit), no el monto.',
      p_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- El saldo inicial tiene su propio camino (el trigger de alta de la cuenta). Un
  -- segundo `opening` sobre la misma cuenta duplicaría el punto de partida y el
  -- descuadre aparecería lejos, en un reporte de saldos.
  IF p_kind = 'opening' AND EXISTS (
    SELECT 1 FROM treasury.movements m
    WHERE m.tenant_id = p_tenant_id AND m.account_id = p_account_id
      AND m.kind = 'opening'
  ) THEN
    RAISE EXCEPTION
      'La cuenta % ya tiene un saldo inicial registrado. Para corregirlo, registrá '
      'un contramovimiento: un segundo saldo inicial duplicaría el punto de partida.',
      v_account.code
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO treasury.movements (
    tenant_id, account_id, kind, direction, amount,
    currency, happened_on, description, source_type, source_id, created_by
  ) VALUES (
    p_tenant_id, p_account_id, p_kind, p_direction, p_amount,
    v_account.currency, p_happened_on, p_description, p_source_type, p_source_id, p_created_by
  )
  RETURNING * INTO v_movement;

  RETURN v_movement;
END $$;

COMMENT ON FUNCTION treasury.record_movement IS
  'Registra un movimiento de fondos que no nace de un cheque. Valida cuenta activa y monto positivo.';

-- -----------------------------------------------------------------------------
-- 7b · Reversión de un movimiento
-- -----------------------------------------------------------------------------
-- La corrección de un movimiento. NO edita el original: agrega el opuesto, con
-- `reverses_id` apuntando a él. Es cómo funciona un extracto bancario real, y es
-- la única forma de corregir que deja rastro.
CREATE OR REPLACE FUNCTION treasury.reverse_movement(
  p_tenant_id  uuid,
  p_movement_id uuid,
  p_on_date    date DEFAULT CURRENT_DATE,
  p_reason     text DEFAULT NULL
) RETURNS treasury.movements
LANGUAGE plpgsql AS $$
DECLARE
  v_orig     treasury.movements;
  v_reversal treasury.movements;
  v_ya       integer;
BEGIN
  SELECT * INTO v_orig FROM treasury.movements
  WHERE tenant_id = p_tenant_id AND id = p_movement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El movimiento % no existe en esta empresa.', p_movement_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Revertir dos veces el mismo movimiento no lo anula dos veces: lo deja con
  -- saldo opuesto y el error es invisible. Un movimiento ya revertido se detecta
  -- y se rechaza.
  SELECT count(*) INTO v_ya
  FROM treasury.movements m
  WHERE m.tenant_id = p_tenant_id AND m.reverses_id = p_movement_id;

  IF v_ya > 0 THEN
    RAISE EXCEPTION
      'El movimiento % ya fue revertido (% contramovimiento(s)). Revertirlo de nuevo '
      'invertiría el saldo por segunda vez.',
      p_movement_id, v_ya
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Las columnas se listan y los valores van en ese mismo orden. Se listan
  -- explícitamente —y no se confía en el orden físico de la tabla— porque acá hay
  -- dos columnas del mismo tipo (`direction` es enum, `amount` es numeric) y un
  -- desorden entre ellas no daría error de tipo: guardaría el monto en la
  -- dirección y viceversa. Es el tipo de defecto que sólo se ve en los números.
  INSERT INTO treasury.movements (
    tenant_id, account_id, kind, direction, amount, currency,
    happened_on, source_type, source_id, reverses_id, description
  ) VALUES (
    p_tenant_id,
    v_orig.account_id,
    -- El contramovimiento es genérico: su `kind` describe el hecho —"esto es una
    -- reversión"— y no el negocio que la originó, que ya está en `source_type`.
    'adjustment'::treasury.movement_kind,
    -- La dirección OPUESTA: eso es lo que revierte.
    CASE WHEN v_orig.direction = 'credit' THEN 'debit'::treasury.movement_direction
         ELSE 'credit'::treasury.movement_direction END,
    v_orig.amount,
    v_orig.currency,
    p_on_date,
    v_orig.source_type,
    v_orig.source_id,
    v_orig.id,
    COALESCE(p_reason, 'Reversión del movimiento ' || v_orig.id::text)
  )
  RETURNING * INTO v_reversal;

  RETURN v_reversal;
END $$;

COMMENT ON FUNCTION treasury.reverse_movement IS
  'Revierte un movimiento con un contramovimiento de dirección opuesta. No edita el original.';

-- =============================================================================
-- 8 · Transferencia entre cuentas propias
-- =============================================================================
-- Una transferencia entre dos cuentas de la misma empresa mueve dinero sin
-- cambiar el patrimonio: dos movimientos, uno por cuenta, de direcciones
-- opuestas. Tiene que ser atómica y tienen que ser exactamente dos. Si el
-- llamador registrara los dos movimientos por separado, un error entre ambos
-- dejaría el dinero saliendo de una cuenta sin llegar a la otra —y el total de
-- tesorería no cuadraría con nada.
CREATE OR REPLACE FUNCTION treasury.transfer_between_accounts(
  p_tenant_id  uuid,
  p_from_id    uuid,
  p_to_id      uuid,
  p_amount     numeric,
  p_happened_on date DEFAULT CURRENT_DATE,
  p_description text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_from treasury.accounts;
  v_to   treasury.accounts;
  v_n    integer := 0;
BEGIN
  IF p_from_id = p_to_id THEN
    RAISE EXCEPTION 'El origen y el destino de una transferencia no pueden ser la misma cuenta.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Las dos cuentas se bloquean EN ORDEN DE id. Bloquear en el orden que llegaron
  -- los parámetros produce un interbloqueo cuando dos transferencias cruzadas
  -- entre las mismas dos cuentas corren a la vez: A→B bloquea A y espera B, B→A
  -- bloquea B y espera A. El orden fijo elimina la espera circular.
  PERFORM 1 FROM treasury.accounts
  WHERE tenant_id = p_tenant_id AND id IN (p_from_id, p_to_id)
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO v_from FROM treasury.accounts
  WHERE tenant_id = p_tenant_id AND id = p_from_id;
  SELECT * INTO v_to FROM treasury.accounts
  WHERE tenant_id = p_tenant_id AND id = p_to_id;

  IF v_from.id IS NULL OR v_to.id IS NULL THEN
    RAISE EXCEPTION 'Alguna de las dos cuentas no existe en esta empresa.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Las dos tienen que estar en la misma moneda. Un movimiento que cambia de
  -- moneda sin una cotización explícita es una pérdida o ganancia por diferencia
  -- de cambio disfrazada de transferencia, y el saldo por moneda dejaría de
  -- cerrar.
  IF v_from.currency <> v_to.currency THEN
    RAISE EXCEPTION
      'No se puede transferir de % (%) a % (%): monedas distintas. Registrá el '
      'cambio de moneda con su cotización, no como transferencia.',
      v_from.code, v_from.currency, v_to.code, v_to.currency
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM treasury.record_movement(
    p_tenant_id, p_from_id, 'transfer_out', 'debit', p_amount, p_happened_on,
    COALESCE(p_description, 'Transferencia a ' || v_to.code), 'transfer', NULL
  );
  v_n := v_n + 1;

  PERFORM treasury.record_movement(
    p_tenant_id, p_to_id, 'transfer_in', 'credit', p_amount, p_happened_on,
    COALESCE(p_description, 'Transferencia desde ' || v_from.code), 'transfer', NULL
  );
  v_n := v_n + 1;

  RETURN v_n;
END $$;

COMMENT ON FUNCTION treasury.transfer_between_accounts IS
  'Mueve fondos entre dos cuentas propias: dos movimientos opuestos, atómicos, mismo signo total cero.';

-- =============================================================================
-- 9 · Conciliación bancaria y arqueo
-- =============================================================================
-- T-6 pide que la conciliación cuadre el extracto contra los movimientos. Se
-- modela como un HECHO con identidad propia —una conciliación por cuenta y
-- período— y no como un booleano en cada movimiento, porque:
--
--   · Una conciliación tiene fecha, responsable y saldo de extracto. Un booleano
--     no puede guardar nada de eso.
--   · Se hace por período, no movimiento a movimiento.
--   · Puede quedar PARCIAL: hay movimientos no conciliados, y eso es información
--     (son los que hay que investigar) y no un estado inválido.
--
-- El `statement_balance` es el saldo que informa el banco. La diferencia entre
-- ese número y el saldo derivado de los movimientos es EXACTAMENTE lo que la
-- conciliación existe para explicar. Guardarla obliga a que la diferencia se
-- documente en vez de quedarse en la cabeza del que concilió.
DO $$
BEGIN
  CREATE TYPE treasury.reconciliation_status AS ENUM ('open', 'balanced', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS treasury.reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,

  period_start      date NOT NULL,
  period_end        date NOT NULL,

  -- Saldo que informa el extracto bancario. Puede ser NULL mientras la
  -- conciliación está abierta: al abrirla todavía no se tiene el extracto.
  statement_balance numeric(14,2),

  status            treasury.reconciliation_status NOT NULL DEFAULT 'open',

  -- Cierre: quién y cuándo. Se exige en `closed` por el CHECK de abajo.
  closed_at         timestamptz,
  closed_by         uuid REFERENCES app.users(id) ON DELETE SET NULL,

  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trec_id_tenant    UNIQUE (tenant_id, id),
  CONSTRAINT trec_account_fk   FOREIGN KEY (tenant_id, account_id)
    REFERENCES treasury.accounts(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT trec_period CHECK (period_end >= period_start),
  -- Una sola conciliación abierta por cuenta y período. Dos conciliaciones
  -- simultáneas del mismo período conciliarían los mismos movimientos dos veces.
  CONSTRAINT trec_period_uniq  UNIQUE (tenant_id, account_id, period_start, period_end),
  CONSTRAINT trec_closed_coherent CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  ),
  -- No se cierra una conciliación sin el saldo del extracto: el objetivo de
  -- cerrarla es dejar constancia de que la diferencia se explicó, y sin el número
  -- del banco no hay contra qué explicarla.
  CONSTRAINT trec_closed_has_balance CHECK (
    status <> 'closed' OR statement_balance IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_trec_account_period
  ON treasury.reconciliations(tenant_id, account_id, period_end DESC);

CREATE TRIGGER trg_trec_touch BEFORE UPDATE ON treasury.reconciliations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Las líneas: qué movimiento se concilió, contra qué referencia del extracto.
-- `statement_reference` es el texto del extracto ('TRF 0001234', 'DEP 88231'):
-- es lo que permite encontrar el movimiento cuando el banco lo reclama.
CREATE TABLE IF NOT EXISTS treasury.reconciliation_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  reconciliation_id   uuid NOT NULL,
  movement_id         uuid NOT NULL,

  statement_reference text,
  -- Monto conciliado. Puede ser MENOR que el del movimiento cuando el banco parte
  -- una operación en dos líneas del extracto —que es lo normal, no la excepción.
  amount              numeric(14,2) NOT NULL,

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trl_id_tenant  UNIQUE (tenant_id, id),
  CONSTRAINT trl_rec_fk     FOREIGN KEY (tenant_id, reconciliation_id)
    REFERENCES treasury.reconciliations(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT trl_mov_fk     FOREIGN KEY (tenant_id, movement_id)
    REFERENCES treasury.movements(tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT trl_amount_pos CHECK (amount > 0),
  -- Un movimiento se concilia UNA vez dentro de la misma conciliación. Conciliarlo
  -- dos veces duplicaría el monto conciliado y la conciliación cerraría con una
  -- diferencia que no existe.
  CONSTRAINT trl_unique_mov UNIQUE (tenant_id, reconciliation_id, movement_id)
);

CREATE INDEX IF NOT EXISTS idx_trl_rec      ON treasury.reconciliation_lines(tenant_id, reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_trl_movement ON treasury.reconciliation_lines(tenant_id, movement_id);

COMMENT ON TABLE treasury.reconciliations IS
  'Conciliación bancaria por cuenta y período: el saldo del extracto contra el saldo derivado de los movimientos.';
COMMENT ON TABLE treasury.reconciliation_lines IS
  'Qué movimiento se concilió contra qué referencia del extracto. Parcial por diseño: los no conciliados son los que hay que investigar.';

-- -----------------------------------------------------------------------------
-- 9b · Abrir y cerrar una conciliación
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION treasury.open_reconciliation(
  p_tenant_id    uuid,
  p_account_id   uuid,
  p_period_start date,
  p_period_end   date,
  p_statement_balance numeric DEFAULT NULL
) RETURNS treasury.reconciliations
LANGUAGE plpgsql AS $$
DECLARE
  v_rec treasury.reconciliations;
BEGIN
  INSERT INTO treasury.reconciliations (
    tenant_id, account_id, period_start, period_end, statement_balance
  ) VALUES (
    p_tenant_id, p_account_id, p_period_start, p_period_end, p_statement_balance
  )
  RETURNING * INTO v_rec;

  RETURN v_rec;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION
    'Ya hay una conciliación para esa cuenta y ese período (% a %). Cerrá o eliminá '
    'la existente antes de abrir otra: dos conciliaciones del mismo período '
    'conciliarían los mismos movimientos dos veces.',
    p_period_start, p_period_end
    USING ERRCODE = 'unique_violation';
END $$;

-- El cierre verifica que la diferencia quede EXPLICADA. La regla: el saldo del
-- extracto tiene que ser igual al saldo derivado de los movimientos MÁS el neto de
-- las partidas en tránsito (cheques depositados y no acreditados, y movimientos
-- registrados que el banco todavía no impactó).
--
-- Se acepta un desvío declarado en `notes` para el residuo no explicado, porque en
-- la práctica siempre queda algo —una comisión no informada, un centavo de
-- redondeo del banco— y exigir cero absoluto empuja a no cerrar nunca. Lo que NO
-- se acepta es cerrar sin decir cuál es la diferencia.
CREATE OR REPLACE FUNCTION treasury.close_reconciliation(
  p_tenant_id uuid,
  p_rec_id    uuid,
  p_closed_by uuid DEFAULT NULL,
  p_notes     text DEFAULT NULL
) RETURNS treasury.reconciliations
LANGUAGE plpgsql AS $$
DECLARE
  v_rec         treasury.reconciliations;
  v_derivado    numeric;
  v_en_transito numeric;
  v_diferencia  numeric;
BEGIN
  SELECT * INTO v_rec FROM treasury.reconciliations
  WHERE tenant_id = p_tenant_id AND id = p_rec_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La conciliación % no existe en esta empresa.', p_rec_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_rec.status = 'closed' THEN
    RAISE EXCEPTION 'La conciliación % ya está cerrada.', p_rec_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rec.statement_balance IS NULL THEN
    RAISE EXCEPTION
      'No se puede cerrar la conciliación % sin el saldo del extracto bancario: es '
      'el número contra el que se explica la diferencia.',
      p_rec_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Saldo derivado de los movimientos de la cuenta hasta el fin del período.
  SELECT COALESCE(SUM(CASE m.direction
                        WHEN 'credit' THEN m.amount
                        WHEN 'debit'  THEN -m.amount
                      END), 0)
  INTO v_derivado
  FROM treasury.movements m
  WHERE m.tenant_id = p_tenant_id
    AND m.account_id = v_rec.account_id
    AND m.happened_on <= v_rec.period_end;

  -- Partidas en tránsito: cheques depositados en esta cuenta que todavía no
  -- acreditaron. Están descontados del saldo del banco —el banco no los
  -- acreditó— y en cambio el sistema todavía no los registró como fondos. Son la
  -- causa número uno de una diferencia de conciliación.
  SELECT COALESCE(SUM(c.amount), 0)
  INTO v_en_transito
  FROM treasury.checks c
  WHERE c.tenant_id = p_tenant_id
    AND c.account_id = v_rec.account_id
    AND c.state = 'deposited';

  v_diferencia := treasury.round_money(v_rec.statement_balance - v_derivado - v_en_transito);

  -- Si queda diferencia, tiene que estar documentada. El mensaje nombra los tres
  -- números: sin ellos el usuario sabe que algo no cuadra y no sabe qué.
  IF v_diferencia <> 0 AND (p_notes IS NULL OR btrim(p_notes) = '') THEN
    RAISE EXCEPTION
      'La conciliación no cuadra y no se explicó la diferencia. Extracto % / '
      'movimientos % / en tránsito % ⇒ diferencia %. Documentala en las notas para '
      'poder cerrarla.',
      v_rec.statement_balance, v_derivado, v_en_transito, v_diferencia
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE treasury.reconciliations
  SET status   = 'closed',
      closed_at = now(),
      closed_by = p_closed_by,
      -- Las notas del cierre se AGREGAN a las existentes: la explicación previa de
      -- la apertura no se pierde.
      notes = CASE
                WHEN p_notes IS NULL OR btrim(p_notes) = '' THEN notes
                WHEN notes IS NULL OR btrim(notes) = ''      THEN p_notes
                ELSE notes || E'\n' || p_notes
              END
  WHERE tenant_id = p_tenant_id AND id = p_rec_id
  RETURNING * INTO v_rec;

  RETURN v_rec;
END $$;

COMMENT ON FUNCTION treasury.close_reconciliation IS
  'Cierra una conciliación bancaria exigiendo que la diferencia esté documentada en las notas.';

-- =============================================================================
-- 10 · Arqueo de caja
-- =============================================================================
-- Un arqueo no es una conciliación: no hay extracto. Un arqueo cuenta el efectivo
-- físico y lo compara con el saldo derivado. La diferencia es el faltante o
-- sobrante, y se registra como un movimiento de ajuste —porque el efectivo físico
-- es la realidad y el libro tiene que converger a ella, no al revés.
CREATE TABLE IF NOT EXISTS treasury.cash_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL,

  counted_on     date NOT NULL DEFAULT CURRENT_DATE,
  -- Lo que se contó físicamente.
  counted_amount numeric(14,2) NOT NULL,
  -- El saldo derivado al momento del arqueo. Se guarda como SNAPSHOT y no se
  -- recalcula: es lo que hace que el arqueo sea un documento histórico y no una
  -- consulta. Si después entra un movimiento retroactivo, el arqueo original
  -- sigue diciendo lo que decía el día que se hizo.
  expected_amount numeric(14,2) NOT NULL,
  -- counted - expected. Positivo = sobrante, negativo = faltante.
  difference     numeric(14,2) NOT NULL,

  -- El movimiento de ajuste que se emitió para que el libro converja al conteo.
  adjustment_movement_id uuid,

  counted_by     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tcc_id_tenant   UNIQUE (tenant_id, id),
  CONSTRAINT tcc_account_fk  FOREIGN KEY (tenant_id, account_id)
    REFERENCES treasury.accounts(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tcc_adjust_fk   FOREIGN KEY (tenant_id, adjustment_movement_id)
    REFERENCES treasury.movements(tenant_id, id) ON DELETE RESTRICT,
  -- La diferencia es una CONSECUENCIA de los dos montos, no un dato propio. Un
  -- CHECK que la ata a la resta impide que una fila se guarde con una diferencia
  -- que no es la que sus propios números implican.
  CONSTRAINT tcc_diff_derived CHECK (
    difference = treasury.round_money(counted_amount - expected_amount)
  )
);

CREATE INDEX IF NOT EXISTS idx_tcc_account_date
  ON treasury.cash_counts(tenant_id, account_id, counted_on DESC);

COMMENT ON TABLE treasury.cash_counts IS
  'Arqueo de caja: el conteo físico contra el saldo derivado. La diferencia se registra como movimiento de ajuste.';

-- =============================================================================
-- 11 · Vistas
-- =============================================================================
-- `security_invoker = true` en TODAS. Sin la opción, la vista corre con los
-- privilegios de su dueño —`postgres`, que tiene BYPASSRLS— y devuelve los datos
-- de todas las empresas sin ningún error. Es el modo de falla más silencioso del
-- sistema y el que la suite de invariantes verifica explícitamente.

-- Saldo por cuenta, derivado. La columna `balance` de esta vista es la ÚNICA
-- definición de "saldo" que ve un consumidor, y sale de la misma función que usa
-- el gate.
CREATE OR REPLACE VIEW treasury.v_account_balances WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.id                AS account_id,
  a.code,
  a.name,
  a.kind,
  a.currency,
  a.is_active,
  a.opening_balance,
  treasury.account_balance(a.tenant_id, a.id)                       AS balance,
  COUNT(m.id)                                                        AS movement_count,
  COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'credit'), 0)::numeric(14,2) AS total_in,
  COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'debit'),  0)::numeric(14,2) AS total_out,
  MAX(m.happened_on)                                                 AS last_movement_on
FROM treasury.accounts a
LEFT JOIN treasury.movements m
  ON m.tenant_id = a.tenant_id AND m.account_id = a.id
GROUP BY a.tenant_id, a.id, a.code, a.name, a.kind, a.currency, a.is_active, a.opening_balance;

COMMENT ON VIEW treasury.v_account_balances IS
  'Saldo derivado por cuenta de tesorería, con el total de entradas y salidas. La única definición de saldo.';

-- Saldo total de tesorería por empresa y moneda. Es la vista sobre la que un
-- reporte de posición de fondos se apoya, y por eso es derivada y no un acumulado.
CREATE OR REPLACE VIEW treasury.v_treasury_position WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.currency,
  COUNT(DISTINCT a.id)          AS account_count,
  SUM(treasury.account_balance(a.tenant_id, a.id))::numeric(14,2) AS total_balance
FROM treasury.accounts a
WHERE a.is_active
GROUP BY a.tenant_id, a.currency;

COMMENT ON VIEW treasury.v_treasury_position IS
  'Posición de fondos por empresa y moneda. Derivada de los movimientos, nunca de un acumulado.';

-- Cartera de cheques con su antigüedad. Los cheques en cartera y depositados son
-- activos que todavía no son dinero: esta vista es la que permite verlos por
-- separado del saldo.
CREATE OR REPLACE VIEW treasury.v_check_portfolio WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.id              AS check_id,
  c.check_number,
  c.drawer_name,
  c.customer_id,
  -- `trade_name` es el nombre de fantasía y `legal_name` la razón social. Se
  -- prefiere el primero con el segundo como respaldo: en una cartera de cheques la
  -- persona que lee el listado reconoce el nombre con el que le habla al cliente, no
  -- la razón social. `app.customers` no tiene una columna `display_name`; la
  -- preferencia se resuelve acá y no en una columna nueva, que sería un dato
  -- derivado más que mantener sincronizado.
  COALESCE(cust.trade_name, cust.legal_name) AS customer_name,
  c.amount,
  c.currency,
  c.due_date,
  c.received_on,
  c.deposited_on,
  c.state,
  c.account_id,
  a.code            AS account_code,
  c.rejection_reason,
  -- Días hasta el vencimiento. Negativo = vencido. Se calcula acá y no en el
  -- cliente para que todos los consumidores coincidan en qué es "vencido".
  (c.due_date - CURRENT_DATE) AS days_to_due,
  c.movement_id,
  c.invoice_id,
  c.payment_id
FROM treasury.checks c
LEFT JOIN treasury.accounts a
  ON a.tenant_id = c.tenant_id AND a.id = c.account_id
LEFT JOIN app.customers cust
  ON cust.tenant_id = c.tenant_id AND cust.id = c.customer_id;

COMMENT ON VIEW treasury.v_check_portfolio IS
  'Cartera de cheques con estado, antigüedad y cuenta destino. Los no acreditados NO son fondos disponibles.';

-- Extracto de cuenta: el libro de movimientos con su saldo acumulado corrido. Es
-- lo que se compara contra el extracto del banco en T-6.
CREATE OR REPLACE VIEW treasury.v_account_statement WITH (security_invoker = true) AS
SELECT
  m.tenant_id,
  m.account_id,
  m.id             AS movement_id,
  m.happened_on,
  m.created_at,
  m.kind,
  m.direction,
  CASE m.direction WHEN 'credit' THEN m.amount ELSE -m.amount END::numeric(14,2) AS signed_amount,
  m.amount,
  m.currency,
  m.description,
  m.source_type,
  m.source_id,
  m.reverses_id,
  -- Saldo acumulado hasta este movimiento inclusive. `ROWS BETWEEN UNBOUNDED
  -- PRECEDING AND CURRENT ROW` es obligatorio: sin la cláusula, la ventana por
  -- defecto es `RANGE`, que colapsa las filas con la misma fecha y orden distinto
  -- en una sola, y el acumulado salta.
  SUM(CASE m.direction WHEN 'credit' THEN m.amount ELSE -m.amount END)
    OVER (PARTITION BY m.tenant_id, m.account_id
          ORDER BY m.happened_on, m.created_at, m.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric(14,2) AS running_balance
FROM treasury.movements m;

COMMENT ON VIEW treasury.v_account_statement IS
  'Extracto de la cuenta: movimientos con el saldo acumulado corrido. Es lo que se concilia contra el extracto bancario.';

-- =============================================================================
-- 12 · Configuración contable de tesorería
-- =============================================================================
-- Igual que `0013`, `0014` y `0015`: mapeo declarativo, una fila por línea, y la
-- función falla si el plan de cuentas no tiene las cuentas que las reglas nombran.
--
-- POR QUÉ ACÁ SÍ HAY CUENTAS NUEVAS
--
-- La acreditación de un cheque no es un cobro: cuando el cheque entró, el cliente
-- ya pagó y se acreditó la cuenta a cobrar. Lo que pasa al acreditar es que un
-- valor en cartera se convierte en fondos disponibles, y eso necesita una cuenta
-- de ACTIVO propia —'1.1.1.03 Valores al cobro'— que `0012` no tiene. Sin ella, la
-- acreditación no tiene contrapartida y el asiento no cierra.
--
-- Se crea como cuenta de la EMPRESA (copiada) por `treasury.ensure_treasury_accounts`,
-- no en la plantilla de `0012`: la plantilla es del plan mínimo de plataforma y
-- modificarla desde acá cambiaría el plan de todas las empresas y de las que se
-- creen en el futuro, incluidos los que ya tenían asientos. Es un cambio de
-- alcance que no corresponde a esta migración.
CREATE OR REPLACE FUNCTION treasury.ensure_treasury_accounts(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_creadas integer := 0;
  v_padre   uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  -- El padre directo de '1.1.1.03' es '1.1.1' (Caja y bancos). Si la empresa
  -- recodificó su plan y no existe, se deja sin padre en vez de fallar: una cuenta
  -- huérfana es operable, y abortar por la jerarquía impediría configurar la
  -- tesorería por un detalle de presentación.
  SELECT id INTO v_padre FROM accounting.accounts
  WHERE tenant_id = p_tenant_id AND code = '1.1.1' LIMIT 1;

  INSERT INTO accounting.accounts
    (tenant_id, code, name, kind, parent_id, is_template, is_postable)
  VALUES
    -- Valores al cobro: cheques recibidos, depositados y no acreditados. Es el
    -- activo que representa "tengo un papel que vale esto, todavía no es dinero".
    (p_tenant_id, '1.1.1.03', 'Valores al cobro', 'asset', v_padre, false, true),
    -- Cheques rechazados: el activo que ya no se va a cobrar y queda pendiente de
    -- gestión de cobro. Separado de Valores al cobro para que la morosidad se vea.
    (p_tenant_id, '1.1.1.04', 'Cheques rechazados', 'asset', v_padre, false, true)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  GET DIAGNOSTICS v_creadas = ROW_COUNT;

  RETURN v_creadas;
END $$;

COMMENT ON FUNCTION treasury.ensure_treasury_accounts IS
  'Crea las cuentas del plan de la empresa que la tesorería necesita (valores al cobro, cheques rechazados) si faltan.';

CREATE OR REPLACE FUNCTION treasury.seed_tenant_treasury_config(p_tenant_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_cuentas integer := 0;
  v_extra   integer := 0;
  v_roles   integer := 0;
  v_reglas  integer := 0;
  v_faltan  text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  -- El plan se copia si la empresa todavía no tiene ninguno, igual que en `0014`.
  IF NOT EXISTS (SELECT 1 FROM accounting.accounts WHERE tenant_id = p_tenant_id) THEN
    v_cuentas := accounting.seed_tenant_chart_of_accounts(p_tenant_id);
  END IF;

  -- Las cuentas propias de tesorería, antes de resolver los roles que las
  -- referencian. El orden importa: al revés, el rol apuntaría a una cuenta que
  -- todavía no existe y el JOIN dejaría el rol sin insertar, en silencio.
  v_extra := treasury.ensure_treasury_accounts(p_tenant_id);

  -- Se resuelven por código y, si falta, se dice CUÁL.
  SELECT string_agg(m.code, ', ') INTO v_faltan
  FROM (VALUES ('1.1.1.01'), ('1.1.2.01'), ('1.1.1.03'), ('1.1.1.04'), ('6.3.1.05'), ('4.2.1.02')) AS m(code)
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting.accounts a
    WHERE a.tenant_id = p_tenant_id AND a.code = m.code
  );

  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION
      'La empresa % no tiene las cuentas que tesorería necesita: %. '
      'Ejecutá accounting.seed_tenant_chart_of_accounts() primero.',
      p_tenant_id, v_faltan
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Roles contables. `cash` y `bank` ya existen desde `0013`, pero se repiten acá
  -- a propósito: esta función tiene que poder garantizar por sí sola que TODOS los
  -- roles que sus reglas nombran existan. Un rol que una regla referencia y la
  -- tabla no resuelve no falla al configurar: falla al asentar, con el hecho ya
  -- creado y el usuario mirando otra pantalla.
  INSERT INTO accounting.account_roles (tenant_id, role, account_id)
  SELECT p_tenant_id, m.role, a.id
  FROM (VALUES
    ('cash',             '1.1.1.01'),   -- Caja
    ('bank',             '1.1.2.01'),   -- Banco cuenta corriente
    ('checks_in_hand',   '1.1.1.03'),   -- Valores al cobro
    ('checks_rejected',  '1.1.1.04'),   -- Cheques rechazados
    ('bank_fees',        '6.3.1.05'),   -- Gastos bancarios
    -- Contrapartida del ajuste de arqueo. La cuenta es de INGRESO aunque el
    -- ajuste pueda ser un faltante: el motor contable de `0013` prohíbe asentar
    -- importes negativos —"la reversión se hace con un contra-asiento, no con un
    -- signo"— y por lo tanto la dirección del asiento la determina
    -- `is_credit_line`, no el signo del monto. Un faltante se asienta como débito
    -- sobre esta misma cuenta, que es lo correcto: un sobrante de caja es un
    -- ingreso y un faltante es un gasto, y ambos se netean en la misma cuenta de
    -- resultados para que el arqueo no ensucie dos cuentas con el mismo hecho.
    ('cash_shortage_surplus', '4.2.1.02')
  ) AS m(role, code)
  JOIN accounting.accounts a
    ON a.tenant_id = p_tenant_id AND a.code = m.code
  ON CONFLICT (tenant_id, role) DO UPDATE
    SET account_id = EXCLUDED.account_id,
        updated_at = now();

  GET DIAGNOSTICS v_roles = ROW_COUNT;

  -- Reglas de mapeo. Una fila por línea; agregar una línea es un INSERT y no una
  -- lectura-modificación-escritura, que es donde dos configuraciones simultáneas
  -- se pisan.
  INSERT INTO accounting.mapping_rules
    (tenant_id, source_type, event_kind, line_number, account_role, is_credit_line, amount_key, description)
  VALUES
    -- Acreditación de cheque: el valor al cobro se convierte en fondos. No hay
    -- ingreso acá: el ingreso se reconoció al facturar y la cuenta a cobrar se
    -- canceló al recibir el cheque.
    (p_tenant_id, 'check_cleared', 'check_cleared', 1, 'bank',            false, 'total',      'Ingreso de fondos por acreditación de cheque'),
    (p_tenant_id, 'check_cleared', 'check_cleared', 2, 'checks_in_hand',  true,  'total',      'Se da de baja el valor al cobro'),

    -- Rechazo de un cheque ya acreditado: el dinero no estaba. Se revierte el
    -- ingreso de fondos y el valor vuelve como rechazado, no como al cobro: son
    -- dos situaciones distintas y la segunda es la que hay que gestionar.
    (p_tenant_id, 'check_rejected', 'check_rejected', 1, 'checks_rejected', false, 'total',     'El cheque rechazado vuelve como activo a gestionar'),
    (p_tenant_id, 'check_rejected', 'check_rejected', 2, 'bank',           true,  'total',     'Se revierte el ingreso de fondos'),

    -- Comisión o gasto bancario: sale dinero y es un gasto.
    (p_tenant_id, 'bank_fee', 'bank_fee', 1, 'bank_fees', false, 'total', 'Gasto bancario'),
    (p_tenant_id, 'bank_fee', 'bank_fee', 2, 'bank',      true,  'total', 'Salida de fondos por gasto bancario'),

    -- Ajuste de arqueo: la contrapartida es la cuenta de faltantes y sobrantes de
    -- caja. La dirección del asiento la decide `is_credit_line` y no el signo del
    -- monto (el motor rechaza importes negativos): un sobrante acredita la cuenta
    -- —es un ingreso— y un faltante la debita, que es un gasto neteado contra el
    -- mismo concepto.
    (p_tenant_id, 'adjustment', 'adjustment', 1, 'bank',                  false, 'total', 'Ajuste de arqueo sobre la cuenta de fondos'),
    (p_tenant_id, 'adjustment', 'adjustment', 2, 'cash_shortage_surplus', true,  'total', 'Contrapartida del ajuste de arqueo')
  ON CONFLICT (tenant_id, source_type, event_kind, line_number) DO UPDATE
    SET account_role   = EXCLUDED.account_role,
        is_credit_line = EXCLUDED.is_credit_line,
        amount_key     = EXCLUDED.amount_key,
        description    = EXCLUDED.description;

  GET DIAGNOSTICS v_reglas = ROW_COUNT;

  RETURN v_cuentas + v_extra + v_roles + v_reglas;
END $$;

COMMENT ON FUNCTION treasury.seed_tenant_treasury_config IS
  'Roles contables y reglas de mapeo de tesorería. Crea las cuentas propias que hacen falta y falla si el plan no las tiene.';

-- =============================================================================
-- 13 · Aislamiento (RLS) sobre las tablas nuevas del esquema treasury
-- =============================================================================
-- Mismo macro dinámico que `0012`–`0015`. ENABLE y FORCE: sin FORCE, el dueño
-- —`postgres`, que corre las migraciones— saltea sus propias políticas, y las
-- pruebas de aislamiento pasarían por la razón equivocada.
--
-- DOS DIFERENCIAS DELIBERADAS CON EL MACRO DE LOS OTROS ARCHIVOS:
--
-- 1. Se limita al esquema `treasury`. Los otros archivos incluían `billing` y
--    `app` en el WHERE, y volver a recorrerlos acá no aportaría nada —las tablas
--    ya tienen política— pero sí crearía un riesgo real: si alguien agregara una
--    tabla con `tenant_id` NULLABLE a `app`, este macro le pondría una política
--    `tenant_id = current_tenant_id()` que esconde las filas con NULL de todas las
--    empresas. Es exactamente lo que pasa con `accounting.accounts`, que tiene su
--    propia política escrita a mano en `0012` con la cláusula `tenant_id IS NULL`
--    justamente para no caer en eso.
--
-- 2. El `NOT EXISTS (SELECT 1 FROM pg_policy ...)` conserva la idempotencia: una
--    tabla que ya tiene política no se toca, así que correr la migración dos veces
--    no duplica políticas ni cambia las existentes.
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
      AND n.nspname = 'treasury'
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

-- =============================================================================
-- 14 · Exención declarada: la máquina de estados es de plataforma
-- =============================================================================
-- `treasury.check_state_transitions` NO tiene `tenant_id`: las transiciones
-- válidas de un cheque son una regla del dominio y no un dato del inquilino.
-- Duplicarlas por empresa sería permitir que una empresa dejara un cheque
-- acreditado sin fondos.
--
-- `app.assert_rls_coverage()` exige que toda tabla sin `tenant_id` tenga una
-- exención declarada, y la reconoce por `(esquema, tabla)` en una lista fija. Esa
-- lista vive en `0008`; la aserción no acepta una exención "por comentario". Por
-- eso la tabla recibe una política permisiva de SÓLO LECTURA para todos: cumple la
-- aserción sin abrir la escritura, y el GRANT de la sección 15 la limita a
-- `SELECT` para el rol de aplicación.
ALTER TABLE treasury.check_state_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS check_transitions_read_all ON treasury.check_state_transitions;
CREATE POLICY check_transitions_read_all ON treasury.check_state_transitions
  FOR SELECT TO PUBLIC
  USING (true);

COMMENT ON TABLE treasury.check_state_transitions IS
  'Transiciones válidas del ciclo de vida de un cheque. Tabla de plataforma sin tenant_id: la máquina de estados es una regla del dominio, igual para todas las empresas.';

-- =============================================================================
-- 15 · Permisos
-- =============================================================================
-- EL `GRANT USAGE` SOBRE EL ESQUEMA ES OBLIGATORIO Y VA PRIMERO. Sin él,
-- PostgreSQL rechaza cualquier acceso ANTES de evaluar los privilegios de tabla:
-- todos los GRANT de abajo quedarían inertes y `app_login` recibiría "permiso
-- denegado al esquema treasury" en el primer SELECT, con un mensaje que no nombra
-- ninguna tabla. Es el defecto que documenta `0012`.
GRANT USAGE ON SCHEMA treasury TO control_app, control_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON treasury.accounts              TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON treasury.checks                TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON treasury.reconciliations       TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON treasury.reconciliation_lines  TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON treasury.cash_counts           TO control_app;

-- Los movimientos: el UPDATE NO se otorga. El trigger lo rechazaría igual, pero no
-- otorgar el privilegio es la defensa de un nivel más abajo: el motor ni siquiera
-- llega a evaluar el trigger. Defensa en profundidad, no redundancia.
GRANT SELECT, INSERT, DELETE ON treasury.movements TO control_app;

GRANT SELECT ON treasury.accounts             TO control_readonly;
GRANT SELECT ON treasury.checks               TO control_readonly;
GRANT SELECT ON treasury.movements            TO control_readonly;
GRANT SELECT ON treasury.reconciliations      TO control_readonly;
GRANT SELECT ON treasury.reconciliation_lines TO control_readonly;
GRANT SELECT ON treasury.cash_counts          TO control_readonly;
GRANT SELECT ON treasury.check_state_transitions TO control_app, control_readonly;

-- LAS VISTAS NO HEREDAN EL GRANT DE SUS TABLAS BASE. Van explícitas: es el defecto
-- que costó la suite de compras entera (`0014`). Un `GRANT SELECT ON ALL TABLES`
-- sobre el esquema incluiría las vistas, pero se prefiere la lista explícita
-- porque documenta cuáles existen y porque un `ALL TABLES` se evalúa al ejecutarlo
-- y no cubre lo que se agregue después.
GRANT SELECT ON treasury.v_account_balances  TO control_app, control_readonly;
GRANT SELECT ON treasury.v_treasury_position TO control_app, control_readonly;
GRANT SELECT ON treasury.v_check_portfolio   TO control_app, control_readonly;
GRANT SELECT ON treasury.v_account_statement TO control_app, control_readonly;

-- Funciones. Las que escriben, sólo para el rol de aplicación.
GRANT EXECUTE ON FUNCTION treasury.account_balance(uuid, uuid)                       TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION treasury.assert_balances_reconcile(uuid)                   TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION treasury.transition_check(uuid, uuid, treasury.check_state, date, uuid, text) TO control_app;
GRANT EXECUTE ON FUNCTION treasury.record_movement(uuid, uuid, treasury.movement_kind, treasury.movement_direction, numeric, date, text, text, uuid, uuid) TO control_app;
GRANT EXECUTE ON FUNCTION treasury.reverse_movement(uuid, uuid, date, text)          TO control_app;
GRANT EXECUTE ON FUNCTION treasury.transfer_between_accounts(uuid, uuid, uuid, numeric, date, text) TO control_app;
GRANT EXECUTE ON FUNCTION treasury.open_reconciliation(uuid, uuid, date, date, numeric) TO control_app;
GRANT EXECUTE ON FUNCTION treasury.close_reconciliation(uuid, uuid, uuid, text)      TO control_app;
GRANT EXECUTE ON FUNCTION treasury.ensure_treasury_accounts(uuid)                    TO control_app;
GRANT EXECUTE ON FUNCTION treasury.seed_tenant_treasury_config(uuid)                 TO control_app;

-- Por defecto, para lo que se agregue después EN ESTE ESQUEMA. `ON TABLES` no
-- cubre secuencias ni vistas, así que van declaradas aparte: una vista nueva
-- repetiría el defecto de `0014`.
ALTER DEFAULT PRIVILEGES IN SCHEMA treasury
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA treasury
  GRANT SELECT ON TABLES TO control_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA treasury
  GRANT SELECT ON SEQUENCES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA treasury
  GRANT SELECT ON SEQUENCES TO control_readonly;

-- =============================================================================
-- 16 · El cobro en efectivo o transferencia ya mueve fondos
-- =============================================================================
-- Hasta `0015`, `billing.apply_customer_collection` registraba el cobro y lo
-- imputaba a las facturas, y el dinero quedaba sin cuenta. Ahora que existe la
-- cuenta de fondos, el cobro puede —y debe— dejar su movimiento.
--
-- Se hace con un trigger AFTER INSERT sobre `billing.payments`, y no modificando
-- la función de `0015`, por dos razones:
--
--   1. `apply_customer_collection` tiene un contrato ya probado (T-1, T-2, T-3) y
--      reescribirla entera para agregar una llamada al final es riesgo sin
--      beneficio. El trigger es aditivo.
--   2. Un movimiento tiene que existir para TODO cobro, no sólo para los que
--      entran por esa función. Un `INSERT` directo en `billing.payments` —que la
--      suite de compras usa— también tiene que dejarlo. Una llamada dentro de la
--      función se saltea por el camino crudo; un trigger no.
--
-- SÓLO PARA LOS MEDIOS QUE NO TIENEN CICLO. Un cheque no mueve fondos al
-- registrarse: el movimiento lo emite la acreditación (sección 6). Si el trigger
-- lo registrara igual, el dinero se contaría dos veces —una al recibir el cheque
-- y otra al acreditarlo— y el saldo quedaría inflado justo por el monto de los
-- cheques en cartera.
CREATE OR REPLACE FUNCTION treasury.trg_payment_to_movement()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account treasury.accounts;
BEGIN
  -- Los que tienen ciclo de vida propio no mueven fondos acá.
  IF NEW.method IN ('cheque', 'check') THEN
    RETURN NEW;
  END IF;

  -- Sin cuenta indicada, no hay dónde registrar el movimiento. Se permite NULL
  -- —una empresa puede estar migrando y tener cobros históricos sin cuenta— pero
  -- el movimiento no se inventa: el gate de la sección 5 no exige que todo cobro
  -- tenga movimiento, sólo que el saldo cuadre con los que hay. Inventar una
  -- cuenta sería peor: crearía un movimiento en un lugar que nadie eligió.
  IF NEW.treasury_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_account FROM treasury.accounts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.treasury_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'El cobro % apunta a la cuenta de tesorería %, que no existe en esta empresa.',
      NEW.id, NEW.treasury_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO treasury.movements (
    tenant_id, account_id, kind, direction, amount, currency,
    happened_on, source_type, source_id, created_by, description
  ) VALUES (
    NEW.tenant_id,
    NEW.treasury_account_id,
    'customer_payment',
    'credit',
    NEW.amount,
    NEW.currency,
    NEW.received_at::date,
    'customer_payment',
    NEW.id,
    NEW.created_by,
    'Cobro a cliente por ' || NEW.method
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pay_to_movement ON billing.payments;
CREATE TRIGGER trg_pay_to_movement
  AFTER INSERT ON billing.payments
  FOR EACH ROW EXECUTE FUNCTION treasury.trg_payment_to_movement();

-- La columna que el trigger necesita. Se agrega acá y no en `0015` porque es de
-- tesorería: `0015` no tenía cuentas de fondos con las que poblar una FK.
ALTER TABLE billing.payments
  ADD COLUMN IF NOT EXISTS treasury_account_id uuid;

-- La FK se agrega con la guardia de `pg_constraint`: `ADD CONSTRAINT` no es
-- idempotente, a diferencia del resto de la migración. Mismo patrón que `0015`
-- usó para `pay_id_tenant`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pay_treasury_account_fk' AND conrelid = 'billing.payments'::regclass
  ) THEN
    ALTER TABLE billing.payments
      ADD CONSTRAINT pay_treasury_account_fk
      FOREIGN KEY (tenant_id, treasury_account_id)
      REFERENCES treasury.accounts(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMENT ON COLUMN billing.payments.treasury_account_id IS
  'Cuenta de fondos donde entró el cobro. NULL en los cobros históricos o cuando el medio tiene ciclo propio (cheque): en ese caso el movimiento lo emite la acreditación.';

-- =============================================================================
-- 17 · Extensión de la vista de brechas para tesorería
-- =============================================================================
-- `CREATE OR REPLACE VIEW` conserva los permisos pero PIERDE `security_invoker`
-- si no se repite la opción: la vista reemplazada leería datos de todas las
-- empresas, en silencio y sin error.
--
-- SE REPITEN TODAS LAS RAMAS ANTERIORES. Quitar una al reemplazar es la forma
-- silenciosa de perder cobertura: la vista seguiría funcionando y dejaría de
-- detectar lo que ya detectaba. Las ramas de `0015` —cobros a cliente y notas de
-- crédito— más las de `0013`/`0014` son las que están abajo, textualmente.
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

-- Cobros a cliente sin asiento.
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

-- Notas de crédito aplicadas sin asiento.
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

-- NUEVO EN 0016 · Cheques acreditados sin asiento. El hecho es la acreditación,
-- no el alta del cheque: un cheque en cartera no es un hecho contable.
SELECT
  c.tenant_id,
  'check_cleared'::text AS source_type,
  c.id                  AS source_id,
  'check_cleared'::text AS event_kind,
  c.cleared_on          AS happened_on,
  'Acreditación de cheque sin asiento contable'::text AS gap_description
FROM treasury.checks c
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = c.tenant_id
 AND e.source_type = 'check_cleared'
 AND e.source_id = c.id
WHERE c.state = 'cleared'
  AND e.id IS NULL

UNION ALL

-- NUEVO EN 0016 · Cheques rechazados sin asiento. Sólo los que alguna vez
-- acreditaron: rechazar un cheque que nunca movió fondos no genera asiento porque
-- no hubo hecho contable que revertir.
SELECT
  c.tenant_id,
  'check_rejected'::text AS source_type,
  c.id                   AS source_id,
  'check_rejected'::text AS event_kind,
  c.rejected_on          AS happened_on,
  'Rechazo de cheque sin asiento contable'::text AS gap_description
FROM treasury.checks c
LEFT JOIN accounting.journal_entries e
  ON e.tenant_id = c.tenant_id
 AND e.source_type = 'check_rejected'
 AND e.source_id = c.id
WHERE c.state = 'rejected'
  AND e.id IS NULL
  -- Tuvo que haber acreditado: la marca es que existe un movimiento revertido por
  -- el rechazo. Un cheque rechazado desde `deposited` nunca fue un hecho contable.
  AND EXISTS (
    SELECT 1 FROM treasury.movements m
    WHERE m.tenant_id = c.tenant_id
      AND m.source_type = 'check'
      AND m.source_id = c.id
      AND m.kind IN ('check_cleared', 'check_rejected')
  )

UNION ALL

-- Salidas de stock por venta con costo sin asiento. Se conserva del `0013`
-- original, de `0014` y de `0015`.
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
  'Hechos económicos sin asiento contable: facturas de venta y compra, cobros a cliente, notas de crédito, pagos a proveedor, acreditaciones y rechazos de cheque, y salidas de stock con costo. Alimenta accounting.posting_check.';

-- =============================================================================
-- 17b · Los hechos de tesorería como origen de asiento
-- =============================================================================
-- `accounting.post_entry` recibe el origen como `accounting.entry_source`, que es
-- un ENUM. `0012` dejó declarados los valores de las fases siguientes —`purchase`
-- y `supplier_payment` con el comentario "fase E3"— y `0014` los usó sin tocar el
-- tipo. Los hechos de tesorería no estaban previstos: sin agregarlos, cualquier
-- intento de asentar una acreditación de cheque falla en la RESOLUCIÓN de la
-- función, con un error de tipo que no menciona el hecho ni el motivo.
--
-- `ALTER TYPE ... ADD VALUE` tiene una restricción que gobierna este archivo:
-- el valor nuevo NO se puede USAR en la misma transacción en la que se agregó
-- (PostgreSQL 12+ lo permite sólo si el tipo no se usó antes en la transacción).
-- Esta migración sólo DECLARA los valores; quien los usa es una migración
-- posterior o el runtime. Declararlos acá, y no en el momento de usarlos, es la
-- misma estrategia que siguió `0012`.
--
-- `IF NOT EXISTS` hace la migración idempotente: correrla dos veces no es un
-- error, y `ADD VALUE` sin la cláusula sí lo sería.
ALTER TYPE accounting.entry_source ADD VALUE IF NOT EXISTS 'check_cleared';
ALTER TYPE accounting.entry_source ADD VALUE IF NOT EXISTS 'check_rejected';

COMMENT ON TYPE accounting.entry_source IS
  'Origen de un asiento automático. Valores de fases posteriores se declaran por adelantado (purchase/supplier_payment en 0012, check_cleared/check_rejected en 0016).';

-- =============================================================================
-- 18 · Job de conciliación en el ledger
-- =============================================================================
-- El ledger vive en la base (`ops.jobs`, `ops.job_runs`), no en un log de la
-- aplicación: la pregunta "¿la conciliación de tesorería corrió este mes?" tiene
-- que responderse con una consulta y sobrevivir al reciclado de logs.
--
-- El job es DIARIO y no mensual: detectar que un cheque lleva 45 días depositado
-- sin acreditar sirve el día 45, no el último del mes.
INSERT INTO ops.jobs (code, description, expected_every)
VALUES (
  'treasury.reconciliation',
  'Verifica que el saldo de cada cuenta de tesorería cuadre con sus movimientos, y reporta cheques depositados sin acreditar y rechazados sin gestionar.',
  interval '1 day'
)
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 19 · Cierre
-- =============================================================================
-- La barrera. Si alguna tabla de `treasury` quedó sin política o sin FORCE RLS,
-- esto levanta una excepción y la transacción entera se revierte. No es un aviso:
-- el PR no puede mergearse con una tabla desprotegida.
SELECT app.assert_rls_coverage();

-- El gate de E4, medido sobre los datos que existen en este momento. Corre acá
-- además de en CI porque una cuenta recién creada con un saldo inicial es
-- exactamente el caso en que el movimiento de apertura puede faltar.
SELECT treasury.assert_balances_reconcile();

COMMIT;
