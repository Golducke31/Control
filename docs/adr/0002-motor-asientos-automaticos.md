# ADR 0002 · Motor de asientos automáticos

- **Estado:** aceptado, previo a la migración `0013`
- **Fase:** E2 del `docs/PLAN-ERP-MULTIEMPRESA.md`
- **Contexto previo:** `docs/adr/0001-nucleo-contable.md` (E1, ya implementado)

## Por qué este ADR existe antes del código

El plan §8.2 fija cuatro decisiones como irreversibles, y §7.3 explica por qué E2 va
inmediatamente después de E1: *"es el puente entre módulos y libro. Construirlo con los
orígenes que ya existen (ventas, facturación, stock) es más barato que construirlo junto
con un origen nuevo, porque el patrón se valida contra datos reales primero."*

La decisión que este ADR fija es **cómo se garantiza que un hecho económico tenga
exactamente un asiento**. Eso no es una decisión de implementación: si se elige mal, el
error no aparece como un fallo, aparece como un balance que dice otra cosa, y se descubre
en un cierre. Cambiarla después cuesta en proporción al histórico acumulado.

---

## Decisión 1 · La idempotencia la garantiza una restricción única, no la lógica

**Decisión.** `accounting.journal_entries` recibe un índice único parcial sobre
`(tenant_id, source_type, source_id)` para los asientos de origen automático. Un segundo
intento de generar el asiento del mismo hecho **falla en el motor**, no se detecta por
aplicación.

**Motivo.** Es la misma garantía que ya usa el proyecto para el correlativo fiscal
(`inv_idem_unique` en `0004`: `UNIQUE (tenant_id, idempotency_key)`) y para los jobs
(`uq_job_runs_one_running` en `0010`). El patrón está verificado. Y el modo de falla que
evita es el peor de todos: **un hecho con dos asientos no rompe nada visible** — el
balance sigue cuadrando, las dos líneas cierran, la suma del debe iguala la del haber.
Lo único que cambia es que la ganancia está duplicada y nadie lo sabe. Un trigger de
aplicación se puede saltear (un reproceso, un `INSERT` a mano en una corrección, un
script de migración de datos); la restricción única no.

**Consecuencia aceptada.** El generador debe tolerar el conflicto y tratarlo como
"ya estaba hecho", no como un error. Se implementa con `ON CONFLICT DO NOTHING` sobre el
índice, seguido de una lectura del asiento existente: la operación es **idempotente por
reintento**, que es lo que exige un job que puede correr dos veces.

**Alternativa descartada.** Un campo `accounted_at` en el hecho de origen, consultado antes
de generar. Se descarta porque es una condición de carrera entre dos transacciones
concurrentes: ambas leen "no tiene asiento", ambas generan. El índice único convierte esa
carrera en un error de motor determinista.

---

## Decisión 2 · El mapeo hecho → cuentas es DATO, no código

**Decisión.** El mapeo vive en una tabla `accounting.mapping_rules` por empresa, con
`source_type` + una clave de clasificación (`event_kind`) que resuelve a un conjunto de
cuentas por rol (`debit_account_role` / `credit_account_role`). Los roles se resuelven
contra el plan de la empresa por código normalizado.

**Motivo.** Es la aplicación directa de la decisión 2 del ADR 0001 (plan de cuentas
copiado, códigos normalizados). Si el mapeo estuviera en el código, agregar una empresa
con otro criterio contable sería un despliegue; y la única forma de que un contador ajuste
su imputación sería un pedido de cambio. Además, un mapeo en código no se puede auditar:
la tabla se consulta, el código se lee.

**Consecuencia aceptada.** Hay una indirección más (rol → código → cuenta) y un caso de
error nuevo: una empresa a la que le falta la cuenta de un rol. Se resuelve con un error
explícito y accionable que nombra el rol y el código esperado — nunca con un asiento
incompleto o con una cuenta adivinada.

**Alternativa descartada.** Resolver las cuentas por `code` hardcodeado en el generador.
Se descarta por el riesgo ya declarado en §8.4 del plan: si la contabilidad nace con
lógica argentina dispersa, un segundo país no es una implementación sino una reescritura.

---

## Decisión 3 · Un asiento automático se genera en la MISMA transacción que el hecho

