-- =============================================================================
-- Control · 0017 · Fundación fiscal: vocabulario neutral y parámetros con vigencia
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- Dos cosas que tienen que estar antes del primer cálculo de IVA, y ninguna de
-- las dos es un cálculo.
--
-- **La primera es un nombre.** `0004` declaró la columna `cae` y le ató un CHECK
-- de formato argentino. El dominio TypeScript, en cambio, ya es neutral:
-- `fiscal-driver.ts` expone `authorizationId` y su encabezado lo declara —"la
-- traducción vive en el driver, nunca en el dominio"—. El proyecto eligió dos
-- veces distinto, y la base eligió la opción que cierra la puerta multinacional.
-- El ADR `docs/adr/0003-vocabulario-fiscal-neutral.md` fija el criterio; acá se
-- ejecuta el renombre.
--
-- **La segunda es dónde viven las alícuotas.** El ADR `0004` decide que son
-- parámetros con vigencia temporal y no constantes en el código. Una alícuota es
-- una norma con fecha: si es una constante, un comprobante de marzo se recalcula
-- con la alícuota de septiembre y el número que se presentó ante el organismo
-- deja de ser reproducible. Esta migración crea el esquema `fiscal.*` donde esas
-- vigencias se persisten.
--
-- EL GATE DE E5 Y ESTE ARCHIVO NO SON LO MISMO
--
-- §7.1 define el gate de E5 como **"posición de IVA reproducible desde el libro"**
-- y §6.2 lo desglosa en F-1..F-6. Este archivo NO implementa la determinación:
-- implementa lo que la determinación necesita para poder ser reproducible. La
-- posición se calcula desde el libro —decisión 3 del ADR 0004— y el libro ya
-- tiene las cuentas de IVA con sus roles desde `0013`:
--
--     vat_payable    → 2.1.2.01  IVA débito fiscal
--     vat_receivable → 1.1.4.01  IVA crédito fiscal
--
-- y las reglas de mapeo que asientan `tax_total` en cada comprobante. Es decir:
-- **el débito y el crédito fiscal ya se están asentando.** Lo que falta es
-- resumirlos por período con la alícuota correcta a la fecha de cada comprobante,
-- y eso es lo que estas tablas habilitan.
--
-- LAS TRES DECISIONES QUE GOBIERNAN ESTE ARCHIVO
--
-- 1. SE RENOMBRA, NO SE COPIA.
--
--    `ALTER TABLE ... RENAME COLUMN` es atómico. La alternativa —agregar la
--    columna nueva, copiar, borrar la vieja— tiene una ventana en la que las dos
--    existen, y ese es exactamente el momento en que un proceso escribe en la
--    equivocada. No hay ventana que no exista, y hay 699 verificaciones en las
--    suites existentes que fallan si el renombre rompió algo.
--
--    El CHECK de FORMATO se elimina; la INVARIANTE DE DOMINIO se conserva. No es
--    una distinción cosmética:
--
--      · `inv_cae_format` (`^[0-9]{14}$`) es una regla de un país. Un comprobante
--        chileno no tiene un identificador de 14 dígitos numéricos: la columna no
--        puede representarlo ni aunque se la renombre. Esa regla pasa al driver,
--        que es el único que conoce el país.
--
--      · `inv_authorized_has_cae` (`result <> 'approved' OR cae IS NOT NULL`) es
--        una invariante del dominio: un comprobante aprobado tiene una
--        autorización. Vale en todos los países. Se conserva, renombrada.
--
-- 2. LAS ALÍCUOTAS TIENEN VIGENCIA, NO VALOR.
--
--    `fiscal.tax_rates` no guarda "la alícuota de IVA". Guarda las alícuotas de
--    IVA que rigieron, cada una con `valid_from` y `valid_to`. La consulta de
--    `rates_on(fecha)` devuelve las vigentes A ESA FECHA.
--
--    Se versionan los PARÁMETROS de la norma (qué alícuota, qué régimen, desde
--    cuándo). Las FÓRMULAS (base × alícuota, débito menos crédito, prorrateo)
--    quedan en código, dentro del driver. Configurar las fórmulas sería trasladar
--    el problema al usuario, que es como se llega a una planilla con peor
--    mantenimiento que el código.
--
-- 3. LOS CÓDIGOS LOCALES SE PRESERVAN, Y NO EN EL NOMBRE PRINCIPAL.
--
--    Cuando AFIP rechaza un comprobante, el código de observación es lo único que
--    permite buscar la causa. Perderlo para "no contaminar el dominio" sería peor
--    que el problema. Se conserva en `local_codes jsonb`, un campo cuyo nombre
--    admite que su contenido es local — el mismo principio que
--    `FiscalTaxBreakdown`, que ya expone `rate` neutro más `localTaxId?`.
--
-- ORDEN DE EJECUCIÓN: el renombre va primero. Todo lo que sigue puede asumir que
-- la columna ya se llama `authorization_id`.
--
-- DEPENDENCIA QUE `0001` NO PROVEE: esta migración instala `btree_gist`. `0001`
-- instala `btree_gin`, que es otro módulo, y las constraints de exclusión de
-- vigencia necesitan el operador de igualdad de `uuid` y `text` en la familia
-- GiST. Se declara acá y no allá porque `0001` ya está aplicada.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1 · Vocabulario neutral en el comprobante
-- =============================================================================
-- ADR 0003. Se ejecuta acá y no en una migración propia porque no tiene valor
-- separado del resto: sin el renombre, las tablas de `fiscal.*` de la sección 3
-- tendrían que referirse a `cae` y nacerían contaminadas.
-- =============================================================================

