-- =============================================================================
-- 0020 · Claves foráneas al catálogo fiscal compartido
-- =============================================================================
-- PROBLEMA QUE CORRIGE
--
-- `fiscal.taxes` (y `fiscal.withholding_regimes`) son un CATÁLOGO COMPARTIDO. La
-- columna `tenant_id` admite NULL por diseño (0017): NULL = definición de
-- plataforma —el IVA 21% de AFIP es el mismo para todas las empresas, no pertenece
-- a ninguna—. Una empresa, al emitir, DISCRIMINA un impuesto que es de plataforma:
-- su `document_taxes` referencea el impuesto global.
--
-- Pero las claves foráneas que apuntan a ese catálogo eran COMPUESTAS:
--
--     FOREIGN KEY (tenant_id, tax_id) REFERENCES fiscal.taxes(tenant_id, id)
--
-- Esa forma EXIGE que el `tenant_id` del documento coincida con el del impuesto.
-- Como el impuesto de plataforma tiene `tenant_id = NULL`, la referencia NUNCA
-- empareja y el rol de aplicación (`control_app`) no puede registrar un
-- `document_taxes`, ni un `vat_accruals`, ni una retención que cite el impuesto
-- global. El módulo fiscal quedaba INUTILIZABLE en producción: la aplicación no
-- puede volcar el discriminado de un comprobante.
--
-- DECISIÓN
--
-- Se relajan ESTAS seis FKs (y sólo éstas) a referencias de UNA columna:
--
--     FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id)
--     FOREIGN KEY (regime_id) REFERENCES fiscal.withholding_regimes(id)
--
-- Es la excepción explícita a la regla de claves compuestas del proyecto. La regla
-- existe para impedir que una fila apunte a un RECURSO DE OTRA EMPRESA; un recurso
-- de PLATAFORMA (compartido, `tenant_id` NULL) no es de otra empresa, es global.
-- La aislamiento multiempresa sigue garantizada por RLS —que es el mecanismo
-- autoritativo del proyecto— y no por estas FKs: el rol de aplicación sólo VE los
-- impuestos de plataforma o los propios (política `taxes_read` / `withholding_read`
-- en 0017), así que nunca obtiene el id de un impuesto ajeno para referenciarlo.
--
-- Las claves compuestas en DATOS DE NEGOCIO (facturas, asientos, comprobantes) NO
-- se tocan: allí sí debe impedirse el apuntado cruzado.
-- =============================================================================

BEGIN;

-- `fiscal.taxes` y `fiscal.withholding_regimes` tienen PK compuesta
-- `(tenant_id, id)`. Para referenciarlas por `id` solo (ver abajo) la columna
-- `id` tiene que ser UNIQUE por sí misma: el UUID es globalmente único, así que
-- la restricción es correcta y necesaria para que la FK de una columna sea válida.
ALTER TABLE fiscal.taxes
  ADD CONSTRAINT taxes_id_uniq UNIQUE (id);
ALTER TABLE fiscal.withholding_regimes
  ADD CONSTRAINT withholding_regimes_id_uniq UNIQUE (id);

-- `fiscal.taxes` es el catálogo compartido.
ALTER TABLE fiscal.tax_rates
  DROP CONSTRAINT tax_rates_tax_fk;
ALTER TABLE fiscal.tax_rates
  ADD CONSTRAINT tax_rates_tax_fk
  FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id) ON DELETE RESTRICT;

ALTER TABLE fiscal.withholding_regimes
  DROP CONSTRAINT withholding_tax_fk;
ALTER TABLE fiscal.withholding_regimes
  ADD CONSTRAINT withholding_tax_fk
  FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id) ON DELETE RESTRICT;

ALTER TABLE fiscal.document_taxes
  DROP CONSTRAINT document_taxes_tax_fk;
ALTER TABLE fiscal.document_taxes
  ADD CONSTRAINT document_taxes_tax_fk
  FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id) ON DELETE RESTRICT;

ALTER TABLE fiscal.book_definitions
  DROP CONSTRAINT book_definitions_tax_fk;
ALTER TABLE fiscal.book_definitions
  ADD CONSTRAINT book_definitions_tax_fk
  FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id) ON DELETE RESTRICT;

ALTER TABLE fiscal.vat_accruals
  DROP CONSTRAINT vat_accruals_tax_fk;
ALTER TABLE fiscal.vat_accruals
  ADD CONSTRAINT vat_accruals_tax_fk
  FOREIGN KEY (tax_id) REFERENCES fiscal.taxes(id) ON DELETE RESTRICT;

-- `fiscal.withholding_regimes` también es catálogo compartido: un régimen de
-- retención de Ganancias es el mismo para todas las empresas.
ALTER TABLE fiscal.document_withholdings
  DROP CONSTRAINT withh_regime_fk;
ALTER TABLE fiscal.document_withholdings
  ADD CONSTRAINT withh_regime_fk
  FOREIGN KEY (regime_id) REFERENCES fiscal.withholding_regimes(id) ON DELETE RESTRICT;

COMMIT;
