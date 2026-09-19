-- =============================================================================
-- Control · 0023 · Listas de precios con vigencia y escalas por cantidad
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- `0003` dejó `app.price_lists` (nombre, moneda, multiplicador, por defecto) y
-- `app.price_list_items` con una sola columna `price` y una PK
-- `(price_list_id, variant_id)`: un precio por variante y por lista, sin vigencia
-- y sin escalas. Dos consecuencias concretas:
--
--   1. Cambiar un precio BORRA el anterior. Un presupuesto de marzo re-cotizado en
--      junio devuelve el precio de junio, y el número que se le pasó al cliente
--      deja de ser reproducible. Es el mismo defecto que `0017` evitó en las
--      alícuotas al darles `valid_from`/`valid_to` (ADR 0004, F-6).
--   2. No hay forma de expresar «10 o más, más barato». La escala por cantidad
--      terminaba hardcodeada en la aplicación, que es exactamente lo que el
--      ADR 0006 prohíbe: el precio se resuelve por datos.
--
-- DECISIÓN (ADR 0006, decisión 4)
--
-- Precio = función de `(lista, vigencia, variante, cantidad)`, resuelta por datos y
-- no por código, para que una determinación vieja siga siendo reproducible.
--
-- La vigencia vive en la LÍNEA y no en la lista. Una lista («Mayorista») es una
-- entidad durable cuyo CONTENIDO cambia con el tiempo; ponerle vigencia a la lista
-- obligaría a crear «Mayorista marzo» y «Mayorista abril» como listas distintas, y
-- `price_lists_unique (tenant_id, name)` lo impide. Ésa es la alternativa que se
-- descartó, y el motivo.
--
-- PRECEDENCIA (lo que `app.price_for()` resuelve, de más específico a más general)
--
--   1. `tier`             — la escala de la lista que cubre la cantidad Y la fecha.
--   2. `list_multiplier`  — `product_variants.list_price × price_lists.multiplier`.
--   3. sin fila           — no hay precio configurado. No se inventa un 0.
--
-- GARANTÍAS DE MOTOR
--
-- 1. `EXCLUDE` de solapamiento: para una misma (empresa, lista, variante) no puede
--    haber dos escalas que se solapen A LA VEZ en cantidad y en fecha. Sin esto
--    `app.price_for()` podría devolver dos precios para la misma consulta y el
--    resultado dependería del orden físico — la irreproducibilidad que el ADR 0004
--    prohíbe para las alícuotas y que acá vale igual.
-- 2. `UNIQUE` parcial de lista por defecto: a lo sumo una lista `is_default` por
--    empresa. Con dos, «la lista por defecto» no tiene respuesta y la resolución
--    dependería del orden físico otra vez.
--
-- POR QUÉ NO HACE FALTA EL CENTINELA DE `0017`
--
-- `0017` necesitó `COALESCE(tenant_id, <centinela>)` dentro del `EXCLUDE` porque
-- `fiscal.tax_rates.tenant_id` admite NULL (alícuotas de plataforma) y en un
-- `EXCLUDE` NULL no colisiona con NULL: dos alícuotas de plataforma solapadas
-- entraban las dos. Acá `tenant_id` es NOT NULL en las dos tablas, así que la
-- columna entra al `EXCLUDE` directamente. No es un olvido: es que el problema que
-- el centinela resuelve no existe en esta tabla.
--
-- AISLAMIENTO
--
-- No se crean tablas: `app.price_lists` y `app.price_list_items` ya están cubiertas
-- por RLS desde `0006`, con sus políticas `tenant_isolation`. Igual corre
-- `app.assert_rls_coverage()` al final, como toda migración de negocio.
-- =============================================================================

BEGIN;

-- `btree_gist` es lo que habilita el operador `=` sobre uuid dentro de un
-- `EXCLUDE USING gist`. `0017` ya lo instaló, pero se declara igual y antes del
-- primer uso: si faltara, el `ALTER TABLE` de abajo falla con «data type uuid has
-- no default operator class for access method gist», que no dice qué hacer.
-- (No va dentro de un `IF NOT EXISTS` de un constraint: si el constraint ya
-- existiera, el guard saltearía también el `CREATE EXTENSION`.)
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- -----------------------------------------------------------------------------
-- 1 · Escalas por cantidad y vigencia en la línea de la lista
-- -----------------------------------------------------------------------------
ALTER TABLE app.price_list_items
  -- Identidad propia. La PK natural `(price_list_id, variant_id)` impide más de un
  -- precio por variante y por lista, que es justamente lo que las escalas necesitan
  -- romper. El `id` además habilita las FK compuestas `(tenant_id, id)` del resto
  -- del proyecto si algún día una línea de presupuesto quiere apuntar a su precio.
  ADD COLUMN id           uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Desde qué cantidad rige la escala (inclusive). Es `numeric(14,3)` y no `integer`
  -- para no obligar a truncar una cantidad fraccionaria: el proyecto lleva las
  -- cantidades de venta en `numeric(14,3)` (`invoice_items`, `delivery_note_items`).
  ADD COLUMN min_quantity numeric(14,3) NOT NULL DEFAULT 1,
  -- NULL = sin tope superior, misma decisión que `valid_to`: un tope centinela se
  -- compara mal y se muestra peor.
  ADD COLUMN max_quantity numeric(14,3),
  ADD COLUMN valid_from   date NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = vigente hasta nuevo aviso. Es la forma de expresar «rige hoy»: una fecha
  -- centinela como '9999-12-31' se compara mal y se muestra peor.
  ADD COLUMN valid_to     date,
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now();

