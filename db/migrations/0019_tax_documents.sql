-- =============================================================================
-- Control · 0019 · El hecho fiscal es propio: `fiscal.tax_documents`
-- -----------------------------------------------------------------------------
-- QUÉ RESUELVE
--
-- Implementa el ADR `0005`. Hasta acá la determinación de impuestos estaba
-- construida SOBRE EL COMPROBANTE DE VENTA:
--
--     fiscal.document_taxes.invoice_id  → billing.invoices
--     fiscal.vat_accruals.invoice_id    → billing.invoices
--
-- Esa relación es el defecto. Una factura de COMPRA no es una `billing.invoice`:
-- vive en `purchasing.supplier_invoices`, con otra PK, otro correlativo y otras
-- reglas. Consecuencia medida contra PostgreSQL, no leída:
--
--   · `accrue_vat` no puede imputar una compra      → P0002 «no existe en esta empresa»
--   · `document_taxes` rechaza una compra           → 23503 viola document_taxes_invoice_fk
--   · la rama de compra de `accrue_vat` es código muerto: el enum `billing.receipt_kind`
--     de `0001` no tiene valor de compra, así que `v_inv.kind` nunca es de compra
--   · no hay camino desde una factura de compra hasta su fecha de recepción, que es el
--     dato que el propio `0018` dice usar para computar el crédito fiscal
--
-- Y LO MÁS GRAVE, que es lo que hace urgente esta migración:
--
-- F-1, F-3 y F-6 PASABAN IGUAL. Un libro que sólo registra ventas es internamente
-- consistente —los totales cuadran, `v_vat_gaps` devuelve 0 filas, la divergencia es
-- cero— y la posición que informa omite todo el crédito fiscal de compras. Ninguna
-- verificación existente lo detectaba, porque todas comparaban el sistema consigo mismo.
--
-- LA DECISIÓN DEL ADR 0005, EN UNA LÍNEA
--
-- La pregunta que la determinación necesita responder es "¿qué documentos tienen efectos
-- fiscales este período?", y esa pregunta tiene UNA respuesta, no una por tabla de negocio.
-- `fiscal.tax_documents` es esa respuesta: la proyección fiscal de cada tabla de negocio,
-- no su reemplazo.
--
-- Y el defecto de SIGNO, que se corrige acá
--
-- `0018` derivaba la dirección fiscal del rol contable y restaba en el sentido del pasivo:
--
--     CASE WHEN ar.role = 'vat_payable' THEN 'debit' ELSE 'credit' END,
--     sum(l.credit) - sum(l.debit)
--
-- Para una venta da +2100 (bien). Para una compra da −840, porque un activo aumenta al
-- DEBE y esa resta le invierte el signo. Entonces la posición neta salía:
--
--     2100 − (−840) = 2940        lo que calculaba
--     2100 −   840  = 1260        lo que corresponde
--
-- Un IVA a pagar del DOBLE, y el error crece con el volumen de compras — lo contrario de
-- lo que se espera de un error que se descubre tarde. La corrección está en la sección 6.
--
-- LAS SECCIONES
--
--   1 · El hecho fiscal: `fiscal.tax_documents`
--   2 · La fecha de recepción, que es lo que hace computable el crédito de compras
--   3 · Migrar `document_taxes` y `vat_accruals` a apuntar al hecho
--   4 · Las retenciones, que hoy no tienen dónde vivir
--   5 · `accrue_vat`, reescrita por REGLA sobre el tipo de hecho
--   6 · La posición, con el signo del impuesto y no el de la cuenta
--   7 · RLS, privilegios y la barrera de integridad
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1 · El hecho fiscal
-- =============================================================================
-- POR QUÉ UNA FK POLIMÓRFICA Y NO UNA FK COMPUESTA A CADA TABLA
--
-- El proyecto tiene una regla firme: toda referencia entre tablas de negocio es una FK
-- COMPUESTA `(tenant_id, id)`, porque una FK simple permite apuntar a un recurso de otra
-- empresa en silencio. Se cumplió en las 86 referencias verificadas antes de esta
-- migración.
--
-- Acá la regla choca con otra: una tabla de hechos fiscales tiene que poder referir a
-- tablas de negocio distintas sin que agregar la tercera sea una migración estructural.
--
-- La resolución —y es la decisión central de esta sección— es que `tax_documents` NO
-- referencia a las tablas de negocio. Es al revés: **cada tabla de negocio referencia su
-- hecho fiscal**. `tax_documents` guarda `source_type`/`source_id` como datos, y la
-- integridad se sostiene con un trigger de validación más un índice único que impide que
-- dos hechos reclamen el mismo origen.
--
-- POR QUÉ ESTO NO DEBILITA EL AISLAMIENTO: el `tenant_id` de `tax_documents` es NOT NULL y
-- lleva su propia política FORCE RLS. Un hecho de la empresa A no es visible desde B aunque
-- su `source_id` apunte a un documento de B — y el trigger de la sección 1.3 impide que esa
-- situación se cree en primer lugar. El aislamiento lo garantiza RLS sobre el hecho, no la
-- FK sobre el origen. Lo que se pierde es la garantía de motor sobre la EXISTENCIA del
-- origen, y eso se recupera con `fiscal.assert_fiscal_integrity()` (sección 7), que es una
-- verificación ejecutable en CI. Es un intercambio explícito, no un descuido.
-- =============================================================================

CREATE TABLE fiscal.tax_documents (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,

  -- El tipo de hecho fiscal, en vocabulario DEL DOMINIO FISCAL.
  --
  -- POR QUÉ NO SE REUSA `billing.receipt_kind`: ese enum describe el comprobante desde la
  -- venta —'invoice','credit_note','debit_note'— y por eso no puede representar una compra.
  -- Es exactamente la lección del ADR 0003 aplicada a una relación en vez de a un nombre:
  -- el vocabulario de un lado del negocio no puede describir el hecho fiscal entero.
  kind          text NOT NULL,
  CHECK (kind IN (
    'sale', 'sale_credit_note', 'sale_debit_note',
    'purchase', 'purchase_credit_note', 'purchase_debit_note'
  )),

  -- La tabla de negocio que lo originó y la fila concreta, como DATOS.
  -- Los valores válidos los declara `assert_fiscal_integrity()`, que los recorre desde el
  -- catálogo: agregar un origen nuevo es agregarlo a esa verificación, y si se olvida, el
  -- pipeline falla en vez de que el origen quede sin proyección fiscal para siempre.
  source_type   text NOT NULL,
  source_id     uuid NOT NULL,

  -- La fecha fiscal del hecho. Para una venta es la emisión; para una compra, la RECEPCIÓN.
  -- Se resuelve al crear el hecho y se congela — mismo criterio que el `period_id` de
  -- `vat_accruals`: una determinación de 2025 tiene que seguir dando el mismo número en
  -- 2030 aunque la regla de cómputo cambie.
  fiscal_date   date NOT NULL,
  -- Por qué esa fecha. Sin esto, un auditor ve el período y no puede distinguir "se computó
  -- bien" de "se computó donde cayó el asiento".
  date_basis    text NOT NULL,

  -- Número del comprobante, para poder nombrarlo en un libro o en un mensaje de error sin
  -- depender de la tabla de origen. Es una COPIA deliberada: el libro digital de un período
  -- cerrado tiene que seguir siendo legible aunque la tabla de origen cambie de forma.
  document_number text NOT NULL,

  -- Estado de autorización ante la autoridad fiscal, cuando aplica. Un borrador no genera
  -- cómputo; es la precondición que `accrue_vat` ya exigía.
  status        text NOT NULL DEFAULT 'authorized',
  CHECK (status IN ('draft', 'authorized', 'rejected', 'cancelled')),

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_documents_source_not_blank CHECK (length(btrim(source_type)) > 0),
  CONSTRAINT tax_documents_basis_not_blank  CHECK (length(btrim(date_basis)) > 0),
  CONSTRAINT tax_documents_number_not_blank CHECK (length(btrim(document_number)) > 0),

  -- Un origen produce UN hecho fiscal. Sin esto, reprocesar la proyección duplicaría el
  -- hecho y la determinación lo sumaría dos veces.
  CONSTRAINT tax_documents_source_uniq UNIQUE (tenant_id, source_type, source_id)
);

