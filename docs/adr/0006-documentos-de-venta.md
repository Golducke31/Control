# ADR 0006 · Documentos de venta: remito, devolución y listas de precios

- **Estado:** Aceptada
- **Fase:** E6 del `PLAN-ERP-MULTIEMPRESA.md`
- **Fecha:** 18 de septiembre de 2026
- **Reemplaza / relaciona:** `0003` (vocabulario fiscal neutral), `0005` (hecho fiscal propio)

## Contexto

La fase E5 cerró la determinación de IVA y dejó al sistema capaz de responder "¿cuánto IVA se paga?". El plan §4.6 / M6 identifica el siguiente hueco del módulo de ventas: hoy una orden de venta (`billing.sales_orders`) se parece a todos los documentos, y no existen tres documentos que en la operación real son distintos y legales:

1. **Cotización** — oferta con validez, que vence y no compromete stock ni genera asiento.
2. **Remito** — documento que viaja con la mercadería, se firma al recibir, y es el origen fiscal del despacho. Hoy su papel lo ocupa `logistics.shipments` (despacho operativo + POD), pero **no es un documento comercial/fiscal**: no tiene número de remito propio, no es el origen de la facturación, y nada impide facturar dos veces la misma mercadería.
3. **Devolución de cliente** — documento que revierte stock y genera la nota de crédito aplicada al saldo.

Además faltan **listas de precios con vigencia y escalas por cantidad**, que son la base de cualquier facturación correcta y del margen real.

El **gate de E6** (§7.1) es explícito y medible: *"Remito facturado en partes sin duplicar cantidades"* (criterio V-2). Es decir, el riesgo que este ADR debe cerrar primero es que, al facturar un remito en varias partes, las cantidades no se cuenten dos veces ni se excedan las despachadas.

## Decisiones

### Decisión 1 · El remito es un documento propio, separado de la orden y de la factura

`billing.sales_orders`, `billing.invoices` y el nuevo `billing.delivery_notes` (remito) son tres entidades distintas con ciclo de vida propio, siguiendo la lección de `0003`/`0005`: el vocabulario de un lado del negocio no describe el documento entero. La orden compromete; el remito autoriza la salida y se firma; la factura liquida.

- El remito se genera **desde una orden** (o varias líneas de ella) y, opcionalmente, se liga a un `logistics.shipments` operativo (el POD vive en el despacho, no en el remito).
- La factura se genera **desde uno o varios remitos**, no directamente desde la orden para el flujo de remito. El camino directo orden→factura (legado) sigue existiendo para los casos sin remito.

### Decisión 2 · El acumulado facturado vive en la línea del remito, no en la factura

Cada línea de remito lleva `qty_invoiced`. La garantía de "no duplicar" se sostiene con **tres capas**, igual que en el resto del proyecto (motor > aplicación):

1. Un `CHECK (qty_invoiced <= quantity)` en `billing.delivery_note_items` — el motor rechaza el sobre-facturado aunque la aplicación lo pidiera.
2. La función `billing.invoice_delivery_note(...)` incrementa `qty_invoiced` **con la línea bloqueada (`FOR UPDATE`) en la misma transacción** que crea la factura, y valida `qty_invoiced + nueva <= quantity` antes de escribir. Sin esto, dos facturaciones concurrentes de la misma línea podrían sumar más que lo despachado.
3. `billing.invoice_items` referencia la línea de remito (`delivery_note_item_id`), de modo que la trazabilidad origen→destino (Regla 2 del ERP) es navegable: de un asiento se llega a la factura, de la factura a la línea de remito, del remito a la orden y al POD.

El estado del remito deriva del acumulado: `invoiced` cuando toda línea está completa, `partially_invoiced` en otro caso. Es derivado, no escrito a mano (igual que `payment_status` en `0015`).

### Decisión 3 · Devolución como documento que revierte stock y genera nota de crédito

La devolución de cliente (`billing.customer_returns`) es un documento propio con estado (`draft|confirmed|applied`), no una edición de la factura. Al aplicarse:

- revierte el stock con un movimiento `return_in` vía `app.apply_stock_movement()` (ya resuelve costo promedio ponderado), y
- genera una `billing.invoices` de `kind = 'credit_note'` ligada por `related_invoice_id`, aplicada al saldo del cliente.

Una devolución no borra la factura original: la contabilidad es inmutable y se revierte con contra-asiento (Regla 3 del ERP). Esto se implementa en la migración `0022` (siguiente incremento de E6).

### Decisión 4 · Listas de precios con vigencia y escalas por cantidad

Precio = función de `(lista, vigencia, variante, cantidad)`, resuelta por datos y no hardcodeada, por el mismo motivo que las alícuotas viven en `fiscal.tax_rates` (`0004`/`0005`): la norma de precios cambia y una determinación vieja tiene que seguir siendo reproducible. Se implementa en la migración `0023` (siguiente incremento de E6). Hasta entonces, el remito y la factura siguen usando el `unit_price` snapshot de la orden.

## Consecuencias

- **Positivas:** el gate V-2 es medible y está en el motor; la trazabilidad comercial es navegable; el remito deja de ser un campo implícito y se vuelve auditabe.
- **Negativas / costo:** dos tablas nuevas y una función de facturación específica. El camino orden→factura legado convive con remito→factura; la unificación en un motor de facturación único queda como mejora futura, no bloquea el gate.
- **Riesgo aceptado:** la conciliación `qty_invoiced` vs. cantidades de `sales_order_items.qty_delivered` no se fuerza con FK (son documentos distintos); se verifica con la suite y con una consulta de control en el cierre.

## Cumplimiento del gate

- **V-2 (gate):** `tests/sales/run.mjs` factura un remito de 100 en partes (60 + 40), reintenta facturar de más y una segunda vez las 60, y exige que el total facturado sea 100 y el acumulado no se duplique.
- **V-7:** el `CHECK` y la función rechazan el sobre-facturado a nivel de motor, no sólo de aplicación.

Las demás aceptaciones de E6 (V-1 cotización, V-3 devolución, V-4 listas) se cubren en `0022` y `0023`.
