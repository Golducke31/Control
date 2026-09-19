# ADR 0005 · El hecho fiscal es propio, y no el comprobante de venta

- **Estado:** aceptado
- **Fase:** E5 del `docs/PLAN-ERP-MULTIEMPRESA.md`
- **Contexto previo:** `docs/adr/0003-vocabulario-fiscal-neutral.md`,
  `docs/adr/0004-motor-de-impuestos.md` (misma fase)

## Por qué este ADR existe

El ADR 0003 decidió que el dominio fiscal no hablara la nomenclatura de un país
(`authorization_id` en vez de `cae`) y declaró: *"cualquier código nuevo de E5 en adelante
nace neutral y no tiene la opción de no serlo."*

`0018` cumplió esa promesa en el nombre de las cosas y **la rompió en la forma de las
relaciones**. `fiscal.document_taxes` y `fiscal.vat_accruals` apuntan a `billing.invoices`:
el vocabulario de **venta** quedó incrustado en la determinación de impuestos.

Este ADR no es una revisión del 0003 — extiende su criterio a las relaciones, que es donde
la neutralidad se pierde de verdad. Un nombre malo se renombra con un `ALTER ... RENAME`
(0003, decisión 3). Una **relación** mal elegida se paga con una migración de datos y con
todo el histórico apuntando al lugar equivocado.

---

## El estado real, medido

No se decide en abstracto. Estas cuatro verificaciones se corrieron contra PostgreSQL 16
con las 18 migraciones aplicadas, y las cuatro fallan:

**(a) `fiscal.accrue_vat` no puede imputar una compra.**

```
accrue_vat RECHAZÓ: P0002 · El comprobante 52d3fe8c-… no existe en esta empresa
```

La función resuelve `SELECT * INTO v_inv FROM billing.invoices`, y una factura de compra
vive en `purchasing.supplier_invoices`. La fila existe, en otra tabla, con otra PK.

**(b) `fiscal.document_taxes` rechaza un comprobante de compra.**

```
23503 · viola la llave foránea «document_taxes_invoice_fk»
```

**(c) No hay camino desde una factura de compra hasta su fecha de recepción.**
`purchasing.goods_receipts` cuelga de `supplier_orders`, no de la factura, y no existe
ninguna función que ligue las dos. El comentario de `0018` afirma que el crédito se computa
*"en el período de la RECEPCIÓN"*; el dato que eso requiere **no está representado**.

**(d) La rama de compra de `accrue_vat` es código muerto.**
`billing.receipt_kind` es `('invoice','credit_note','debit_note')` (`0001:49`). **No existe
un valor de compra**, así que las ramas `ELSIF v_inv.kind = …` nunca se alcanzan con un
hecho de compra, y `v_inv.issue_date` se usa para todo.

### La consecuencia que hace urgente esta decisión

F-1, F-3 y F-6 **pasan igual**. Un libro que sólo registra ventas es internamente
consistente: los totales cuadran, `v_vat_gaps` devuelve 0 filas, `variance` es 0. El
sistema informa una posición de IVA que **omite todo el crédito fiscal de compras** y ninguna
de las verificaciones existentes lo detecta, porque todas comparan el sistema consigo mismo.

Con empresas importantes en producción, ése es el único escenario verdaderamente
inaceptable: no que falte código, sino que **el número que se presenta ante el organismo
esté mal y el sistema diga que está bien**.

### Un quinto defecto, del mismo origen, no buscado

`withheld_total` (`0014:403`) documenta *"el cálculo es de E5"*. **No existe ninguna tabla
que ligue una retención a la factura que la sufre.** `fiscal.document_taxes` existe y podría
admitir `kind='withholding'`, pero su FK también apunta a `billing.invoices`. F-4 tiene el
mismo agujero que F-2, por la misma causa. Un importe sin origen es peor que un importe
ausente: nadie lo audita porque parece que funciona.

### Un sexto defecto, de signo

`fiscal.v_vat_position` concilia `vat_payable` (pasivo, acredita) y `vat_receivable`
(activo, debita) con una sola expresión:

```sql
CASE WHEN ar.role = 'vat_payable' THEN 'debit' ELSE 'credit' END AS direction,
sum(l.credit) - sum(l.debit) AS amount
```

Para una venta da `+2100` (correcto). Para una compra da **`−840`**, porque un activo
aumenta al debe y la resta propia de un pasivo le invierte el signo. Entonces:

```
net_position = 2100 − (−840) = 2940      (lo que calcula)
net_position = 2100 − 840   = 1260       (lo que corresponde)
```

