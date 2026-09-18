# ADR 0003 · Vocabulario fiscal neutral, no nomenclatura AFIP

- **Estado:** aceptado, previo a la fase E5
- **Fase:** E5 del `docs/PLAN-ERP-MULTIEMPRESA.md`
- **Contexto previo:** `docs/adr/0001-nucleo-contable.md` (E1), `docs/adr/0002-motor-asientos-automaticos.md` (E2)

## Por qué este ADR existe antes del código

El plan §8.2 fija esta decisión como irreversible y con vencimiento explícito:
*"El plan de producción ya propone neutralizar (`authorization_id` en vez de `cae`). Si la
contabilidad nace con nombres AFIP, la expansión multinacional queda bloqueada — Antes de
E5."*

E5 es la fase que mete el vocabulario fiscal en la contabilidad: alícuotas, retenciones,
percepciones, libros digitales. Es el momento en que el nombre de cada cosa deja de ser una
decisión reversible. Después de E5, renombrar cuesta en proporción al histórico acumulado
de todas las empresas, y no sólo al código.

---

## El estado real, medido

No hay que decidir en abstracto: el proyecto ya eligió, y eligió **dos veces distinto**.

**El dominio TypeScript ya es neutral.** `apps/api/src/modules/fiscal/fiscal-driver.ts`
expone `authorizationId`, no `cae`; `taxRate`, no `alicuota`; `FiscalDocumentType` con
valores como `'invoice_a'`, no el `CbteTipo` 1. Su encabezado lo dice sin ambigüedad:

> *"El dominio habla de `documentType`, `netAmount`, `taxAmount`, `authorizationId`. Cada
> driver traduce a y desde la nomenclatura local: `CbteTipo`, `ImpNeto`, `ImpIVA`, `CAE`.
> La traducción vive en el driver, nunca en el dominio."*

**La base de datos no.** `0004_sales_and_afip.sql:141` declara:

```sql
cae text,  -- Código de Autorización Electrónico (14 dígitos)
```

y `:178` lo ata al formato argentino:

```sql
CONSTRAINT inv_cae_format CHECK (cae IS NULL OR cae ~ '^[0-9]{14}$'),
```

El `CHECK` es el problema más grave: no es un nombre, es una **regla argentina escrita en
el esquema**. Un comprobante chileno o mexicano no tiene un identificador de 14 dígitos
numéricos, así que la columna no puede representarlo ni aunque se la renombre.

### Por qué esa inconsistencia no es cosmética

Un `CHECK` que codifica el formato de un país convierte "agregar un país" en "migrar la
tabla de comprobantes de todas las empresas". La abstracción del `FiscalDriver` promete que
un segundo país es *una implementación nueva*; este `CHECK` la convierte en *una migración
de datos*. La promesa y el esquema dicen cosas distintas, y gana el esquema.

---

## Decisión 1 · La columna se llama `authorization_id`, y el formato no se valida en la base

**Decisión.** En `billing.invoices`, la columna `cae` pasa a llamarse `authorization_id`
(la columna se renombra, no se agrega una nueva: los datos son los mismos). El `CHECK`
`inv_cae_format` **se elimina de la base**. La restricción de formato pasa a ser
responsabilidad del driver, que es quien conoce el país.

**Motivo.** El nombre debe decir qué ES el dato (una autorización de la autoridad fiscal)
y no de dónde vino (un CAE de AFIP). El formato es una regla local: pertenece al driver,
igual que el mapeo de códigos.

**Qué se conserva.** `inv_authorized_has_cae` (`result <> 'approved' OR cae IS NOT NULL`)
**se mantiene**, renombrado a `inv_authorized_has_authorization`. No es una regla de
formato sino una invariante del dominio: un comprobante aprobado tiene una autorización.
Eso vale en todos los países. La distinción que este ADR fija es: **se conserva la
invariante de dominio, se elimina la regla de formato local.**

**Costo de la decisión.** Se pierde una validación barata en la base y el driver se vuelve
el único garante del formato. Se acepta porque el driver ya es el único que sabe traducir
la respuesta de la autoridad: un `authorization_id` que llega a la base pasó por él.

---

## Decisión 2 · Los códigos locales viven en una tabla, no en una columna

**Decisión.** El código local que la autoridad asigna a cada documento (hoy `doc_type` con
valores de `CBTE_TIPO`) se complementa con una columna `local_codes jsonb NOT NULL DEFAULT
'{}'` que preserva los códigos crudos tal como los devolvió la autoridad, indexada por
concepto.

**Motivo.** El proyecto ya tiene el patrón resuelto en `FiscalTaxBreakdown`, que expone un
`rate` neutro y un `localTaxId?: string` para el código que exija el país. El mismo
principio aplicado a la base: el vocabulario neutral es la columna de primera clase, y lo
local se preserva **al lado**, sin ocupar el nombre principal.

Esto además resuelve un problema real de diagnóstico: cuando AFIP rechaza un comprobante,
el código de observación es lo único que permite buscar la causa. Perderlo para "no
contaminar el dominio" sería peor. Se conserva, pero en un campo cuyo nombre admite que es
local.

**Alternativa descartada.** Una tabla `fiscal.local_code_mappings` por país. Es más
"correcta" en teoría, pero agrega un JOIN a toda lectura de comprobantes y un ciclo de vida
(migrar cuando la autoridad cambia un código) que nadie pidió. Si el volumen de países
crece a más de tres, esta decisión se revisa; hoy es sobreingeniería.

---

## Decisión 3 · La migración de E5 se escribe como `ALTER ... RENAME`, y deja el histórico intacto

**Decisión.** El renombre se hace con `ALTER TABLE billing.invoices RENAME COLUMN cae TO
authorization_id;` y `ALTER TABLE ... DROP CONSTRAINT inv_cae_format;` dentro de `0017`, la
migración de E5. No se copian datos: el valor es el mismo y el nombre cambia.

**Motivo.** Una migración que "agrega la columna nueva, copia y borra la vieja" tiene una
ventana en la que las dos existen, y ese es exactamente el momento en que un proceso
escribe en la equivocada. `RENAME` es atómico y no tiene ventana.

**Verificación.** `app.assert_rls_coverage()` sigue corriendo al final, y las suites
existentes (contable, compras, tesorería) **fallan si el renombre rompió algo** — que es la
razón por la que este renombre se hace ahora y no después: hay 699 verificaciones que lo
cubren.

---

## Consecuencias aceptadas

- Los `COMMENT` y el código que hoy dicen "CAE" en contexto argentino **se conservan**: el
  driver de AFIP habla de CAE porque es su vocabulario. Lo que cambia es el dominio, no el
  driver.
- `0004` no se reescribe — es historia y está aplicada. El renombre vive en `0017`. Una
  migración aplicada no se edita: se corrige hacia adelante.
- Cualquier código nuevo de E5 en adelante (IVA, retenciones, percepciones) **nace neutral
  y no tiene la opción de no serlo.** Este ADR es el que cierra esa puerta.
