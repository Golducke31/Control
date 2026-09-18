# ADR 0001 · Núcleo contable: decisiones irreversibles

**Estado:** Aceptado
**Fecha:** 18 de septiembre de 2026
**Fase:** E1 del [plan de evolución a ERP](../docs/PLAN-ERP-MULTIEMPRESA.md)
**Decide:** Arquitectura de datos contable. Afecta a todas las fases posteriores (E2 a E9).

---

## Contexto

Control no tiene contabilidad. El [plan de evolución a ERP](../docs/PLAN-ERP-MULTIEMPRESA.md) §4.1 identifica el núcleo contable como el punto de apalancamiento del plan: compras, RR.HH. y fiscal avanzado producen asientos, y sin el libro esos módulos quedan como islas de datos.

Cinco decisiones de este núcleo son **caras o imposibles de revertir** una vez que haya datos contables en producción. Este ADR las fija antes de escribir la migración, porque el costo de cambiarlas después es proporcional al volumen histórico acumulado, no al esfuerzo de reescribir el código.

La regla que gobierna todas: **la garantía va en el motor, no en la aplicación.** Es el criterio que ya se aplicó en `app.apply_stock_movement()` y que el propio defecto #11 de la migración `0007` justificó en la práctica.

---

## Decisión 1 · Modelo de asiento: cabecera + líneas, con diferencial cero en el motor

### Decisión

`accounting.journal_entries` (cabecera) + `accounting.journal_lines` (líneas). El diferencial cero se valida con una **restricción diferida** a nivel de motor, no en la capa de aplicación.

### Contexto

Existen tres formas conocidas de modelar un asiento:

| Alternativa | Descripción | Por qué se descarta |
|---|---|---|
| Líneas sueltas sin cabecera | Cada línea es una fila independiente con fecha y número | No hay forma de garantizar que un conjunto de líneas forme un asiento balanceado. El balance se calcula sumando, y cuando no cuadra no hay nada que señalar |
| Documento único con arrays | El asiento es una fila con un JSON de líneas | No se puede indexar por cuenta ni consultar el mayor eficientemente. La integridad queda en la aplicación |
| **Cabecera + líneas** | Entidad explícita + líneas con FK | **Elegida.** El asiento es una entidad con ciclo de vida propio, y la restricción de balance tiene dónde vivir |

### Implementación

```sql
-- El diferencial cero se verifica al cierre de la transacción, no en cada INSERT.
-- Es diferido a propósito: al insertar la cabecera todavía no hay líneas, así que
-- una verificación inmediata sería imposible. AL FINAL de la transacción —cuando
-- ya están todas las líneas— es el único punto donde el asiento está completo.
CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON accounting.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting.assert_entry_balanced();
```

La función `assert_entry_balanced()` suma débitos y créditos de la entrada afectada y **lanza excepción** si difieren. Aborta la transacción completa: no queda un asiento descuadrado, ni parcial.

### Por qué es irreversible

Las líneas ya escritas definen el histórico. Cambiar de modelo obliga a migrar todas las líneas de todas las empresas y a recalcular todos los saldos: no es un `ALTER TABLE`, es una reescritura de los libros.

### Consecuencia aceptada

Un asiento no se puede insertar en dos transacciones separadas (cabecera en una, líneas en otra). Es una restricción real de la arquitectura y se documenta acá para que no sorprenda: todo asiento se crea en una única transacción.

---

## Decisión 2 · Plan de cuentas: mínimo obligatorio de plataforma + extensión por empresa

### Decisión

Toda empresa tiene, desde su creación, un **plan mínimo obligatorio** creado por la plataforma con códigos normalizados. La empresa puede agregar cuentas propias y subdividir las existentes, pero **no puede eliminar ni recodificar** las del mínimo.

### Contexto

Un plan de cuentas libre por empresa parece más flexible y es la opción que eligen por defecto los sistemas que no piensan en consolidación. El problema aparece después: si la empresa A llama `4.1.1` a "Ventas" y la empresa B llama `5.2.3` a lo mismo, **ninguna consulta agregada puede comparar ni sumar**. No hay forma de recuperar esa correspondencia a posteriori: los códigos ya están en el histórico.

### Vocabulario mínimo (extracto)

| Código | Cuenta | Tipo | Uso obligatorio |
|---|---|---|---|
| `1.1.1.01` | Caja | Activo | Cobros en efectivo |
| `1.1.2.01` | Banco cuenta corriente | Activo | Cobros y pagos bancarios |
| `1.1.3.01` | Cuentas a cobrar clientes | Activo | `billing.invoices` autorizadas |
| `1.2.1.01` | Inventario de mercaderías | Activo | Valuación desde `stock_levels.avg_cost` |
| `2.1.2.01` | Cuentas a pagar proveedores | Pasivo | `purchasing.purchase_invoices` |
| `2.1.3.01` | IVA débito fiscal | Pasivo | Del comprobante emitido |
| `2.1.3.02` | IVA crédito fiscal | Activo | De la factura de compra |
| `3.1.1.01` | Capital | Patrimonio | Alta de empresa |
| `4.1.1.01` | Ventas | Resultado positivo | `billing.invoices` |
| `5.1.1.01` | Costo de mercadería vendida | Resultado negativo | Desde `stock_movements` |
| `6.1.1.01` | Sueldos y cargas sociales | Resultado negativo | Fase E7 |

