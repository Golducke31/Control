# ADR 0004 · Motor de impuestos genérico, con Argentina como primera implementación

- **Estado:** aceptado, previo a la fase E5
- **Fase:** E5 del `docs/PLAN-ERP-MULTIEMPRESA.md`
- **Contexto previo:** `docs/adr/0003-vocabulario-fiscal-neutral.md` (misma fase, misma conversación)

## Por qué este ADR existe antes del código

El plan §8.2 fija esta decisión como irreversible, con la misma frase que la anterior:
*"Igual que el anterior: define si un segundo país es una implementación o una reescritura —
Antes de E5."*

§8.4 ya propone la forma del contrato (`TaxDriver` con `ratesOn`, `withholdingRules`,
`requiredBooks`, `normalize`) y su propio argumento: *"Extender el contrato es barato;
desarmar contabilidad no."*

Este ADR ratifica ese contrato y decide **las dos cosas que el plan deja abiertas**: dónde
viven las reglas impositivas, y de dónde sale la posición de IVA que el gate de E5 exige
reproducible.

---

## Decisión 1 · El contrato de §8.4 se adopta tal como está, sin agregar métodos

**Decisión.** Se implementa `TaxDriver` con exactamente los cuatro métodos que §8.4
enumera: `ratesOn`, `withholdingRules`, `requiredBooks`, `normalize`. No se agrega ninguno
en E5.

**Motivo.** Los cuatro métodos cubren las seis verificaciones F-1…F-6 de §6.2:
`ratesOn` resuelve F-1 (cálculo por alícuota) y F-5 (alícuota nueva sin recompilar);
`withholdingRules` resuelve F-4; `requiredBooks` resuelve F-3 (el formato del libro digital);
`normalize` permite que F-6 (posición reproducible) se exprese en vocabulario común.

**Por qué no agregar métodos "por las dudas".** Un contrato con métodos que nadie llama es
un contrato que nadie prueba, y cuando por fin se llama descubre que no encaja. Si E5
demuestra que falta una operación, se agrega **con la implementación que la necesita
delante** — igual que `contractVersion` existe para permitir.

**Consistencia con el patrón ya probado.** `FiscalDriverRegistry` resuelve por código de
país con un `Map` y no con un `switch`, por una razón que está escrita en su encabezado:
*"el `switch` obliga a modificar un archivo central cada vez que se agrega un país, y ese
archivo se vuelve un punto de conflicto de merges."* `TaxDriverRegistry` nace con la misma
forma y la misma razón.

---

## Decisión 2 · Las reglas impositivas viven en datos versionados, no en código

**Decisión.** Las alícuotas, los regímenes de retención y las definiciones de libros que
devuelve el driver argentino se leen de tablas en `fiscal.*`, con **vigencia temporal**
(`valid_from`, `valid_to`), no de constantes en TypeScript. El driver es la capa que las
interpreta; no la que las contiene.

**Motivo.** Una alícuota es una norma con fecha de vigencia, y en Argentina eso no es
teórico: la alícuota de IVA cambió varias veces en la última década, y los regímenes de
retención se modifican por resolución. Si la alícuota es una constante en el código:

- Cambiar una alícuota es un deploy, y el histórico queda mal calculado para atrás salvo
  que el deploy haya salido el día exacto del cambio.
- Un comprobante de marzo se recalcula con la alícuota de septiembre si alguien reprocesa.
  El número que se presentó ante el organismo deja de ser reproducible.

Con vigencias en la base, `ratesOn(date)` es una consulta por fecha y el histórico se
reproduce solo. Una determinación de IVA de un período viejo vuelve a dar el mismo número
en 2030, que es lo que F-6 pide.

**Lo que esto NO significa.** No se construye un motor de reglas genérico con DSL ni
fórmulas configurables por el usuario. Las **fórmulas** de cálculo (base × alícuota, débito
menos crédito, prorrateo) viven en código y son parte del driver. Lo que se versiona son
los **parámetros** de la norma: qué alícuota, qué régimen, desde cuándo. Configurar las
fórmulas sería trasladar el problema al usuario, que es como se llega a una planilla con
peor mantenimiento que el código.

**Alternativa descartada.** Alícuotas como constantes en `afip.tax-driver.ts`. Es más
simple y es lo que haría un MVP. Se descarta porque el costo de migrar a vigencias después
es proporcional al histórico, que es la definición de decisión irreversible de §8.2.

---

## Decisión 3 · La posición de IVA se DERIVA del libro, y no se acumula en una columna

**Decisión.** La posición de IVA de un período (el gate de E5: *"posición de IVA
reproducible desde el libro"*) se calcula siempre desde los asientos del período, sumando
las cuentas que `fiscal.*` marca con rol `iva_debito` / `iva_credito`. No existe una tabla
`fiscal.iva_positions` con el resultado guardado.

**Motivo.** Es la misma decisión que `0015` tomó para `payment_status`, y por la misma
razón, ya escrita en esa migración:

> *"El estado de cobro se DERIVA. Un estado escrito a mano sobre una factura que después
> recibe una nota de crédito queda mintiendo, y nadie lo recalcula. Misma lógica que el
> estado de línea en `0014`: la columna existe para poder indexar y filtrar, pero su valor
> no lo elige nadie."*

Una posición de IVA guardada es peor que un saldo guardado: es un número que se presenta a
un organismo fiscal y que puede quedar desincronizado del libro por una nota de crédito
posterior, una rectificativa o un cierre de período. Y F-6 no pide "un número guardado",
pide uno **reproducible desde el libro** — que es exactamente lo contrario de guardarlo.

**Consecuencia de rendimiento, aceptada.** Sumar el libro de un período es más caro que
leer una fila. Se acepta porque el volumen de un período es acotado, y porque el proyecto ya
tiene el patrón para el caso general: `E-R8` del plan deja la materialización de saldos con
recálculo por job como decisión de rendimiento, **sobre datos derivados y verificados**, no
como fuente de verdad. Si el `EXPLAIN ANALYZE` con 10 M de filas lo exige, se agrega una
tabla materializada con job de recálculo — y el gate de E5 sigue midiendo contra el libro,
no contra la tabla.

**Alternativa descartada.** Acumular el débito y el crédito fiscal en columnas de
`fiscal.iva_positions` al momento de emitir. Es más rápido y es incorrecto por la misma
razón por la que lo era el estado de cobro escrito a mano.

---

## Consecuencias aceptadas

- E5 introduce el esquema `fiscal.*` con tablas con vigencia temporal. La primera carga es
  un seed con la normativa argentina vigente a la fecha de la migración, **con sus fechas**
  y no con `now()`: una norma no empieza a regir cuando se corre la migración.
- `ratesOn(date)` recibe una fecha y no devuelve "la alícuota actual". Un llamador que quiera
  "hoy" pasa `CURRENT_DATE` explícitamente. Esto impide el defecto silencioso de recalcular
  un comprobante viejo con la alícuota de hoy.
- El driver argentino es la primera implementación y **no es el default del contrato**: el
  registro arranca vacío y un país sin driver registrado falla ruidosamente, igual que en
  `FiscalDriverRegistry.resolve()`.
- La neutralidad de `0003` aplica también acá: las tablas de `fiscal.*` nombran conceptos
  (`iva_debito`, `withholding`) y el código local argentino vive en columnas `local_code`,
  nunca en el nombre de la columna principal.