**Decisión.** La generación no va en un job que barre hechos y les agrega asientos: va en
el camino de escritura del hecho, dentro de su transacción. El job de control
(`accounting.posting_check`) **verifica y reporta**, no corrige.

**Motivo.** Es el criterio que el ADR 0001 ya aplicó a los saldos materializados y que
`apply_stock_movement()` aplica al stock. Un job que "completa" los asientos faltantes
convierte un error de negocio en una deuda silenciosa: el asiento aparece horas después,
en un período que puede estar cerrado para entonces, y el hecho y su asiento dejan de ser
atómicos. Si el asiento no se puede generar, el hecho no debería confirmarse.

**Consecuencia aceptada.** El camino de escritura del hecho se vuelve más largo y puede
fallar por causas contables (empresa sin ejercicio abierto, sin mapeo configurado). Es una
consecuencia deseable: esas condiciones son errores de configuración que deben aparecer en
el momento, no acumularse. **Excepción explícita:** los hechos históricos que ya existen
al aplicar la migración no tienen asiento; para esos hay una **puesta al día explícita y
auditada** (`accounting.backfill_entries`), que es una operación distinta y trazable, no el
comportamiento normal del sistema.

**Alternativa descartada.** Job de barrido que corre cada N minutos y asienta lo que falta.
Se descarta como mecanismo primario por lo anterior. Se conserva, invertido, como job de
**detección**: encuentra hechos sin asiento y los reporta como incidente.

---

## Decisión 4 · El asiento de un hecho no se edita ni se borra: se revierte

**Decisión.** Cancelar o anular un hecho (una nota de crédito, una devolución, un
movimiento de ajuste) **no modifica el asiento original**: genera un contra-asiento con
`reverse_entry()`, que ya existe y está verificado en E1. El vínculo es
`reverses_entry_id`.