El error es `2 × crédito` en todo período con compras — y **crece con la empresa**, que es
lo contrario de lo que se espera de un error que se descubre tarde. Ninguna aserción de
`0018` lo detecta porque `divergence` compara el débito del detalle contra el débito del
libro: los dos están mal de la misma manera, así que la diferencia es cero.

---

## Decisión 1 · El hecho fiscal es una entidad propia: `fiscal.tax_documents`

**Decisión.** Se crea `fiscal.tax_documents`, que representa *un documento que tiene efectos
fiscales*, con `source_type` y `source_id` que apuntan a la tabla de negocio que lo originó.
`fiscal.document_taxes` y `fiscal.vat_accruals` referencian **esa** entidad y no
`billing.invoices`.

**Motivo.** La pregunta que la determinación necesita responder es *"¿qué documentos tienen
efectos fiscales este período?"*, y esa pregunta no tiene una respuesta por cada tabla de
negocio: tiene una sola. Modelar la relación contra `billing.invoices` obligó a que cada
origen nuevo agregara una excepción en `accrue_vat`, y el proyecto ya tiene tres orígenes
previstos (ventas, compras, y las notas de crédito de ambos) más dos en fases posteriores
(retenciones de sueldos en E7, IIBB por jurisdicción en E8). Eso no es una decisión: es un
patrón de excepciones.

**Por qué no se unifican las tablas de negocio.** `billing.invoices` y
`purchasing.supplier_invoices` **no son el mismo hecho**. Una factura de venta tiene
correlativo propio, punto de venta, CAE, estado de autorización ante el organismo y
condición de receptor; una de compra tiene número del proveedor, orden de compra y
recepción. Fusionarlas produciría una tabla donde la mitad de las columnas son nulas según
el caso, y donde las restricciones de una (`inv_authorized_has_authorization`) no aplican a
la otra. `tax_documents` es la **proyección fiscal** de ambas, no su reemplazo: cada una
conserva sus reglas.

**Qué NO es `tax_documents`.** No es una tabla de saldos ni de posición (eso lo prohíbe el
ADR 0004, decisión 3) y no guarda importes de posición. Guarda el **hecho**: qué documento,
de qué tipo, con qué fecha fiscal, de qué empresa, y en qué estado de autorización.
Es entrada para la determinación, no su resultado.

---

## Decisión 2 · El tipo de hecho es del dominio, no de la tabla de origen

**Decisión.** `fiscal.tax_documents.kind` usa un vocabulario propio
(`('sale','purchase','sale_credit_note','purchase_credit_note','sale_debit_note','purchase_debit_note')`),
y la **dirección fiscal** (`debit` / `credit`) y la **fecha de cómputo** se resuelven por
regla explícita sobre `kind`, en un solo lugar.

**Motivo.** Es exactamente la lección del ADR 0003 aplicada a las relaciones: el
`billing.receipt_kind` describe el comprobante desde la venta y por eso no puede representar
una compra. El tipo de hecho fiscal es un concepto del dominio fiscal y tiene que nombrarse
desde ahí. La traducción desde cada tabla de negocio vive en el adaptador de esa tabla,
nunca en la determinación.

**La fecha de cómputo por tipo, explícita y congelada.**

| `kind` | Fecha de cómputo | Dirección |
|---|---|---|
| `sale` | emisión | débito |
| `sale_credit_note` | emisión propia | débito (revierte) |
| `sale_debit_note` | emisión propia | débito |
| `purchase` | **recepción** | crédito |
| `purchase_credit_note` | emisión propia | crédito (revierte) |
| `purchase_debit_note` | emisión propia | crédito |

**La recepción tiene que existir como dato.** Para `purchase`, la fecha de cómputo es la
recepción, y hoy no hay ninguna relación entre una factura de compra y su recepción. Se
agrega: `purchasing.supplier_invoices.received_on` (nullable, porque una factura puede
cargarse antes de que llegue la mercadería) más la resolución por orden de compra cuando
existe. Una factura de compra **sin fecha de recepción no se puede imputar**, y `accrue_vat`
lo dice con un mensaje accionable en vez de usar la emisión por defecto — ese default
silencioso es el que produce la posición mal presentada.

**Por qué la nota de crédito computa en su propia fecha.** Es la decisión que `0015` ya tomó
para el cobro: una nota de crédito es un hecho propio y no una edición del original. El
período del original puede estar cerrado y presentado.

---