-- El CHECK de formato se elimina ANTES del renombre. `DROP CONSTRAINT` no depende
-- del nombre de la columna, pero hacerlo primero deja el renombre sin nada que lo
-- referencie y hace evidente que no queda ninguna regla argentina en el esquema.
ALTER TABLE billing.invoices DROP CONSTRAINT IF EXISTS inv_cae_format;

-- El renombre arrastra los índices, las vistas y las FK que la referencian: no hay
-- que recrear nada. Es la razón por la que se prefiere a copiar.
ALTER TABLE billing.invoices RENAME COLUMN cae TO authorization_id;
ALTER TABLE billing.invoices RENAME COLUMN cae_expires_at TO authorization_expires_at;

-- La invariante de dominio se recrea con su nombre neutral. Se dropea por su
-- nombre viejo para que la migración sea idempotente si se re-ejecuta.
ALTER TABLE billing.invoices DROP CONSTRAINT IF EXISTS inv_authorized_has_cae;
ALTER TABLE billing.invoices
  ADD CONSTRAINT inv_authorized_has_authorization
  CHECK (result <> 'approved' OR authorization_id IS NOT NULL);

COMMENT ON COLUMN billing.invoices.authorization_id IS
  'Identificador de la autorización de la autoridad fiscal. En Argentina es el CAE (14 dígitos). El FORMATO no se valida acá: es una regla por país y cada driver la impone. Antes se llamaba `cae` y tenía un CHECK de 14 dígitos, que impedía representar el comprobante de cualquier otro país (ADR 0003).';
COMMENT ON COLUMN billing.invoices.authorization_expires_at IS
  'Vencimiento de la autorización. Antes `cae_expires_at`.';

-- La columna se AGREGA antes de comentarla. `COMMENT ON COLUMN` sobre una columna
-- inexistente falla con «no existe la columna ... en la relación ...», y ese error
-- apunta al COMMENT y no al ADD COLUMN que falta — que es la causa real.
ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS local_codes jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN billing.invoices.local_codes IS
  'Códigos crudos tal como los devolvió la autoridad, para diagnóstico y trazabilidad. Los códigos son locales por definición, así que viven acá y no en el nombre de una columna de primera clase (ADR 0003).';

-- =============================================================================
-- 2 · El trigger de inmutabilidad fiscal de `0015` nombra la columna vieja
-- =============================================================================
-- `0015` creó `billing.assert_invoice_immutable()` comparando `NEW.cae` con
-- `OLD.cae`. Esa función es SQL almacenado: sobrevive al renombre y pasa a ser
-- inválida en silencio, porque plpgsql resuelve los nombres de columna en tiempo
-- de ejecución y no de creación.
--
-- El modo de falla merece explicarse, porque es el peor posible: el cuerpo de la
-- función se compila en el primer UPDATE, no al crearse. `NEW.cae` sobre una
-- tabla sin columna `cae` no da error de creación; da error la primera vez que
-- alguien intenta modificar una factura autorizada — es decir, justo en el camino
-- del cobro, y con un mensaje sobre una columna inexistente que no menciona ni la
-- inmutabilidad ni el renombre.
--
-- Se redefine completa, con `authorization_id`.
-- =============================================================================