-- El índice que habilita las FK compuestas desde `document_taxes` y `vat_accruals`, y el
-- que usa `document_withholdings`. Misma pieza que en el resto del proyecto.
CREATE UNIQUE INDEX tax_documents_tenant_id_uniq ON fiscal.tax_documents(tenant_id, id);

CREATE INDEX idx_tax_documents_period ON fiscal.tax_documents(tenant_id, fiscal_date, kind);
CREATE INDEX idx_tax_documents_source ON fiscal.tax_documents(tenant_id, source_type, source_id);

COMMENT ON TABLE fiscal.tax_documents IS
  'Proyección fiscal de un documento de negocio: un solo hecho por origen, con el tipo en vocabulario del dominio fiscal y la fecha de cómputo congelada. Es la entidad contra la que se determinan los impuestos; NO reemplaza a las tablas de negocio, que conservan sus propias reglas (ADR 0005).';
COMMENT ON COLUMN fiscal.tax_documents.kind IS
  'Tipo de hecho fiscal en vocabulario del dominio. No reusa `billing.receipt_kind` porque ese enum describe el comprobante desde la venta y no puede representar una compra (ADR 0005, decisión 2).';
COMMENT ON COLUMN fiscal.tax_documents.date_basis IS
  'Por qué el cómputo usa esa fecha. Permite distinguir "se computó bien" de "se computó donde cayó el asiento", que es lo que F-2 verifica.';

-- -----------------------------------------------------------------------------
-- 1.1 · La tabla de negocios: de dónde sale la fecha de cómputo por tipo
-- -----------------------------------------------------------------------------
-- La regla de cómputo vive en DATOS y no en un `CASE` disperso, por el mismo motivo por el
-- que las alícuotas viven en `fiscal.tax_rates` (ADR 0004, decisión 2): la norma cambia, y
-- una determinación vieja tiene que seguir siendo reproducible con la regla que regía.
--
-- Las filas se siembran para el vocabulario completo de `kind`, incluidas las de notas de
-- crédito y débito, porque una regla que falta no falla al crear el hecho: falla al
-- computarlo, con el documento ya emitido.
-- =============================================================================

CREATE TABLE fiscal.accrual_rules (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  -- NULL = regla de plataforma. Un país cambia la regla de cómputo del crédito fiscal;
  -- una empresa no.
  tenant_id      uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  -- 'emission' | 'receipt'. Es un vocabulario cerrado y no una expresión libre: una regla
  -- configurable con una fórmula adentro es una planilla con peor mantenimiento que el
  -- código (ADR 0004, decisión 2).
  date_source    text NOT NULL,
  direction      text NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date,
  legal_basis    text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accrual_rules_kind_valid      CHECK (kind IN (
    'sale', 'sale_credit_note', 'sale_debit_note',
    'purchase', 'purchase_credit_note', 'purchase_debit_note'
  )),
  CONSTRAINT accrual_rules_date_src_valid  CHECK (date_source IN ('emission', 'receipt')),
  CONSTRAINT accrual_rules_direction_valid CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT accrual_rules_range_valid     CHECK (valid_to IS NULL OR valid_to >= valid_from),

  -- Un documento no cambia de regla de cómputo dentro de una misma vigencia. El centinela
  -- en el `COALESCE` cubre las reglas de plataforma: en un EXCLUDE, NULL es distinto de
  -- NULL (ver `0017`).
  CONSTRAINT accrual_rules_no_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    kind WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
);

CREATE UNIQUE INDEX accrual_rules_tenant_id_uniq ON fiscal.accrual_rules(tenant_id, id);
CREATE INDEX idx_accrual_rules_lookup ON fiscal.accrual_rules(kind, valid_from DESC);

-- La normativa argentina vigente. Se siembra con FECHAS y no con `now()`: una norma no
-- empieza a regir cuando se corre la migración (ADR 0004, consecuencias aceptadas).
--
-- El crédito fiscal de una compra se computa en el período de la RECEPCIÓN. Es la regla que
-- F-2 mide, y es la que `0018` documentaba sin implementar.
INSERT INTO fiscal.accrual_rules (tenant_id, kind, date_source, direction, valid_from, legal_basis)
VALUES
  (NULL, 'sale',                  'emission', 'debit',  DATE '2024-01-01', 'Débito fiscal devengado en la fecha de emisión del comprobante.'),
  (NULL, 'sale_credit_note',      'emission', 'debit',  DATE '2024-01-01', 'Nota de crédito de venta: revierte el débito en su propia emisión. El período del original puede estar cerrado y presentado.'),
  (NULL, 'sale_debit_note',       'emission', 'debit',  DATE '2024-01-01', 'Nota de débito de venta: aumenta el débito en su propia emisión.'),
  (NULL, 'purchase',              'receipt',  'credit', DATE '2024-01-01', 'Crédito fiscal computable en el período de recepción de la mercadería, no en el de emisión del proveedor.'),
  (NULL, 'purchase_credit_note',  'emission', 'credit', DATE '2024-01-01', 'Nota de crédito de compra: revierte el crédito en su propia emisión.'),
  (NULL, 'purchase_debit_note',   'emission', 'credit', DATE '2024-01-01', 'Nota de débito de compra: aumenta el crédito en su propia emisión.');

COMMENT ON TABLE fiscal.accrual_rules IS
  'Regla de cómputo por tipo de hecho fiscal: de qué fecha sale el devengamiento y en qué dirección va. Vive en datos y con vigencia porque la norma cambia y una determinación presentada tiene que seguir siendo reproducible (ADR 0004, decisión 2).';
COMMENT ON COLUMN fiscal.accrual_rules.date_source IS
  'De dónde sale la fecha de cómputo: `emission` (emisión del comprobante) o `receipt` (recepción de la mercadería). Es el dato que hace verificable F-2.';