**Motivo.** Es la decisión 4 del ADR 0001 aplicada al puente. Un asiento que se edita
destruye la trazabilidad que §6.1 declara como objetivo (*"100% de hechos económicos con
asiento balanceado y trazable al documento"*). Si al anular una factura se borrara su
asiento, el libro dejaría de explicar lo que pasó en el período.

**Consecuencia aceptada.** El libro diario conserva el asiento original y su reversión.
Un lector que sume todo ve cero, que es lo correcto; un lector que mire el período ve el
hecho y su corrección. Eso es lo que se quiere.

---

## Reglas de mapeo para los orígenes de E2

Sólo se cubren los hechos que **ya existen** en el sistema, que es el alcance que el plan
fija para E2 (§7.1: *"ventas, facturación y stock"*).

| Origen (`source_type`) | `event_kind` | Débito | Crédito |
|---|---|---|---|
| `invoice` | `invoice` | `1.1.3.01` CxC clientes (`total`) | `4.1.1.01` Ventas (`subtotal`) |
| | | | `2.1.2.01` IVA débito fiscal (`tax_total`) |
| `invoice` | `credit_note` | `4.1.1.03` Devoluciones (`subtotal`) | `1.1.3.01` CxC clientes (`total`) |
| | | `2.1.2.01` IVA débito fiscal (`tax_total`) | |
| `invoice` | `debit_note` | `1.1.3.01` CxC clientes (`total`) | `4.1.1.01` Ventas (`subtotal`) |
| | | | `2.1.2.01` IVA débito fiscal (`tax_total`) |
| `stock_movement` | `sale_out` | `5.1.1.01` CMV (`cost_amount`) | `1.1.5.01` Inventario (`cost_amount`) |

El `event_kind` no es una etiqueta inventada por la migración: se corresponde con el
vocabulario que ya existe en el origen — `billing.invoices.kind` y
`stock.movements.kind`— para que un hecho nuevo no requiera traducir su nombre. El
`amount_key` entre paréntesis indica de qué campo del jsonb de importes sale cada línea.

**Nota sobre el IVA.** El array de impuestos **no incluye alícuota 0%**, por la misma razón
que el cliente de WSFE: AFIP rechaza el Id 3. Un comprobante con IVA 0% genera asiento sin
la línea de impuesto, no con una línea en cero. Cero y ausente no son lo mismo en
contabilidad: una línea de IVA en cero sugiere una operación alcanzada al 0%, que es un
hecho distinto de una operación no alcanzada.

**Nota sobre el costo de venta.** El asiento de `sale_out` usa el `unit_cost` **del
movimiento**, no el `avg_cost` actual del producto. El costo relevante es el del momento
de la salida, que es el que `apply_stock_movement()` ya congeló en la fila del movimiento.
Leer el costo actual sería un error de imputación temporal: el CMV del mes cambiaría
retroactivamente cada vez que entra mercadería.

---

## Defecto encontrado por el motor, no por la revisión

Al probar la idempotencia contra PostgreSQL (no contra la migración leída), el generador
falló con:

```
ERROR:  la sintaxis de entrada no es válida para el enum entry_source: «automatic»
CONTEXT:  función PL/pgSQL post_entry_for_source(...) en la línea 27 en asignación
```

`post_entry_for_source` le pasaba el literal `'automatic'` a `accounting.post_entry()`,
pero el enum `entry_source` de `0012` **no tiene ese valor**: sus etiquetas son `invoice`,
`credit_note`, `debit_note`, `payment`, `purchase`, `supplier_payment`, `stock_movement`,
`payroll`, `tax`, `depreciation`, `opening`, `closing` y `manual`.

**Qué revela el error.** No es un typo: es un error de modelo. El enum describe el
**origen del hecho**, no **quién lo asentó**. Un asiento nacido de una factura autorizada
es de origen `invoice`, lo haya escrito una persona o este generador. La distinción
automático/manual ya la da `source_id IS NOT NULL` —un asiento automático siempre tiene
hecho de origen; uno manual, salvo ajustes explícitos, no—, y duplicarla en el enum
habría creado dos fuentes de verdad para la misma pregunta.

**Cómo se corrigió.** El generador traduce `p_source_type` al valor del enum con una tabla
explícita y no con un cast ciego. Un `p_source_type::accounting.entry_source` habría
funcionado hoy y explotado con un mensaje incomprensible el día que alguien agregue un
tipo de hecho que el enum no prevea. Un `source_type` que el vocabulario no nombre cae en
`manual`, y `source_type` conserva el nombre real: se prefiere un asiento auditable y
rastreable antes que abortar una operación de negocio por una etiqueta.

**Por qué la revisión estática no lo vio.** El enum se declara en `0012` y se usa en
`0013`. Ninguno de los dos archivos es incorrecto por separado: el defecto vive en la
costura entre los dos, y ningún validador de un solo archivo puede verlo. Es el argumento
a favor de la regla del proyecto de que las migraciones se **aplican** en una base real
antes de darse por buenas.

**Estado.** Corregido y verificado. La invariante 11 de `tests/accounting/run.mjs` llama al
generador tres veces con el mismo `source_id` y exige el mismo asiento con una sola fila, y
además verifica que el `source` del asiento generado sea `invoice` y no un literal fuera
del vocabulario —así el defecto no puede volver sin que la suite lo diga.

---

## Riesgos que este ADR NO elimina

1. **Un hecho puede confirmarse sin asiento si el sistema falla entre la confirmación y la
   generación.** La decisión 3 los vuelve atómicos *dentro de la transacción*, pero si un
   despliegue introduce un camino que confirma sin asentar, el job de control lo detecta
   y no lo corrige. **El control es una alarma, no una red.**
2. **Los códigos de cuenta normalizados son una convención, no una garantía.** El mapeo
   referencia `1.1.3.01`; si una empresa recodifica su plan (lo que el ADR 0001 permite),
   el mapeo apunta a una cuenta que ya no existe con ese código. Se mitiga con un error
   explícito al detectar el rol sin cuenta, y con la restricción de que **recodificar una
   cuenta con movimientos exige un procedimiento explícito** (criterio C-7 del plan).
3. **El backfill de hechos históricos puede materializar asientos en un período cerrado.**
   Es exactamente el riesgo residual de la adenda del ADR 0001, que E1 resolvió para el
   camino normal. El backfill usa el mismo camino (`post_entry`), así que hereda la
   protección: falla en vez de escribir. Se documenta porque un operador podría
   interpretar ese fallo como un problema del backfill y no como la garantía funcionando.