CREATE OR REPLACE FUNCTION billing.assert_invoice_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'authorized' THEN
    RETURN NEW;
  END IF;

  -- Los acumuladores de cobro y su estado derivado son lo ÚNICO que puede cambiar.
  -- Se listan por nombre y se comparan una por una: una lista corta y explícita se
  -- revisa; una condición genérica ("¿cambió algo que no sea esto?") se olvida.
  IF  NEW.id             IS DISTINCT FROM OLD.id
   OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
   OR NEW.kind           IS DISTINCT FROM OLD.kind
   OR NEW.doc_type       IS DISTINCT FROM OLD.doc_type
   OR NEW.point_of_sale  IS DISTINCT FROM OLD.point_of_sale
   OR NEW.number         IS DISTINCT FROM OLD.number
   OR NEW.issue_date     IS DISTINCT FROM OLD.issue_date
   OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
   OR NEW.subtotal       IS DISTINCT FROM OLD.subtotal
   OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
   OR NEW.tax_total      IS DISTINCT FROM OLD.tax_total
   OR NEW.total          IS DISTINCT FROM OLD.total
   OR NEW.currency       IS DISTINCT FROM OLD.currency
   OR NEW.fx_rate        IS DISTINCT FROM OLD.fx_rate
   OR NEW.authorization_id         IS DISTINCT FROM OLD.authorization_id
   OR NEW.authorization_expires_at IS DISTINCT FROM OLD.authorization_expires_at
   OR NEW.result         IS DISTINCT FROM OLD.result
   OR NEW.related_invoice_id    IS DISTINCT FROM OLD.related_invoice_id
   OR NEW.receptor_doc_type     IS DISTINCT FROM OLD.receptor_doc_type
   OR NEW.receptor_doc_number   IS DISTINCT FROM OLD.receptor_doc_number
   OR NEW.receptor_name         IS DISTINCT FROM OLD.receptor_name
   OR NEW.receptor_tax_condition IS DISTINCT FROM OLD.receptor_tax_condition
   OR NEW.idempotency_key       IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION
      'El comprobante % % está autorizado y es fiscalmente inmutable: sólo se '
      'anula con Nota de Crédito. Se intentó modificar un campo que no es un '
      'acumulador de cobro.',
      OLD.doc_type, OLD.number
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

-- =============================================================================
-- 3 · Esquema fiscal: parámetros de la norma con vigencia temporal
-- =============================================================================
-- ADR 0004, decisión 2. Nada de acá se usa todavía: esta migración deja el lugar
-- donde la determinación de IVA va a leer sus parámetros, y lo deja vacío a
-- propósito. La carga inicial de la normativa argentina va en la migración de
-- determinación, junto con el código que la consume — una tabla de parámetros sin
-- su lector es una tabla que nadie sabe si está bien.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS fiscal;

COMMENT ON SCHEMA fiscal IS
  'Parámetros impositivos con vigencia temporal. Versiona los PARÁMETROS de la norma (alícuotas, regímenes, libros); las FÓRMULAS viven en el driver (ADR 0004).';

-- -----------------------------------------------------------------------------
-- 3.1 · Impuestos
-- -----------------------------------------------------------------------------
-- Un impuesto es una entidad con identidad propia, no un número de alícuota. 'IVA'
-- existe independientemente de si hoy es 21% o 10,5%: eso es una vigencia. La
-- separación importa porque la determinación agrupa POR IMPUESTO y luego por
-- alícuota, y si el impuesto fuera sólo un número habría que inferir el
-- agrupamiento desde los valores.
-- -----------------------------------------------------------------------------

CREATE TABLE fiscal.taxes (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  -- NULL = definición de plataforma (como `accounting.accounts`). Un impuesto
  -- nacional no pertenece a ninguna empresa; una percepción provincial propia de
  -- una empresa puede existir con su `tenant_id`.
  tenant_id     uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  -- Código neutral y estable: 'iva', 'iibb', 'withholding_ganancias'.
  code          text NOT NULL,
  name          text NOT NULL,
  -- Clasificación neutra del impuesto. Gobierna cómo entra al cálculo:
  --   'vat'          suma al débito menos crédito del período
  --   'withholding'  se sufre o se practica sobre un comprobante
  --   'perception'   se suma al comprobante como un cargo más
  --   'turnover'     ingresos brutos, por jurisdicción (Convenio Multilateral)
  kind          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT taxes_kind_valid CHECK (kind IN ('vat','withholding','perception','turnover')),
  CONSTRAINT taxes_code_not_blank CHECK (length(btrim(code)) > 0)
);

-- El mismo patrón que `accounting.accounts`: NULL no colisiona con NULL en un
-- UNIQUE, así que hacen falta dos índices —uno por empresa, uno para plataforma—
-- para que 'iva' de plataforma sea único entre los de plataforma.
CREATE UNIQUE INDEX taxes_tenant_code_uniq ON fiscal.taxes(tenant_id, code);
CREATE UNIQUE INDEX taxes_template_code_uniq ON fiscal.taxes(code) WHERE tenant_id IS NULL;