-- La PK pasa de natural a subrogada. `DROP CONSTRAINT` + `ADD CONSTRAINT` y no
-- recrear la tabla: la tabla no tiene filas hoy, pero la migración no debe depender
-- de eso — con datos, las columnas nuevas nacen con default y el cambio es válido.
ALTER TABLE app.price_list_items DROP CONSTRAINT price_list_items_pkey;
ALTER TABLE app.price_list_items ADD CONSTRAINT pli_pkey PRIMARY KEY (id);

-- Habilita las FK compuestas hacia esta tabla (patrón del proyecto: un
-- `CREATE UNIQUE INDEX (tenant_id, id)` sirve de destino de FK igual que un UNIQUE).
CREATE UNIQUE INDEX pli_tenant_id_uniq ON app.price_list_items(tenant_id, id);

ALTER TABLE app.price_list_items
  ADD CONSTRAINT pli_qty_range_valid CHECK (
    min_quantity > 0 AND (max_quantity IS NULL OR max_quantity >= min_quantity)
  ),
  ADD CONSTRAINT pli_date_range_valid CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  );

-- La garantía de no-solapamiento. Es lo que hace que la resolución sea determinista:
-- para (empresa, lista, variante) hay a lo sumo UNA escala vigente para una cantidad
-- y una fecha dadas.
--
-- `daterange` y no `tstzrange`: las vigencias de precio son fechas, no instantes. Un
-- cambio de precio rige desde el día 1, no desde una hora, y modelarlo con instantes
-- obligaría a elegir una hora inventada (mismo criterio que `fiscal.tax_rates`).
ALTER TABLE app.price_list_items
  ADD CONSTRAINT pli_no_overlap EXCLUDE USING gist (
    tenant_id  WITH =,
    price_list_id WITH =,
    variant_id WITH =,
    numrange(min_quantity, max_quantity, '[]') WITH &&,
    daterange(valid_from, valid_to, '[]')     WITH &&
  );

CREATE INDEX idx_pli_lookup ON app.price_list_items(tenant_id, price_list_id, variant_id, min_quantity);
CREATE INDEX idx_pli_validity ON app.price_list_items(tenant_id, valid_from DESC);

-- El trigger de `updated_at` va JUNTO con la columna, nunca sin ella:
-- `app.touch_updated_at()` asigna `NEW.updated_at`, y sobre una tabla sin esa
-- columna el primer UPDATE aborta con «el registro new no tiene un campo
-- updated_at». Ese defecto existió en `0021` (el trigger se copió de la cabecera a
-- una tabla de líneas que no tenía la columna) y dejaba la función inutilizable.
-- Acá la columna está, así que el trigger es correcto y mantiene `updated_at`
-- veraz sin depender de que cada escritor se acuerde de setearlo.
CREATE TRIGGER trg_price_list_items_touch BEFORE UPDATE ON app.price_list_items
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE app.price_list_items IS
  'Escalas de precio de una variante dentro de una lista, con vigencia temporal. '
  'La constraint EXCLUDE impide que dos escalas se solapen a la vez en cantidad y en '
  'fecha para la misma variante y lista: dos escalas vigentes a la vez harían que '
  'app.price_for() devuelva dos precios y el resultado dependiera del orden físico '
  '(ADR 0006, decisión 4).';
COMMENT ON COLUMN app.price_list_items.min_quantity IS
  'Cantidad desde la que rige la escala, inclusive. Junto con max_quantity (NULL = sin '
  'tope) forma el rango de cantidad de la escala.';
COMMENT ON COLUMN app.price_list_items.valid_from IS
  'Primer día en que rige este precio, inclusive. Una cotización vieja re-resuelta a su '
  'fecha devuelve este precio y no el de hoy: es la reproducibilidad que el ADR 0006 '
  'exige, igual que en las alícuotas de 0017.';
COMMENT ON COLUMN app.price_list_items.updated_at IS
  'Última modificación del precio. Lo mantiene el trigger trg_price_list_items_touch.';

-- -----------------------------------------------------------------------------
-- 2 · A lo sumo una lista por defecto por empresa
-- -----------------------------------------------------------------------------
-- «La lista por defecto» tiene que tener UNA respuesta. Con dos, elegir cuál aplicar
-- depende del orden físico de la consulta: el mismo defecto de irreproducibilidad que
-- el `EXCLUDE` de arriba cierra para las escalas.
CREATE UNIQUE INDEX price_lists_one_default_per_tenant
  ON app.price_lists(tenant_id)
  WHERE is_default;

