# Plan de Evolución hacia un ERP Multiempresa · Control

**Documento:** Evaluación de brechas y plan de mejora hacia estándar ERP
**Versión:** 1.0
**Fecha:** 18 de septiembre de 2026
**Estado base:** Commit `6bf0942` sobre `main` (**E6 cerrada**). 25 migraciones aplicadas y verificadas contra PostgreSQL 16.15; los invariantes de aislamiento, contabilidad, compras, tesorería, fiscal y las cuatro puertas de ventas (E6) corren como jobs de CI.
**Documento relacionado:** [`PLAN-PRODUCCION.md`](PLAN-PRODUCCION.md) — puesta en producción y escalamiento multinacional.

---

## Tabla de contenidos

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Qué es y qué no es un ERP multiempresa](#2-qué-es-y-qué-no-es-un-erp-multiempresa)
3. [Evaluación del estado actual](#3-evaluación-del-estado-actual)
4. [Análisis de brechas por módulo](#4-análisis-de-brechas-por-módulo)
5. [Mejoras priorizadas](#5-mejoras-priorizadas)
6. [Objetivos esperados y métricas](#6-objetivos-esperados-y-métricas)
7. [Orden de implementación sugerido](#7-orden-de-implementación-sugerido)
8. [Riesgos y decisiones irreversibles](#8-riesgos-y-decisiones-irreversibles)
9. [Anexo · Matriz de brechas consolidada](#anexo--matriz-de-brechas-consolidada)

---

> **Estado de ejecución (E6 cerrada).** Las fases **E0 a E6** de §7 ya están implementadas y verificadas: **E0** red de seguridad (manifiestos reales, tests unitarios y typecheck efectivo en CI), **E1** núcleo contable (`0012`), **E2** asientos automáticos (`0013`), **E3** compras y CxP (`0014`), **E4** cobros y tesorería (`0015`, `0016`), **E5** fiscal avanzado (`0017`–`0020`) y **E6** documentos de venta — **cotización** (`0025`), **remito** (`0021`), **devolución de cliente** (`0022`) y **listas de precios con vigencia y escalas** (`0023`), todas por ADR `0006`.
>
> El diagnóstico de §3–§5 es el **relevamiento original** (18/09, commit `ae08fbc`). Sus afirmaciones de "ausente" para contabilidad, compras, tesorería y fiscal, y de "falta remito" en ventas, ya están superadas por esas migraciones; se conservan como registro del punto de partida. Las filas de §3.1 que siguen marcadas como ausentes/parciales deben leerse contra ese estado original.
>
> **E6 no tiene pendientes.** Los cuatro gates medibles están cerrados y medidos contra un motor real: **V-1** (cotización que vence y exige reconfirmar), **V-2** (remito facturado en partes sin duplicar), **V-3** (devolución que revierte stock y acredita) y **V-4** (precio por lista con vigencia y escala por cantidad). La siguiente fase del plan es **E7 (Recursos humanos)**, que §7.3 declara el módulo de mayor riesgo y mayor volumen de cálculo.

---

## 1. Resumen ejecutivo

### La conclusión honesta

Control **no es un ERP todavía**, y el diagnóstico no es de cantidad de pantallas: es de **naturaleza del dato**.

Lo que Control tiene hoy es un **núcleo operativo de muy buena calidad**: un modelo de datos multi-tenant con aislamiento en el motor, un módulo de stock con libro mayor append-only y costo promedio ponderado, una integración fiscal AFIP real con recuperación ante fallos, y logística con tracking en tiempo real. Esa base es genuinamente mejor que la de muchos ERP comerciales de gama media: la mayoría resuelve el multiempresa con `WHERE empresa_id = ?` disperso en el código, y acá está resuelto en el motor con una barrera que falla el pipeline.

Pero un ERP tiene una propiedad que Control no tiene: **un único libro contable que explica todos los hechos económicos de la empresa.** Todo lo demás —ventas, compras, stock, cobros, pagos, sueldos, impuestos— son *hechos* que se registran, y el libro contable es la *consecuencia obligatoria* de esos hechos. Cuando esa propiedad existe, el sistema puede responder "¿cuánto gané?", "¿cuánto debo?", "¿cuál es mi posición de IVA?", "¿cuánto vale mi inventario?" con una consulta al libro.

Hoy Control puede responder "¿cuántas unidades hay en el depósito 3?" y "¿emitió CAE la factura 145?". No puede responder "¿cuánto gané?" ni "¿cuánto debo a proveedores?", porque no existe el concepto de acreedor, ni de asiento, ni de ejercicio.

### Los tres huecos que definen la brecha

| Hueco | Qué falta | Impacto si no se cierra |
|---|---|---|
| **1. No hay compras ni cuentas a pagar** | Proveedores, órdenes de compra, recepción, factura de compra, pagos, CxP | El negocio no puede registrar de dónde viene su mercadería. El inventario entra sólo por ajuste manual. Sin CxP no hay posición de deuda ni flujo de fondos proyectado. **Es el hueco más grave: sin compras no hay ciclo de negocio completo.** |
| **2. No hay contabilidad general** | Plan de cuentas, asientos, libro diario/mayor, ejercicios, cierre, balance, IVA determinativo | Nada de lo que el sistema registra es auditable contablemente. El cliente que necesita presentar balances sigue llevando su contabilidad en otro lado, y Control queda como sistema operativo auxiliar — nunca como ERP. |
| **3. No hay recursos humanos** | Legajo, contratos, convenios, novedades, liquidación, cargas sociales | El costo laboral —el rubro más pesado de una pyme argentina— no existe en el sistema. Sin costo laboral no hay costo total, y sin costo total el "¿cuánto gané?" sigue sin respuesta. |

Los tres tienen una propiedad en común que determina el orden de implementación: **dependen o alimentan la contabilidad general.** Compras genera asientos de compra y CxP. RR.HH. genera asientos de sueldos. Sin contabilidad, ambas quedarían como módulos de datos aislados que producen información que nadie puede consolidar. Por eso la contabilidad general es el **punto de apalancamiento**: es la pieza que convierte el resto en un ERP.

### Recomendación

Construir un **núcleo contable** antes o en paralelo a los módulos nuevos, y tratar cada módulo nuevo (compras, RR.HH., producción) como un **productor de asientos**, no como una isla de datos. Si se implementan compras sin contabilidad, se gasta el mismo esfuerzo y se obtiene la mitad del valor; integrarlas después cuesta más que haberlas nacido integradas.

El plan de §7 cubre **7 fases** y transforma el producto de "plataforma comercial y logística" a "ERP multiempresa con alcance pyme y mediana empresa, mercado argentino, con base preparada para otros países".

---

## 2. Qué es y qué no es un ERP multiempresa

Antes de medir la brecha hay que fijar el patrón contra el que se mide. "ERP" se usa para cosas muy distintas, y sin una definición el análisis se vuelve una lista de deseos.

### 2.1 Los nueve módulos esenciales

Un ERP comercializable cubre, como mínimo, estos nueve dominios. No son "features": son funciones con entidad propia, cada una con su modelo de datos, su ciclo de vida y sus reglas de negocio.

| # | Módulo | Función esencial | Qué produce |
|---|---|---|---|
| 1 | **Contabilidad general** | Registrar todo hecho económico como asiento de doble partida sobre un plan de cuentas | Libro diario, mayor, balance, estado de resultados |
| 2 | **Cuentas a cobrar y a pagar** | Gestionar saldos por tercero, imputación de cobros y pagos, cancelación | Posición de deuda, antigüedad de saldos, flujo proyectado |
| 3 | **Tesorería** | Caja, bancos, movimientos, conciliación bancaria, medios de pago | Saldo real de fondos, disponibilidad |
| 4 | **Compras** | Proveedores, requerimiento, orden de compra, recepción, factura de compra | Costo de adquisición, trazabilidad de origen |
| 5 | **Inventario** | Existencias por depósito, movimientos, costeo, valuación | Saldo físico y valorizado, trazabilidad |
| 6 | **Ventas** | Cotización, pedido, remito, factura, devoluciones | Ingreso reconocido, margen |
| 7 | **Fiscal** | Comprobantes electrónicos, determinación de impuestos, retenciones, libros IVA | Obligación fiscal calculada y presentable |
| 8 | **Recursos humanos** | Legajo, contratos, novedades, liquidación de sueldos, cargas sociales | Costo laboral y obligaciones previsionales |
| 9 | **Reportes y analítica** | Estados cuantificados, comparativos, tableros por rol | Información para decidir |

### 2.2 Las cuatro reglas que hacen que un ERP sea un ERP

Un sistema puede tener los nueve módulos y no ser un ERP. Lo que lo define son cuatro reglas estructurales:

**Regla 1 · Partida doble sin excepciones.** Todo hecho económico genera un asiento balanceado. No hay atajos. Una venta no sólo mueve stock y emite un CAE: debita cuentas a cobrar, acredita ventas, acredita IVA débito fiscal, y da de baja el inventario contra costo de mercadería vendida. Si un módulo puede escribir un hecho económico sin asiento, no es un ERP.

**Regla 2 · Trazabilidad de origen a destino (audit trail contable).** Todo asiento se puede navegar hacia atrás hasta el documento que lo originó. Cuando un contador ve "cuenta 4.1.1.05 — Ventas: $1.234.500", tiene que poder abrir el asiento, ver las 47 facturas que lo componen, y de cada una abrir el comprobante con su CAE. Sin esto, el ERP no sirve para una auditoría ni para una inspección.

**Regla 3 · Inmutabilidad y reversión, nunca edición.** Un asiento cerrado no se modifica: se revierte con un contra-asiento. Un período cerrado no se toca. Esto es lo que hace que el libro sea confiable, y es la misma lógica que Control ya aplica correctamente en `billing.invoices` (inmutable tras CAE) y en `app.stock_movements` (append-only). **El patrón ya está resuelto en el proyecto; lo que falta es quién lo use para contabilidad.**

**Regla 4 · Períodos y cierre.** La contabilidad existe en el tiempo: ejercicio fiscal, período contable, apertura, cierre. Un período cerrado es inmutable y sus saldos de apertura son los del cierre anterior. Sin períodos no hay balances comparables.

### 2.3 Qué agrega "multiempresa"

La dimensión multi-tenant agrega tres requisitos que un ERP de una sola empresa no tiene:

| Requisito | Implicación |
|---|---|
| **Plan de cuentas por empresa** | Cada empresa tiene su propio plan, editable. Pero debe existir un **plan mínimo obligatorio** que la plataforma exige: si cada empresa mapea sus cuentas a un vocabulario libre, ningún reporte consolidado de plataforma es posible |
| **Aislamiento contable verificable** | Es la extensión directa de lo ya construido: todo asiento, cuenta y saldo lleva `tenant_id` con RLS `FORCE`. La suite de aislamiento debe cubrir las tablas contables como cualquier otra |
| **Consolidación de plataforma** | La plataforma (no la empresa) necesita métricas agregadas: cuántas facturas se emitieron, cuántos tenants activos, qué uso de recursos. Requiere leer a través del modo `platform_admin` auditado, igual que los jobs transversales de hoy |

**Diferencias fiscales por país.** Un ERP multiempresa que aspira a operar en varios países no puede hardcodear el IVA argentino. La abstracción `FiscalDriver` ya existe en el proyecto para los comprobantes; **hay que extender el mismo patrón a impuestos** (alícuotas, regímenes de retención, libros obligatorios, formato de declaración). Ver §8.4.

---

## 3. Evaluación del estado actual

### 3.1 Cobertura por módulo

La evaluación se hizo leyendo el esquema real (`db/migrations/*.sql`), los servicios (`apps/api/src/**`) y el catálogo de permisos (`db/seed/0001_system_catalog.sql`), no la documentación: lo que está documentado y no existe se marca como inexistente.

| Módulo ERP | Estado | Evidencia en el repositorio |
|---|---|---|
| **Contabilidad general** | **Ausente** | No existe plan de cuentas, asiento, período ni ejercicio. Cero aparición de conceptos contables en todo el árbol |
| **Cuentas a pagar** | **Ausente** | No existe proveedor, OC, factura de compra ni pago a proveedor |
| **Cuentas a cobrar** | **Parcial** | `billing.payments` con `amount`, `method`, `reference`, `invoice_id`. No hay saldo por cliente, ni imputación parcial, ni antigüedad de saldos, ni nota de crédito aplicada a saldo |
| **Tesorería** | **Parcial** | `billing.payments` registra cobros. No hay caja, banco, movimiento de fondos, ni conciliación |
| **Compras** | **Ausente** | El tipo de movimiento `purchase_in` existe en el enum de stock, pero no hay orden de compra, proveedor ni documento que lo origine. El ingreso por compra se registra por ajuste manual |
| **Inventario** | **Implementado** | `stock_levels` + `stock_movements` (append-only), 9 tipos de movimiento, `apply_stock_movement()` con costo promedio ponderado, transferencias entre depósitos, `app.v_low_stock`, job `stock.reconciliation` verificado |
| **Ventas** | **Implementado (núcleo + documentos)** | `sales_orders` + `_items`, canales, multi-moneda con `fx_rate`, reserva de stock. **Los cuatro documentos de E6, del ADR `0006`**: cotización con validez (`0025`, gate V-1), remito (`0021`, gate V-2), devolución (`0022`, gate V-3) y listas de precios con vigencia y escalas (`0023`, gate V-4). El módulo queda completo salvo los extras de §4.6 (promociones, cupones, venta contra entrega) |
| **Fiscal** | **Implementado (emisión)** | WSAA + WSFE completos, CAE, Facturas A/B/C, notas de crédito, `afip_outbox` idempotente, `afip_request_log` forense. **Falta determinación de impuestos, retenciones y libros de IVA** |
| **Recursos humanos** | **Ausente** | Cero aparición de empleado, legajo, contrato, novedad o liquidación |
| **Reportes** | **Parcial** | `report.service.ts` (822 líneas) con exportación XLSX/PDF y motor de temas; 5 vistas SQL de apoyo. No hay jerarquías de reportes, comparativos por período, ni tableros por rol |
| **Producción / manufactura** | **Ausente** | Fuera del alcance declarado; se evalúa como extensión futura |

### 3.2 Activos que hay que reconocer

Sería un error tratar el proyecto como si hubiera que empezar de nuevo. Estos activos son directamente reutilizables y reducen el costo de lo que falta:

| Activo | Por qué importa para el plan ERP |
|---|---|
| **Aislamiento RLS con `FORCE` y barrera `assert_rls_coverage()`** | Las ~30 tablas contables nuevas que agrega este plan nacen protegidas por el mismo mecanismo. El costo marginal de aislamiento por tabla nueva es cero — ya está resuelto y verificado |
| **Patrón append-only ya probado** | `stock_movements` y `audit.events` son exactamente la forma que necesita un libro diario. El asiento contable es un `stock_movement` con otra semántica: misma inmutabilidad, misma reversión por contra-asiento |
| **`FiscalDriver` como contrato** | La abstracción país-agnóstica ya existe. Extenderla a impuestos es agregar métodos a un contrato vigente, no inventar arquitectura |
| **Ledger de jobs con garantía de cierre** | Los cierres contables, la liquidación de sueldos y la determinación de impuestos son **jobs programados** con una ventana de ejecución. `ops.jobs` + `JobScheduler` ya resuelven el problema que cualquier módulo de cierre tiene que resolver |
| **Auditoría con hash chain** | El requisito de trazabilidad contable (Regla 2) se apoya en una cadena de auditoría que ya detecta manipulación |
| **Whitelabel por tokens** | Los estados contables, las liquidaciones y las órdenes de compra salen con la identidad de la empresa sin trabajo adicional |
| **Costo promedio ponderado** | Ya calculado en `apply_stock_movement()`. La valuación de inventario, que suele ser un proyecto propio en un ERP, está hecha |

### 3.3 Estado técnico de la base

| Dimensión | Estado | Comentario |
|---|---|---|
| Migraciones | 11/11 aplicadas y verificadas | PG 16.15 local; cadena reproducible desde cero |
| Aislamiento | 308 aserciones en verde | Incluye prueba negativa que verifica que la guardia aborta |
| Lint de cobertura RLS | 0 violaciones | `lint_rls_coverage.sql` |
| Tablas con `tenant_id` | ~30 cubiertas | Descubiertas desde `pg_class`, no desde lista manual |
| Jobs | 5 definidos, ejecutados en vivo | Ledger con `is_overdue`, `is_running` |
| Typecheck | Limpio en `apps/api/src/jobs/**` | `report.service.ts` tiene errores de sintaxis preexistentes (línea 489) que hay que resolver antes de que el typecheck global corra en CI |
| Suite de tests | Sólo aislamiento | No hay tests unitarios ni de integración por módulo |
| Frontend de producción | No existe | El prototipo (`prototype/index.html`, 2.447 líneas) valida diseño; no hay implementación Next.js |

**Dos deudas que afectan directamente este plan.** La primera es la ausencia total de tests unitarios y de integración: el plan de producción exige 85–95% de cobertura por módulo y hoy no hay ninguno. La segunda es que `report.service.ts` no compila, lo que impide que el job `typecheck` del CI tenga valor: un pipeline que no puede romperse no protege nada.

---

## 4. Análisis de brechas por módulo

Cada brecha se expresa como **qué falta**, **por qué importa** y **qué la desbloquea**. La prioridad no sale del tamaño de la brecha sino de su posición en el grafo de dependencias: sin contabilidad, compras y RR.HH. producen datos huérfanos.

### 4.1 Contabilidad general — ausente

**Qué falta.** Plan de cuentas jerárquico por empresa; tipos de asiento y de documento contable; asientos con líneas de doble partida; períodos y ejercicios con cierre; saldos por cuenta y período; libro diario y mayor; estados (situación patrimonial, resultados, evolución del patrimonio); asientos automáticos desde los hechos de negocio; asientos manuales con aprobación; reglas de mapeo cuenta-origen.

**Por qué importa.** Es la condición sin la cual el resto no es ERP. Es además lo que permite responder las preguntas que un dueño de empresa hace: cuánto ganó, cuánto tiene, cuánto debe, cómo evolucionó el margen.

**Qué la desbloquea.** Nada: no tiene dependencias hacia atrás. Puede empezar ya. **Es el punto de partida de todo el plan.**

**Riesgo específico.** El error clásico es modelar el asiento como una tabla de líneas sueltas y calcular el balance sumando. Eso funciona hasta que hay que explicar por qué el balance no cuadra. La mitigación es una **restricción de diferencial cero validada en el motor** (trigger o constraint diferido que aborta el asiento si `débitos ≠ créditos`), no una validación en la capa de aplicación. Mismo criterio que ya se aplicó con `apply_stock_movement`: la garantía va en el motor.

### 4.2 Compras y cuentas a pagar — ausente

**Qué falta.** Proveedores con condición fiscal y datos bancarios; requerimientos de compra; órdenes de compra con aprobación por monto; recepción total y parcial contra orden (con la comparación cantidad pedida vs. recibida); factura de compra con alícuotas; nota de crédito de proveedor; pagos con imputación y medios; saldo por proveedor; antigüedad de saldos; flujo de fondos proyectado; retenciones sufridas; condiciones de pago y descuentos.

**Por qué importa.** Sin compras el ciclo de negocio está incompleto en su origen: la mercadería aparece por ajuste manual, lo que significa que el sistema no sabe de dónde vino, cuánto costó realmente, ni a quién hay que pagarle. Es también el hueco que más rápido nota un cliente pyme: comprar es una operación diaria, tanto como vender.

**Qué la desbloquea.** La contabilidad general (§4.1) para generar asientos y CxP, y el inventario —**que ya existe y es lo más fácil de integrar de todo el plan**: el tipo `purchase_in` ya está en el enum de `app.stock_move_kind` y `apply_stock_movement()` **ya actualiza el costo promedio ponderado** cuando recibe `purchase_in` con `unit_cost` no nulo. La recepción de una orden de compra se resuelve llamando a la función que ya está escrita y verificada.

**Nota de diseño.** La recepción parcial es donde más proyectos de compras fallan: hay que poder recibir 60 de 100 unidades sin perder la referencia a las 40 pendientes, y sin que el stock quede con un movimiento huérfano. La orden de compra tiene estado por línea, no sólo por cabecera.

### 4.3 Cuentas a cobrar y tesorería — parcial

**Qué falta.** Saldo por cliente calculado desde documentos (no un campo); imputación de cobros a facturas con pagos parciales y a cuenta; nota de crédito aplicada a saldo; antigüedad de saldos por tramos (0-30, 31-60, 61-90, +90); estado de cuenta del cliente; caja y banco como entidades con movimientos; conciliación bancaria; transferencias entre cuentas; arqueo de caja; medios de pago parametrizables; cheques con gestión de cartera, fecha de pago y estado.

**Por qué importa.** Cobrar es la operación que sostiene la empresa. Un registro de cobros sin saldo por cliente deja al usuario haciendo la cuenta a mano, y la antigüedad de saldos es la herramienta con la que se decide a quién reclamarle. En el mercado argentino, además, los cheques son un medio de pago central y tienen ciclo de vida propio (en cartera, depositado, acreditado, rechazado, endosado): modelarlos como un `method` de texto los vuelve inútiles.

**Qué la desbloquea.** La contabilidad general para saldos y asientos; el módulo de compras comparte la mecánica de pagos con el de cobros, así que conviene diseñarlos juntos.

### 4.4 Fiscal avanzado — parcial

**Qué falta.** Determinación de IVA (débito menos crédito fiscal por período, con el crédito de las compras que §4.2 habilita); retenciones sufridas y practicadas; percepción de IVA; libro de IVA digital con formato de presentación; régimen informativo de compras y ventas; registros de ingresos por jurisdicción (Ingresos Brutos, Convenio Multilateral); posición fiscal y vencimientos; IVA por alícuota con prorrateo.

**Por qué importa.** Hoy Control emite comprobantes correctamente pero no puede decir cuánto IVA hay que pagar. Un contador que recibe los comprobantes y calcula el IVA en una planilla no considera a Control su sistema de facturación, y menos su ERP.

**Qué la desbloquea.** La contabilidad general (el IVA es una cuenta) y compras (el crédito fiscal viene de las facturas de compra). **Este módulo no puede hacerse antes que esos dos**, y es un buen ejemplo de por qué el orden de §7 importa.

### 4.5 Recursos humanos — ausente

**Qué falta.** Legajo con datos personales y familiares; contratos con modalidad, categoría, convenio y jornada; novedades mensuales (presentismo, horas extra, licencias, ausencias, adelantos, embargos); liquidación de sueldos con conceptos remunerativos y no remunerativos; aportes y contribuciones; SAC (aguinaldo) y vacaciones con cálculo proporcional; liquidación final; libro de sueldos digital; asientos de sueldos; F.931 / declaración jurada previsional.

**Por qué importa.** Es el rubro de costo más pesado de una pyme argentina y hoy no existe en el sistema. Sin costo laboral no hay costo total, y sin costo total no hay margen real. Y las reglas argentinas (SAC, vacaciones proporcionales, tope previsional, mínimo no imponible de Ganancias, escalas, deducciones) son lo bastante específicas como para que liquidar en una planilla sea lento y propenso a error.

**Qué la desbloquea.** La contabilidad general. Es el módulo de mayor volumen de cálculo y el de mayor riesgo de error con impacto legal, así que necesita un nivel de tests muy superior al de los demás.

**Advertencia de alcance.** La liquidación de sueldos tiene consecuencias legales. Es el módulo donde un defecto no se manifiesta como un error visible sino como una liquidación mal pagada, con implicancias laborales y previsionales. Requiere validación contra un estudio contable antes de habilitarse en producción — no se libera por prueba interna.

### 4.6 Ventas — completar

**Qué falta.** Descuentos por volumen y bonificaciones; cupones y promociones; venta contra entrega; cuenta corriente del cliente en el flujo de venta. Son extras del módulo, no documentos faltantes.

**Por qué importa.** La brecha no es de capacidad sino de **documentos faltantes**. En una operación real, el remito es un documento que viaja con la mercadería y se firma: no tenerlo obliga a improvisar con la orden de venta.

**Qué la desbloquea.** Nada externo; comparte mecánica con logística, que ya existe (`logistics.shipments` puede originarse en un remito en vez de directamente en una orden).

**Estado tras E6 — el remito y la devolución ya no faltan.** La separación pedido / remito / factura dejó de ser una brecha. La migración `0021` (ADR `0006`) crea `billing.delivery_notes` + `billing.delivery_note_items` como documento propio, y `billing.invoice_delivery_note()` factura un remito en varias partes sin duplicar ni exceder lo despachado. La garantía es de motor en tres capas: `CHECK (qty_invoiced <= quantity)`, validación con la línea bloqueada (`FOR UPDATE`) dentro de la transacción, y `invoice_items.delivery_note_item_id` para la trazabilidad origen→destino. El criterio V-2 (§6.2) se **mide** en `tests/sales/run.mjs` y corre en el job `sales` del CI.

La migración `0022` cierra el otro documento que el ADR `0006` había decidido: la **devolución de cliente** (`billing.customer_returns` + `customer_return_items`), con ciclo `draft → confirmed → applied`. Al aplicarse revierte el stock con un movimiento `return_in` trazable por `app.apply_stock_movement()` y emite la nota de crédito como borrador ligada por `related_invoice_id`, que después se autoriza por AFIP y se imputa al saldo con `billing.apply_credit_note()`. La garantía también es de motor: por variante no se devuelve más de lo facturado (descontando lo ya devuelto por devoluciones aplicadas, serializado por un lock de asesoría sobre la factura), no se aplica dos veces, y una devolución `applied` sin nota de crédito es imposible por `CHECK`. El criterio V-3 (§6.2) se **mide** en `tests/sales/run.mjs`. El asiento y el cómputo de IVA de la nota de crédito ya estaban preparados por E2 (`0013`) y E5 (`0019`), así que la devolución los activa sin cambios.

La migración `0023` cierra la cuarta decisión del ADR `0006`: las **listas de precios con vigencia y escalas por cantidad**. El precio pasa a ser función de `(lista, vigencia, variante, cantidad)` resuelta por datos (`app.price_for()`), con `valid_from`/`valid_to` y tramos de cantidad en `app.price_list_items`. Dos garantías de motor hacen la resolución determinista: una `EXCLUDE` que impide dos escalas solapadas a la vez en cantidad y fecha —sin ella `price_for()` podría devolver dos precios y el resultado dependería del orden físico, la misma irreproducibilidad que el ADR 0004 prohíbe para las alícuotas— y un `UNIQUE` parcial que admite una sola lista por defecto por empresa. El criterio V-4 (§6.2) se **mide** en `tests/sales/run.mjs`. Efecto colateral: escribir su escenario destapó que `0003` impedía tener dos variantes sin código de barras, corregido en `0024`.

La migración `0025` cierra la última pieza que el ADR `0006` nombraba: la **cotización con validez** (`billing.quotes` + `quote_items`), una oferta que vence y que por definición **no compromete stock ni genera asiento** —las dos negaciones se verifican: no emite ningún movimiento de stock, ni una reserva, y no produce línea de diario ni aparece como hecho pendiente—. `add_quote_item()` resuelve el precio desde la lista con `app.price_for()`, `issue_quote()` recalcula los totales desde las líneas, y `accept_quote()` **rechaza una oferta vencida** exigiendo reconfirmarla: es el criterio V-1. El vencimiento se deriva (`billing.v_quotes.effective_status`) en lugar de almacenarse, porque un estado guardado exigiría un job que lo mantenga al día y entre el vencimiento y la corrida del job la fila mentiría.

**Con esto el módulo de ventas queda completo en lo que el plan le pedía.** Los cuatro gates están medidos contra un motor real. Lo que resta son extras de §4.6 (promociones, cupones, venta contra entrega) que el plan nunca trató como documentos faltantes.

### 4.7 Reportes y analítica — parcial

**Qué falta.** Jerarquía de informes por rol; comparativos entre períodos con variación; reportes de margen por producto, cliente, canal y vendedor; rotación y cobertura de stock; valorización de inventario por depósito; análisis de rentabilidad; proyección de flujo de fondos; tableros configurables; exportación programada y por email; consultas guardadas.

**Por qué importa.** El motor de exportación está bien resuelto (XLSX/PDF con identidad), pero hoy exporta **lo que existe**: listados. Un ERP exporta **estados cuantificados**: "el balance al 30/06", "el estado de resultados del trimestre", "la antigüedad de saldos al cierre". Esos reportes no se pueden escribir hasta que existan las tablas que agregan, y esto es la razón por la que reportes aparece **después** de contabilidad, compras y RR.HH. en el orden de §7, no antes.

**Qué la desbloquea.** Todos los módulos anteriores. Es el módulo que más depende y el que menos desbloquea, y por eso va al final.

### 4.8 Producción / manufactura — fuera de alcance, evaluado

**Qué falta.** Lista de materiales, ruta de fabricación, orden de producción, consumo de componentes, informe de avance, costeo de producción, mermas.

**Por qué queda fuera.** Es un dominio completo, con su propia complejidad, y sirve a un segmento distinto (industria) del que el proyecto apunta hoy (retail, servicios, distribuidoras, operadores logísticos). Incluirlo ahora desvía esfuerzo de los tres huecos que sí definen la brecha. Se evalúa en §7.7 como extensión del segmento, **después** de que el núcleo contable esté estable.

---

## 5. Mejoras priorizadas

### 5.1 Criterio de priorización

No se priorizó por impacto aislado, sino por **apalancamiento sobre las demás mejoras**. Un módulo que desbloquea otros dos va primero que uno más grande que no desbloquea nada; es la misma lógica que ordena el camino crítico de `PLAN-PRODUCCION.md`.

| Criterio | Peso | Qué mide |
|---|---|---|
| **Desbloqueo** | 40% | Cuántos otros ítems dependen de éste |
| **Impacto en la propuesta de valor** | 30% | Cuánto acerca el producto a "ERP" frente a "sistema comercial" |
| **Riesgo de no hacerlo** | 20% | Consecuencia si el cliente lo requiere y no está |
| **Costo de reversión** | 10% | Cuánto más caro sale hacerlo después |

### 5.2 Cuadro de mejoras priorizadas

| # | Mejora | Prioridad | Desbloquea | Esfuerzo | Justificación |
|---|---|---|---|---|---|
| **M1** | **Núcleo contable**: plan de cuentas, asientos de doble partida, períodos, ejercicios, libro diario y mayor | **P0** | M2, M3, M4, M5, M9 | Alto | Sin esto nada es ERP. No tiene dependencias: puede empezar hoy |
| **M2** | **Motor de asientos automáticos**: reglas que traducen cada hecho de negocio a asiento | **P0** | M3, M4, M5, M9 | Medio | Es lo que conecta los módulos con el libro. Sin esto, los asientos son manuales y nadie los carga |
| **M3** | **Compras y cuentas a pagar**: proveedor, OC, recepción, factura de compra, pagos, saldos | **P0** | M4, M5, M7 | Alto | El hueco funcional más grave. Se integra con inventario, que ya existe |
| **M4** | **Cobros y tesorería**: saldo por cliente, imputación, antigüedad, caja, banco, cheques, conciliación | **P1** | M9 | Alto | Cobrar es operación diaria. Los cheques son obligatorios en el mercado argentino |
| **M5** | **Fiscal avanzado**: determinación de IVA, retenciones, percepciones, libros digitales, IIBB | **P1** | M9 | Medio | Completa el módulo fiscal y habilita al contador a dejar la planilla |
| **M6** | **Documentos de venta faltantes**: cotización, remito, devolución, listas con vigencia, escalas | **P1** | M9 | Medio | La operación actual se sostiene; esto elimina improvisación. **Hecho en E6**: cotización (`0025`), remito (`0021`), devolución (`0022`) y listas con vigencia y escalas (`0023`), los cuatro con su gate medido |
| **M7** | **Recursos humanos y liquidación de sueldos** | **P2** | M9 | Muy alto | Módulo completo y con riesgo legal. Requiere validación externa |
| **M8** | **Reportes y estados**: balance, resultados, márgenes, antigüedad, rotación, flujo proyectado, tableros por rol | **P2** | — | Alto | Depende de todo lo anterior. Es la cara visible del ERP |
| **M9** | **Consolidación y analítica de plataforma**: métricas agregadas multi-tenant con lectura auditada | **P2** | — | Bajo | Necesario para operar el negocio SaaS, no para el cliente |
| **M10** | **Plan de cuentas mínimo obligatorio y mapeo normalizado** | **P0** | M2, M9 | Bajo | Sin vocabulario común, ningún reporte multi-tenant es posible. Es una decisión de diseño, no un desarrollo |
| **M11** | **Producción / manufactura** | **P3** | — | Muy alto | Fuera de alcance actual. Se reevalúa por demanda de segmento |
| **M12** | **Cierre de deuda técnica previa**: tests unitarios/integración, `report.service.ts`, frontend productivo | **P0** | Todo | Alto | Sin tests, cada módulo nuevo agrega riesgo sin red. Bloquea la entrega confiable de todo lo demás |

**M12 no es un módulo, es una condición.** El plan de producción exige 85–95% de cobertura por módulo y hoy no existe un solo test unitario. Agregar contabilidad, compras y RR.HH. —los tres módulos de mayor criticidad numérica— sobre una base sin red de tests es la forma más rápida de construir algo que no se puede cambiar y no se puede confiar. **M12 corre en paralelo desde el día uno y no se posterga.**

### 5.3 Lo que se descarta explícitamente

| Descartado | Por qué |
|---|---|
| CRM completo (campañas, embudos, lead scoring) | Es un producto, no un módulo. Se resuelve por integración, no construyéndolo |
| BI genérico con constructor de reportes ad-hoc | Muy caro de construir bien y muy poco usado. Reportes curados superan a un constructor mediocre |
| E-commerce propio / storefront | Ya hay mercado y oferta. Se integra, no se construye |
| Gestión documental | Se apoya en object storage y adjuntos por entidad; no merece módulo |
| Portal de proveedores y de clientes | Fase muy posterior, depende de que compras y CxC maduren |

---

## 6. Objetivos esperados y métricas

### 6.1 Objetivos de producto

| Objetivo | Situación actual | Objetivo al cerrar el plan | Cómo se verifica |
|---|---|---|---|
| Cobertura de módulos ERP esenciales | 4 de 9 implementados, 3 parciales, 2 ausentes | **9 de 9** implementados y usables | Revisión contra §2.1 |
| Preguntas de negocio respondibles | Stock y estado fiscal de comprobantes | **+ Ganancia, posición de deuda, IVA a pagar, valor de inventario, costo laboral, flujo proyectado** | Una consulta o reporte por pregunta, sin exportar a planilla |
| Integridad contable | No aplica | **100% de hechos económicos con asiento balanceado y trazable al documento** | Consulta de control: hechos sin asiento = 0 |
| Períodos contables | No existen | Balance por período con cierre inmutable y comparativo interanual | Simulacro de cierre |
| Cobertura de tests | Sólo aislamiento | **≥85% unitario por módulo; ≥95% en fiscal, contable y sueldos** | Reporte de cobertura en CI |
| Trazabilidad | Documental (auditoría + hash chain) | **+ Contable de origen a destino** | Navegación asiento → documento en la UI |

### 6.2 Criterios de aceptación por módulo

Cada módulo se declara terminado con criterios verificables por alguien distinto de quien lo implementó, y con la misma exigencia que el plan de producción.

**Contabilidad general**

| # | Criterio | Verificación |
|---|---|---|
| C-1 | Un asiento con débitos ≠ créditos **es rechazado por el motor** | Test con asiento descuadrado |
| C-2 | Un asiento en un período cerrado **es rechazado** | Test de período cerrado |
| C-3 | Todo asiento se navega hasta su documento de origen | Verificación de UI en los 5 orígenes principales |
| C-4 | El balance cuadra (`activo = pasivo + patrimonio`) en el 100% de los períodos de prueba | Consulta de control |
| C-5 | La suma del libro diario por período coincide con la del mayor | Test de reconciliación |
| C-6 | **Cero hechos económicos sin asiento** tras un escenario completo de prueba | Job de control en verde |
| C-7 | Una cuenta con movimientos no puede eliminarse, sólo inactivarse | Test de constraint |
| C-8 | El cierre de un período genera los saldos de apertura del siguiente | Test de cierre |

**Compras y cuentas a pagar**

| # | Criterio | Verificación |
|---|---|---|
| P-1 | Recepción parcial contra OC: 60 de 100 deja 40 pendientes y estado por línea | Test funcional |
| P-2 | La recepción actualiza stock **y** costo promedio ponderado | Consulta sobre `stock_levels.avg_cost` |
| P-3 | El movimiento de stock queda referenciado a su documento de compra | Consulta sobre `source_type` / `source_id` |
| P-4 | Saldo por proveedor = facturas − notas de crédito − pagos | Consulta de reconciliación |
| P-5 | Antigüedad de saldos por tramos cuadra con el saldo total | Test de reconciliación |
| P-6 | Un pago parcial deja saldo abierto y estado correcto | Test funcional |
| P-7 | Los asientos de compra cuadran con el total de la factura | Consulta de control |
| P-8 | Recepción por encima de lo pedido requiere autorización explícita | Test de regla de negocio |

**Cobros y tesorería**

| # | Criterio | Verificación |
|---|---|---|
| T-1 | Imputación de un cobro a varias facturas deja cada saldo correcto | Test funcional |
| T-2 | Nota de crédito aplicada reduce el saldo de la factura origen | Test funcional |
| T-3 | Saldo por cliente cuadra con documentos abiertos | Consulta de reconciliación |
| T-4 | Cheque: ciclo completo cartera → depositado → acreditado | Test de máquina de estados |
| T-5 | Cheque rechazado revierte el movimiento de fondos | Test funcional |
| T-6 | Conciliación bancaria: diferencia entre extracto y libro es explicable | Test funcional |
| T-7 | El saldo de caja/bancos coincide con la suma de movimientos | Consulta de control |

**Fiscal avanzado**

| # | Criterio | Verificación |
|---|---|---|
| F-1 | IVA débito menos crédito del período cuadra con la suma de comprobantes | Consulta de §6.3 |
| F-2 | El crédito fiscal de compras se computa en el período correcto | Test con factura de compra de otro período |
| F-3 | El libro de IVA digital cuadra con los comprobantes | Consulta de reconciliación |
| F-4 | Retenciones sufridas y practicadas quedan asociadas a su comprobante | Test funcional |
| F-5 | Una alícuota nueva no requiere recompilar el dominio | Test de configuración |
| F-6 | La posición de IVA por período es reproducible desde el libro | Consulta de control |

**Recursos humanos**

| # | Criterio | Verificación |
|---|---|---|
| H-1 | Liquidación de sueldos validada contra **estudio contable externo**, sin diferencias | Informe firmado |
| H-2 | SAC y vacaciones proporcionales correctos para antigüedad y período incompleto | Tests con casos borde |
| H-3 | Los conceptos no remunerativos no se incluyen en la base previsional | Test de cálculo |
| H-4 | El asiento de sueldos cuadra con el total de la liquidación | Consulta de control |
| H-5 | El libro de sueldos digital cuadra con las liquidaciones | Consulta de reconciliación |
| H-6 | Una liquidación cerrada es inmutable; se corrige con una nueva | Test de inmutabilidad |
| H-7 | Miembro del equipo deja de aparecer en la nómina al desactivarlo, sin perder su histórico | Test funcional |

**Documentos de venta**

| # | Criterio | Verificación |
|---|---|---|
| V-1 | Cotización con validez; vencida, requiere reconfirmación | **Medido** en `tests/sales/run.mjs` (job `sales` del CI): la línea toma el precio de la escala de la lista, los totales se recalculan desde las líneas, aceptar una vencida es rechazado con un error que dice qué hacer, reconfirmar la vuelve aceptable, y la cotización no mueve stock ni genera asiento |
| V-2 | Remito facturado en partes: las cantidades no se duplican | **Medido** en `tests/sales/run.mjs` (job `sales` del CI): 60 + 40 = 100 sin duplicar; sobre-facturado, re-facturación de lo ya facturado y cross-tenant rechazados |
| V-3 | Devolución revierte stock y genera nota de crédito aplicada al saldo | **Medido** en `tests/sales/run.mjs` (job `sales` del CI): stock 5 → 9 con un `return_in` trazable; nota de crédito por 484; doble aplicación, exceso de cantidad, cantidad fraccionaria y cross-tenant rechazados; asiento balanceado y saldo del cliente en 726 |
| V-4 | Precio por lista con vigencia y escala por cantidad se resuelve correctamente | **Medido** en `tests/sales/run.mjs` (job `sales` del CI): bordes de cada tramo (9 y 10 en escalas distintas), escala sin tope superior, precio futuro que no reescribe el de hoy, caída al multiplicador, 0 filas si no hay precio, y rechazo del solapamiento de escalas y de la segunda lista por defecto |
| V-5 | La orden de venta puede originar el envío logístico | Test de integración |

**Reportes**

| # | Criterio | Verificación |
|---|---|---|
| R-1 | **Todo reporte cuadra con su consulta fuente** | Test de reconciliación por reporte |
| R-2 | El balance, el estado de resultados y el flujo cuadran entre sí | Consulta cruzada |
| R-3 | Los comparativos entre períodos coinciden con la suma de períodos | Test aritmético |
| R-4 | **Ningún reporte incluye datos de otra empresa** | Extensión de la suite de aislamiento |
| R-5 | Un reporte de 50.000 filas termina en menos de 60 s | Prueba de rendimiento |
| R-6 | El pie incluye usuario y timestamp de generación | Revisión |

**R-1 y R-4 son los criterios que no se negocian.** Un estado contable que no cuadra destruye la confianza en todo el sistema, y un reporte que filtra datos entre empresas es el incidente crítico que el SLO de tolerancia cero prohíbe. Los dos tienen que estar cubiertos por tests, no por revisión manual.

### 6.3 Consultas de control permanente

Se ejecutan en cada cierre y como verificación continua de integridad:

```sql
-- 1. Asientos descuadrados (no debería existir jamás)
SELECT je.id, sum(jl.debit) AS debitos, sum(jl.credit) AS creditos
FROM accounting.journal_entries je
JOIN accounting.journal_lines jl ON jl.entry_id = je.id
GROUP BY je.id
HAVING abs(sum(jl.debit) - sum(jl.credit)) > 0.01;

-- 2. Hechos económicos sin asiento (por cada origen)
SELECT 'invoice' AS origen, count(*) FROM billing.invoices i
WHERE i.status = 'authorized'
  AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries je
                  WHERE je.source_type = 'invoice' AND je.source_id = i.id);

-- 3. Saldo de inventario vs. libro mayor
--    La aritmética es la misma que ya usa el job `stock.reconciliation`
--    (apps/api/src/jobs/job-runner.ts), que está implementado y verificado.
--    Se reproduce acá para que quede como consulta de control reutilizable.
SELECT sl.variant_id, sl.warehouse_id,
       sl.on_hand                     AS saldo_fisico,
       coalesce(libro.neto, 0)        AS libro
FROM app.stock_levels sl
LEFT JOIN (
  SELECT variant_id, warehouse_id,
         sum(quantity * CASE kind
               WHEN 'purchase_in'    THEN  1
               WHEN 'transfer_in'    THEN  1
               WHEN 'adjustment_pos' THEN  1
               WHEN 'return_in'      THEN  1
               WHEN 'sale_out'       THEN -1
               WHEN 'transfer_out'   THEN -1
               WHEN 'adjustment_neg' THEN -1
               ELSE 0            -- reservation / release no mueven cantidad física
             END) AS neto
  FROM app.stock_movements
  GROUP BY variant_id, warehouse_id
) AS libro
  ON libro.variant_id = sl.variant_id
 AND libro.warehouse_id = sl.warehouse_id
WHERE sl.on_hand <> coalesce(libro.neto, 0);

-- 4. CxC: saldo por cliente vs. documentos abiertos
SELECT c.id, c.legal_name,
       sum(i.total) - coalesce(sum(p.amount), 0) AS saldo_esperado
FROM app.customers c
LEFT JOIN billing.invoices i ON i.customer_id = c.id AND i.status = 'authorized'
LEFT JOIN billing.payments p ON p.customer_id = c.id
GROUP BY c.id, c.legal_name;

-- 5. CxP: saldo por proveedor vs. documentos abiertos
SELECT s.id, s.legal_name,
       sum(pb.total) - coalesce(sum(pp.amount), 0) AS saldo_esperado
FROM purchasing.suppliers s
LEFT JOIN purchasing.purchase_invoices pb ON pb.supplier_id = s.id AND pb.status = 'posted'
LEFT JOIN purchasing.supplier_payments pp ON pp.supplier_id = s.id
GROUP BY s.id, s.legal_name;

-- 6. IVA del período: débito − crédito vs. suma de comprobantes
SELECT period,
       sum(debito_fiscal) - sum(credito_fiscal) AS posicion
FROM accounting.v_vat_ledger
GROUP BY period;

-- 7. Balance cuadra
SELECT period, sum(debit) AS activo, sum(credit) AS pasivo_patrimonio
FROM accounting.v_trial_balance
GROUP BY period
HAVING abs(sum(debit) - sum(credit)) > 0.01;
```

La consulta 3 del listado es la misma verificación que el job `stock.reconciliation` **ya implementa y ya fue probado** con una deriva inyectada de +7 unidades. Es la primera de estas consultas que existe en el sistema, y sirve de plantilla para las demás.

### 6.4 Métricas de progreso del plan

| Métrica | Hoy | Objetivo |
|---|---|---|
| Módulos ERP esenciales completos | 4 / 9 | 9 / 9 |
| Módulos con tests unitarios ≥85% | 0 / 9 | 9 / 9 |
| Preguntas de negocio respondibles sin planilla | 2 | 8 |
| Hechos económicos trazables al documento | 0% | 100% |
| Períodos contables con cierre | No existen | 12 meses históricos + cierre automático |
| Documentos de venta soportados | 5 (cotización, orden, remito, factura, devolución) | 5 (cotización, pedido, remito, factura, devolución) |

---

## 7. Orden de implementación sugerido

### 7.1 Secuencia

Siete fases. Cada una deja el sistema desplegable y en verde, con la misma regla que el plan de producción: **ninguna fase cierra sin su gate**.

| Fase | Nombre | Alcance | Depende de | Gate de salida |
|---|---|---|---|---|
| **E0** | Red de seguridad | Tests unitarios e integración, arreglo de `report.service.ts`, typecheck global en CI | — | Typecheck y tests unitarios corriendo en cada push |
| **E1** | Núcleo contable | Plan de cuentas, asientos, períodos, ejercicios, libro diario y mayor, balance y resultados | E0 | Balance cuadra y cero asientos descuadrados |
| **E2** | Asientos automáticos | Reglas de mapeo hecho → asiento para ventas, facturación y stock | E1 | Cero hechos sin asiento en un escenario completo |
| **E3** | Compras y CxP | Proveedores, OC, recepción parcial, factura de compra, pagos, saldos, antigüedad | E2 | Recepción parcial integrada con stock y costo |
| **E4** | Cobros y tesorería | Saldo por cliente, imputación, antigüedad, caja, banco, cheques, conciliación | E3 | Saldo de tesorería cuadra con movimientos |
| **E5** | Fiscal avanzado | IVA determinativo, retenciones, percepciones, libros digitales, IIBB | E4 | Posición de IVA reproducible desde el libro |
| **E6** | Ventas y documentos | Cotización, remito, devolución, listas con vigencia y escalas | E5 | **CERRADA.** Los cuatro gates cumplidos y medidos en `tests/sales/run.mjs` (job `sales` del CI): V-1 cotización que vence (`0025`), V-2 remito en partes (`0021`), V-3 devolución que acredita (`0022`), V-4 precio por lista con vigencia y escala (`0023`) |
| **E7** | Recursos humanos | Legajo, contratos, novedades, liquidación, cargas sociales, libro de sueldos | E6 | **Liquidación validada por estudio contable externo** |
| **E8** | Reportes y analítica | Estados, márgenes, rotación, flujo proyectado, tableros por rol | E7 | Todo reporte cuadra con su fuente |
| **E9** | Plataforma y extensión | Consolidación multi-tenant, evaluación de producción/manufactura | E8 | Métricas agregadas auditadas |

### 7.2 Camino crítico

```
E0 → E1 → E2 → E3 → E4 → E5 → E7 → E8
```

**E6 corre en paralelo con E5** (documentos de venta no dependen de impuestos) y **E9 corre en paralelo con E8** (consolidación de plataforma no depende de reportes de cliente).

E0 corre en paralelo con todo, desde el primer día, y no se cierra nunca: es la red de seguridad que cada fase nueva necesita.

### 7.3 Por qué este orden y no otro

| Decisión de orden | Razón |
|---|---|
| **Contabilidad antes que compras** | Compras produce asientos y CxP. Sin el libro, quedaría como un módulo de datos que nadie consolida. Al revés, el núcleo contable es útil desde el día uno con lo que **ya existe**: ventas, facturación y stock pueden generar asientos antes de que haya compras |
| **Asientos automáticos antes que compras** | Es el puente entre módulos y libro. Construirlo con los orígenes que ya existen (ventas, facturación, stock) es más barato que construirlo junto con un origen nuevo, porque el patrón se valida contra datos reales primero |
| **Compras antes que tesorería** | Compras introduce el concepto de pago a un tercero; tesorería generaliza esa mecánica (caja, banco, cheques). Diseñar ambas juntas ahorra retrabajo, pero compras primero porque es donde está el hueco funcional más grave |
| **Fiscal después de compras** | El crédito fiscal nace de la factura de compra. Sin compras, la determinación de IVA sólo tendría el débito |
| **RR.HH. después de fiscal** | Es el módulo de mayor riesgo y mayor volumen de cálculo. Se hace cuando la plataforma contable ya está probada y el patrón de liquidación por job (que el ledger ya soporta) está maduro |
| **Reportes al final** | Depende de todos. Es el único módulo que no desbloquea nada y que no se puede adelantar |
| **E0 primero** | Tres módulos de altísima criticidad numérica (contabilidad, compras, sueldos) sobre una base sin tests es la forma más eficiente de construir algo que no se puede cambiar sin miedo |

### 7.4 Estimación relativa de esfuerzo

Sin días concretos: la estimación depende del equipo, y el plan de producción ya fija un equipo de 6 a 8 personas. Se expresa en esfuerzo relativo, que es útil para decidir el orden y no para comprometer fechas.

| Fase | Esfuerzo | Comparación |
|---|---|---|
| E0 | Medio | Comparable a F0 del plan de producción |
| E1 | Alto | El mayor esfuerzo individual del plan |
| E2 | Medio | Concentrado en el mapeo y su validación |
| E3 | Alto | Comparable a la fase de ventas del plan original |
| E4 | Alto | Los cheques y la conciliación son la mitad del trabajo |
| E5 | Medio | Depende mucho del régimen impositivo que se cubra |
| E6 | Medio | Documentos nuevos sobre mecánica existente |
| E7 | Muy alto | El mayor del plan; liquidación + validación externa |
| E8 | Alto | Muchos reportes, cada uno con su test de reconciliación |
| E9 | Bajo | Reutiliza el patrón de jobs transversales ya probado |

### 7.5 Fases que se pueden comprimir

| Si el objetivo es… | Se puede… | Consecuencia |
|---|---|---|
| Llegar antes a "ERP usable por una pyme" | Saltar E9 y diferir E7 (RR.HH.) | Se obtiene un ERP comercial-financiero completo; el costo laboral queda afuera y el margen real no se ve completo |
| Atender un cliente que sólo exige contabilidad | Detener en E2 | Se tiene un ERP contable alimentado por ventas y stock, sin compras. Válido sólo para un negocio sin inventario con costo relevante |
| Atender una distribuidora o mayorista | Priorizar E3 sobre E4 | Compras y CxP son más urgentes que la conciliación bancaria, que puede hacerse con el extracto en mano un tiempo |
| Preparar expansión a otro país | Adelantar el trabajo de §8.4 | El motor de impuestos genérico conviene hacerlo antes de que haya lógica argentina dispersa, no después |

---

## 8. Riesgos y decisiones irreversibles

### 8.1 Riesgos del plan

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| E-R1 | Contabilidad modelada con balance calculado en vez de diferencial cero en el motor | Media | **Alto** | Restricción de diferencial cero a nivel motor desde la primera migración. No se negocia |
| E-R2 | Planes de cuentas incompatibles entre empresas impiden reportes consolidados | Alta | Medio | **M10**: plan mínimo obligatorio de plataforma y mapeo normalizado desde el inicio |
| E-R3 | Liquidación de sueldos con error legal | Media | **Alto** | Validación por estudio contable externo como gate de fase. No se libera por prueba interna |
| E-R4 | Módulos nuevos escritos sin tests por presión de alcance | Alta | Alto | E0 permanente; el pipeline rechaza un módulo sin cobertura mínima |
| E-R5 | Compras integradas al stock sin actualizar costo | Baja | Medio | La función `apply_stock_movement()` ya maneja `purchase_in` y `avg_cost`; el test P-2 lo verifica |
| E-R6 | Períodos contables sin política de reapertura | Media | Medio | Definir y documentar el procedimiento de reapertura antes de la fase E1, no después |
| E-R7 | `report.service.ts` sigue roto y el typecheck nunca protege | Alta | Medio | Primer entregable de E0. Un pipeline que no puede fallar no es una barrera |
| E-R8 | Degradación de rendimiento en consultas de saldos con volumen | Media | Medio | Saldos materializados con recálculo por job, sobre el patrón de ledger ya probado. `EXPLAIN ANALYZE` obligatorio con 10 M de filas |
| E-R9 | El alcance de ERP desvía al producto de su mercado actual | Media | Alto | E3/E6/E4 se apoyan en lo que ya existe; el segmento actual no pierde nada mientras el plan avanza |

### 8.2 Decisiones irreversibles y cómo tratarlas

Estas decisiones son caras de revertir. Se documentan como ADR **antes** de implementar la fase que las toca.

| Decisión | Por qué es irreversible | Cuándo se decide |
|---|---|---|
| **Plan mínimo obligatorio de cuentas** | Cambiarlo después reescribe el histórico contable de todas las empresas | Antes de E1 |
| **Modelo de asiento (cabecera + líneas, o documento único)** | Define cómo se consulta y se audita todo el libro | Antes de E1 |
| **Saldos materializados vs. calculados** | Determina si hay jobs de recálculo y cómo se corrige una diferencia | Antes de E1 |
| **Granularidad de período (mensual, o configurable por empresa)** | Afecta el cierre, los reportes y los índices | Antes de E1 |
| **Vocabulario fiscal neutral vs. nomenclatura AFIP** | El plan de producción ya propone neutralizar (`authorization_id` en vez de `cae`). Si la contabilidad nace con nombres AFIP, la expansión multinacional queda bloqueada | Antes de E5 |
| **Motor de impuestos genérico vs. argentino** | Igual que el anterior: define si un segundo país es una implementación o una reescritura | Antes de E5 |

### 8.3 Deuda técnica a cerrar antes de escalar

| Deuda | Impacto | Fase |
|---|---|---|
| `report.service.ts` no compila (líneas 489 y siguientes) | El job de typecheck del CI no protege | E0 |
| Sin tests unitarios ni de integración | Todo módulo nuevo agrega riesgo sin red | E0 (permanente) |
| Frontend de producción inexistente | El prototipo valida diseño, no implementa | E0 en adelante |
| `apps/api` sin `package.json` ni `tsconfig.json` | El typecheck del CI se saltea silenciosamente | E0 |
| `git push` bloqueado por el asistente de credenciales | Los commits quedan locales | Independiente del plan |

### 8.4 Extensión del `FiscalDriver` a impuestos

El proyecto ya tiene el contrato correcto para comprobantes. Para que el plan sea genuinamente multiempresa y multinacional, el mismo patrón tiene que cubrir impuestos:

```typescript
/**
 * Contrato del motor impositivo por país.
 * La contabilidad no conoce alícuotas ni regímenes: los pide a este contrato.
 * Argentina lo implementa con IVA, retenciones, percepciones e Ingresos Brutos.
 */
export interface TaxDriver {
  readonly countryCode: string;

  /** Alícuotas y regímenes vigentes a una fecha (cambian por normativa). */
  ratesOn(date: Date): Promise<TaxRate[]>;

  /** Regímenes de retención/percepción aplicables a una operación. */
  withholdingRules(ctx: TaxContext): Promise<WithholdingRule[]>;

  /** Libros obligatorios y su formato de presentación. */
  requiredBooks(): Promise<BookDefinition[]>;

  /** Traduce los conceptos locales a un vocabulario contable común. */
  normalize(code: string): NormalizedTaxConcept;
}
```

**Por qué importa ahora y no después.** Si la contabilidad se modela con el IVA hardcodeado —cuentas fijas, alícuotas fijas, nombres AFIP en las columnas—, agregar un segundo país obliga a reescribir el núcleo contable, que es exactamente lo que el plan de producción quiso evitar al abstraer el driver fiscal. **Extender el contrato es barato; desarmar contabilidad no.**

---

## Anexo · Matriz de brechas consolidada

| Módulo ERP | Estado | Brecha principal | Mejora | Prioridad | Fase |
|---|---|---|---|---|---|
| Contabilidad general | Ausente | No existe libro contable | M1, M2, M10 | P0 | E1, E2 |
| Cuentas a pagar | Ausente | Inexistente | M3 | P0 | E3 |
| Compras | Ausente | Inexistente; stock entra por ajuste | M3 | P0 | E3 |
| Cuentas a cobrar | Parcial | Sin saldo por cliente ni antigüedad | M4 | P1 | E4 |
| Tesorería | Parcial | Sin caja, banco, cheques ni conciliación | M4 | P1 | E4 |
| Inventario | Implementado | Costeo y reconciliación resueltos | — | — | — |
| Ventas | Implementado (núcleo + documentos) | Cotización (`0025`), remito (`0021`), devolución (`0022`) y listas con vigencia (`0023`) hechos en E6; el módulo queda completo | M6 | P1 | E6 |
| Fiscal | Parcial | Emite correctamente; no determina impuestos | M5 | P1 | E5 |
| Recursos humanos | Ausente | Inexistente | M7 | P2 | E7 |
| Reportes | Parcial | Exporta listados; no emite estados | M8 | P2 | E8 |
| Producción | Ausente | Fuera de alcance actual | M11 | P3 | E9 |
| Plataforma | Implementado | Falta consolidación multi-tenant | M9 | P2 | E9 |
| **Red de seguridad** | **Inexistente** | **Sin tests; typecheck inerte** | **M12** | **P0** | **E0** |

---

*Fin del documento.*