-- El índice que habilita las FK compuestas desde `fiscal.tax_rates`,
-- `fiscal.withholding_regimes` y `fiscal.document_taxes`. Es la misma pieza que
-- `0012` declara para `accounting.accounts`: `(tenant_id, id)` único permite que
-- una fila apunte a un recurso de **su propia empresa**, y contra una tabla con
-- `tenant_id` NULLABLE eso además tiene una consecuencia que conviene entender.
--
-- CONSECUENCIA DE LA FK COMPUESTA CONTRA UN PARÁMETRO DE PLATAFORMA: una fila de
-- una empresa NO puede referenciar un impuesto de plataforma (`tenant_id` NULL),
-- porque el par `(tenant_id_de_la_empresa, id_del_impuesto)` no existe en ningún
-- índice — el impuesto de plataforma está bajo `(NULL, id)`. Es decir que los
-- impuestos y alícuotas de plataforma se LEEN desde `fiscal.rates_on()`, que hace
-- la resolución empresa-sobre-plataforma en su consulta, y NO se referencian por
-- FK. `fiscal.document_taxes.tax_id` apunta a un impuesto **de la empresa**.
--
-- Eso es deliberado y es la razón por la que el discriminado es un snapshot: el
-- comprobante guarda la alícuota COPIADA, así que no necesita la referencia al
-- parámetro de plataforma para ser reproducible. Si la necesitara, este esquema
-- no podría soportar el caso normal —una empresa que no define sus propios
-- impuestos y usa los de plataforma— sin duplicar la tabla de impuestos por
-- empresa, que es peor.
CREATE UNIQUE INDEX taxes_tenant_id_uniq ON fiscal.taxes(tenant_id, id);

COMMENT ON TABLE fiscal.taxes IS
  'Impuestos con identidad propia. La alícuota NO vive acá: vive en fiscal.tax_rates con vigencia temporal, porque una alícuota es una norma con fecha (ADR 0004).';

-- -----------------------------------------------------------------------------
-- 3.2 · Alícuotas con vigencia
-- -----------------------------------------------------------------------------
-- La tabla central de la decisión 2 del ADR 0004.
--
-- LA REGLA QUE LA HACE ÚTIL: los rangos de un mismo (tenant, impuesto, código de
-- alícuota) NO PUEDEN SOLAPARSE. Si se solaparan, `rates_on(fecha)` devolvería dos
-- filas y el cálculo elegiría una — cualquiera, según el orden físico de las
-- filas, que cambia con el VACUUM. Un resultado que depende del orden físico es
-- irreproducible, que es exactamente lo que F-6 prohíbe.
--
-- DEFECTO REAL ENCONTRADO AL EJECUTAR ESTA MIGRACIÓN, y la razón por la que la
-- constraint se escribe como se escribe:
--
-- El primer intento fue `EXCLUDE USING gist (tenant_id WITH =, tax_id WITH =,
-- rate_code WITH =, daterange(...) WITH &&)`. Es la forma que parece obvia, y NO
-- FUNCIONA para las alícuotas de plataforma: **en un `EXCLUDE`, NULL se considera
-- DISTINTO de NULL** — al revés que en un `UNIQUE`, donde NULL tampoco colisiona
-- pero por otra razón. Las alícuotas de plataforma tienen `tenant_id IS NULL`, así
-- que dos de ellas nunca conflictuaban entre sí y el `EXCLUDE` no protegía
-- exactamente el caso que existe desde el día uno: el plan impositivo de la
-- plataforma. Se comprobó insertando dos alícuotas de IVA al 21% con rangos
-- solapados y `tenant_id NULL`: las dos entraron, y `rates_on()` devolvió DOS filas
-- para la misma fecha y el mismo `rate_code`.
--
-- La corrección es la misma que `0012` usa para el plan mínimo de cuentas: llevar
-- el `NULL` a un centinela no-nulo con `COALESCE`, para que "sin empresa" sea un
-- valor comparable y se comporte como una empresa más.
--
-- POR QUÉ UN CENTINELA Y NO UN `UNIQUE` PARCIAL: un `EXCLUDE` no admite `WHERE`,
-- así que no se puede declarar por separado "para plataforma" y "para empresas".
-- El centinela unifica los dos casos en una sola constraint.
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "btree_gist";