COMMENT ON COLUMN app.price_lists.is_default IS
  'Lista que se aplica cuando no se especifica ninguna. A lo sumo una por empresa: lo '
  'impone el índice único parcial price_lists_one_default_per_tenant.';

-- -----------------------------------------------------------------------------
-- 3 · Resolución del precio a una fecha y una cantidad
-- -----------------------------------------------------------------------------
-- ADR 0006, decisión 4, y misma forma que `fiscal.rates_on()` de `0017`: RECIBE la
-- fecha en lugar de devolver «el precio actual». Un llamador que quiera hoy pasa la
-- fecha explícitamente. Eso impide el defecto silencioso de re-cotizar un documento
-- viejo con el precio de hoy.
--
-- Devuelve 0 o 1 fila (la `EXCLUDE` garantiza que no puedan ser dos). 0 filas
-- significa «sin precio configurado» y es una respuesta legítima: el llamador NO
-- debe inventar un 0, porque `0003` declara `list_price NOT NULL DEFAULT 0` y ese 0
-- es el centinela de «sin cargar», no un precio.
CREATE OR REPLACE FUNCTION app.price_for(
  p_tenant_id     uuid,
  p_price_list_id uuid,
  p_variant_id    uuid,
  p_quantity      numeric,
  p_on_date       date DEFAULT CURRENT_DATE
) RETURNS TABLE (
  price         numeric(14,2),
  source        text,
  price_list_id uuid,
  min_quantity  numeric(14,3),
  max_quantity  numeric(14,3),
  valid_from    date,
  valid_to      date
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.price, r.source, r.price_list_id,
         r.min_quantity, r.max_quantity, r.valid_from, r.valid_to
  FROM (
    -- 1 · La escala de la lista que cubre (cantidad, fecha).
    SELECT
      1                              AS priority,
      i.price                        AS price,
      'tier'::text                   AS source,
      i.price_list_id                AS price_list_id,
      i.min_quantity                 AS min_quantity,
      i.max_quantity                 AS max_quantity,
      i.valid_from                   AS valid_from,
      i.valid_to                     AS valid_to
    FROM app.price_list_items i
    JOIN app.price_lists l
      ON l.tenant_id = i.tenant_id AND l.id = i.price_list_id
    WHERE i.tenant_id = p_tenant_id
      AND i.price_list_id = p_price_list_id
      AND i.variant_id = p_variant_id
      AND numrange(i.min_quantity, i.max_quantity, '[]') @> p_quantity
      AND daterange(i.valid_from, i.valid_to, '[]')      @> p_on_date

    UNION ALL

    -- 2 · Sin escala: el precio de lista de la variante escalado por el
    --     multiplicador de la lista. `list_price = 0` es el centinela de «sin
    --     precio configurado», así que no se devuelve un 0 inventado.
    SELECT
      2                              AS priority,
      round(v.list_price * l.multiplier, 2) AS price,
      'list_multiplier'::text        AS source,
      l.id                           AS price_list_id,
      NULL::numeric(14,3)            AS min_quantity,
      NULL::numeric(14,3)            AS max_quantity,
      NULL::date                     AS valid_from,
      NULL::date                     AS valid_to
    FROM app.price_lists l
    JOIN app.product_variants v
      ON v.tenant_id = l.tenant_id AND v.id = p_variant_id
    WHERE l.tenant_id = p_tenant_id
      AND l.id = p_price_list_id
      AND v.list_price > 0
      AND NOT EXISTS (
        SELECT 1
        FROM app.price_list_items i
        WHERE i.tenant_id = p_tenant_id
          AND i.price_list_id = p_price_list_id
          AND i.variant_id = p_variant_id
          AND numrange(i.min_quantity, i.max_quantity, '[]') @> p_quantity
          AND daterange(i.valid_from, i.valid_to, '[]')      @> p_on_date
      )
  ) AS r
  -- El `ORDER BY` sobre la prioridad explícita NO es decorativo: `UNION ALL` no
  -- garantiza el orden de las ramas, así que un `LIMIT 1` sin ordenar podría
  -- devolver la rama 2 aunque la 1 tuviera fila — es decir, ignorar la escala.
  ORDER BY r.priority
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.price_for IS
  'Precio de una variante en una lista, A UNA FECHA Y UNA CANTIDAD. Recibe la fecha de '
  'forma explícita —no devuelve «el precio actual»— para impedir que un documento viejo '
  'se re-cotice con el precio de hoy (ADR 0006, decisión 4). Precedencia: escala que '
  'cubre cantidad y fecha, luego `list_price × multiplier`. Devuelve 0 filas si no hay '
  'precio configurado; el llamador no debe inventar un 0.';

GRANT EXECUTE ON FUNCTION app.price_for(uuid, uuid, uuid, numeric, date) TO control_app;

-- La barrera de integridad: no se crean tablas, pero la aserción corre igual y deja
-- constancia de que la cobertura sigue completa.
DO $assert$
BEGIN
  PERFORM app.assert_rls_coverage();
END $assert$;

COMMIT;
