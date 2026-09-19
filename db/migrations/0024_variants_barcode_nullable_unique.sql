-- =============================================================================
-- Control · 0024 · Dos variantes sin código de barras pueden coexistir
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- `0003` declaró `variants_barcode_unique UNIQUE NULLS NOT DISTINCT (tenant_id, barcode)`
-- sobre una columna que es NULLABLE (`barcode text, -- EAN-13 / GTIN`). Con
-- `NULLS NOT DISTINCT`, NULL cuenta como un valor más: **una empresa no puede tener
-- dos variantes sin código de barras**. La segunda falla con
-- «llave duplicada viola restricción de unicidad variants_barcode_unique».
--
-- POR QUÉ ES UN DEFECTO Y NO UNA REGLA
--
-- 1. No hay ninguna regla de negocio que diga «a lo sumo una variante sin EAN». Un
--    catálogo real tiene decenas: todo producto que todavía no tiene código, todo
--    ítem de uso interno, todo servicio.
-- 2. La misma migración declara dos líneas más abajo
--    `idx_variants_barcode ... (tenant_id, barcode) WHERE barcode IS NOT NULL`, un
--    índice parcial que EXCLUYE los NULL. Esa forma sólo tiene sentido si los NULL
--    son muchos: la intención era «el código de barras es único cuando está», y el
--    `NULLS NOT DISTINCT` la contradice.
-- 3. `NULLS NOT DISTINCT` es explícito: no es el default de PostgreSQL (el default
--    es `NULLS DISTINCT`, que admite muchos NULL). Se escribió a propósito, pero el
--    efecto no coincide con la intención que declara el índice parcial de al lado.
--
-- CÓMO SE DESCUBRIÓ
--
-- Al escribir el gate V-4 (listas de precios, `0023`) el escenario necesitaba una
-- segunda variante sin precio cargado, y el `INSERT` falló con la violación de
-- unicidad. Es de la misma familia que los defectos que este proyecto viene
-- encontrando al EJECUTAR: no se ve leyendo la migración y aparece en cuanto existe
-- una segunda variante.
--
-- POR QUÉ UNA MIGRACIÓN NUEVA Y NO EDITAR `0003`
--
-- Una base que ya aplicó `0003` tiene la restricción puesta; editar `0003` arreglaría
-- sólo las bases recreadas desde cero y dejaría rotas a las demás, en silencio.
-- `0020` (FK del catálogo fiscal) es el precedente del mismo criterio.
--
-- La corrección es estrictamente una RELAJACIÓN: admite filas que antes se
-- rechazaban y no invalida ninguna fila existente, así que no necesita migración de
-- datos ni puede romper un dato ya cargado.
-- =============================================================================

BEGIN;

ALTER TABLE app.product_variants DROP CONSTRAINT variants_barcode_unique;

-- `UNIQUE` a secas, sin `NULLS NOT DISTINCT`: es el default de PostgreSQL y admite
-- muchos NULL por empresa. La unicidad sigue vigente para los códigos presentes, que
-- es exactamente lo que el índice parcial `idx_variants_barcode` ya expresaba.
ALTER TABLE app.product_variants
  ADD CONSTRAINT variants_barcode_unique UNIQUE (tenant_id, barcode);

COMMENT ON CONSTRAINT variants_barcode_unique ON app.product_variants IS
  'El código de barras es único por empresa CUANDO ESTÁ. La columna es opcional: una '
  'empresa puede tener muchas variantes sin código. El NULLS NOT DISTINCT original de '
  '0003 permitía una sola, y contradecía el índice parcial idx_variants_barcode.';

COMMIT;