CREATE TABLE fiscal.tax_rates (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  tax_id       uuid NOT NULL,
  -- Código de la alícuota dentro del impuesto: en IVA, '21', '10.5', '27', '0'.
  -- Es texto y no un número por el mismo motivo que `local_codes`: el código es
  -- una etiqueta de la norma, no una cantidad.
  rate_code    text NOT NULL,
  -- La alícuota como fracción: 0.21, no 21.
  rate         numeric(9,6) NOT NULL,
  valid_from   date NOT NULL,
  -- NULL = vigente hasta nuevo aviso. Es la forma correcta de expresar "rige hoy":
  -- una fecha centinela como '9999-12-31' se compara mal y se muestra peor.
  valid_to     date,
  -- Atributo de la norma, no del cálculo: en IVA, si la alícuota es reducida.
  -- Sirve para agrupar el libro y para validar la posición.
  legal_basis  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_rates_rate_valid   CHECK (rate >= 0 AND rate < 1),
  CONSTRAINT tax_rates_range_valid  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT tax_rates_code_not_blank CHECK (length(btrim(rate_code)) > 0),

  -- La garantía de no-solapamiento. `tstzrange` no: las vigencias son fechas
  -- fiscales, no instantes. Un cambio de alícuota rige desde el día 1, no desde
  -- una hora, y modelarlo con instantes obligaría a elegir una hora inventada.
  --
  -- `COALESCE(tenant_id, <centinela>)` es la pieza que hace que la constraint
  -- proteja también las alícuotas de plataforma. Ver el bloque de comentarios
  -- sobre la tabla: sin esto, NULL no colisiona con NULL en un EXCLUDE.
  CONSTRAINT tax_rates_no_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tax_id    WITH =,
    rate_code WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);

-- El `EXCLUDE` de arriba NO protege las alícuotas de plataforma sin el `COALESCE`
-- a un centinela, porque en un `EXCLUDE` NULL se considera distinto de NULL. El
-- bloque de comentarios que precede a `fiscal.tax_rates` documenta el defecto
-- completo, cómo se descubrió y por qué la corrección es un centinela.
--
-- (Un `EXCLUDE` tampoco admite `WHERE`, así que no hay forma de declarar la regla
-- por separado para plataforma y para empresas: el centinela las unifica.)

CREATE INDEX idx_tax_rates_lookup ON fiscal.tax_rates(tax_id, valid_from DESC);
CREATE INDEX idx_tax_rates_tenant ON fiscal.tax_rates(tenant_id, tax_id, valid_from DESC);

-- Habilita las FK compuestas hacia esta tabla (mismo criterio que `fiscal.taxes`).
CREATE UNIQUE INDEX tax_rates_tenant_id_uniq ON fiscal.tax_rates(tenant_id, id);

-- FK compuesta al impuesto. `tax_id` es NOT NULL y `tenant_id` puede ser NULL en
-- las alícuotas de plataforma: una alícuota de plataforma referencia un impuesto
-- de plataforma y ambos están bajo `(NULL, id)`, así que la FK compuesta SÍ los
-- empareja. Lo que la FK compuesta impide es que una alícuota de la empresa A
-- apunte a un impuesto de la empresa B.
ALTER TABLE fiscal.tax_rates
  ADD CONSTRAINT tax_rates_tax_fk
  FOREIGN KEY (tenant_id, tax_id)
  REFERENCES fiscal.taxes(tenant_id, id) ON DELETE RESTRICT;

COMMENT ON TABLE fiscal.tax_rates IS
  'Alícuotas con vigencia temporal. La constraint EXCLUDE impide rangos solapados para un mismo impuesto y código: dos alícuotas vigentes a la vez harían que rates_on() devuelva dos filas y el cálculo dependa del orden físico (ADR 0004).';
COMMENT ON COLUMN fiscal.tax_rates.rate IS
  'Alícuota como fracción: 0.21, no 21. La multiplicación directa evita el error de dividir por 100 en un lugar y no en otro.';
COMMENT ON COLUMN fiscal.tax_rates.valid_to IS
  'NULL = vigente hasta nuevo aviso. Se prefiere a una fecha centinela, que se compara mal y se muestra peor.';

-- -----------------------------------------------------------------------------
-- 3.3 · Regímenes de retención y percepción
-- -----------------------------------------------------------------------------
-- ADR 0004 decisión 1: `withholdingRules` es uno de los cuatro métodos del
-- contrato. Su forma de tabla es ésta.
--
-- Un régimen tiene dos parámetros que lo definen operativamente —a partir de qué
-- importe se retiene y con qué alícuota— y un sujeto: quién retiene. Se versiona
-- igual que las alícuotas y por la misma razón: la RG que cambia el mínimo no
-- reescribe las retenciones ya practicadas.
-- -----------------------------------------------------------------------------

CREATE TABLE fiscal.withholding_regimes (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  tax_id          uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  -- 'suffered' = nos retuvieron; 'practiced' = retuvimos nosotros. Es la misma
  -- distinción que F-4 pide y la que decide el sentido del asiento.
  direction       text NOT NULL,
  -- Base a partir de la cual se aplica. En Argentina, el mínimo no imponible.
  threshold_amount numeric(14,2) NOT NULL DEFAULT 0,
  rate            numeric(9,6) NOT NULL,
  -- Jurisdicción, para Ingresos Brutos. NULL cuando el régimen es nacional.
  jurisdiction    text,
  valid_from      date NOT NULL,
  valid_to        date,
  legal_basis     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT withholding_direction_valid CHECK (direction IN ('suffered','practiced')),
  CONSTRAINT withholding_rate_valid CHECK (rate >= 0 AND rate < 1),
  CONSTRAINT withholding_threshold_valid CHECK (threshold_amount >= 0),
  CONSTRAINT withholding_range_valid CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT withholding_code_not_blank CHECK (length(btrim(code)) > 0),

  CONSTRAINT withholding_no_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tax_id       WITH =,
    code         WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);