## Decisión 3 · La posición neta se calcula en el dominio, con el signo del rol

**Decisión.** `fiscal.v_vat_position` deja de derivar la dirección del rol contable y de
invertir el signo de un activo. El detalle por alícuota viene de `fiscal.vat_accruals` (que
ya tiene `direction` correcta por `kind`) y el libro aporta **importes absolutos por rol**,
con el signo resuelto por la naturaleza de la cuenta:

- débito fiscal → `vat_payable`, que acredita: su importe es `sum(credit) − sum(debit)`
- crédito fiscal → `vat_receivable`, que debita: su importe es `sum(debit) − sum(credit)`

**Motivo.** El defecto de signo del estado medido es la prueba de que derivar el sentido
fiscal de la *naturaleza contable de una cuenta* es una inferencia que un esquema puede
sostener sólo mientras nadie agregue una cuenta que no encaje. El sentido fiscal de un
impuesto lo define **el impuesto**, no la cuenta donde cayó el asiento. La cuenta es el
efecto contable; el impuesto es la causa, y la causa se resuelve antes.

**Lo que se conserva.** `divergence` sigue existiendo y sigue siendo la verificación
cruzada: compara el detalle de imputaciones contra el agregado del libro. Con el signo
corregido deja de ser una comprobación que puede dar cero con los dos lados mal.

---

## Decisión 4 · La retención es un hecho del comprobante, y se liga a él

**Decisión.** Las retenciones y percepciones se registran en `fiscal.document_withholdings`,
ligadas al `tax_documents` que las sufre o las practica, con `direction`
(`suffered` / `practiced`) y la referencia al régimen de `fiscal.withholding_regimes` que
las originó. `purchasing.supplier_invoices.withheld_total` pasa a ser **derivado** de esa
tabla, igual que `payment_status` en `0015`.

**Motivo.** Un `withheld_total` que nadie puede descomponer no se puede auditar y no se
puede corregir sin reescribir un total. Con el hecho registrado, "¿por qué esta factura
tiene 1.200 de retención?" tiene una respuesta: el régimen, la base y la tasa.

**Verificación obligatoria.** La suite comprueba que `withheld_total` coincida con la suma
de los hechos. Es la misma forma que `v_vat_gaps`: exponer la diferencia en vez de asumir
que no hay.

---

## Decisión 5 · Una barrera que impide que la omisión vuelva a pasar en silencio

**Decisión.** Se agrega `fiscal.v_fiscal_integrity`, que reporta todo documento con efectos
fiscales que no tenga su hecho registrado, y un aserto `fiscal.assert_fiscal_integrity()`
que corre **al final de las migraciones y en CI**, con el mismo criterio que
`app.assert_rls_coverage()`.

**Motivo.** El defecto que este ADR corrige nunca falló. Ninguna prueba, ningún job, ningún
cierre lo detectaba. La lección del `assert_rls_coverage` —que la cobertura de RLS se
verifique contra el catálogo y no contra una lista escrita a mano— es la misma acá: la
integridad de lo fiscal se verifica contra el catálogo de orígenes, no contra la memoria de
quien escribió el código.

Concretamente: una tabla con `tenant_id` que represente un hecho con efectos fiscales y que
no esté alcanzada por la proyección **hace fallar el pipeline**. Es lo único que garantiza
que E6, E7 y E8 no repitan esta omisión.

---

## Consecuencias aceptadas

- `0019` crea `fiscal.tax_documents`, migra `document_taxes` y `vat_accruals`, agrega
  `document_withholdings` y `received_on`. Es una migración con **cambio de FK**: se
  backfillea desde `billing.invoices` (que hoy es el único origen con datos) en la misma
  transacción, y `document_taxes` no tiene filas todavía en ninguna base de producción.
- `v_vat_position` se reescribe. El defecto de signo se corrige en la misma migración, y la
  suite de la puerta lo mide con una aserción aritmética escrita a mano contra un escenario
  conocido — no contra el propio sistema.
- `accrue_vat` cambia de firma conceptual: recibe el hecho fiscal, no el comprobante.
- F-2 y F-4 pasan a ser medibles. **Sin este ADR, F-2 no era implementable**: no es que
  faltara código, es que faltaba el dato.
- El ADR 0004, decisión 3, menciona roles `iva_debito` / `iva_credito` que no existen: los
  roles reales son `vat_payable` / `vat_receivable` (`0013:514-518`). Se corrige la mención
  en este ADR y se deja constancia; el ADR 0004 no se reescribe, se interpreta.