El listado completo se entrega con la migración `0012`.

### Distinción estructural

- `tenant_id IS NULL` → cuenta de plantilla de plataforma. Nadie la edita.
- `tenant_id = <uuid>` → cuenta de la empresa. Libre dentro de las reglas.

Al crear una empresa, sus cuentas se **copian** desde la plantilla, no se referencian. La razón es que una empresa necesita poder renombrar "Caja" a "Caja chica sucursal Norte" sin afectar a las demás. Si referenciara la plantilla, la personalización filtraría entre empresas.

### Por qué es irreversible

Cambiar el vocabulario después obliga a remapear el histórico de todas las empresas. Es exactamente la deuda que este ADR existe para no contraer.

### Consecuencia aceptada

Un cliente que quiera un plan de cuentas totalmente distinto al mínimo no está soportado. Se puede subdividir y renombrar, no reemplazar la raíz. Se acepta: el costo de la inconsistencia es mayor que el de la rigidez.

---

## Decisión 3 · Saldos: materializados, con recálculo auditado

### Decisión

`accounting.account_balances` mantiene el saldo por cuenta y período, **materializado**. El movimiento del asiento lo actualiza por trigger. Un job de reconciliación verifica la consistencia contra el libro y **reporta sin corregir**.

### Contexto

| Alternativa | Ventaja | Costo |
|---|---|---|
| Calcular siempre desde el libro | Nunca se desincroniza | El balance de una empresa con 5 años de historia suma millones de líneas en cada consulta. Inviable |
| **Materializar** | Consulta O(1) por cuenta y período | Hay dos vistas del mismo dato: se pueden desincronizar |
| Materializar en caché externa | No ensucia la base | Un balance que no es transaccional no sirve para contabilidad: se consulta dentro de transacciones que pueden abortar |

### El patrón ya está resuelto en el proyecto

`app.stock_levels` es exactamente esto: una proyección materializada de `app.stock_movements`, mantenida por `apply_stock_movement()` en la misma transacción que escribe el movimiento. Y el job `stock.reconciliation` ya detecta y **reporta sin corregir** las divergencias.

Se replica el patrón tal cual, por tres razones:

1. **Está verificado.** Se inyectó una deriva de +7 y el job la detectó (`saldo_fisico=77 vs libro=70`).
2. **Tiene la decisión de no autocorregir ya tomada y justificada**: una divergencia es un síntoma, y no se sabe cuál de las dos vistas es la equivocada. Corregir propagaría el error y destruiría la evidencia.
3. **La escritura va por función, no por INSERT directo**, así que la proyección no se puede saltear.

### Implementación

La escritura de asientos pasa por `accounting.post_entry(...)`, que en una transacción: crea la cabecera, inserta las líneas, y actualiza los saldos. Mismo criterio que `apply_stock_movement()`.

### Por qué es irreversible

Elegir "calcular siempre" y descubrir el problema de rendimiento obliga a introducir materialización con el histórico ya cargado, y a resolver el backfill de saldos sin una referencia confiable. Al revés es más barato: materializar desde el inicio y agregar el job de verificación después es trivial.

---

## Decisión 4 · Períodos: mensual, con cierre irreversible y reapertura auditada

### Decisión

Granularidad de período **mensual** para todas las empresas. Un período cerrado es inmutable. La reapertura requiere permiso, deja rastro de auditoría y es una operación explícita, no un efecto colateral.

### Contexto

La granularidad podría ser configurable por empresa (mensual, trimestral, o por ejercicio completo). Se descarta por una razón concreta: los reportes comparativos entre empresas —el objetivo de negocio declarado en el ADR 0001 §2— necesitan una unidad de tiempo común. Con granularidades mezcladas, cada comparación requiere reagrupar, y el reagrupamiento no es exacto cuando hay cierres intermedios.

### Modelo temporal

```
accounting.fiscal_years      -- ejercicio fiscal (tenant_id, starts_on, ends_on, status)
accounting.periods           -- mes dentro del ejercicio (year_id, period_number, status)
```

Estados: `open` → `closing` → `closed`. La transición a `closed` es la que congela.

### Regla de inmutabilidad

Un `CHECK` no alcanza: hace falta un trigger sobre `journal_entries` que consulte el estado del período y rechace el insert si no está `open`. Es la misma forma que ya usa `billing.invoices` para volverse inmutable tras el CAE.

### Reapertura

Reabrir un período cerrado es una operación con consecuencias: invalida cualquier balance ya presentado. Por eso:

- Requiere el permiso `accounting.reopen_period` (que no tiene ningún rol por defecto).
- Escribe en `audit.events` con severidad `critical`.
- Registra motivo obligatorio (`reopened_reason`).

El procedimiento queda documentado acá **antes** de la fase E1, que era el riesgo E-R6 del plan.

### Por qué es irreversible

La granularidad determina los índices, los cortes de reporte y la forma del cierre. Cambiarla con historia cargada obliga a re-cortar todos los períodos existentes.

### Consecuencia aceptada

Una empresa que quiera cerrar por trimestre tiene que usar tres períodos mensuales y un reporte trimestral agregado. Se acepta.

---

## Decisión 5 · Vocabulario neutral, no nomenclatura AFIP

### Decisión

Todo lo que se agregue a partir de ahora usa **vocabulario neutral** (`authorization_id`, no `cae`; `tax_condition`, no `condicion_iva_receptor`; `credit_note`, no `nota_credito_a`). La traducción al vocabulario AFIP ocurre en el driver, en el borde.

### Contexto

Esto no es nuevo: el [plan de producción](../docs/PLAN-PRODUCCION.md) ya introdujo `FiscalDriver` precisamente para que el dominio no dependa del país. El riesgo es concreto y tiene antecedente: si la contabilidad nace con `cae` hardcodeado en las columnas y con las alícuotas de IVA argentino como constantes, **un segundo país no es una implementación: es una reescritura del núcleo contable.**

### Alcance

| Capa | Vocabulario | Por qué |
|---|---|---|
| `accounting.*` | Neutral | Es el libro: debe ser el mismo en cualquier país |
| `app.*`, `billing.*` existentes | Mixto (herencia) | Ya están en producción; se migran si y cuando haya un segundo país |
| `modules/afip/*` | AFIP | Es el borde: acá vive lo específico y debe quedar contenido |

`billing.invoices.cae` se mantiene: renombrarlo es un `ALTER` sin beneficio inmediato. Lo que se decide es que **lo nuevo no repita el patrón**, y que el driver fiscal sea el único lugar con nombres de AFIP.

### Extensión a impuestos

El plan §8.4 define `TaxDriver` como el contrato que extiende el mismo criterio a los impuestos. `accounting` no conoce alícuotas: las pide al driver. Es la decisión que hace que agregar un país sea implementar un contrato y no tocar el libro.

### Por qué es irreversible

Los nombres de columna y los códigos de impuesto quedan en el esquema y en el histórico. Renombrar con datos cargados es costoso y propenso a error.

---

## Resumen

| # | Decisión | Garantía | Reversibilidad |
|---|---|---|---|
| 1 | Cabecera + líneas | Diferencial cero en el motor (trigger diferido) | Reescritura del libro |
| 2 | Mínimo obligatorio de cuentas | Copia al crear la empresa | Remapeo del histórico |
| 3 | Saldos materializados | Trigger en la misma transacción + job que reporta sin corregir | Backfill sin referencia confiable |
| 4 | Período mensual | Trigger de inmutabilidad + reapertura auditada | Re-corte de todos los períodos |
| 5 | Vocabulario neutral | Contenido en el driver fiscal | Renombre con datos cargados |

---

## Consecuencias sobre el plan

- **E1** implementa las decisiones 1 a 4 en la migración `0012`, más la `0013` con las políticas RLS y el plan mínimo. La cobertura la verifica `app.assert_rls_coverage()` sin cambios: las tablas nuevas nacen alcanzadas por la barrera existente.
- **E2** (asientos automáticos) depende de la decisión 1: el motor de reglas emite cabecera + líneas, nunca líneas sueltas.
- **E3 y E4** (compras, tesorería) usan el vocabulario de la decisión 2 para mapear a las cuentas del mínimo.
- **E5** (fiscal) implementa `TaxDriver` según la decisión 5.
- **E7** (RR.HH.) usa `6.1.1.01` del mínimo para el asiento de sueldos.

Ninguna decisión de este ADR bloquea una fase: todas la habilitan.

---

## Adenda · El riesgo que este ADR no elimina

Fijar las decisiones elimina la ambigüedad, no el riesgo. Los tres puntos que siguen requieren atención durante la implementación:

1. **El trigger diferido no es gratis.** Se ejecuta una vez por transacción sobre las líneas afectadas. Con un cierre que escribe 50.000 líneas, la verificación tiene costo. Hay que medirlo con volumen real, no con el escenario de prueba.

2. **La materialización de saldos tiene un caso borde real:** un asiento que afecta un período **cerrado** debe rechazarse antes de tocar el saldo, no después. Si el orden es "actualizo el saldo y después valido el período", la actualización queda escrita y el saldo miente. La validación de período va primero, sin excepción.

3. **El plan mínimo es una decisión de producto, no técnica.** Qué cuentas son obligatorias determina qué reportes de plataforma son posibles. La lista de la decisión 2 es un punto de partida razonable, no una verdad: conviene revisarla con un contador antes de que la migración `0012` se aplique en producción, y no después.