CREATE INDEX idx_withholding_lookup ON fiscal.withholding_regimes(tax_id, valid_from DESC);

CREATE UNIQUE INDEX withholding_tenant_id_uniq ON fiscal.withholding_regimes(tenant_id, id);

ALTER TABLE fiscal.withholding_regimes
  ADD CONSTRAINT withholding_tax_fk
  FOREIGN KEY (tenant_id, tax_id)
  REFERENCES fiscal.taxes(tenant_id, id) ON DELETE RESTRICT;

COMMENT ON TABLE fiscal.withholding_regimes IS
  'Regímenes de retención y percepción con vigencia temporal. `direction` distingue sufrir de practicar, que es lo que F-4 verifica y lo que decide el sentido del asiento.';

-- =============================================================================
-- 4 · Consulta de parámetros a una fecha
-- =============================================================================
-- ADR 0004, consecuencia aceptada: `ratesOn` RECIBE una fecha y no devuelve "la
-- alícuota actual". Un llamador que quiera hoy pasa la fecha explícitamente. Eso
-- impide el defecto silencioso de recalcular un comprobante viejo con la alícuota
-- de hoy — que es la razón por la que F-6 exige reproducibilidad y no sólo
-- corrección.
-- =============================================================================

CREATE OR REPLACE FUNCTION fiscal.rates_on(
  p_date      date,
  p_tax_code  text,
  p_tenant_id uuid DEFAULT NULL
) RETURNS TABLE (
  tax_code   text,
  rate_code  text,
  rate       numeric(9,6),
  legal_basis text,
  valid_from date,
  valid_to   date
)
LANGUAGE sql
STABLE
AS $$
  SELECT t.code, r.rate_code, r.rate, r.legal_basis, r.valid_from, r.valid_to
  FROM fiscal.tax_rates r
  JOIN fiscal.taxes t ON t.id = r.tax_id
  WHERE t.code = p_tax_code
    AND t.is_active
    -- La vigencia: el rango contiene la fecha. `daterange` con '[]' es inclusivo
    -- en ambos extremos, así que un cambio que rige desde el 1/1 aplica el 1/1.
    AND daterange(r.valid_from, r.valid_to, '[]') @> p_date
    -- Resolución empresa-vs-plataforma: la alícuota propia de la empresa GANA
    -- sobre la de plataforma cuando ambas existen. Se expresa con `IS NOT
    -- DISTINCT FROM` en lugar de `=` porque el tenant de plataforma es NULL y
    -- `NULL = NULL` es NULL, no verdadero.
    AND (r.tenant_id = p_tenant_id
         OR (r.tenant_id IS NULL AND NOT EXISTS (
               SELECT 1 FROM fiscal.tax_rates r2
               JOIN fiscal.taxes t2 ON t2.id = r2.tax_id
               WHERE t2.code = p_tax_code
                 AND r2.tenant_id = p_tenant_id
                 AND r2.rate_code = r.rate_code
                 AND daterange(r2.valid_from, r2.valid_to, '[]') @> p_date
             )))
  ORDER BY r.rate_code;
$$;

COMMENT ON FUNCTION fiscal.rates_on IS
  'Alícuotas de un impuesto vigentes A UNA FECHA. Recibe la fecha de forma explícita —no devuelve "lo actual"— para impedir que un comprobante viejo se recalcule con la alícuota de hoy (ADR 0004, F-6). La alícuota propia de la empresa gana sobre la de plataforma.';

CREATE OR REPLACE FUNCTION fiscal.withholdings_on(
  p_date      date,
  p_tax_code  text,
  p_tenant_id uuid DEFAULT NULL
) RETURNS TABLE (
  code              text,
  name              text,
  direction         text,
  threshold_amount  numeric(14,2),
  rate              numeric(9,6),
  jurisdiction      text,
  legal_basis       text
)
LANGUAGE sql
STABLE
AS $$
  SELECT w.code, w.name, w.direction, w.threshold_amount, w.rate, w.jurisdiction, w.legal_basis
  FROM fiscal.withholding_regimes w
  JOIN fiscal.taxes t ON t.id = w.tax_id
  WHERE t.code = p_tax_code
    AND t.is_active
    AND daterange(w.valid_from, w.valid_to, '[]') @> p_date
    AND (w.tenant_id = p_tenant_id
         OR (w.tenant_id IS NULL AND NOT EXISTS (
               SELECT 1 FROM fiscal.withholding_regimes w2
               JOIN fiscal.taxes t2 ON t2.id = w2.tax_id
               WHERE t2.code = p_tax_code
                 AND w2.tenant_id = p_tenant_id
                 AND w2.code = w.code
                 AND daterange(w2.valid_from, w2.valid_to, '[]') @> p_date
             )))
  ORDER BY w.code;