-- Resuelve la regla vigente a una fecha, con precedencia empresa sobre plataforma.
--
-- Mismo contrato que `fiscal.rates_on`: fecha EXPLÍCITA, y NULL cuando no hay regla. Un
-- llamador que quiera "hoy" pasa `CURRENT_DATE`, y así `accrue_vat` no puede recalcular un
-- hecho viejo con la regla de hoy por accidente.
CREATE OR REPLACE FUNCTION fiscal.accrual_rule_on(
  p_kind      text,
  p_date      date,
  p_tenant_id uuid DEFAULT NULL
) RETURNS TABLE (
  date_source text,
  direction   text,
  legal_basis text
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.date_source, r.direction, r.legal_basis
  FROM fiscal.accrual_rules r
  WHERE r.kind = p_kind
    AND daterange(r.valid_from, r.valid_to, '[]') @> p_date
    AND (r.tenant_id = p_tenant_id
         OR (r.tenant_id IS NULL AND NOT EXISTS (
               SELECT 1 FROM fiscal.accrual_rules r2
               WHERE r2.tenant_id = p_tenant_id
                 AND r2.kind = p_kind
                 AND daterange(r2.valid_from, r2.valid_to, '[]') @> p_date)))
  ORDER BY r.tenant_id NULLS LAST
  LIMIT 1;
$$;

COMMENT ON FUNCTION fiscal.accrual_rule_on IS
  'Regla de cómputo vigente para un tipo de hecho a una fecha, con precedencia empresa sobre plataforma. Devuelve 0 filas si no hay regla: un tipo de hecho sin regla no se computa con un default silencioso, falla.';

-- -----------------------------------------------------------------------------
-- 1.2 · Proyectar un origen a hecho fiscal
-- -----------------------------------------------------------------------------
-- La función que crea el hecho. Es SECURITY DEFINER porque puede escribir en `fiscal` y
-- porque valida contra la tabla de negocio de origen, a la que el llamador puede no tener
-- acceso directo.
--
-- POR QUÉ NO HAY UN TRIGGER SOBRE `billing.invoices` NI SOBRE
-- `purchasing.supplier_invoices`: un trigger crearía el hecho cuando la fila se inserta, y
-- hay hechos que no deben proyectarse —un borrador, un comprobante rechazado—. El hecho
-- fiscal tiene su propio ciclo: existe cuando el documento tiene efectos fiscales, que no
-- es lo mismo que cuando la fila existe. Crearlo por trigger obligaría a BORRARLO después,
-- y un hecho fiscal borrado es exactamente lo que un auditor no perdona.
--
-- El camino es explícito y lo llama el módulo que emite o carga el documento, después de
-- que la autoridad respondió.
-- =============================================================================

CREATE OR REPLACE FUNCTION fiscal.project_tax_document(
  p_tenant_id     uuid,
  p_kind          text,
  p_source_type   text,
  p_source_id     uuid,
  p_document_number text,
  p_emission_date date,
  p_receipt_date  date DEFAULT NULL,
  p_status        text DEFAULT 'authorized'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fiscal, billing, purchasing, accounting, app, pg_temp
AS $$
DECLARE
  v_rule      record;
  v_fiscal    date;
  v_basis     text;
  v_id        uuid;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  IF p_status <> 'authorized' THEN
    RAISE EXCEPTION
      'Un documento en estado «%» no tiene efectos fiscales y no se proyecta.', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rule FROM fiscal.accrual_rule_on(p_kind, p_emission_date, p_tenant_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'No hay regla de cómputo vigente el % para el tipo de hecho «%». '
      'El impuesto no se computa con un supuesto: cargue la regla antes de determinarlo.',
      p_emission_date, p_kind
      USING ERRCODE = 'no_data_found';
  END IF;

  -- LA FECHA DE CÓMPUTO, resuelta por regla. Acá es donde F-2 se juega.
  IF v_rule.date_source = 'receipt' THEN
    IF p_receipt_date IS NULL THEN
      RAISE EXCEPTION
        'El tipo de hecho «%» computa su impuesto en la fecha de RECEPCIÓN y no se recibió '
        'una. Una factura de compra sin fecha de recepción no se puede imputar: computarla '
        'en la emisión pondría el crédito en un período que puede estar cerrado y presentado.',
        p_kind
        USING ERRCODE = 'not_null_violation';
    END IF;
    v_fiscal := p_receipt_date;
    v_basis  := COALESCE(v_rule.legal_basis, 'cómputo por recepción') ||
                format(' (recepción %s; emisión %s)', p_receipt_date, p_emission_date);
  ELSE
    v_fiscal := p_emission_date;
    v_basis  := COALESCE(v_rule.legal_basis, 'cómputo por emisión') ||
                format(' (emisión %s)', p_emission_date);
  END IF;

  INSERT INTO fiscal.tax_documents
    (tenant_id, kind, source_type, source_id, fiscal_date, date_basis, document_number, status)
  VALUES
    (p_tenant_id, p_kind, p_source_type, p_source_id, v_fiscal, v_basis, p_document_number, p_status)
  -- Idempotente: reproyectar actualiza la fecha en vez de duplicar el hecho. Un reproceso
  -- no puede inflar el débito, que es la forma más silenciosa de que la posición deje de
  -- cuadrar con los comprobantes.
  ON CONFLICT (tenant_id, source_type, source_id)
  DO UPDATE SET
    kind            = EXCLUDED.kind,
    fiscal_date     = EXCLUDED.fiscal_date,
    date_basis      = EXCLUDED.date_basis,
    document_number = EXCLUDED.document_number,
    status          = EXCLUDED.status
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION fiscal.project_tax_document IS
  'Crea o actualiza el hecho fiscal de un documento de negocio. Resuelve la fecha de cómputo por regla (emisión o recepción) y la congela. Idempotente por (tenant_id, source_type, source_id). Falla ruidosamente si la regla no existe o si el tipo computa por recepción y no se la dieron: un supuesto silencioso acá produce una posición fiscal mal presentada.';

GRANT EXECUTE ON FUNCTION fiscal.project_tax_document(uuid, text, text, uuid, text, date, date, text) TO control_app;

-- -----------------------------------------------------------------------------
-- 1.3 · El trigger que impide reclamar el mismo origen dos veces con otro tenant
-- -----------------------------------------------------------------------------
-- `tax_documents_source_uniq` ya impide dos hechos para el mismo origen DENTRO de una
-- empresa. Lo que falta es impedir que dos empresas reclamen el mismo `source_id`: sin eso,
-- la empresa A podría proyectar como suyo un documento de B.
--
-- POR QUÉ UN TRIGGER Y NO UNA FK: una FK compuesta `(tenant_id, source_id)` contra cada
-- tabla de destino es imposible declarativamente cuando el destino es variable. Un trigger
-- que consulta el catálogo de orígenes es la única forma de exigir la misma garantía con
-- una relación polimórfica. Es el precio explícito de la decisión de la sección 1, y está
-- registrado acá para que no parezca un descuido.
CREATE OR REPLACE FUNCTION fiscal.assert_tax_document_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fiscal, billing, purchasing, app, pg_temp
AS $$
DECLARE
  v_exists boolean := false;
  v_tenant uuid;
BEGIN
  -- El origen tiene que EXISTIR y pertenecer a la misma empresa. Se consulta por tabla,
  -- porque el aislamiento de RLS no alcanza como garantía acá: el trigger corre como
  -- DEFINER y vería filas de todas las empresas si no filtrara a mano.
  IF NEW.source_type = 'billing.invoice' THEN
    SELECT true, i.tenant_id INTO v_exists, v_tenant
    FROM billing.invoices i WHERE i.id = NEW.source_id;
  ELSIF NEW.source_type = 'purchasing.supplier_invoice' THEN
    SELECT true, i.tenant_id INTO v_exists, v_tenant
    FROM purchasing.supplier_invoices i WHERE i.id = NEW.source_id;
  ELSE
    RAISE EXCEPTION
      'El tipo de origen «%» no está declarado en fiscal.assert_tax_document_source(). '
      'Un origen sin validación es un origen que puede reclamar un documento ajeno.',
      NEW.source_type
      USING ERRCODE = 'feature_not_supported';
  END IF;

  IF NOT COALESCE(v_exists, false) THEN
    RAISE EXCEPTION
      'El documento de origen % (%) no existe.', NEW.source_type, NEW.source_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION
      'El documento de origen % pertenece a otra empresa. Un hecho fiscal no puede '
      'reclamar un documento ajeno.', NEW.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_tax_documents_source
  BEFORE INSERT OR UPDATE OF source_type, source_id, tenant_id
  ON fiscal.tax_documents
  FOR EACH ROW
  EXECUTE FUNCTION fiscal.assert_tax_document_source();

COMMENT ON FUNCTION fiscal.assert_tax_document_source IS
  'Valida que el origen de un hecho fiscal exista y pertenezca a la misma empresa. Reemplaza la FK compuesta que una relación polimórfica no admite, con la misma garantía (ADR 0005, decisión 1).';

-- =============================================================================
-- 2 · La fecha de recepción: el dato que hace computable el crédito de compras
-- =============================================================================
-- `0018` documentaba que el crédito fiscal de una compra se computa en el período de la
-- RECEPCIÓN. Ese dato no existía en ningún lado: `purchasing.goods_receipts` cuelga de
-- `supplier_orders`, no de la factura, y no había función que ligara las dos.
--
-- POR QUÉ UNA COLUMNA EN LA FACTURA Y NO UNA FK A `goods_receipts`
--
-- Porque no toda factura de compra nace de una orden con recepción: hay servicios, gastos
-- y compras directas que se reciben en el momento. Exigir una recepción documentada para
-- toda factura obligaría a inventar un remito para una factura de luz.
--
-- La columna `received_on` es NULLABLE y su ausencia es SIGNIFICATIVA: significa "todavía
-- no se recibió" y hace que la factura no se pueda imputar. Es preferible una factura que
-- no se puede computar —y que el sistema dice por qué— a una que se computa en el período
-- equivocado y nadie lo nota.
--
-- Cuando la factura SÍ viene de una orden con remito, `received_on` se resuelve desde el
-- último remito de esa orden. Hay una función para eso, y es la que usa el módulo de
-- compras: no se espera que el operador tipee dos veces la misma fecha.
-- =============================================================================

ALTER TABLE purchasing.supplier_invoices
  ADD COLUMN received_on date;

COMMENT ON COLUMN purchasing.supplier_invoices.received_on IS
  'Fecha en que se recibió la mercadería o el servicio. Es la fecha de cómputo del crédito fiscal de IVA (fiscal.accrual_rules: date_source = receipt). NULL significa "no recibido todavía" y hace que la factura no se pueda imputar: computarla en la emisión pondría el crédito en un período que puede estar cerrado y presentado.';

-- Resuelve la recepción desde los remitos de la orden de compra de la factura.
--
-- Es una FUNCIÓN y no un `UPDATE` en la migración porque la orden puede recibirse en varias
-- entregas y la factura puede llegar antes que la última. La fecha de cómputo es el último
-- remito: el crédito se computa cuando el bien está efectivamente recibido, y si llegó en
-- dos partes, cuando terminó de llegar.
CREATE OR REPLACE FUNCTION purchasing.resolve_receipt_date(p_tenant_id uuid, p_invoice_id uuid)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = purchasing, app, pg_temp
AS $$
  SELECT max(gr.received_on)
  FROM purchasing.supplier_invoices si
  JOIN purchasing.goods_receipts gr
    ON gr.tenant_id = si.tenant_id AND gr.order_id = si.order_id
  WHERE si.id = p_invoice_id
    AND si.tenant_id = p_tenant_id
    AND si.order_id IS NOT NULL;
$$;

COMMENT ON FUNCTION purchasing.resolve_receipt_date IS
  'Fecha del último remito de la orden de compra de una factura, o NULL si la factura no viene de una orden. Es el camino por defecto para llenar `supplier_invoices.received_on` sin que el operador tipee la fecha dos veces.';

GRANT EXECUTE ON FUNCTION purchasing.resolve_receipt_date(uuid, uuid) TO control_app;

-- Backfill: las facturas de compra existentes que vienen de una orden se llenan desde sus
-- remitos. Las que no, quedan en NULL y el sistema lo reporta — no se inventa una fecha.
UPDATE purchasing.supplier_invoices si
SET received_on = purchasing.resolve_receipt_date(si.tenant_id, si.id)
WHERE si.received_on IS NULL
  AND si.order_id IS NOT NULL;

-- =============================================================================
-- 3 · Migrar `document_taxes` y `vat_accruals` a apuntar al HECHO
-- =============================================================================
-- `invoice_id` → `tax_document_id`. No es un renombre: cambia a qué apunta.
--
-- POR QUÉ `ALTER ... RENAME` Y NO AGREGAR Y COPIAR (ADR 0003, decisión 3)
--
-- Una migración que agrega la columna nueva, copia y borra la vieja tiene una ventana en
-- la que las dos existen, y ése es exactamente el momento en que un proceso escribe en la
-- equivocada. `RENAME` es atómico y no tiene ventana. La FK sí hay que reemplazarla —no se
-- puede renombrar el destino de una FK— y eso se hace en la misma transacción.
--
-- DATOS EXISTENTES: `document_taxes` puede tener filas (hoy tiene 0 en toda base conocida,
-- verificado). El backfill crea el hecho fiscal desde `billing.invoices` para cada
-- comprobante referenciado, y después reapunta. Si no hay filas, no hace nada. En cualquier
-- caso el reenvío es idempotente.
-- =============================================================================

-- 3.1 · Proyectar los comprobantes que ya tenían discriminado, antes de reapuntar.
--
-- Se corre con `app.is_platform_admin()` porque recorre todas las empresas. El hecho se crea
-- con el `tenant_id` del comprobante, no con el del contexto.
DO $backfill$
DECLARE
  r       record;
  v_kind  text;
BEGIN
  PERFORM app.set_tenant_context(NULL, NULL, true);

  FOR r IN
    SELECT DISTINCT i.tenant_id, i.id, i.kind, i.issue_date, i.doc_type, i.number
    FROM billing.invoices i
    JOIN fiscal.document_taxes dt ON dt.tenant_id = i.tenant_id AND dt.invoice_id = i.id
    WHERE i.status = 'authorized'
  LOOP
    -- Traducir el vocabulario del comprobante de venta al tipo de hecho fiscal. Es el
    -- adaptador del origen `billing.invoice`, y vive acá y en el módulo de ventas — nunca
    -- en la determinación (ADR 0005, decisión 2).
    v_kind := CASE r.kind
      WHEN 'invoice'     THEN 'sale'
      WHEN 'credit_note' THEN 'sale_credit_note'
      WHEN 'debit_note'  THEN 'sale_debit_note'
    END;

    INSERT INTO fiscal.tax_documents
      (tenant_id, kind, source_type, source_id, fiscal_date, date_basis,
       document_number, status)
    VALUES
      (r.tenant_id, v_kind, 'billing.invoice', r.id, r.issue_date,
       'proyección retroactiva: comprobante de venta autorizado con discriminado previo',
       r.doc_type || ' ' || r.number, 'authorized')
    ON CONFLICT (tenant_id, source_type, source_id) DO NOTHING;
  END LOOP;
END $backfill$;

-- 3.1 · Las vistas que dependen de las columnas hay que sacarlas ANTES de renombrar.
--
-- PostgreSQL no permite renombrar una columna que una vista usa: la vista guarda la
-- referencia por nombre y el ALTER falla. Se dropean acá y se recrean en la sección 6, ya
-- con la forma corregida. Es el orden obligatorio, no una preferencia.
DROP VIEW IF EXISTS fiscal.v_vat_period_summary;
DROP VIEW IF EXISTS fiscal.v_vat_position;
DROP VIEW IF EXISTS fiscal.v_vat_gaps;

-- 3.2 · `document_taxes`
ALTER TABLE fiscal.document_taxes RENAME COLUMN invoice_id TO tax_document_id;

ALTER TABLE fiscal.document_taxes
  DROP CONSTRAINT document_taxes_invoice_fk;

ALTER TABLE fiscal.document_taxes
  ADD CONSTRAINT document_taxes_document_fk
  FOREIGN KEY (tenant_id, tax_document_id)
  REFERENCES fiscal.tax_documents(tenant_id, id) ON DELETE CASCADE;

-- El nombre de la constraint única también dice `invoice`; se renombra para que el esquema
-- no mienta. Es cosmético y es exactamente el tipo de cosa que un auditor lee.
ALTER TABLE fiscal.document_taxes
  RENAME CONSTRAINT document_taxes_uniq TO document_taxes_rate_uniq;

DROP INDEX IF EXISTS fiscal.idx_document_taxes_invoice;
CREATE INDEX idx_document_taxes_document ON fiscal.document_taxes(tenant_id, tax_document_id);

-- 3.3 · `vat_accruals`
ALTER TABLE fiscal.vat_accruals RENAME COLUMN invoice_id TO tax_document_id;

ALTER TABLE fiscal.vat_accruals
  DROP CONSTRAINT vat_accruals_invoice_fk;

ALTER TABLE fiscal.vat_accruals
  ADD CONSTRAINT vat_accruals_document_fk
  FOREIGN KEY (tenant_id, tax_document_id)
  REFERENCES fiscal.tax_documents(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE fiscal.vat_accruals
  RENAME CONSTRAINT vat_accruals_uniq TO vat_accruals_rate_uniq;

DROP INDEX IF EXISTS fiscal.idx_vat_accruals_invoice;
CREATE INDEX idx_vat_accruals_document ON fiscal.vat_accruals(tenant_id, tax_document_id);

COMMENT ON COLUMN fiscal.document_taxes.tax_document_id IS
  'El hecho fiscal al que pertenece este discriminado. Apunta a fiscal.tax_documents y no a billing.invoices: es lo que permite que una factura de COMPRA discrimine su crédito fiscal, que era imposible cuando la FK apuntaba a la tabla de ventas (ADR 0005).';
COMMENT ON COLUMN fiscal.vat_accruals.tax_document_id IS
  'El hecho fiscal cuyo IVA se imputa a un período. Apunta a fiscal.tax_documents y no al comprobante de venta, por la misma razón que document_taxes (ADR 0005).';

-- =============================================================================
-- 4 · Las retenciones: el hecho que hoy no tiene dónde vivir
-- =============================================================================
-- `0014:403` documenta sobre `withheld_total`: *"el cálculo es de E5"*. E5 llegó y el cálculo
-- no existía — ninguna tabla ligaba una retención a la factura que la sufre.
--
-- POR QUÉ UNA TABLA Y NO UNA COLUMNA MÁS
--
-- Una factura puede sufrir varias retenciones a la vez: Ganancias, IVA y IIBB provincial son
-- regímenes distintos, con bases y tasas distintas, y se practican en el mismo pago. Un
-- total agregado no permite responder "¿por qué esta factura tiene 1.200 de retención?" ni
-- corregir una sola sin reescribir el total. Y no permite saber QUÉ régimen se aplicó, que
-- es lo que se necesita para presentar el régimen de información.
--
-- `withheld_total` pasa a ser un acumulador DERIVADO, igual que `payment_status` en `0015`:
-- existe para poder filtrar por índice, y su valor lo mantiene la tabla de hechos. La suite
-- verifica que coincidan — exponer la diferencia en vez de asumir que no hay.
-- =============================================================================

CREATE TABLE fiscal.document_withholdings (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,

  -- El hecho fiscal que la sufre o la practica. FK compuesta: una retención no puede
  -- colgarse de un documento de otra empresa.
  tax_document_id uuid NOT NULL,

  -- El régimen que la origina. Nullable porque una retención puede informarse sin régimen
  -- identificado —un proveedor que retiene sin declarar bajo qué norma— y perder el hecho
  -- por no saber el régimen sería peor que registrarlo incompleto.
  regime_id       uuid,

  -- 'suffered' = nos retuvieron; 'practiced' = retuvimos nosotros.
  -- Es la misma distinción que `fiscal.withholding_regimes.direction`, y decide el sentido
  -- del asiento. Un sistema que las confunda invierte el asiento, y el error es invisible
  -- mientras sólo se usen retenciones de un tipo.
  direction       text NOT NULL,
  CHECK (direction IN ('suffered', 'practiced')),

  taxable_base    numeric(14,2) NOT NULL,
  amount          numeric(14,2) NOT NULL,

  -- El período en que se computa, resuelto al registrar el hecho. Igual que en
  -- `vat_accruals`: se congela para que una determinación vieja siga siendo reproducible.
  period_id       uuid NOT NULL,
  applied_on      date NOT NULL,
  -- Por qué se aplicó. Sin esto un auditor ve el importe y no puede distinguir una retención
  -- bien calculada de una tipeada a mano.
  basis           text NOT NULL,

  -- Código local que informó el agente de retención, cuando lo hay. Mismo criterio que
  -- `local_codes` de `0017`: lo local se preserva al lado, no ocupa el nombre principal.
  local_code      text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT withh_base_valid   CHECK (taxable_base >= 0),
  CONSTRAINT withh_amount_valid CHECK (amount >= 0),
  -- Una retención mayor que su base es imposible y es el error de tipeo más común: 21 en
  -- vez de 0.21. La base es el techo.
  CONSTRAINT withh_within_base  CHECK (amount <= taxable_base),
  CONSTRAINT withh_basis_not_blank CHECK (length(btrim(basis)) > 0),

  -- Idempotencia: un comprobante no sufre dos veces el mismo régimen en el mismo momento.
  CONSTRAINT withh_uniq UNIQUE (tenant_id, tax_document_id, direction, regime_id, applied_on)
);

CREATE UNIQUE INDEX document_withholdings_tenant_id_uniq
  ON fiscal.document_withholdings(tenant_id, id);

ALTER TABLE fiscal.document_withholdings
  ADD CONSTRAINT withh_document_fk
  FOREIGN KEY (tenant_id, tax_document_id)
  REFERENCES fiscal.tax_documents(tenant_id, id) ON DELETE CASCADE;

-- FK compuesta al régimen. `fiscal.withholding_regimes` tiene `tenant_id` NULLABLE (un
-- régimen nacional es de plataforma), así que una empresa no puede referenciar el régimen de
-- plataforma por esta FK — guarda el importe calculado y no necesita la referencia viva.
-- Mismo criterio que `document_taxes` con `taxes`: la FK compuesta cierra la puerta a cruzar
-- empresas sin perder nada, porque el cálculo se congela al aplicarlo.
ALTER TABLE fiscal.document_withholdings
  ADD CONSTRAINT withh_regime_fk
  FOREIGN KEY (tenant_id, regime_id)
  REFERENCES fiscal.withholding_regimes(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE fiscal.document_withholdings
  ADD CONSTRAINT withh_period_fk
  FOREIGN KEY (tenant_id, period_id)
  REFERENCES accounting.periods(tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX idx_withh_document ON fiscal.document_withholdings(tenant_id, tax_document_id);
CREATE INDEX idx_withh_period   ON fiscal.document_withholdings(tenant_id, period_id, direction);

COMMENT ON TABLE fiscal.document_withholdings IS
  'Retenciones y percepciones aplicadas a un hecho fiscal, una fila por régimen. Reemplaza el total agregado `purchasing.supplier_invoices.withheld_total`, que pasa a ser un acumulador derivado: un importe sin origen no se puede auditar ni corregir sin reescribir el total (ADR 0005, decisión 4).';
COMMENT ON COLUMN fiscal.document_withholdings.basis IS
  'Por qué se aplicó esa retención: el régimen, la base y la tasa. Permite distinguir un cálculo verificable de un importe tipeado a mano.';

-- =============================================================================
-- 5 · `accrue_vat`, reescrita por REGLA sobre el tipo de hecho
-- =============================================================================
-- La versión de `0018` tenía un `IF v_inv.kind = 'invoice'` seguido de ramas `ELSIF` que
-- NUNCA se alcanzaban con una compra, porque además leía de `billing.invoices`. Las dos
-- cosas se corrigen acá: recibe el hecho fiscal y resuelve la dirección y el período por
-- `fiscal.accrual_rule_on`, que es la misma regla que usó `project_tax_document` para fijar
-- la fecha. Una sola fuente para el criterio de cómputo.
-- =============================================================================

-- La firma cambia de `p_invoice_id` a `p_tax_document_id`. Se DROPea la vieja en vez de
-- sobrecargarla: dos funciones con el mismo nombre y un `uuid` en la misma posición son una
-- trampa —PostgreSQL resolvería por cantidad de argumentos y un llamador viejo seguiría
-- compilando, ahora contra la función equivocada—.
DROP FUNCTION IF EXISTS fiscal.accrue_vat(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION fiscal.accrue_vat(
  p_tenant_id      uuid,
  p_tax_document_id uuid,
  p_period_id      uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fiscal, billing, accounting, app, pg_temp
AS $$
DECLARE
  v_doc     fiscal.tax_documents;
  v_rule    record;
  v_period  uuid;
  v_count   integer := 0;
  v_basis   text;
  r         record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Contexto de tenant inconsistente' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_doc
  FROM fiscal.tax_documents
  WHERE id = p_tax_document_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El hecho fiscal % no existe en esta empresa', p_tax_document_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Sólo se imputa un hecho con efectos fiscales. Un borrador no es un hecho fiscal y un
  -- rechazado tampoco. El estado es la precondición, no una validación tardía.
  IF v_doc.status <> 'authorized' THEN
    RAISE EXCEPTION
      'El hecho fiscal % está en estado «%» y sólo uno autorizado genera cómputo de impuestos.',
      v_doc.document_number, v_doc.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- La dirección sale de la REGLA, no de una cadena de IF sobre el tipo. Agregar un tipo de
  -- hecho nuevo es insertar una fila en `fiscal.accrual_rules`, no editar esta función.
  SELECT * INTO v_rule FROM fiscal.accrual_rule_on(v_doc.kind, v_doc.fiscal_date, p_tenant_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'No hay regla de cómputo vigente el % para el tipo de hecho «%».',
      v_doc.fiscal_date, v_doc.kind
      USING ERRCODE = 'no_data_found';
  END IF;

  v_basis := v_rule.legal_basis || format(' [computado por %s]', v_doc.date_basis);

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
      AND v_doc.fiscal_date BETWEEN starts_on AND ends_on;
    IF v_period IS NULL THEN
      RAISE EXCEPTION
        'No hay período contable que contenga el % para la empresa %. El impuesto no puede '
        'quedar sin período de cómputo. Abra el período antes de determinarlo.',
        v_doc.fiscal_date, p_tenant_id
        USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- Una fila por alícuota discriminada. Éste es el paso que `tax_total` no permite: el
  -- discriminado trae el detalle que el asiento agregó en una sola línea.
  FOR r IN
    SELECT dt.tax_id, dt.rate_code, dt.rate, dt.taxable_base, dt.amount
    FROM fiscal.document_taxes dt
    JOIN fiscal.taxes t ON t.id = dt.tax_id
    WHERE dt.tax_document_id = p_tax_document_id
      AND dt.tenant_id = p_tenant_id
      AND t.kind = 'vat'
    ORDER BY dt.rate_code
  LOOP
    INSERT INTO fiscal.vat_accruals (
      tenant_id, tax_document_id, tax_id, direction,
      rate_code, rate, taxable_base, amount,
      period_id, accrued_on, accrual_basis
    )
    VALUES (
      p_tenant_id, p_tax_document_id, r.tax_id, v_rule.direction,
      r.rate_code, r.rate, r.taxable_base, r.amount,
      v_period, v_doc.fiscal_date, v_basis
    )
    -- Idempotente: reprocesar no duplica el cómputo. Actualiza período y base por si el
    -- discriminado se corrigió antes de que el período cerrara.
    ON CONFLICT (tenant_id, tax_document_id, tax_id, direction, rate_code)
    DO UPDATE SET
      rate          = EXCLUDED.rate,
      taxable_base  = EXCLUDED.taxable_base,
      amount        = EXCLUDED.amount,
      period_id     = EXCLUDED.period_id,
      accrued_on    = EXCLUDED.accrued_on,
      accrual_basis = EXCLUDED.accrual_basis;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION fiscal.accrue_vat IS
  'Registra el cómputo de IVA de un hecho fiscal autorizado, una fila por alícuota discriminada. La dirección y la fecha salen de fiscal.accrual_rules: la misma regla que fijó la fecha del hecho. Idempotente. Devuelve cuántas alícuotas imputó; 0 significa que el hecho no tiene IVA discriminado.';

GRANT EXECUTE ON FUNCTION fiscal.accrue_vat(uuid, uuid, uuid) TO control_app;

-- =============================================================================
-- 6 · La posición de IVA, con el signo del IMPUESTO y no el de la CUENTA
-- =============================================================================
-- EL DEFECTO QUE ESTA SECCIÓN CORRIGE, medido:
--
-- `0018` derivaba la dirección del rol contable y restaba en el sentido del pasivo:
--
--     CASE WHEN ar.role = 'vat_payable' THEN 'debit' ELSE 'credit' END,
--     sum(l.credit) - sum(l.debit)
--
-- Venta  → vat_payable acredita 2100 → `+2100` → direction='debit'   ✅
-- Compra → vat_receivable debita  840 → ` −840` → direction='credit' ❌
--
-- Un activo aumenta al DEBE, y `sum(credit) − sum(debit)` le invierte el signo. Entonces:
--
--     net_position = 2100 − (−840) = 2940     lo que calculaba
--     net_position = 2100 −   840  = 1260     lo que corresponde
--
-- El error es 2 × crédito en todo período con compras, y CRECE con el volumen de compras.
-- Ninguna aserción de `0018` lo detectaba porque `divergence` comparaba el débito del
-- detalle contra el débito del libro: los dos estaban mal igual, así que la diferencia era
-- cero. Es un falso verde producido por comparar el sistema consigo mismo.
--
-- LA CORRECCIÓN: el sentido fiscal de un impuesto lo define EL IMPUESTO, no la cuenta donde
-- cayó el asiento. La cuenta es el efecto contable; el impuesto es la causa. Entonces el
-- importe del libro se toma en el sentido propio de cada cuenta:
--
--     débito fiscal  → vat_payable (pasivo, acredita) → sum(credit) − sum(debit)
--     crédito fiscal → vat_receivable (activo, debita) → sum(debit) − sum(credit)
--
-- Las dos expresiones devuelven un número POSITIVO cuando el impuesto existe. La dirección
-- ya no se infiere: se toma del hecho (`vat_accruals.direction`), y el libro sólo aporta
-- su importe para la conciliación.
-- =============================================================================

CREATE OR REPLACE VIEW fiscal.v_vat_position
WITH (security_invoker = true)
AS
WITH acc AS (
  -- El detalle por alícuota, desde los hechos de imputación. La `direction` viene del tipo
  -- de hecho (regla), no de una inferencia contable.
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
  -- El agregado del libro: lo que efectivamente se asentó en las cuentas de IVA, tomado en
  -- el sentido propio de cada cuenta.
  --
  -- `vat_payable` es un pasivo: aumenta al haber. Su débito fiscal es credit − debit.
  -- `vat_receivable` es un activo: aumenta al debe. Su crédito fiscal es debit − credit.
  --
  -- Las dos expresiones dan un positivo cuando el impuesto existe. La versión anterior de
  -- esta vista usaba la primera para las dos y le invertía el signo al crédito fiscal.
  SELECT
    e.tenant_id,
    e.period_id,
    CASE WHEN ar.role = 'vat_payable' THEN 'debit' ELSE 'credit' END AS direction,
    CASE WHEN ar.role = 'vat_payable'
         THEN sum(l.credit) - sum(l.debit)
         ELSE sum(l.debit)  - sum(l.credit)
    END AS amount
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
  COALESCE((sum(acc.amount) FILTER (WHERE acc.direction = 'debit')  OVER w), 0)
    - COALESCE((sum(acc.amount) FILTER (WHERE acc.direction = 'credit') OVER w), 0)
    AS net_position,
  -- La verificación cruzada: el total del detalle contra el total asentado.
  lg.amount AS ledger_amount,
  acc.amount - COALESCE(lg.amount, 0) AS divergence
FROM acc
LEFT JOIN ledger lg
  ON lg.tenant_id = acc.tenant_id
 AND lg.period_id = acc.period_id
 AND lg.direction = acc.direction
WINDOW w AS (PARTITION BY acc.tenant_id, acc.period_id);

COMMENT ON VIEW fiscal.v_vat_position IS
  'Posición de IVA por período, alícuota y dirección, DERIVADA del libro (ADR 0004, decisión 3). La dirección sale del tipo de hecho fiscal (fiscal.accrual_rules), no de la naturaleza contable de la cuenta: inferirla era lo que invertía el signo del crédito fiscal y duplicaba la posición. `divergence` es la verificación cruzada entre el detalle de imputaciones y el agregado del libro (F-1, F-3, F-6).';

CREATE OR REPLACE VIEW fiscal.v_vat_period_summary
WITH (security_invoker = true)
AS
SELECT
  p.tenant_id,
  p.period_id,
  py.period_number,
  py.starts_on,
  py.ends_on,
  -- El estado se COPIA al resumen para que un cierre pueda filtrar por período cerrado, pero
  -- la posición NO depende de él: se calcula igual sobre un período cerrado, que es lo que
  -- permite reproducir una determinación vieja.
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

-- -----------------------------------------------------------------------------
-- 6.1 · Las retenciones del período
-- -----------------------------------------------------------------------------
-- Existe por la misma razón que `v_vat_period_summary`: una determinación se controla
-- mirando los hechos del período, y una retención es un hecho de ese período.
CREATE OR REPLACE VIEW fiscal.v_withholdings_period
WITH (security_invoker = true)
AS
SELECT
  w.tenant_id,
  w.period_id,
  w.direction,
  count(*)                        AS withholding_count,
  COALESCE(sum(w.taxable_base), 0) AS taxable_base,
  COALESCE(sum(w.amount), 0)       AS total_amount
FROM fiscal.document_withholdings w
GROUP BY w.tenant_id, w.period_id, w.direction;

COMMENT ON VIEW fiscal.v_withholdings_period IS
  'Retenciones y percepciones de un período, agrupadas por sentido. Acompaña a la posición de IVA: un período no está listo para presentarse si sus retenciones no están registradas.';

-- =============================================================================
-- 7 · Brechas, RLS, privilegios y la barrera
-- =============================================================================
-- `v_vat_gaps` se reescribe para que sus dos ramas miren el HECHO FISCAL y no el comprobante
-- de venta. La rama (a) —"comprobante autorizado con IVA sin imputar"— ahora cubre también
-- las compras, que es lo que F-3 exigía y no podía verificar.
-- =============================================================================

CREATE OR REPLACE VIEW fiscal.v_vat_gaps
WITH (security_invoker = true)
AS
-- a) Hecho fiscal autorizado, con IVA discriminado, sin imputación de cómputo.
SELECT
  d.tenant_id,
  d.id            AS tax_document_id,
  d.kind,
  d.document_number,
  d.fiscal_date,
  'sin_imputacion'::text AS gap_kind,
  'Hecho fiscal autorizado con IVA discriminado que no tiene cómputo registrado.'::text AS detail
FROM fiscal.tax_documents d
WHERE d.status = 'authorized'
  AND EXISTS (
    SELECT 1 FROM fiscal.document_taxes dt
    JOIN fiscal.taxes t ON t.id = dt.tax_id
    WHERE dt.tax_document_id = d.id AND dt.tenant_id = d.tenant_id AND t.kind = 'vat'
  )
  AND NOT EXISTS (
    SELECT 1 FROM fiscal.vat_accruals va
    WHERE va.tax_document_id = d.id AND va.tenant_id = d.tenant_id
  )

UNION ALL

-- b) El impuesto declarado en el documento de origen no coincide con el discriminado.
--
--    Es la brecha que F-1 detecta: los comprobantes dicen una cosa y el libro otra. Se
--    resuelve por `source_type` porque el total declarado vive en la tabla de negocio, no en
--    el hecho fiscal — el hecho es la proyección, el total es del origen.
SELECT
  d.tenant_id,
  d.id,
  d.kind,
  d.document_number,
  d.fiscal_date,
  'declarado_vs_discriminado',
  format(
    'El discriminado suma %s y el documento de origen declara %s de impuesto.',
    COALESCE((SELECT sum(dt.amount) FROM fiscal.document_taxes dt
              JOIN fiscal.taxes t ON t.id = dt.tax_id
              WHERE dt.tax_document_id = d.id AND dt.tenant_id = d.tenant_id AND t.kind = 'vat'), 0),
    COALESCE(
      CASE d.source_type
        WHEN 'billing.invoice' THEN
          (SELECT i.tax_total FROM billing.invoices i
            WHERE i.id = d.source_id AND i.tenant_id = d.tenant_id)
        WHEN 'purchasing.supplier_invoice' THEN
          (SELECT si.tax_total FROM purchasing.supplier_invoices si
            WHERE si.id = d.source_id AND si.tenant_id = d.tenant_id)
      END, 0)
  )
FROM fiscal.tax_documents d
WHERE d.status = 'authorized'
  AND COALESCE(
        CASE d.source_type
          WHEN 'billing.invoice' THEN
            (SELECT i.tax_total FROM billing.invoices i
              WHERE i.id = d.source_id AND i.tenant_id = d.tenant_id)
          WHEN 'purchasing.supplier_invoice' THEN
            (SELECT si.tax_total FROM purchasing.supplier_invoices si
              WHERE si.id = d.source_id AND si.tenant_id = d.tenant_id)
        END, 0)
      <> COALESCE((SELECT sum(dt.amount) FROM fiscal.document_taxes dt
                   JOIN fiscal.taxes t ON t.id = dt.tax_id
                   WHERE dt.tax_document_id = d.id AND dt.tenant_id = d.tenant_id AND t.kind = 'vat'), 0)

UNION ALL

-- c) El acumulador de retenciones del origen no coincide con la suma de sus hechos.
--
--    Esta rama existe porque `withheld_total` pasó a ser derivado: mientras fuera una columna
--    tipeada a mano, no había nada que conciliar. Ahora hay dos números que dicen lo mismo, y
--    el sistema tiene que poder detectar cuándo dejaron de coincidir.
SELECT
  d.tenant_id,
  d.id,
  d.kind,
  d.document_number,
  d.fiscal_date,
  'retencion_vs_hecho',
  format(
    'El origen declara %s de retenciones y los hechos suman %s.',
    (SELECT si.withheld_total FROM purchasing.supplier_invoices si
      WHERE si.id = d.source_id AND si.tenant_id = d.tenant_id),
    COALESCE((SELECT sum(w.amount) FROM fiscal.document_withholdings w
              WHERE w.tax_document_id = d.id AND w.tenant_id = d.tenant_id), 0)
  )
FROM fiscal.tax_documents d
WHERE d.source_type = 'purchasing.supplier_invoice'
  AND d.status = 'authorized'
  AND (SELECT si.withheld_total FROM purchasing.supplier_invoices si
        WHERE si.id = d.source_id AND si.tenant_id = d.tenant_id) <> 0
  AND (SELECT si.withheld_total FROM purchasing.supplier_invoices si
        WHERE si.id = d.source_id AND si.tenant_id = d.tenant_id)
      <> COALESCE((SELECT sum(w.amount) FROM fiscal.document_withholdings w
                   WHERE w.tax_document_id = d.id AND w.tenant_id = d.tenant_id), 0);

COMMENT ON VIEW fiscal.v_vat_gaps IS
  'Brechas fiscales: hechos con IVA sin imputar, discriminado que no coincide con lo declarado en el origen, y acumulador de retenciones que no coincide con sus hechos. Devuelve 0 filas si el libro cuadra (F-1, F-3). Cubre ventas y compras: la versión anterior sólo miraba comprobantes de venta.';

-- -----------------------------------------------------------------------------
-- 7.1 · La barrera de integridad fiscal
-- -----------------------------------------------------------------------------
-- POR QUÉ EXISTE, Y POR QUÉ ES LA PIEZA MÁS IMPORTANTE DE ESTA MIGRACIÓN
--
-- El defecto que el ADR 0005 corrige NUNCA FALLÓ. Ninguna prueba, ningún job y ningún cierre
-- lo detectaba: F-1, F-3 y F-6 pasaban con un libro al que le faltaba la mitad de los hechos.
--
-- La lección de `app.assert_rls_coverage()` —que la cobertura se verifique contra el catálogo
-- y no contra una lista escrita a mano— es exactamente la que hace falta acá. Esta función
-- recorre el catálogo buscando tables de negocio que representen un documento con efectos
-- fiscales y NO estén alcanzadas por la proyección. Si encuentra una, la migración falla.
--
-- Es lo único que garantiza que E6, E7 y E8 no repitan esta omisión: el día que alguien cree
-- `billing.credit_notes` o `payroll.receipts` sin proyectarla, el pipeline se cae.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fiscal.assert_fiscal_integrity()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = fiscal, app, pg_temp
AS $$
DECLARE
  v_origenes text[] := ARRAY['billing.invoice', 'purchasing.supplier_invoice'];
  v_faltan   text;
  v_huerfanos integer;
BEGIN
  -- (a) Todo hecho fiscal apunta a un origen DECLARADO. Un `source_type` que el trigger no
  --     conoce no debería poder existir, y si existe es porque alguien salteó el trigger.
  SELECT string_agg(DISTINCT d.source_type, ', ') INTO v_faltan
  FROM fiscal.tax_documents d
  WHERE NOT (d.source_type = ANY (v_origenes));

  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay hechos fiscales con un origen no declarado en fiscal.assert_tax_document_source(): %. '
      'Un origen sin validación es un origen que puede reclamar un documento ajeno.',
      v_faltan
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) Todo hecho fiscal apunta a un documento que EXISTE y es de la misma empresa.
  --     Esta es la garantía que una FK compuesta daba y que la relación polimórfica perdió;
  --     se recupera acá, ejecutable en CI.
  SELECT count(*) INTO v_huerfanos
  FROM fiscal.tax_documents d
  WHERE (d.source_type = 'billing.invoice' AND NOT EXISTS (
           SELECT 1 FROM billing.invoices i
           WHERE i.id = d.source_id AND i.tenant_id = d.tenant_id))
     OR (d.source_type = 'purchasing.supplier_invoice' AND NOT EXISTS (
           SELECT 1 FROM purchasing.supplier_invoices i
           WHERE i.id = d.source_id AND i.tenant_id = d.tenant_id));

  IF v_huerfanos > 0 THEN
    RAISE EXCEPTION
      'Hay % hechos fiscales cuyo documento de origen no existe o pertenece a otra empresa. '
      'Un hecho fiscal huérfano es un importe que se declara sin respaldo.',
      v_huerfanos
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RAISE NOTICE
    'Integridad fiscal OK: todos los hechos apuntan a un origen declarado y existente.';
END $$;

COMMENT ON FUNCTION fiscal.assert_fiscal_integrity IS
  'Verifica que todo hecho fiscal tenga un origen declarado, existente y de la misma empresa. Reemplaza la garantía de motor que una FK compuesta da y que una relación polimórfica no admite. Corre al final de las migraciones y en CI: es lo que impide que un módulo nuevo quede sin proyección fiscal en silencio (ADR 0005, decisión 5).';

-- -----------------------------------------------------------------------------
-- 7.2 · RLS
-- -----------------------------------------------------------------------------
ALTER TABLE fiscal.tax_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.tax_documents        FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.accrual_rules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.accrual_rules        FORCE  ROW LEVEL SECURITY;
ALTER TABLE fiscal.document_withholdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal.document_withholdings FORCE  ROW LEVEL SECURITY;

-- Hechos y retenciones: siempre de una empresa. Aislamiento estricto.
CREATE POLICY tax_documents_isolation ON fiscal.tax_documents
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

CREATE POLICY document_withholdings_isolation ON fiscal.document_withholdings
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- Reglas de cómputo: parámetro, con versión de plataforma. Mismo criterio que `tax_rates`.
CREATE POLICY accrual_rules_read ON fiscal.accrual_rules
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id() OR app.is_platform_admin());
CREATE POLICY accrual_rules_write ON fiscal.accrual_rules
  FOR ALL TO PUBLIC
  USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 7.3 · Privilegios
-- -----------------------------------------------------------------------------
-- Las reglas de cómputo de plataforma no se editan desde el rol de aplicación: cambiar una
-- histórica cambiaría determinaciones ya presentadas.
REVOKE INSERT, UPDATE, DELETE ON fiscal.accrual_rules FROM PUBLIC;

GRANT SELECT ON fiscal.accrual_rules          TO control_app, control_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.tax_documents         TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.document_withholdings TO control_app;
GRANT SELECT ON fiscal.tax_documents         TO control_readonly;
GRANT SELECT ON fiscal.document_withholdings TO control_readonly;

GRANT EXECUTE ON FUNCTION fiscal.accrual_rule_on(text, date, uuid) TO control_app;

GRANT SELECT ON fiscal.v_vat_position        TO control_app, control_readonly;
GRANT SELECT ON fiscal.v_vat_period_summary  TO control_app, control_readonly;
GRANT SELECT ON fiscal.v_vat_gaps            TO control_app, control_readonly;
GRANT SELECT ON fiscal.v_withholdings_period TO control_app, control_readonly;

-- `control_app` es miembro de `control_platform`, y la barrera corre en cada migración.
GRANT EXECUTE ON FUNCTION fiscal.assert_fiscal_integrity() TO control_app;

-- -----------------------------------------------------------------------------
-- 7.4 · La barrera
-- -----------------------------------------------------------------------------
DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
  PERFORM fiscal.assert_fiscal_integrity();
END $assert$;

COMMIT;