$$;

COMMENT ON FUNCTION fiscal.withholdings_on IS
  'Regímenes de retención/percepción vigentes a una fecha, con el mismo criterio de fecha explícita y misma precedencia empresa-sobre-plataforma que rates_on.';

-- =============================================================================
-- 5 · El impuesto que un comprobante discriminó
-- =============================================================================
-- El puente entre el comprobante y la determinación.
--
-- POR QUÉ HACE FALTA, SI `invoices.tax_total` YA EXISTE:
--
-- `tax_total` es un número. Dice CUÁNTO impuesto tiene el comprobante y no dice
-- DE QUÉ ALÍCUOTA. Y la determinación de IVA necesita las dos cosas: F-1 compara
-- el débito del período con la suma de comprobantes, y el libro digital de F-3 se
-- presenta DISCRIMINADO POR ALÍCUOTA. Reconstruir la alícuota desde el total
-- dividiendo por 0,21 es un cálculo que falla en cuanto un comprobante mezcla
-- alícuotas — y ninguno avisa que las mezcló.
--
-- POR QUÉ ES UN SNAPSHOT Y NO UNA REFERENCIA:
--
-- Guarda `rate` COPIADO de `fiscal.tax_rates`, no un `rate_id`. Si guardara la
-- referencia, corregir la alícuota de 2024 cambiaría retroactivamente el
-- discriminado de un comprobante de 2024 ya presentado ante el organismo. El
-- comprobante es un hecho consumado: su discriminado se congela al emitir, igual
-- que su `receptor_name` o su `total`. La tabla de alícuotas es la norma; esta
-- tabla es lo que efectivamente se aplicó.
-- =============================================================================

CREATE TABLE fiscal.document_taxes (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  -- FK compuesta: impide apuntar a un comprobante de otra empresa.
  invoice_id   uuid NOT NULL,
  tax_id       uuid NOT NULL,
  -- Código de alícuota aplicado, copiado. Ver el comentario de la sección.
  rate_code    text NOT NULL,
  rate         numeric(9,6) NOT NULL,
  -- Base imponible sobre la que se aplicó.
  taxable_base numeric(14,2) NOT NULL,
  amount       numeric(14,2) NOT NULL,
  -- Código local del impuesto tal como lo reportó la autoridad, cuando lo hay.
  local_code   text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_taxes_rate_valid CHECK (rate >= 0 AND rate < 1),
  CONSTRAINT document_taxes_amount_valid CHECK (amount >= 0),
  CONSTRAINT document_taxes_base_valid CHECK (taxable_base >= 0),

  -- Una factura no puede tener dos veces la misma alícuota del mismo impuesto:
  -- sería una duplicación, y la determinación la sumaría dos veces.
  CONSTRAINT document_taxes_uniq UNIQUE (tenant_id, invoice_id, tax_id, rate_code)
);

ALTER TABLE fiscal.document_taxes
  ADD CONSTRAINT document_taxes_invoice_fk
  FOREIGN KEY (tenant_id, invoice_id)
  REFERENCES billing.invoices(tenant_id, id) ON DELETE CASCADE;

-- FK COMPUESTA, y por eso `tax_id` apunta a un impuesto DE LA EMPRESA y no a uno
-- de plataforma. Es la restricción deliberada que documenta `taxes_tenant_id_uniq`:
-- un comprobante no referencia parámetros de plataforma, porque guarda la alícuota
-- copiada y no necesita la referencia. Antes esto era una FK simple a `taxes(id)`,
-- que funcionaba y permitía que una fila de la empresa A apuntara a un impuesto de
-- la empresa B.
ALTER TABLE fiscal.document_taxes
  ADD CONSTRAINT document_taxes_tax_fk
  FOREIGN KEY (tenant_id, tax_id)
  REFERENCES fiscal.taxes(tenant_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX document_taxes_tenant_id_uniq ON fiscal.document_taxes(tenant_id, id);

CREATE INDEX idx_document_taxes_invoice ON fiscal.document_taxes(tenant_id, invoice_id);
CREATE INDEX idx_document_taxes_tax     ON fiscal.document_taxes(tenant_id, tax_id, rate_code);

COMMENT ON TABLE fiscal.document_taxes IS
  'Discriminado de impuestos de un comprobante, con la alícuota COPIADA y no referenciada: el comprobante es un hecho consumado y su discriminado se congela al emitir. Sin esto la determinación sólo tendría totales y no podría presentar el libro por alícuota (F-3), ni distinguir un comprobante que mezcla alícuotas.';

-- =============================================================================
-- 6 · RLS y cobertura
-- =============================================================================
-- Regla 6 del proyecto: toda tabla nueva con `tenant_id` tiene que quedar
-- alcanzada por la cobertura, y `app.assert_rls_coverage()` (que corre al final de
-- esta migración) falla si alguna quedó sin política o sin FORCE.
--
-- `fiscal.taxes`, `fiscal.tax_rates` y `fiscal.withholding_regimes` tienen
-- `tenant_id` NULLABLE —son parámetros, y su versión de plataforma no pertenece a
-- ninguna empresa—. Se les aplica el mismo criterio que a `accounting.accounts`:
-- la empresa ve lo suyo más lo de plataforma, y NUNCA lo de otra empresa.
-- =============================================================================

ALTER TABLE fiscal.taxes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.taxes              FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.tax_rates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.tax_rates          FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.withholding_regimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.withholding_regimes FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.document_taxes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.document_taxes     FORCE  ROW LEVEL SECURITY;

-- Parámetros: lectura de lo propio y de plataforma; escritura sólo de lo propio.
CREATE POLICY taxes_read ON fiscal.taxes
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY taxes_write ON fiscal.taxes
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY tax_rates_read ON fiscal.tax_rates
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY tax_rates_write ON fiscal.tax_rates
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY withholding_read ON fiscal.withholding_regimes
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY withholding_write ON fiscal.withholding_regimes
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Discriminado: SIEMPRE de una empresa, sin rama de plataforma. Es un dato del
-- comprobante, no un parámetro.
CREATE POLICY document_taxes_isolation ON fiscal.document_taxes
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Los parámetros de plataforma no se modifican desde el rol de aplicación:
-- cambiar una alícuota histórica reescribiría el pasado de todas las empresas.
--
-- El criterio de privilegios sigue a `accounting`, que es el otro esquema con la
-- misma forma (parámetros de plataforma + datos de empresa): la aplicación LEE los
-- parámetros y ESCRIBE sólo el discriminado de sus comprobantes.
--
-- `ALTER DEFAULT PRIVILEGES` de `0007` NO cubre este esquema — sólo alcanza a
-- `app`, `billing`, `logistics` y `audit`, y para cuando este esquema existe ya se
-- aplicó. Sin estos GRANT explícitos, `control_app` no puede ni ver las tablas
-- aunque tenga la política RLS adecuada: RLS filtra FILAS, no concede ACCESO.
-- Es un modo de falla fácil de confundir, porque el error («permiso denegado al
-- esquema fiscal») NO se parece a un problema de aislamiento.
GRANT USAGE ON SCHEMA fiscal TO control_app, control_readonly;
GRANT USAGE ON SCHEMA fiscal TO control_platform;

REVOKE INSERT, UPDATE, DELETE ON fiscal.taxes               FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON fiscal.tax_rates           FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON fiscal.withholding_regimes FROM PUBLIC;

GRANT SELECT ON fiscal.taxes               TO control_app, control_readonly;
GRANT SELECT ON fiscal.tax_rates           TO control_app, control_readonly;
GRANT SELECT ON fiscal.withholding_regimes TO control_app, control_readonly;

-- El discriminado sí es dato de empresa: se escribe al emitir.
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.document_taxes TO control_app;
GRANT SELECT ON fiscal.document_taxes TO control_readonly;

-- Las secuencias del esquema, por consistencia con los demás esquemas.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fiscal TO control_app;

-- Las funciones de consulta de parámetros son de lectura: las usa el cálculo de
-- IVA, que corre con el rol de aplicación.
GRANT EXECUTE ON FUNCTION fiscal.rates_on(date, text, uuid)        TO control_app, control_readonly;
GRANT EXECUTE ON FUNCTION fiscal.withholdings_on(date, text, uuid) TO control_app, control_readonly;

-- Y el mismo `ALTER DEFAULT PRIVILEGES` que `0012` dejó para `accounting`, para
-- que las tablas de la determinación de IVA (la próxima migración) no repitan el
-- olvido del USAGE. Es la corrección del defecto que `0012` documenta.
ALTER DEFAULT PRIVILEGES IN SCHEMA fiscal
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA fiscal
  GRANT SELECT ON TABLES TO control_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA fiscal
  GRANT USAGE, SELECT ON SEQUENCES TO control_app;

-- =============================================================================
-- 7 · La barrera
-- =============================================================================
-- Corre acá y en CI (`rls-lint`). Si alguna tabla de esta migración quedó sin
-- política o sin FORCE RLS, la migración entera falla y nada se aplica.
-- =============================================================================

DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
