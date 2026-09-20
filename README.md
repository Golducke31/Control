# Control · Plataforma Multiempresa (Multi-tenant) para Gestión Comercial, Stock y Logística

Especificación de arquitectura, esquema de base de datos con aislamiento por **Row Level Security (RLS)**, diseño de API, integración con **AFIP (WSAA + WSFE)**, motor de **whitelabel** por empresa y un **prototipo funcional** de dashboard con estética *glassmorphism*.

Diseñado para operar en Argentina, con foco en distribuidoras, comercios y operadores logísticos que necesitan facturación electrónica real, stock multidéposito y trazabilidad de entregas en tiempo real.

---

## Tabla de contenidos

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Modelo de datos y aislamiento RLS](#3-modelo-de-datos-y-aislamiento-rls) — incluye las trampas de RLS en tablas particionadas, el remito (§3.10), la devolución (§3.11), las listas de precios con vigencia (§3.12) y la cotización (§3.13)
4. [Autenticación y autorización](#4-autenticación-y-autorización)
5. [Integración AFIP: flujo completo](#5-integración-afip-flujo-completo)
6. [Stock, depósitos y trazabilidad](#6-stock-depósitos-y-trazabilidad)
7. [Tracking en tiempo real](#7-tracking-en-tiempo-real)
8. [Whitelabel y plantillas por rubro](#8-whitelabel-y-plantillas-por-rubro)
9. [Exportaciones XLSX y PDF](#9-exportaciones-xlsx-y-pdf)
10. [Seguridad](#10-seguridad)
11. [Estructura del repositorio](#11-estructura-del-repositorio)
12. [Puesta en marcha](#12-puesta-en-marcha) — incluye la suite de aislamiento
13. [Roadmap](#13-roadmap)

---

## 1. Resumen ejecutivo

**Qué es.** Una plataforma SaaS multiempresa donde cada empresa (inquilino) opera con su propio catálogo, sus depósitos, sus usuarios, su identidad fiscal ante AFIP y su identidad visual, sobre una única instancia de aplicación y base de datos.

**Cómo se aísla.** El aislamiento no depende de que el programador recuerde agregar `WHERE tenant_id = ?` en cada consulta —ese enfoque falla tarde o temprano—. Se implementa en el motor: **PostgreSQL Row Level Security** con `ENABLE` + `FORCE`, de modo que toda consulta queda filtrada por el inquilino activo. Una consulta sin contexto devuelve **cero filas** (fail-closed), no filas de todos.

**Decisiones de arquitectura relevantes**

| Decisión | Elección | Por qué |
|---|---|---|
| Multitenancy | Base compartida + RLS | Costo operativo por inquilino casi nulo; una sola migración sirve a todos. Alternativa (schema por tenant) se vuelve inviable a partir de ~100 inquilinos por costo de migración. |
| Aislamiento | RLS con `FORCE` | `FORCE` extiende la política al owner de la tabla. Sin esto, una migración o un `SET ROLE` abre un agujero silencioso. |
| Identidad | Google OAuth / Workspace SSO | Sin contraseñas propias: menos superficie de ataque, menos soporte. |
| Correlatividad fiscal | Número obtenido de AFIP + lock | Un contador local se desincroniza y produce el error 10016. |
| Realtime | SSE para clientes, WS para operadores | Audiencias distintas, requisitos distintos. Ver [§7](#7-tracking-en-tiempo-real). |
| Exportaciones | Motor de temas, no plantillas por empresa | 200 inquilinos × 2 formatos = 400 plantillas es inmantenible. Ver [§9](#9-exportaciones-xlsx-y-pdf). |
| Credenciales AFIP | Cifradas AES-256-GCM, clave en KMS | El CRT/KEY es una llave privada: una fuga permite emitir facturas en nombre de la empresa. |

---

## 2. Arquitectura del sistema

### 2.1 Diagrama de componentes

```mermaid
graph TB
    subgraph Clientes
        B["Navegador<br/>Next.js + Tailwind"]
        M["App móvil<br/>Conductores"]
        P["Portal de tracking<br/>Cliente final"]
    end

    subgraph Edge
        CDN["CDN / WAF<br/>Rate limit + bot filter"]
        LB["Load Balancer<br/>TLS termination"]
    end

    subgraph App["Capa de aplicación"]
        API["API REST<br/>Fastify + tRPC"]
        RT["Gateway Realtime<br/>WS + SSE"]
        WORK["Workers<br/>Colas AFIP, reportes, GPS"]
        MW["Middleware de Tenancy<br/>AsyncLocalStorage"]
    end

    subgraph Datos
        PG[("PostgreSQL 16<br/>RLS + FORCE")]
        REDIS[("Redis<br/>Sesiones, locks, pub/sub")]
        S3[("Object Storage<br/>PDFs, PODs, logos")]
    end

    subgraph Externos
        GOOGLE["Google OAuth 2.0<br/>OpenID Connect"]
        WSAA["AFIP WSAA<br/>Autenticación"]
        WSFE["AFIP WSFE<br/>Facturación electrónica"]
        MAIL["Email / WhatsApp<br/>Notificaciones"]
    end

    B --> CDN --> LB
    M --> CDN
    P --> CDN
    LB --> API
    LB --> RT
    API --> MW
    MW --> PG
    API --> REDIS
    API --> S3
    API -.-> WORK
    WORK --> PG
    WORK --> WSAA
    WORK --> WSFE
    WORK --> S3
    RT --> REDIS
    RT --> PG
    API --> GOOGLE
    WORK --> MAIL

    classDef datastore fill:#1e3a5f,stroke:#4a90d9,color:#fff
    classDef external fill:#5f1e3a,stroke:#d94a90,color:#fff
    classDef app fill:#1e5f3a,stroke:#4ad990,color:#fff
    class PG,REDIS,S3 datastore
    class GOOGLE,WSAA,WSFE,MAIL external
    class API,RT,WORK,MW app
```

### 2.2 Flujo de un request autenticado

El punto crítico: **el inquilino nunca viaja en el request del cliente**. Se resuelve desde la sesión del servidor.

```mermaid
sequenceDiagram
    autonumber
    participant U as Usuario
    participant API as API
    participant S as Sesión (Redis)
    participant MW as Middleware Tenancy
    participant PG as PostgreSQL

    U->>API: GET /api/v1/invoices?limit=20<br/>Cookie de sesión
    API->>S: Resolver sesión
    S-->>API: userId, activeTenantId, memberships, permissions

    Note over API,MW: El header X-Tenant-Id se ignora.<br/>Si difiere de la sesión, se registra<br/>como evento de seguridad crítico.

    API->>MW: handler(req)

    rect rgb(30, 58, 95)
        Note over MW,PG: Transacción con contexto
        MW->>PG: BEGIN
        MW->>PG: SELECT app.set_tenant_context(tenantId, userId)
        MW->>PG: SELECT current_setting('app.tenant_id')
        PG-->>MW: Verificación: ¿coincide?
        alt Contexto no aplicado
            MW->>PG: ROLLBACK
            MW-->>U: 500 — abortado para evitar fuga
        end
        MW->>PG: SELECT * FROM billing.invoices LIMIT 20
        Note over PG: RLS aplica:<br/>tenant_id = app.current_tenant_id()<br/>AND app.has_permission('billing.read')
        PG-->>MW: Sólo filas del inquilino activo
        MW->>PG: COMMIT
    end

    MW-->>U: 200 — 20 comprobantes
```

### 2.3 Por qué `SET LOCAL` y no `SET`

Con un *connection pool*, una conexión física se reutiliza entre requests distintos. `SET app.tenant_id = '...'` (sin `LOCAL`) queda **pegado a la conexión**. Si un request falla antes del `RESET`, el siguiente request que tome esa conexión hereda el inquilino anterior y **ve datos que no le corresponden**.

`SET LOCAL` está acotado a la transacción: al hacer `COMMIT` o `ROLLBACK`, PostgreSQL restaura el valor previo automáticamente. Todo el acceso a datos pasa por `withTenant()`, que garantiza el ciclo `BEGIN → set_context → operación → COMMIT/ROLLBACK → release`.

---

## 3. Modelo de datos y aislamiento RLS

### 3.1 Diagrama entidad-relación (núcleo)

```mermaid
erDiagram
    tenants ||--o{ memberships : "tiene"
    tenants ||--|| tenant_branding : "identidad"
    tenants ||--o{ warehouses : "opera"
    tenants ||--o{ customers : "atiende"
    tenants ||--o{ categories : "organiza"
    tenants ||--o{ products : "cataloga"
    tenants ||--|| afip_credentials : "certifica"
    users ||--o{ memberships : "pertenece"
    roles ||--o{ memberships : "otorga"
    roles ||--o{ role_permissions : "incluye"
    permissions ||--o{ role_permissions : "concede"

    products ||--o{ product_variants : "se desglosa"
    product_variants ||--o{ stock_levels : "saldo por depósito"
    product_variants ||--o{ stock_movements : "libro mayor"
    product_variants ||--o{ price_list_items : "se cotiza en"
    price_lists ||--o{ price_list_items : "contiene escalas"
    warehouses ||--o{ stock_levels : "almacena"
    warehouses ||--o{ stock_transfers : "origen y destino"

    customers ||--o{ quotes : "cotiza"
    quotes ||--o{ quote_items : "detalla"
    price_lists ||--o{ quotes : "precia"

    customers ||--o{ sales_orders : "compra"
    sales_orders ||--o{ sales_order_items : "detalla"
    sales_orders ||--o{ invoices : "factura"
    invoices ||--o{ invoice_items : "detalla"
    invoices ||--o{ invoice_taxes : "desglosa IVA"
    invoices ||--o{ payments : "cobra"

    sales_orders ||--o{ delivery_notes : "autoriza salida (remito)"
    delivery_notes ||--o{ delivery_note_items : "detalla"
    delivery_notes ||--o{ invoices : "factura en partes"
    delivery_note_items ||--o{ invoice_items : "origina"
    delivery_notes }o--o| shipments : "se despacha en (opcional)"

    invoices ||--o{ customer_returns : "es devuelta por"
    customer_returns ||--o{ customer_return_items : "detalla"
    customer_returns ||--o| invoices : "genera la nota de crédito"

    sales_orders ||--o{ shipments : "despacha"
    customers ||--o{ shipments : "recibe"
    carriers ||--o{ shipments : "transporta"
    shipments ||--o{ shipment_items : "carga"
    shipments ||--o{ shipment_stops : "recorre"
    shipments ||--o{ tracking_events : "registra"
    shipments ||--|| delivery_confirmations : "confirma"

    tenants {
        uuid id PK
        citext slug UK
        text legal_name
        text tax_id "CUIT 11 dígitos"
        enum vertical
        enum status
        jsonb features
    }
    memberships {
        uuid id PK
        uuid tenant_id FK
        uuid user_id FK
        uuid role_id FK
        uuid_array warehouse_scope
        bool is_owner
    }
    products {
        uuid id PK
        uuid tenant_id FK
        text sku UK
        jsonb attributes
        numeric tax_rate
    }
    product_variants {
        uuid id PK
        uuid tenant_id FK
        uuid product_id FK
        text sku UK
        text barcode UK
        numeric list_price
        int min_stock
    }
    price_lists {
        uuid id PK
        uuid tenant_id FK
        text name UK
        char currency
        numeric multiplier
        bool is_default "a lo sumo una por empresa"
    }
    price_list_items {
        uuid id PK
        uuid tenant_id FK
        uuid price_list_id FK
        uuid variant_id FK
        numeric min_quantity
        numeric max_quantity "NULL = sin tope"
        numeric price
        date valid_from
        date valid_to "NULL = vigente"
    }
    stock_levels {
        uuid tenant_id PK
        uuid variant_id PK
        uuid warehouse_id PK
        int on_hand
        int reserved
        int available "GENERATED"
        numeric avg_cost
    }
    stock_movements {
        uuid id PK
        uuid tenant_id FK
        enum kind
        int quantity
        text source_type
        uuid source_id
    }
    invoices {
        uuid id PK
        uuid tenant_id FK
        enum kind
        enum doc_type
        smallint point_of_sale
        bigint number
        text cae "14 dígitos"
        enum result
        uuid delivery_note_id FK "origen si viene de remito"
        text idempotency_key UK
        text pdf_url
    }
    delivery_notes {
        uuid id PK
        uuid tenant_id FK
        text number UK
        uuid order_id FK
        uuid customer_id FK
        uuid shipment_id FK "despacho operativo, opcional"
        text status "draft|issued|partially_invoiced|invoiced|cancelled"
        date issue_date
    }
    delivery_note_items {
        uuid id PK
        uuid tenant_id FK
        uuid delivery_note_id FK
        uuid variant_id FK
        numeric quantity "despachado en el remito"
        numeric qty_invoiced "acumulado facturado (gate V-2)"
        numeric unit_price "snapshot de la orden"
        numeric tax_rate
    }
    customer_returns {
        uuid id PK
        uuid tenant_id FK
        text number UK
        uuid customer_id FK
        uuid invoice_id FK "factura de origen"
        uuid warehouse_id FK
        text status "draft|confirmed|applied|cancelled"
        uuid credit_note_id FK "nota de crédito emitida"
    }
    customer_return_items {
        uuid id PK
        uuid tenant_id FK
        uuid customer_return_id FK
        uuid variant_id FK
        numeric quantity "cuánto vuelve"
        numeric unit_price "snapshot de lo facturado"
        numeric tax_rate
    }
    quotes {
        uuid id PK
        uuid tenant_id FK
        text number UK
        uuid customer_id FK
        uuid price_list_id FK
        text status "draft|issued|accepted|rejected|cancelled"
        date valid_from
        date valid_until "vencida exige reconfirmar"
        numeric total
    }
    quote_items {
        uuid id PK
        uuid tenant_id FK
        uuid quote_id FK
        uuid variant_id FK
        numeric quantity
        numeric unit_price "resuelto por price_for()"
        numeric tax_rate
    }
    shipments {
        uuid id PK
        uuid tenant_id FK
        text tracking_code UK
        enum status
        timestamptz dispatched_at
        jsonb proof_of_delivery
    }
    tracking_events {
        bigserial id PK
        uuid tenant_id FK
        uuid shipment_id FK
        enum status
        point geo
        text client_event_id "dedup"
    }
```

### 3.2 Inventario de tablas

| Schema | Tabla | Propósito | RLS |
|---|---|---|---|
| `app` | `tenants` | Empresas. Raíz del aislamiento. | Sí (select/update propios) |
| `app` | `tenant_branding` | Identidad visual, plantilla, membrantes. | Sí |
| `app` | `ui_templates` | Plantillas de UI por rubro. | Lectura global |
| `app` | `users` | Identidad federada Google. **Global.** | Sí (self + compañeros) |
| `app` | `memberships` | Usuario ↔ empresa con rol. | Sí + RBAC |
| `app` | `roles` | Roles RBAC. `tenant_id NULL` = sistema. | Sí |
| `app` | `permissions` | Catálogo `resource.action`. | Sólo lectura |
| `app` | `role_permissions` | Mapeo rol → permiso. | Sí |
| `app` | `customers` | Clientes con domicilio y geo. | Sí |
| `app` | `categories` | Árbol de categorías. | Sí |
| `app` | `brands` | Marcas. | Sí |
| `app` | `products` | Producto padre. | Sí |
| `app` | `product_variants` | Variante vendible (SKU, EAN, precio). | Sí |
| `app` | `price_lists` | Listas de precios (retail/mayorista). A lo sumo una por defecto. | Sí |
| `app` | `price_list_items` | **Escalas de precio con vigencia** por variante y lista (gate V-4). | Sí |
| `app` | `warehouses` | Depósitos. | Sí |
| `app` | `stock_levels` | Saldo materializado por variante×depósito. | Sí |
| `app` | `stock_movements` | **Libro mayor append-only.** | Sí + no-mutate |
| `app` | `stock_transfers` / `_items` | Transferencias entre depósitos. | Sí |
| `billing` | `afip_credentials` | CRT/KEY cifrados, TA cacheado. | Sí + permiso estricto |
| `billing` | `sales_orders` / `_items` | Órdenes de venta. | Sí |
| `billing` | `invoices` | Comprobantes AFIP. **Inmutable tras CAE.** `delivery_note_id` liga la factura a su remito de origen. | Sí + no-mutate |
| `billing` | `invoice_items` | Líneas (snapshot fiscal). `delivery_note_item_id` da trazabilidad a la línea de remito. | Sí |
| `billing` | `invoice_taxes` | Desglose de IVA por alícuota. | Sí |
| `billing` | `delivery_notes` | **Remito**: documento propio que autoriza la salida y origina la facturación. | Sí |
| `billing` | `delivery_note_items` | Líneas del remito con `qty_invoiced` (acumulado facturado, gate V-2). | Sí |
| `billing` | `customer_returns` | **Devolución**: revierte stock y genera la nota de crédito (gate V-3). | Sí |
| `billing` | `customer_return_items` | Líneas de la devolución, validadas contra lo facturado por variante. | Sí |
| `billing` | `quotes` / `quote_items` | **Cotización**: oferta con validez que no compromete stock ni genera asiento (gate V-1). | Sí |
| `billing` | `credit_applications` | Imputación de notas de crédito al saldo de facturas. | Sí |
| `billing` | `afip_request_log` | Bitácora forense WSAA/WSFE. | Sí + append-only |
| `billing` | `afip_outbox` | Cola de reintentos de emisión. | Sí |
| `billing` | `payments` | Cobranzas. | Sí |
| `logistics` | `carriers` / `vehicles` | Transportistas y flota. | Sí |
| `logistics` | `shipments` | Envíos. | Sí |
| `logistics` | `shipment_items` | Carga del envío. | Sí |
| `logistics` | `shipment_stops` | Paradas multi-punto. | Sí |
| `logistics` | `tracking_events` | Timeline **append-only**. | Sí + no-mutate |
| `logistics` | `position_pings` | GPS de alta frecuencia. **Particionada.** | Sí + no-mutate |
| `logistics` | `delivery_confirmations` | POD del cliente (firma, fotos). | Sí |
| `logistics` | `tenant_logistics_config` | Config del módulo por empresa. | Sí |
| `audit` | `events` | Auditoría con **hash chain**. Particionada. | Sí + append-only |

### 3.3 Modelo de políticas RLS

Cuatro patrones cubren todos los casos. Están implementados en [`db/migrations/0006_rls_policies.sql`](db/migrations/0006_rls_policies.sql).

**Patrón 1 — Aislamiento base (aplica a ~30 tablas)**

```sql
CREATE POLICY tenant_isolation ON <tabla>
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = app.current_tenant_id()
    OR app.is_platform_admin()
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    OR app.is_platform_admin()
  );
```

- `USING` filtra lectura y las filas alcanzadas por `UPDATE`/`DELETE`.
- `WITH CHECK` impide `INSERT`/`UPDATE` que muevan una fila a otro inquilino.
- Sin contexto, `current_tenant_id()` es `NULL`, y `tenant_id = NULL` es `NULL` (no `TRUE`): **ninguna fila pasa**. Esto es fail-closed.

**Patrón 2 — Escritura restringida por permiso**

```sql
CREATE POLICY invoices_insert ON billing.invoices
  AS RESTRICTIVE
  FOR INSERT TO PUBLIC
  WITH CHECK (
    app.is_platform_admin()
    OR app.has_permission('billing.issue_invoice')
    OR app.has_permission('billing.manage')
  );
```

`AS RESTRICTIVE` significa que esta política **se combina con AND** respecto de las permisivas. RLS aísla entre empresas; RBAC controla qué puede hacer un miembro dentro de su empresa. Son capas complementarias: RLS sola dejaría que cualquier miembro leyera la facturación de su propia empresa aunque no tenga el permiso.

**Patrón 3 — Inmutabilidad fiscal**

```sql
CREATE POLICY invoices_no_update_authorized ON billing.invoices
  AS RESTRICTIVE
  FOR UPDATE TO PUBLIC
  USING (status <> 'authorized');
```

Un comprobante autorizado por AFIP es un documento fiscal: no se edita. Si hay un error, se anula con Nota de Crédito. La política lo hace imposible **desde cualquier ruta de código**, incluida una consola de administración.

El mismo patrón protege `stock_movements` y `tracking_events`: son evidencia, se corrigen con un movimiento inverso, no reescribiendo la historia.

**Patrón 4 — Tabla global (`app.users`)**

`app.users` no tiene `tenant_id` porque la identidad es global: un contador puede pertenecer a cinco empresas. La política combina self + membresía:

```sql
CREATE POLICY users_select_self_or_tenant ON app.users
  FOR SELECT TO PUBLIC
  USING (
    id = app.current_user_id()
    OR app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = app.users.id
        AND m.tenant_id = app.current_tenant_id()
        AND m.is_active
    )
  );
```

### 3.4 Vistas: `security_invoker` es obligatorio

```sql
CREATE VIEW app.v_low_stock WITH (security_invoker = true) AS ...
```

Sin `security_invoker = true`, una vista se ejecuta con los privilegios de su **owner** y **bypassea RLS**. Una vista de reporte sin esta opción es una fuga de datos entre inquilinos esperando a ocurrir. PostgreSQL 15+ (o `security_invoker` retroportado). Todas las vistas del proyecto lo llevan.

### 3.5 Tablas particionadas: las políticas NO se heredan

Esta es la trampa más sutil del aislamiento con RLS, y merece su propia sección porque **falla en silencio**.

PostgreSQL evalúa las políticas de la tabla que se consulta. Si `audit.events` está declarada `PARTITION BY RANGE (created_at)` y se crean políticas sobre el **padre**, esas políticas **no** se aplican a `events_2026_09`, `events_2026_10` ni `events_default`. Cada partición necesita su propia copia. La documentación de PostgreSQL lo dice explícitamente: *"row-level security policies are not inherited by partitions"*.

El resultado es un agujero que ninguna revisión de código detecta leyendo el archivo de políticas, porque el archivo está bien. El problema está en la interacción entre dos archivos que se ven correctos por separado.

**Cómo se corrigió** (migración `0008`):

```sql
-- Copia las políticas del padre a TODAS sus particiones, actuales y futuras.
SELECT app.apply_partition_rls('audit', 'events');
SELECT app.apply_partition_rls('logistics', 'position_pings');
```

Y para que no vuelva a ocurrir, la creación de particiones quedó encapsulada de modo que la única forma de crear una es la que deja el aislamiento puesto (migración `0009`):

```sql
-- Crea la partición mensual Y le aplica RLS del padre, en la misma llamada.
SELECT app.ensure_month_partition('audit', 'events', '2026-11-01');
```

**La barrera que falla el build** (migración `0008`):

```sql
SELECT app.assert_rls_coverage();
```

Recorre el catálogo real y lanza excepción si alguna tabla o partición de negocio carece de `FORCE RLS` o de política. Se ejecuta al final de las migraciones y en CI. Un PR que agregue una tabla sin política falla el pipeline en lugar de llegar a producción.

**La segunda trampa, la que hace que las pruebas mientan**

`FORCE ROW LEVEL SECURITY` —obligatorio en este proyecto— existe para que el **owner** de la tabla no pueda saltearse las políticas. Es una protección real, pero acotada: **no alcanza al superusuario ni a un rol con `BYPASSRLS`**. Esos ignoran RLS siempre, sin excepción.

La consecuencia práctica es contraintuitiva: si una prueba de aislamiento se conecta con un DSN de superusuario, cada aserción pasa **por el motivo equivocado**. El rol ve todas las filas de todos los inquilinos, así que "con contexto de A no se ven filas de B" da falso —tanto si las políticas funcionan como si están completamente rotas—. La prueba es verde y no prueba nada.

Por eso la conexión que ejercita las políticas debe ser un rol de aplicación sin privilegios de bypass (`app_login IN ROLE control_app`, ver §12.2), y por eso la suite aborta si detecta lo contrario en vez de advertirlo. Un falso negativo ruidoso es preferible a un falso positivo silencioso en la única barrera que impide que una empresa lea los datos de otra.

> **Regla operativa:** nunca crear una partición con `CREATE TABLE ... PARTITION OF` suelto. Usar `app.ensure_month_partition()`, que aplica la cobertura en la misma transacción. No existe ventana en la que la partición exista sin protección.

### 3.6 Vistas de monitoreo de particiones

`audit.v_default_partition_usage` expone cuántas filas cayeron en la partición `DEFAULT`. Cualquier valor mayor a cero significa que el job de mantenimiento se detuvo y los datos están entrando a un cajón sin política propia. Es una alerta temprana, no un reporte.

### 3.7 Tareas programadas: el ledger y por qué existe

Un job que existe y no corre es peor que un job ausente: da la apariencia de estar cubierto. Por eso el mantenimiento de particiones (`0009`) y la alerta de vencimiento de certificados no se apoyan en un log de aplicación, sino en un **ledger en la base** (`ops.jobs`, `ops.job_runs`, migración `0010`).

La pregunta que el ledger responde con una consulta es la que importa: *¿cuándo corrió esto por última vez, y está atrasado?*

```sql
SELECT code, is_overdue, last_success_at, is_running FROM ops.v_job_health;
```

**Jobs registrados:**

| Job | Cadencia | Crítico | Qué hace |
|---|---|---|---|
| `partition.maintenance` | mensual | sí | Crea las particiones de los próximos 3 meses y verifica la cobertura RLS al final. |
| `partition.retention` | mensual | no | Purga particiones GPS fuera de la ventana de 6 meses. Nunca toca `audit.events`. |
| `certificate.expiry` | diaria | sí | Alerta a 45, 30 y 15 días del vencimiento del certificado AFIP de cada empresa. |
| `stock.reconciliation` | diaria | sí | Compara `stock_levels` contra la suma de `stock_movements`. |
| `outbox.reaper` | cada 15 min | sí | Marca ejecuciones colgadas y trabajos AFIP muertos. |

**Tres decisiones que hacen que el ledger sea confiable:**

1. **El índice único `uq_job_runs_one_running`** impide dos ejecuciones simultáneas del mismo job, en cualquier instancia. Es una garantía del motor, no una convención del runner: aunque el código olvide tomar un lock, la segunda inserción falla.
2. **`begin_job_run()` devuelve `NULL`** en vez de lanzar cuando ya hay una ejecución viva. La segunda instancia **saltea**, que es lo correcto: no es un error, es el sistema funcionando.
3. **El cierre va en un `finally`.** Si el job explota, la fila queda cerrada como fallida. Sin eso, un crash deja la ejecución en `running` para siempre y el índice único bloquea todas las corridas siguientes — el job quedaría muerto en silencio. `ops.reap_stuck_job_runs()` destraba el caso residual.

**El modo de falla más traicionero, y la guarda contra él.** Los jobs transversales (certificados, reaper) corren con `app.platform_admin = 'on'` porque necesitan ver datos de todos los inquilinos. Sin ese contexto, la política RLS de `billing.afip_credentials` devuelve **cero filas**: el job reportaría "sin certificados por vencer" para siempre, con estado `succeeded`. `JobRunner.assertPlatformMode()` verifica al arrancar que el modo plataforma realmente se aplica, para que esa falla aparezca al iniciar el worker y no a las tres de la mañana con una alerta que nunca llega.

### 3.8 Rendimiento

- **Índices con `tenant_id` como primera columna.** `(tenant_id, created_at DESC)`. El planificador descarta el `tenant_id` en el filtro de índice y usa las siguientes columnas para ordenar, evitando un sort.
- **Índices parciales** para las consultas calientes: `WHERE status IN ('draft','queued')` sobre `invoices`, `WHERE available <= 0` sobre `stock_levels`.
- **Particionado** por rango mensual en `position_pings` (~2-5 M filas/mes en una flota mediana) y `audit.events`.
- **Filtro de fila temprano:** con RLS, PostgreSQL agrega el predicado de la política al plan. Si hay un índice sobre `tenant_id`, el costo por consulta es prácticamente el de un inquilino único.

### 3.9 Consistencia de stock

El stock no se actualiza desde la aplicación: se pasa por una única función con lógica transaccional.

```sql
SELECT app.apply_stock_movement(
  p_tenant_id    => $1,
  p_variant_id   => $2,
  p_warehouse_id => $3,
  p_kind         => 'sale_out',
  p_quantity     => 3
);
```

Actualiza el saldo materializado con `ON CONFLICT DO UPDATE` (que toma un lock de fila) y escribe el libro mayor **en la misma transacción**. Los ajustes negativos que dejarían `on_hand < 0` son rechazados por el `CHECK` de `stock_levels`. El costo promedio se recalcula con la fórmula de costo promedio ponderado cuando el movimiento es `purchase_in`.

### 3.10 El remito y la facturación parcial (gate V-2)

Hasta E6 una orden de venta se parecía a todos los documentos, y el papel del remito lo ocupaba `logistics.shipments`: un despacho operativo con tracking y POD, pero **sin número propio y sin ser el origen de la facturación**. El defecto concreto era que nada impedía facturar dos veces la misma mercadería — una factura de 60 y otra de 60 sobre un remito de 100 quedaban en el sistema como si fueran legítimas.

`billing.delivery_notes` + `billing.delivery_note_items` (migración `0021`, ADR [`0006`](docs/adr/0006-documentos-de-venta.md)) cierran el gate de E6 —*"remito facturado en partes sin duplicar cantidades"*— con el mismo criterio que el resto del proyecto: **la garantía va en el motor, no en quien llama.**

| Capa | Mecanismo | Qué garantiza |
|---|---|---|
| **a** | `CHECK (qty_invoiced <= quantity)` en `delivery_note_items` | El motor rechaza el sobre-facturado aunque la aplicación lo pida |
| **b** | `billing.invoice_delivery_note(...)` valida e incrementa `qty_invoiced` **con la línea bloqueada (`FOR UPDATE`)** en la misma transacción | Dos facturaciones concurrentes de la misma línea no pueden sumar más que lo despachado |
| **c** | `billing.invoice_items.delivery_note_item_id` | Trazabilidad origen→destino navegable: de la factura a la línea de remito, del remito a la orden y al POD |

El estado del remito **deriva** del acumulado (`invoiced` cuando toda línea está completa, `partially_invoiced` en otro caso); no se escribe a mano, igual que `payment_status` en `0015`. La función crea la factura como **borrador**: la autorización AFIP es un paso aparte, con su propio correlativo.

**Lo que el remito todavía no cubre.** El ADR `0006` decidió además la **devolución de cliente** (`billing.customer_returns`, migración `0022`) y las **listas de precios con vigencia y escalas por cantidad** (`0023`). Ninguna de las dos está implementada: hasta entonces el remito y la factura siguen usando el `unit_price` snapshot de la orden, y el camino legado orden→factura (sin remito) convive con remito→factura.

**Verificación.** `tests/sales/run.mjs` mide el gate contra el motor real: un remito de 100 facturado en 60 + 40 queda en 100 sin duplicar, y el sobre-facturado, la re-facturación de lo ya facturado y la facturación cross-tenant son rechazados.

### 3.11 La devolución y la nota de crédito (gate V-3)

`0015` dejó a `billing.invoices` capaz de representar una nota de crédito y a `billing.apply_credit_note()` capaz de imputarla al saldo. Faltaba el **documento que la origina**: la devolución de mercadería. Sin él, el camino real quedaba partido en un ajuste de stock por un lado y una nota de crédito emitida a mano por el otro, sin nada que garantizara que la mercadería devuelta es la que se facturó ni que no se devuelva dos veces.

`billing.customer_returns` + `customer_return_items` (migración `0022`, ADR [`0006`](docs/adr/0006-documentos-de-venta.md), decisión 3) cierran el gate V-3 con el ciclo `draft → confirmed → applied`:

| Paso | Qué hace | Garantía |
|---|---|---|
| `confirm_customer_return()` | `draft → confirmed` | Exige al menos una línea. Idempotente sobre una ya confirmada. |
| `apply_customer_return()` | `confirmed → applied` | Revierte stock, emite la nota de crédito y cierra la devolución |

`apply_customer_return()` es donde vive la garantía, y es de motor:

- **No se devuelve más de lo facturado.** Por cada variante valida contra `invoice_items` de la factura de origen, descontando lo ya devuelto por devoluciones **ya aplicadas** —no las confirmadas: una confirmada que todavía no se aplicó no revirtió nada, y contarla dejaría dos devoluciones incompatibles sin poder aplicarse nunca.
- **No se devuelve dos veces.** Una devolución aplicada no se vuelve a aplicar, y el estado `applied` exige nota de crédito (`CHECK cr_credit_note_state`): una devolución "hecha" sin comprobante es imposible por construcción.
- **Stock por el único camino permitido.** Emite un `return_in` por `app.apply_stock_movement()`, trazable a la devolución (`source_type = 'customer_return'`). No pasa costo: `return_in` no recalcula el costo promedio —sólo `purchase_in` lo hace—, así que la valuación vuelve al costo promedio de la empresa y no al precio de venta.
- **Serialización por factura.** Toma un `pg_advisory_xact_lock` sobre `(empresa, factura)`. No puede usar `SELECT ... FOR UPDATE` sobre la factura: la política `invoices_no_update_authorized` bloquea el `UPDATE` —y `FOR UPDATE` lo exige— justo sobre el único comprobante que se puede devolver, que es el autorizado.
- **Stock entero.** `stock_levels.on_hand` es `int` y `apply_stock_movement()` recibe `integer`: una cantidad fraccionaria falla explícitamente en vez de truncarse en silencio.

La nota de crédito nace como **borrador** ligada por `related_invoice_id`; la autorización AFIP y la imputación al saldo (`billing.apply_credit_note()`) son pasos posteriores, igual que en el camino remito → factura. Las funciones son **`SECURITY INVOKER`** a propósito —a diferencia de `invoice_delivery_note()`—, para que RLS y el permiso `billing.issue_invoice` sigan vigentes durante la emisión del comprobante.

**Integración con los módulos anteriores.** La cadena ya estaba preparada y la devolución la activa: el rol contable `sales_returns` → cuenta `4.1.1.03` y las reglas de mapeo de `credit_note` las siembra `0013` (E2); `0019` (E5) define el cómputo del IVA de una nota de crédito como hecho propio y con signo contrario; y `apply_credit_note()` de `0015` (E4) la imputa al saldo. Una nota de crédito en borrador **no** figura en `accounting.v_posting_gaps`; autorizada, sí, y el job la asienta.

**Verificación.** `tests/sales/run.mjs` mide el gate contra el motor real, incluidas las negativas (doble aplicación, exceso de cantidad, devolución sin confirmar, cantidad fraccionaria, factura no autorizada, cross-tenant) y la cadena completa hasta el asiento balanceado y el saldo del cliente.

### 3.12 Listas de precios con vigencia y escalas por cantidad (gate V-4)

`0003` dejó un precio por variante y por lista, sin vigencia y sin escalas. Dos consecuencias: **cambiar un precio borraba el anterior** —un presupuesto de marzo re-cotizado en junio devolvía el precio de junio, y el número que se le pasó al cliente dejaba de ser reproducible—, y la escala por cantidad no tenía dónde vivir, así que terminaba hardcodeada en la aplicación.

`0023` (ADR [`0006`](docs/adr/0006-documentos-de-venta.md), decisión 4) hace que el precio sea **función de `(lista, vigencia, variante, cantidad)` resuelta por datos**:

| Precedencia | Origen | Cuándo |
|---|---|---|
| 1 | `tier` | Una escala de la lista cubre la cantidad **y** la fecha |
| 2 | `list_multiplier` | `product_variants.list_price × price_lists.multiplier` |
| 3 | *(sin fila)* | No hay precio configurado |

`app.price_for(empresa, lista, variante, cantidad, fecha)` **recibe la fecha** en lugar de devolver «el precio actual», con la misma forma que `fiscal.rates_on()` de `0017`: un llamador que quiera hoy la pasa explícitamente, y así un documento viejo no se re-cotiza con el precio de hoy. Devuelve 0 o 1 fila; 0 filas es una respuesta legítima y el llamador **no debe inventar un 0** (`list_price NOT NULL DEFAULT 0` es el centinela de «sin cargar», no un precio).

**La vigencia vive en la línea, no en la lista.** Una lista («Mayorista») es una entidad durable cuyo contenido cambia con el tiempo; ponerle vigencia obligaría a crear «Mayorista marzo» y «Mayorista abril» como listas distintas, y `price_lists_unique (tenant_id, name)` lo impide. Ésa es la alternativa que se descartó.

**Dos garantías de motor** hacen que la resolución sea determinista, que es lo que el criterio exige:

- **`EXCLUDE` de solapamiento.** Para una misma (empresa, lista, variante) no puede haber dos escalas que se solapen *a la vez* en cantidad y en fecha. Sin esto, `price_for()` podría devolver dos precios para la misma consulta y el resultado dependería del orden físico — la misma irreproducibilidad que el ADR 0004 prohíbe para las alícuotas.
- **`UNIQUE` parcial de lista por defecto.** A lo sumo una `is_default` por empresa. Con dos, «la lista por defecto» no tiene respuesta.

Un detalle que la `EXCLUDE` obliga a hacer bien: **un cambio de precio cierra la ventana anterior**. Con `valid_to NULL` la ventana se extiende para siempre y cualquier ventana futura se solapa, así que la `EXCLUDE` la rechaza. Es correcto —así se modela un cambio de precio— y es la clase de error que el motor atrapa en vez de dejar pasar en silencio.

**Verificación.** `tests/sales/run.mjs` mide el gate: los bordes de cada tramo (9 y 10 caen en escalas distintas), la escala sin tope superior, la vigencia (cargar un precio futuro **no** cambia el precio de hoy), la caída al multiplicador, el caso sin precio configurado (0 filas), el rechazo del solapamiento y de la segunda lista por defecto, y el aislamiento entre empresas.

### 3.13 La cotización: una oferta que vence y no compromete nada (gate V-1)

El ADR [`0006`](docs/adr/0006-documentos-de-venta.md) nombra tres documentos que en la operación real son distintos: cotización, remito y factura. Los dos últimos llegaron en §3.10 y §3.11; la cotización faltaba, así que una oferta con vencimiento no tenía dónde vivir — o se mandaba una orden de venta como si fuera una cotización, comprometiendo stock y dejando en el circuito un pedido firme, o se cotizaba fuera del sistema.

`0025` la agrega con el ciclo `draft → issued → accepted` (+ `rejected`, `cancelled`):

| Paso | Qué hace | Garantía |
|---|---|---|
| `add_quote_item()` | Carga una línea | Resuelve el precio con `app.price_for()` a la fecha indicada; **falla** si la lista no tiene precio (no cotiza un 0) |
| `issue_quote()` | `draft → issued` | Exige líneas y **recalcula los totales** desde ellas: la cabecera no elige los importes |
| `accept_quote()` | `issued → accepted` | **Rechaza una vencida**: exige reconfirmarla primero |
| `reconfirm_quote()` | Extiende la validez | No admite reconfirmar hacia el pasado |

**La definición son dos negaciones, y las dos se verifican.** No compromete stock: no emite ningún movimiento, *ni siquiera una `reservation`* — reservar por una oferta que puede no aceptarse nunca sería comprometer mercadería de arriba—. Y no genera asiento: no es un hecho económico, así que no aparece en `accounting.v_posting_gaps` ni puede producir una línea de diario.

**El vencimiento se deriva, no se almacena.** Un `status = 'expired'` guardado en la fila necesitaría un job que lo ponga al día, y entre el vencimiento real y la corrida del job la fila mentiría; peor, si el job no corre, miente para siempre. `billing.v_quotes` expone `effective_status` calculado contra la fecha de hoy **para listar**; el cumplimiento, en cambio, usa la fecha explícita que recibe `accept_quote()`, igual que `rates_on()` y `price_for()`. Una decisión no debería depender de `now()` si se quiere poder verificarla.

**Verificación.** `tests/sales/run.mjs` mide el gate: la línea toma el precio de la escala de la lista, el fallo cuando no hay precio, los totales recalculados desde las líneas, la idempotencia, el rechazo de aceptar una vencida (con un error que dice *qué hacer*), la reconfirmación que la vuelve aceptable, el rechazo de reconfirmar hacia el pasado o una ya aceptada, y las dos negaciones —saldo de stock intacto, cero movimientos y cero asientos—.

---

## 4. Autenticación y autorización

### 4.1 Flujo Google OAuth / Workspace SSO

```mermaid
sequenceDiagram
    autonumber
    participant U as Usuario
    participant F as Frontend
    participant API as API
    participant G as Google OIDC
    participant DB as PostgreSQL
    participant S as Redis

    U->>F: "Iniciar sesión con Google"
    F->>G: Authorization request<br/>scope: openid email profile<br/>+ code_challenge (PKCE)
    U->>G: Autentica y consiente
    G->>F: Redirect con authorization code
    F->>API: POST /auth/google { code, code_verifier }
    API->>G: Token exchange + validar PKCE
    G-->>API: id_token (JWT firmado)

    rect rgb(30, 58, 95)
        Note over API,G: Validación del id_token
        API->>API: Verificar firma contra JWKS de Google
        API->>API: aud == GOOGLE_CLIENT_ID
        API->>API: iss ∈ {accounts.google.com, https://accounts.google.com}
        API->>API: exp > now Y email_verified == true
    end

    API->>DB: UPSERT app.users<br/>ON CONFLICT (google_sub)
    DB-->>API: user.id

    API->>DB: SELECT membresías activas del usuario
    DB-->>API: [{ tenantId, roleCode, isOwner }]

    alt Sin membresías
        API-->>F: Estado "sin organización"<br/>→ flujo de alta o invitación
    else Múltiples membresías
        API->>S: Crear sesión con activeTenantId = última usada
        API-->>F: Sesión + lista de empresas
        Note over F: El switcher cambia de empresa<br/>revalidando la membresía
    else Una membresía
        API->>S: Crear sesión con esa membresía
        API-->>F: Sesión + permisos
    end

    API->>DB: INSERT audit.events (action='auth.login')
```

**Validación del `id_token` — no negociable.** Un JWT de Google no se decodifica sin más: se verifica la firma contra el JWKS de Google (con caché y rotación de claves), se comprueba `aud` contra nuestro `client_id` (si no, un token emitido para otra aplicación sería aceptado), `iss`, `exp`, y `email_verified`. Además se usa **PKCE** desde el inicio: un cliente público no puede guardar un `client_secret` y sin PKCE el `authorization code` es interceptable.

**Vinculación de cuenta.** El identificador estable es el `sub` de Google, no el email. Un email puede cambiar de titular en algunos dominios; el `sub` es inmutable. La vinculación se hace por `google_sub` con `ON CONFLICT`.

**Restricción por dominio Workspace.** Si la empresa exige que sólo se acepten cuentas de su dominio, se valida el claim `hd` del `id_token` contra la configuración del inquilino. Es una defensa contra la auto-registración con un Gmail personal.

### 4.2 RBAC

Siete roles de sistema, más roles personalizados por empresa. El catálogo de permisos usa la forma `resource.action`.

| Rol | Ámbito |
|---|---|
| `owner` | Todos los permisos. Único rol no eliminable. |
| `admin` | Gestión completa, sin certificados AFIP ni notas de crédito. |
| `accountant` | Facturación, reportes financieros, exportaciones. |
| `warehouse` | Stock, transferencias, preparación de envíos. |
| `sales` | Órdenes, clientes, consulta de catálogo y stock. |
| `driver` | Actualización de tracking y confirmaciones de entrega. |
| `viewer` | Sólo lectura. |

**Alcance por depósito.** `memberships.warehouse_scope` (un array de UUID) permite limitar a un usuario a ciertos depósitos. Un encargado del Depósito Norte no ve ni opera el stock del Depósito Sur. Se aplica en la capa de servicio, sobre el resultado ya filtrado por RLS.

### 4.3 Cambio de empresa

```http
POST /api/v1/auth/switch-tenant
Content-Type: application/json

{ "tenantId": "8f3a...-...-...-...-............" }
```

El servidor **revalida la membresía**, recalcula el conjunto de permisos para esa empresa y actualiza `activeTenantId` en la sesión. El cliente nunca decide a qué empresa pertenece: sólo *solicita* el cambio, y el servidor lo concede o lo rechaza.

---

## 5. Integración AFIP: flujo completo

### 5.1 Panorama

AFIP expone dos web services que se usan en secuencia:

- **WSAA** — *Web Service de Autenticación y Autorización*. Es el portero. Entrega un **Ticket de Acceso (TA)** válido 12 horas.
- **WSFE** — *Web Service de Facturación Electrónica*. Emite el **CAE** (*Código de Autorización Electrónico*) de cada comprobante.

En producción se ataca a `servicios1.afip.gov.ar`; existe un ambiente de homologación (`wswhomo`) para pruebas con CUIT y certificados de test.

### 5.2 Flujo de autenticación (WSAA)

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker
    participant DB as PostgreSQL
    participant WSAA as AFIP WSAA
    participant R as Redis (lock)

    W->>DB: Leer TA cacheado de afip_credentials
    DB-->>W: ta_expires_at

    alt TA vigente (con >10 min de margen)
        W-->>W: Reutilizar TA
    else TA vencido o por vencer
        W->>R: SETNX lock:wsaa:{tenantId} EX 30
        alt Lock no obtenido
            R-->>W: Otro worker está renovando
            Note over W: Espera breve y reintenta.<br/>Evita el error 600 de AFIP: "ya existe un TA vigente".
        else Lock obtenido
            W->>W: 1. Descifrar CRT/KEY (AES-256-GCM)
            W->>W: 2. Validar vigencia y par cert/key
            W->>W: 3. Generar TRA (XML)
            Note over W: uniqueId único<br/>generationTime / expirationTime<br/>service = "wsfe"
            W->>W: 4. Firmar TRA → CMS/PKCS#7 detached, SHA-256
            W->>WSAA: POST loginCms { in0: cms_base64 }
            alt Firma válida y servicio habilitado
                WSAA-->>W: TA { token, sign, expirationTime }
                W->>DB: Guardar TA cifrado en afip_credentials
                W->>R: Liberar lock
            else Fault SOAP
                WSAA-->>W: faultstring
                W->>DB: INSERT afip_request_log (succeeded=false)
                W->>R: Liberar lock
                W-->>W: Error clasificado
            end
        end
    end

    W->>DB: INSERT afip_request_log (operation='wsaa.login')
```

**Puntos de fricción reales y cómo se resuelven**

| Problema | Causa | Solución implementada |
|---|---|---|
| Error 600: *"ya existe un TA vigente"* | Varios workers piden TA a la vez | Lock distribuido por inquilino + cache del TA |
| Firma rechazada | `uniqueId` reutilizado, ventana de tiempo incoherente | `uniqueId` por request; reloj bajo NTP verificado |
| *"Certificado no autorizado"* | El servicio `wsfe` no está habilitado para ese CUIT en el Administrador de Relaciones | Se valida antes de habilitar el módulo fiscal: `FEParamGetPtosVenta` como *smoke test* |
| *"El certificado y la clave no coinciden"* | Par CRT/KEY cruzado entre empresas | Validación de par en `signTra()` antes de llamar a AFIP |
| Reloj desfasado | VM sin NTP | `generationTime` con 10 minutos de tolerancia hacia atrás |

### 5.3 Flujo de emisión de CAE (WSFE)

```mermaid
sequenceDiagram
    autonumber
    participant U as Usuario
    participant API as API
    participant DB as PostgreSQL
    participant Q as afip_outbox
    participant W as Worker
    participant WSAA as AFIP WSAA
    participant WSFE as AFIP WSFE
    participant AFIP as AFIP (servicios)

    U->>API: POST /invoices { orderId, cbteTipo: 1, items[] }
    API->>API: requirePermission('billing.issue_invoice')

    rect rgb(30, 58, 95)
        Note over API,DB: Transacción 1: persistir intención
        API->>DB: SELECT app.set_tenant_context(...)
        API->>DB: Validar orden, cliente, CUIT, condición IVA
        API->>DB: Calcular alícuotas e importes
        API->>API: Verificar TOTAL = NETO + IVA (AFIP lo valida)
        API->>DB: INSERT invoices (status='draft', idempotency_key)
        API->>DB: INSERT invoice_items, invoice_taxes
        API->>DB: INSERT afip_outbox (status='pending')
        API->>DB: COMMIT
    end

    API-->>U: 202 Accepted { invoiceId, status: 'queued' }

    Note over Q,W: Procesamiento asíncrono
    W->>Q: UPDATE ... SET status='processing', locked_by=...<br/>WHERE status='pending' ... FOR UPDATE SKIP LOCKED
    Note over Q,W: SKIP LOCKED permite N workers<br/>sin pisarse ni bloquearse
    Q-->>W: Trabajo reclamado

    W->>DB: Obtener credenciales y último número autorizado
    W->>WSAA: getTicket() → TA vigente o login
    WSAA-->>W: TA

    W->>WSFE: FECompUltimoAutorizado(ptoVta, cbteTipo)
    WSFE-->>W: último número (fuente de verdad)

    W->>DB: Reservar correlativo con lock<br/>(advisory lock por tenant+ptoVta+cbteTipo)
    DB-->>W: cbteNumber = ultimo + 1

    W->>AFIP: FECAESolicitar { FeCabReq, FeDetReq[Auth, detail] }

    alt Resultado = 'A' (aprobado)
        AFIP-->>W: { CAE, CAEFchVto, Resultado: 'A' }
        W->>DB: UPDATE invoices SET cae, cae_expires_at,<br/>result='approved', status='authorized'
        W->>DB: UPDATE stock_levels (sale_out)
        W->>DB: INSERT stock_movements
        W->>Q: UPDATE status='done'
        W->>DB: Generar PDF con identidad de la empresa → Object Storage
    else Resultado = 'R' (rechazado)
        AFIP-->>W: { Resultado: 'R', Observaciones[] }
        W->>DB: UPDATE invoices SET result='rejected',<br/>afip_observation, afip_response
        W->>Q: status='dead' — requiere intervención
        Note over W,DB: El número reservado queda hueco.<br/>AFIP tolera huecos, NO duplicados ni retrocesos.
    else Timeout / error de red
        Note over W,AFIP: Estado indeterminado: el CAE puede haberse emitido
        W->>AFIP: FECompConsultar(ptoVta, cbteTipo, cbteNro)
        AFIP-->>W: Comprobante existente con CAE, o vacío
        Note over W: Recuperación: si existe, se persiste el CAE.<br/>Si no, se reintenta la emisión con el mismo número.
    end
```

### 5.4 Idempotencia y recuperación

El caso más delicado es el **timeout**: la petición salió, AFIP pudo haber emitido el CAE, y la respuesta se perdió. Emitir de nuevo crearía un comprobante duplicado con consecuencias fiscales.

La recuperación se apoya en tres mecanismos:

1. **`idempotency_key` única por inquilino.** Un reintento del mismo request devuelve el comprobante ya creado en lugar de crear otro. `UNIQUE (tenant_id, idempotency_key)`.
2. **`FECompConsultar` antes de reintentar.** Ante estado indeterminado, se consulta si el comprobante `(ptoVta, cbteTipo, nro)` ya existe en AFIP.
3. **`afip_request_log` completo.** Cada request/response queda registrado con cuerpo, código HTTP, duración y timestamp. Es la evidencia forense para resolver una disputa con AFIP o con el cliente.

### 5.5 Tipos de comprobante y validaciones

| Tipo | Id AFIP | Valida |
|---|---|---|
| Factura A | 1 | Receptor CUIT + Responsable Inscripto. Discrimina IVA. |
| Nota de Débito A | 2 | Requiere `CbtesAsoc` con el comprobante origen. |
| Nota de Crédito A | 3 | Requiere `CbtesAsoc`. Importe negativo o ajuste. |
| Factura B | 6 | Consumidor final / Monotributo / Exento. |
| Factura C | 11 | Emisor Monotributista. Sin IVA discriminado. |
| Factura M | 51 | Casos especiales. |

**RG 5616 (obligatorio desde 2024).** El campo `CondicionIVAReceptorId` es requerido en toda emisión. Su omisión produce rechazo. Está en `CONDICION_IVA_RECEPTOR` del cliente WSFE.

**Invariantes que AFIP valida y que se comprueban antes de enviar:**
- `ImpTotal = ImpNeto + ImpIVA + ImpTrib + ImpOpEx` (tolerancia de un centavo).
- `CantReg` coincide con la cantidad de elementos en `FECAEDetRequest`.
- `CbteDesde` y `CbteHasta` iguales cuando `CantReg = 1`.
- Correlatividad respecto de `FECompUltimoAutorizado`.
- Redondeo a dos decimales. JavaScript usa *round-half-to-even* y AFIP valida al centavo, de ahí la función `money()` con corrección de épsilon.

---

## 6. Stock, depósitos y trazabilidad

### 6.1 Modelo de doble registro

Se mantienen dos estructuras en paralelo:

- **`stock_levels`** — saldo materializado por `(variante, depósito)`. Da lectura O(1) para el dashboard y para validar disponibilidad al vender.
- **`stock_movements`** — libro mayor **append-only** con cada cambio y su documento origen.

La ventaja: los saldos se reconstruyen desde el libro mayor. Si un saldo queda inconsistente, se recalcula con `SUM(...)` agrupado por tipo de movimiento y se detecta la discrepancia. Un modelo con sólo saldos no permite auditar; uno con sólo movimientos no permite leer el stock actual sin agregar millones de filas.

### 6.2 Tipos de movimiento

| Tipo | Efecto en `on_hand` | Uso |
|---|---|---|
| `purchase_in` | `+` | Entrada por compra. Recalcula costo promedio. |
| `sale_out` | `−` | Salida por venta. |
| `transfer_out` / `transfer_in` | `−` / `+` | Transferencia entre depósitos. |
| `adjustment_pos` / `adjustment_neg` | `+` / `−` | Recuento físico, merma, rotura. |
| `return_in` | `+` | Devolución de cliente. |
| `reservation` / `release` | `0` | Afecta `reserved`, no `on_hand`. |

`available` es una columna generada (`on_hand - reserved`), no un valor en la aplicación: no puede desincronizarse.

### 6.3 Ciclo de una transferencia

```
draft ──dispatch──> dispatched ──receive──> received
  │                      │
  └────── cancel ────────┴──────> cancelled
```

Al despachar se emite `transfer_out` en el depósito origen. Al recibir se emite `transfer_in` en el destino con la cantidad **efectivamente recibida** (`qty_received`), que puede diferir de `qty_sent`. La diferencia no se ajusta automáticamente: se registra y queda visible como discrepancia. Ajustarla en silencio ocultaría un problema de logística o de manipuleo.

---

## 7. Tracking en tiempo real

### 7.1 Dos canales, dos audiencias

| | **SSE** | **WebSocket** |
|---|---|---|
| Ruta | `/rt/v1/tracking/:token/stream` | `/rt/v1/ops` |
| Consumidor | Cliente final | Operadores y conductores |
| Autenticación | Token firmado de un solo uso | Sesión + RBAC |
| Dirección | Servidor → cliente | Bidireccional |
| Reconexión | Nativa del navegador (`EventSource`) | Manual con backoff |
| Atraviesa proxies | Sí (HTTP/1.1) | Requiere upgrade |
| Por qué | El cliente final no necesita enviar nada, y el link de tracking debe funcionar en cualquier red corporativa | El conductor publica GPS y cambios de estado; la oficina recibe el feed multiplexado |

### 7.2 Aislamiento multi-tenant en realtime

Este es el punto donde un sistema multiempresa suele fallar. La regla: **una conexión sólo recibe eventos cuyo `tenantId` coincide con el de su sesión validada, y la suscripción a un recurso se revalida siempre contra la base de datos**.

```mermaid
sequenceDiagram
    autonumber
    participant C1 as Operador (Empresa A)
    participant GW as Gateway RT
    participant DB as PostgreSQL
    participant C2 as Operador (Empresa B)

    C1->>GW: WS connect (sesión válida, tenant=A)
    GW->>DB: Verificar membresía → tenantA
    GW->>GW: Registrar en bus: tenant:A:tracking

    C2->>GW: WS connect (sesión válida, tenant=B)
    GW->>DB: Verificar membresía → tenantB
    GW->>GW: Registrar en bus: tenant:B:tracking

    Note over C1,C2: Se usa un canal por tenant en el bus.<br/>El aislamiento es estructural,<br/>no una comparación que alguien podría olvidar.

    C1->>GW: subscribe { shipmentId: X }  — envío de A
    GW->>DB: canAccessShipment(tenantA, X) → true
    GW-->>C1: subscribed { X }

    C2->>GW: subscribe { shipmentId: X }  — intenta el envío de A
    GW->>DB: canAccessShipment(tenantB, X) → false
    GW->>DB: INSERT audit.events (severity='critical',<br/>kind='realtime.unauthorized_shipment_subscribe')
    GW-->>C2: error { code: 'FORBIDDEN' }
    Note over GW,C2: Sin confirmar si X existe.<br/>No filtra su existencia.

    DB-->>GW: Evento de tracking del envío X
    GW->>C1: event: tracking { status: 'delivered' }
    Note over GW,C2: C2 no recibe nada
```

**Backpressure.** Si un cliente no consume (pestaña suspendida, red lenta), el buffer crece en memoria del servidor. Al superar 512 KB se cierra la conexión con código `1013` (*Try Again Later*) en lugar de acumular. Un consumidor rezagado no debe tumbar el proceso para todos los inquilinos.

**Heartbeat.** Cada 25 segundos se envía un comentario SSE (`: keepalive`). Sin esto, los proxies con *idle timeout* cortan la conexión y el usuario ve un panel congelado sin saberlo.

**Deduplicación.** La app del conductor funciona offline: acumula eventos y los sincroniza al recuperar señal. `tracking_events.client_event_id` con `UNIQUE NULLS NOT DISTINCT (tenant_id, shipment_id, client_event_id)` hace que un reenvío sea inofensivo.

### 7.3 Máquina de estados

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> preparing : confirmar preparación
    draft --> cancelled
    preparing --> ready : preparado
    preparing --> incident
    preparing --> cancelled
    ready --> in_transit : despachado
    ready --> incident
    ready --> cancelled
    in_transit --> out_for_delivery : última milla
    in_transit --> delivered : entrega directa
    in_transit --> incident
    in_transit --> cancelled
    out_for_delivery --> delivered : POD confirmado
    out_for_delivery --> incident : destinatario ausente
    incident --> preparing : reprogramar
    incident --> ready
    incident --> in_transit : resuelto
    incident --> cancelled
    delivered --> [*]
    cancelled --> [*]
```

Las transiciones se validan **antes** de escribir en la base de datos (`assertTransition`). Un `delivered` no vuelve a `in_transit`: ese error corrompe las métricas de cumplimiento y habilita marcar como entregado algo que no lo está. Igual estado es idempotente: un reintento no es un error.

**Conformidad con reservas.** Si el cliente recibe con discrepancias (`conform: false`), el envío pasa a `incident`, no a `delivered`. Forzar `delivered` inflaría el indicador de cumplimiento y ocultaría un problema de calidad.

### 7.4 Confirmación de descarga (POD)

El cliente final recibe un link por email o WhatsApp con un **token**, no con el `shipmentId`:

```http
GET /t/9xK2mP...  →  Portal de tracking
```

El token es de 32 bytes de aleatoriedad criptográfica, se guarda **hasheado** (SHA-256) y expira. Ventajas frente a exponer el UUID: no se pueden enumerar envíos ajenos, el link caduca, y se puede revocar reemitiéndolo.

La confirmación registra firma, DNI del firmante, fotos y geolocalización. `delivery_confirmations.access_token_hash` es `UNIQUE`, de modo que un token sólo resuelve a un envío.

---

## 8. Whitelabel y plantillas por rubro

### 8.1 Tokens de marca

`app.tenant_branding` guarda la identidad como **valores**, no como CSS. El frontend los inyecta como *custom properties*:

```css
:root {
  --brand-primary:   #6D5EF8;
  --brand-secondary: #22D3EE;
  --brand-accent:    #F59E0B;
  --brand-heading-font: 'Space Grotesk', sans-serif;
}
```

Ningún componente consume un color literal. Cuando el usuario cambia de empresa, se reescriben los tokens y **toda la interfaz** —gráficos SVG incluidos— adopta la nueva identidad sin recargar ni re-renderizar componentes. En el prototipo se puede ver en acción con el switcher de empresa.

Los colores RGB se guardan además en forma separada (`--brand-primary-rgb: 109, 94, 248`) porque `rgba()` no acepta una variable hex: es el patrón necesario para usar la marca con transparencia en bordes, halos y `box-shadow`.

### 8.2 Plantillas por rubro

Cinco plantillas predefinidas, cada una con su densidad, radios, intensidad de *glass* y —lo más importante— **su jerarquía de información**:

| Plantilla | Rubro | KPIs principales | Gráficos |
|---|---|---|---|
| `retail-glass` | Comercio | Vendido hoy, ticket promedio, unidades, SKUs activos | Ventas en el tiempo, top productos, mezcla |
| `services-glass` | Servicios | Órdenes abiertas, horas promedio, SLA, horas facturables | Carga por recurso, tendencia SLA, ingreso por servicio |
| `distributor-glass` | Distribuidora | Valor de stock, alertas, envíos activos, cumplimiento | Mapa de depósitos, embudo de entrega, evolución de stock |
| `logistics-glass` | Logística | Envíos activos, en tránsito, entregados hoy, incidencias | Mapa en vivo, uso de flota, tiempos de espera |
| `mixed-glass` | Mixto | Vendido hoy, stock, envíos, facturas pendientes | Ventas, stock, embudo |

Una distribuidora vive pendiente del valor de stock y del cumplimiento de entregas; un comercio minorista, de las ventas del día. Darles el mismo panel obliga a cada uno a ignorar la mitad de la pantalla. La plantilla codifica esa diferencia.

`tenant_logistics_config.enabled` habilita el módulo de transporte por empresa: una consultora no necesita torre de control logística, y mostrarle el módulo vacío agrega ruido.

### 8.3 Contraste accesible

Una empresa puede elegir cualquier color. Si elige amarillo claro, un PDF con texto blanco sobre ese fondo es ilegible —y es nuestro defecto, no su elección—. `accessibleTextOn()` calcula el contraste WCAG 2.1 y, si no alcanza el mínimo AA (4.5:1), **oscurece el color hasta lograrlo** u opta por texto oscuro.

---

## 9. Exportaciones XLSX y PDF

### 9.1 Motor de temas, no plantillas por empresa

Con 200 inquilinos y dos formatos, mantener plantillas por empresa serían 400 archivos. En su lugar: **un artefacto neutro + un `BrandTheme` resuelto en runtime** desde `tenant_branding`. Cambiar el color corporativo de una empresa no requiere tocar código ni redesplegar.

### 9.2 XLSX

- Banda de marca con el nombre de la empresa y su CUIT.
- Encabezados con el color secundario.
- Filas alternadas con un tinte tenue de la marca (`rowAlt = mix(blanco, primario, 6%)`): apenas perceptible, para guiar la vista sin competir con los datos.
- Formatos numéricos por columna (moneda, porcentaje, fecha).
- Fila de totales con el color primario.
- Pie con usuario generador y timestamp: trazabilidad de quién sacó qué dato y cuándo.
- **Streaming** para reportes grandes: 50.000 filas no caben cómodamente en memoria.

### 9.3 PDF

Se renderiza con Chromium headless. Es el único motor que garantiza fidelidad tipográfica y de degradados del whitelabel en cualquier entorno. El HTML es autocontenido, con `@page` para A4 y márgenes, y pie legal fijo con numeración.

**Sanitización de membrantes.** `document_header` y `document_footer` los edita el administrador de la empresa: son entrada no confiable. `sanitizeBrandHtml()` aplica una *allow-list* de etiquetas y propiedades CSS. Sin esto, un `<script>` o un `onerror` en el membrete sería un **XSS almacenado** ejecutado contra nuestros propios operadores cada vez que abren el PDF. Se eliminan además `<iframe>`, `<object>`, `<form>`, handlers `on*` y esquemas `javascript:`/`data:`.

Los gráficos embebidos en el PDF se validan como SVG bien formado antes de inyectarse, con los colores del inquilino ya aplicados por quien los genera.

---

## 10. Seguridad

### 10.1 Defensa en profundidad

| Capa | Control |
|---|---|
| Red | WAF, rate limiting por IP y por usuario, TLS 1.3 |
| Autenticación | OAuth 2.0 + PKCE, validación completa del `id_token` |
| Sesión | Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, rotación tras login |
| Autorización | RBAC por permiso + alcance por depósito |
| Aislamiento | RLS con `FORCE` + verificación de contexto por request |
| Datos | Cifrado de CRT/KEY con AES-256-GCM, clave en KMS |
| Entrada | Validación de esquema (Zod) en todo borde |
| Salida | Sanitización de HTML, escape en plantillas, CSP estricto |
| Auditoría | `audit.events` con hash chain, append-only |

### 10.2 Mapeo OWASP Top 10

| Riesgo | Mitigación |
|---|---|
| **A01 Broken Access Control** | RLS `FORCE` como barrera de motor; RBAC por permiso; el `tenant_id` se deriva de la sesión, nunca del cliente; discrepancia de header → log crítico. |
| **A02 Cryptographic Failures** | AES-256-GCM para claves privadas; TLS 1.3; tokens de tracking hasheados; PIN/tokens nunca en logs. |
| **A03 Injection** | Consultas parametrizadas exclusivamente; serializador XML con escape defensivo; `TextEncoder` en CDATA para Token/Sign; sanitización de membrantes. |
| **A04 Insecure Design** | Fail-closed por defecto; máquina de estados explícita; inmutabilidad fiscal a nivel de política; sin contexto → cero filas. |
| **A05 Security Misconfiguration** | Rol de aplicación sin `BYPASSRLS` ni superuser; `search_path` fijado en funciones `SECURITY DEFINER`; CSP restrictivo; headers de seguridad. |
| **A06 Vulnerable Components** | Dependencias con lockfile y escaneo en CI; auditoría de licencias. |
| **A07 Auth Failures** | Sin contraseñas propias; PKCE; rate limit en el endpoint de auth; validación de `hd` para Workspace. |
| **A08 Integrity Failures** | Hash chain en auditoría; logs append-only; artefactos firmados; `idempotency_key` en emisión fiscal. |
| **A09 Logging Failures** | `audit.events` completo + `afip_request_log`; `requestId` propagado; eventos de seguridad de severidad crítica con alerta. |
| **A10 SSRF** | Las llamadas salientes se limitan a endpoints de AFIP y Google desde una allow-list; URLs de logos validados contra esquema y host. |

### 10.3 Controles específicos de multiempresa

1. **Nunca confiar en el cliente para el inquilino.** Sin header, sin query param, sin campo en el body.
2. **Validar la membresía antes de setear el contexto.** Primero se comprueba el acceso, después se abre la puerta.
3. **Verificar el contexto aplicado.** Tras `set_tenant_context`, se lee `current_setting` y se compara. Si no coincide, se aborta la transacción.
4. **`FORCE` RLS.** Sin esto, el owner de la tabla no está alcanzado por las políticas.
5. **`security_invoker` en todas las vistas.** Una vista sin esto es una fuga esperando.
6. **Registrar los intentos de cruce.** Un `X-Tenant-Id` que no coincide con la sesión no se ignora en silencio: se registra como evento crítico. Puede ser un bug o puede ser un ataque, y en ambos casos hay que saberlo.
7. **Tests de aislamiento en CI.** El pipeline incluye pruebas que, *autenticadas como empresa A*, intentan leer y escribir datos de la empresa B en cada tabla, y **deben fallar**. Es la única forma de verificar que RLS siga cubriendo las tablas nuevas.

### 10.4 Funciones `SECURITY DEFINER`

`app.is_member_of()` y `app.has_permission()` son `SECURITY DEFINER` para poder consultar `memberships` desde dentro de una política sin depender de los privilegios del invocador. Esto exige cuidado: una función `SECURITY DEFINER` mal escrita es una escalada de privilegios. Controles aplicados:

- `SET search_path = app, pg_temp` fijado en la definición. Sin esto, un atacante puede crear un objeto en un schema anterior del `search_path` y lograr que la función lo invoque con privilegios elevados.
- `REVOKE EXECUTE ... FROM PUBLIC` y `GRANT` sólo a `control_app`.
- Sólo leen, nunca escriben.

---

## 11. Estructura del repositorio

```
Control/
├── README.md
├── .github/
│   └── workflows/
│       └── ci.yml                                # 12 jobs: migraciones, lint RLS, aislamiento, contable, compras, tesorería, fiscal, ventas, typecheck, frontend, unit, secretos
├── db/
│   ├── migrations/
│   │   ├── 0001_extensions_and_helpers.sql    # Extensiones, tipos, helpers de sesión
│   │   ├── 0002_tenancy_and_identity.sql      # Tenants, branding, users, membresías, RBAC
│   │   ├── 0003_catalog_and_stock.sql         # Clientes, catálogo, depósitos, stock
│   │   ├── 0004_sales_and_afip.sql            # Ventas, comprobantes, credenciales AFIP
│   │   ├── 0005_logistics_and_tracking.sql    # Transporte, envíos, tracking, POD
│   │   ├── 0006_rls_policies.sql              # ★ Políticas RLS de aislamiento
│   │   ├── 0007_hardening_and_audit.sql       # Roles, grants, auditoría, lógica de stock
│   │   ├── 0008_rls_partition_coverage.sql    # ★ RLS en particiones + aserción de cobertura
│   │   ├── 0009_partition_maintenance.sql     # Creación de particiones con RLS heredado
│   │   ├── 0010_job_ledger.sql                # Ledger de tareas programadas
│   │   ├── 0011_job_runner_grants.sql         # Permisos del runner de jobs
│   │   ├── 0012_accounting_core.sql           # Núcleo contable: plan de cuentas, asientos, períodos
│   │   ├── 0013_automatic_entries.sql         # Asientos automáticos desde hechos operativos
│   │   ├── 0014_purchasing_and_payables.sql   # Compras y cuentas por pagar
│   │   ├── 0015_receivables_and_collections.sql # Cobros, imputaciones, cuentas por cobrar
│   │   ├── 0016_cash_bank_and_checks.sql      # Caja, banco y cheques
│   │   ├── 0017_fiscal_foundation.sql         # Vocabulario fiscal neutral, alícuotas con vigencia
│   │   ├── 0018_vat_determination.sql         # Determinación de IVA
│   │   ├── 0019_tax_documents.sql             # Comprobantes fiscales propios
│   │   ├── 0020_fiscal_catalog_fk.sql         # FK al catálogo fiscal
│   │   ├── 0021_delivery_notes.sql            # ★ Remito: documento propio + facturación parcial
│   │   ├── 0022_customer_returns.sql          # ★ Devolución: revierte stock + nota de crédito
│   │   ├── 0023_price_lists_validity_and_tiers.sql # ★ Precio por lista con vigencia y escalas
│   │   ├── 0024_variants_barcode_nullable_unique.sql # Fix: dos variantes sin código de barras
│   │   └── 0025_quotes_with_validity.sql      # ★ Cotización: oferta con validez y vencimiento
│   └── seed/
│       └── 0001_system_catalog.sql            # Permisos, roles de sistema, plantillas
├── apps/
│   ├── api/
│   │   ├── package.json / tsconfig.json       # Cada workspace declara su typecheck; el tsconfig raíz es el índice
│   │   └── src/
│   │       ├── jobs/
│   │       │   ├── job-runner.ts              # ★ Runner con ledger, modo plataforma, 7 jobs
│   │       │   ├── scheduler.ts               # Interpretación de cadencias cron
│   │       │   ├── worker.ts                  # Arranque del worker
│   │       │   ├── scheduler.test.ts          # Tests unitarios del scheduler
│   │       │   └── job-catalog.test.ts        # Catálogo de jobs ↔ cadencia declarada
│   │       ├── modules/
│   │       │   ├── tenancy/
│   │       │   │   └── tenant-context.service.ts   # ★ Contexto, middleware, guards
│   │       │   ├── afip/
│   │       │   │   ├── wsaa.client.ts              # Autenticación AFIP (TRA, CMS, TA)
│   │       │   │   └── wsfe.client.ts              # Emisión de CAE (FECAESolicitar)
│   │       │   ├── fiscal/
│   │       │   │   ├── fiscal-driver.ts            # Contrato neutral multi-país
│   │       │   │   └── drivers/
│   │       │   │       └── afip.driver.ts          # Implementación AFIP del contrato
│   │       │   └── exports/
│   │       │       └── report.service.ts           # XLSX/PDF con identidad dinámica
│   │       └── realtime/
│   │           └── tracking.service.ts             # WS/SSE, bus por tenant, máquina de estados
│   └── web/
│       ├── package.json / tsconfig.json / next.config.ts
│       └── src/
│           ├── rutas.ts                       # ★ El mapa de ventanas: fuente del menú, de las guardas y de los tests
│           ├── rutas.test.ts                  # ★ Suite del mapa: permisos, duplicados y página por ventana
│           ├── empresa.ts                     # Empresas de demostración (F2 las reemplaza por la sesión)
│           ├── app/
│           │   ├── layout.tsx                 # Raíz: tokens, tipografía, estilos
│           │   └── e/[slug]/
│           │       ├── layout.tsx             # ★ La carcasa
│           │       └── <ventana>/page.tsx     # 14 ventanas, una ruta cada una
│           ├── componentes/                   # Carcasa, barra lateral, menú móvil, migas, iconos
│           └── estilos/globals.css            # @theme: el puente entre los tokens y Tailwind
├── packages/
│   ├── tokens/                                # ★ Sistema de diseño: la fuente única del color
│   │   ├── src/                               # escalas, roles, contraste, derivación, verificación
│   │   ├── src/*.test.ts                      # Suite de contraste, con pruebas negativas
│   │   └── generated/                         # tokens.css · theme.ts · tokens.json (commiteados)
│   └── ui/                                    # ★ Componentes sin lógica de negocio
│       └── src/                               # Botón, Tarjeta, Insignia, Esqueleto, EstadoVacio…
├── tests/
│   ├── _apply_migrations.mjs                   # Aplica la cadena completa sobre base limpia
│   ├── isolation/                              # ★ Aislamiento multi-tenant (descubre tablas desde pg_class)
│   ├── accounting/                             # Invariantes contables
│   ├── purchasing/                             # Invariantes de compras y CxP
│   ├── treasury/                               # Invariantes de cobros y tesorería
│   ├── fiscal/                                 # Determinación de IVA
│   └── sales/                                  # ★ Puertas de E6: remito en partes (V-2) y devolución (V-3)
├── scripts/
│   ├── push.sh                                 # Push a GitHub sorteando el helper GUI de Windows
│   └── verify-isolation.ps1                    # Verificación completa en Windows
├── tools/
│   ├── validate-workflow.mjs                   # Validador estructural del CI
│   ├── check-suite-sql.mjs                     # Valida el SQL embebido en las suites
│   ├── check-migration-order.mjs               # Referencias FK hacia adelante
│   ├── check-composite-fks.mjs                 # FK compuesta sin UNIQUE / FK simple a tabla con tenant_id
│   ├── check-partitioned-tables.mjs            # PK/UNIQUE en particionadas sin la clave de partición
│   ├── check-token-literals.mjs                # ★ Sin colores, tipografías ni tamaños escritos a mano
│   └── check-workspace-typecheck.mjs           # ★ Todo workspace declara cómo se chequea
├── docs/
│   ├── PLAN-PRODUCCION.md                      # Plan a producción multinacional
│   ├── PLAN-ERP-MULTIEMPRESA.md                # Plan de evolución a ERP multiempresa
│   ├── PLAN-FRONTEND-PRODUCCION.md             # ★ Frontend de producción: sistema de diseño y ventanas
│   └── adr/                                    # ADR 0001–0006 (decisiones irreversibles)
└── prototype/
    └── index.html                              # Prototipo de diseño, reemplazado por apps/web
```

### Archivos clave

| Archivo | Qué contiene |
|---|---|
| [`db/migrations/0006_rls_policies.sql`](db/migrations/0006_rls_policies.sql) | Las políticas RLS. Es el archivo que materializa el aislamiento. |
| [`db/migrations/0007_hardening_and_audit.sql`](db/migrations/0007_hardening_and_audit.sql) | Roles de DB, `set_tenant_context`, auditoría con hash chain, `apply_stock_movement`. |
| [`db/migrations/0008_rls_partition_coverage.sql`](db/migrations/0008_rls_partition_coverage.sql) | RLS en particiones (`apply_partition_rls`) y `assert_rls_coverage()`. |
| [`db/migrations/0009_partition_maintenance.sql`](db/migrations/0009_partition_maintenance.sql) | `ensure_month_partition()`: crear particiones sin perder el aislamiento. |
| [`db/migrations/0010_job_ledger.sql`](db/migrations/0010_job_ledger.sql) | Ledger de jobs, `begin_job_run`, `finish_job_run`, `v_job_health`. |
| [`apps/api/src/jobs/job-runner.ts`](apps/api/src/jobs/job-runner.ts) | Runner con ledger, cierre garantizado y verificación de modo plataforma. |
| [`apps/api/src/modules/tenancy/tenant-context.service.ts`](apps/api/src/modules/tenancy/tenant-context.service.ts) | `withTenant()`, middleware HTTP, guard de permisos. |
| [`apps/api/src/modules/afip/wsaa.client.ts`](apps/api/src/modules/afip/wsaa.client.ts) | TRA, firma CMS, login, cache y lock del TA. |
| [`apps/api/src/modules/afip/wsfe.client.ts`](apps/api/src/modules/afip/wsfe.client.ts) | Catálogos AFIP, armado del request, emisión, recuperación. |
| [`apps/api/src/modules/fiscal/fiscal-driver.ts`](apps/api/src/modules/fiscal/fiscal-driver.ts) | Contrato neutral para el motor fiscal multi-país. |
| [`apps/api/src/realtime/tracking.service.ts`](apps/api/src/realtime/tracking.service.ts) | Bus por tenant, SSE/WS, backpressure, máquina de estados. |
| [`apps/api/src/modules/exports/report.service.ts`](apps/api/src/modules/exports/report.service.ts) | Contraste WCAG, sanitizador, motor de temas, XLSX y PDF. |
| [`tests/isolation/run.mjs`](tests/isolation/run.mjs) | Suite de aislamiento: cobertura, lectura, escritura, fail-closed, ledger. Con guardia de rol. |
| [`scripts/verify-isolation.ps1`](scripts/verify-isolation.ps1) | Ciclo completo en Windows: migra, crea el rol de aplicación, corre lint, suite y prueba negativa. |
| [`prototype/index.html`](prototype/index.html) | Prototipo funcional. Abrir en el navegador. |

---

## 12. Puesta en marcha

### 12.1 Base de datos

```bash
# PostgreSQL 16 o superior (requiere security_invoker en vistas: PG 15+)
createdb control

# Las migraciones se aplican en orden. La 0008 falla a propósito si la
# cobertura RLS quedó incompleta, así que actúa como verificación al final.
for f in $(ls db/migrations/*.sql | sort); do
  psql -d control -v ON_ERROR_STOP=1 -f "$f"
done

psql -d control -v ON_ERROR_STOP=1 -f db/seed/0001_system_catalog.sql
```

`ON_ERROR_STOP=1` no es opcional: sin él, `psql` continúa después de un error y las migraciones quedan aplicadas **a medias sin avisar**. Es el peor modo de falla posible, porque el esquema parece migrado y las mediciones posteriores miden otra cosa.

**En Windows**, la misma operación en PowerShell nativo (el `for f in $(ls ...)` de arriba es sintaxis de bash y PowerShell no la interpreta):

```powershell
Get-ChildItem -Path "db\migrations\*.sql" | Sort-Object Name | ForEach-Object {
  Write-Host "=== $($_.Name) ==="
  psql -d control -v ON_ERROR_STOP=1 -f $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Falló $($_.Name)" }
}
```

O directamente el script que hace todo el ciclo, incluida la verificación:

```powershell
# Consola ELEVADA. Crea la base, migra, crea el rol de aplicación,
# corre el lint, la suite y la prueba negativa de la guardia de rol.
powershell -ExecutionPolicy Bypass -File scripts/verify-isolation.ps1
```

### 12.2 Usuario de aplicación

El rol de login se crea **después de migrar** —depende de `control_app`, que nace en la migración `0007`— y con credenciales del gestor de secretos:

```sql
-- La contraseña va en el secret manager, nunca en el repositorio
CREATE ROLE app_login LOGIN PASSWORD :'app_password' NOBYPASSRLS IN ROLE control_app;
```

`NOBYPASSRLS` se declara explícitamente aunque sea el valor por defecto, porque es la propiedad de la que depende que **toda** la verificación de aislamiento signifique algo. Un rol con `BYPASSRLS` —o el superusuario— ignora las políticas RLS incluso cuando las tablas tienen `FORCE ROW LEVEL SECURITY`. Ver §12.4.

Un login creado con `IN ROLE control_app` **sí** hereda los privilegios del rol al conectar: el `NOINHERIT` que lleva `control_app` afecta a la propagación *desde* él, no a la membresía *hacia* él. El login debe quedar con el `INHERIT` por defecto (no agregarle `NOINHERIT`).

### 12.3 Verificar el aislamiento

Prueba manual del aislamiento. Dos transacciones, dos inquilinos:

```sql
-- Sesión 1: inquilino A
BEGIN;
SELECT app.set_tenant_context(
  '<tenant-A-uuid>'::uuid,
  '<user-A-uuid>'::uuid
);
SELECT count(*) FROM app.products;   -- sólo productos de A
COMMIT;

-- Sesión 2: inquilino B
BEGIN;
SELECT app.set_tenant_context('<tenant-B-uuid>'::uuid, '<user-B-uuid>'::uuid);
SELECT count(*) FROM app.products;   -- sólo productos de B, sin intersección
COMMIT;

-- Sesión 3: SIN contexto — debe devolver 0, no la tabla completa
SELECT count(*) FROM app.products;

-- Sesión 4: intento de escritura cruzada — debe fallar
BEGIN;
SELECT app.set_tenant_context('<tenant-A-uuid>'::uuid, '<user-A-uuid>'::uuid);
INSERT INTO app.products (tenant_id, sku, name)
VALUES ('<tenant-B-uuid>', 'HACK-001', 'Intento de cruce');
-- ERROR: new row violates row-level security policy for table "products"
ROLLBACK;
```

La prueba 3 es la más importante: **sin contexto debe devolver cero filas**, no todas. Un sistema que devuelve todo cuando falta el contexto tiene una fuga en el caso de error, que es exactamente cuando ocurre.

### 12.4 Suite automatizada de aislamiento

La verificación manual sirve para entender el mecanismo; la suite automatizada es la que protege el sistema en cada cambio:

```bash
node tests/isolation/run.mjs \
  --dsn       "postgres://app_login:...@host:5432/control" \
  --admin-dsn "postgres://postgres:...@host:5432/control" \
  --verbose
```

**Las dos conexiones son deliberadas, y cambiarlas rompe lo que la suite mide.**

| Conexión | Rol | Para qué |
|---|---|---|
| `--dsn` | Aplicación: miembro de `control_app`, **sin** `BYPASSRLS` | Conduce las pruebas de aislamiento. Es el único rol con el que el resultado significa algo. |
| `--admin-dsn` | Plataforma | Prepara y limpia el escenario: crea inquilinos y purga `audit.events`. |

Por qué la preparación necesita un rol distinto: `control_app` no tiene `INSERT` sobre `app.tenants` ni `app.memberships` —sus políticas exigen `is_platform_admin()`— y `audit.events` lleva una política `RESTRICTIVE USING (false)` que hace que un `DELETE` con rol de aplicación afecte **0 filas sin lanzar error**. Con una sola conexión, la limpieza no limpiaba y el escenario se ensuciaba entre corridas, en silencio.

> **El superusuario ignora RLS. Siempre.** Ni `FORCE ROW LEVEL SECURITY` lo detiene: `FORCE` existe para que el *owner* de la tabla también quede sujeto a las políticas, pero no alcanza al superusuario ni a un rol con `BYPASSRLS`. Si la suite corriera con un DSN de superusuario, leería las filas de todos los inquilinos y las aserciones de fuga darían falso —tanto con las políticas bien como con las políticas rotas—. El pipeline de CI **tenía este defecto**: usar el DSN de superusuario y nunca ejercitar una sola política.

Para que eso no pueda repetirse, la suite tiene una **guardia de rol** que corre antes de tocar nada y aborta con exit 2 si detecta un rol privilegiado o uno que no sea miembro de `control_app`. Consulta `pg_has_role(current_user, 'control_app', 'MEMBER')` en vez de comparar contra un nombre, así funciona con cualquier login.

**Prueba negativa obligatoria**: correr la suite con el DSN de superusuario **debe** abortar.

```bash
node tests/isolation/run.mjs --dsn "postgres://postgres:...@host:5432/control"
# exit 2 — ABORTADO: la suite se conectó como `postgres`, que es superusuario...
```

Si esa corrida pasa en verde, la guardia está rota y el aislamiento no se está probando. El job `isolation` del CI ejecuta esta prueba negativa en cada PR, precisamente para que la guardia no pueda degradarse sin que nadie lo note.

La suite **descubre las tablas desde `pg_class`** y los esquemas desde `pg_namespace` —no desde una lista escrita a mano, que se desactualiza en silencio—. Para cada tabla con `tenant_id` verifica:

| Grupo | Verificación |
|---|---|
| **A · Cobertura** | `FORCE RLS` activo, al menos una política, ninguna política permisiva con `USING (true)`, y cada partición con su propia cobertura. |
| **B · Lectura** | Con contexto de A, cero filas de B. Y A sí ve las suyas — un filtro demasiado agresivo también es un bug. |
| **C · Escritura** | `UPDATE`/`DELETE` sobre filas ajenas afectan 0 filas; `INSERT` con `tenant_id` ajeno y reasignación de una fila propia a otro inquilino fallan por `WITH CHECK`. |
| **D · Fail-closed** | Sin contexto, cero filas en todas las tablas. Además comprueba que un `SET` sin `LOCAL` no deja el inquilino pegado en la conexión. |
| **E · Aserción** | `app.assert_rls_coverage()` existe y pasa sobre el esquema actual. |
| **F · Ledger de jobs** | `ops.jobs` y `ops.job_runs` existen, el catálogo está poblado, `ops` no tiene `tenant_id`, el índice único rechaza dos ejecuciones vivas del mismo job, `begin_job_run` devuelve `NULL` cuando ya hay una viva y `finish_job_run` es idempotente. Además comprueba que la aplicación **no** puede escribir el ledger. |

La suite corre en CI sobre una base migrada desde cero en cada PR ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), con `app_login` para probar y `postgres` sólo para migrar. Junto con `tests/isolation/lint_rls_coverage.sql`, materializa el criterio **F0-AC2** del plan: *un PR con una tabla nueva sin política RLS falla el pipeline antes de que lo vea un revisor.*

Para validar el SQL embebido en la suite sin un motor disponible (hay comentarios y bloques largos dentro de template literals, que `node --check` no inspecciona):

```bash
node tools/check-suite-sql.mjs tests/isolation/run.mjs
```

### 12.5 Frontend

```bash
npm install                     # instala los cuatro workspaces
npm run dev:web                 # servidor de desarrollo en http://localhost:3000
npm run build --workspace @control/web
```

La raíz redirige a `/e/andes/panel`. Hay tres empresas de demostración, y cambiar de una a otra **cambia el menú**: `andes` es propietaria y ve las catorce ventanas, `pampa` es encargada de depósito y ve cinco, y `nordico` tiene la logística desactivada, así que esa ventana no existe para ella ni por URL.

**Cambiar un color del sistema.** Se edita el ancla en `packages/tokens/src/escalas.ts` —es lo único que se escribe a mano— y después:

```bash
npm run tokens                  # regenera tokens.css, theme.ts y tokens.json
npm test --workspace @control/tokens   # vuelve a medir los 38 pares de contraste
```

**Las puertas que protegen el sistema:**

| Comando | Qué impide |
|---|---|
| `npm run verify:tokens` | Un color, una tipografía o un tamaño escritos a mano |
| `npm run verify:tokens-sync` | Que los artefactos generados se separen de su fuente |
| `npm run verify:typecheck-coverage` | Un workspace que nadie verifica |
| `npm test --workspace @control/web` | Una ventana en el menú sin su página, un permiso inexistente, una ruta repetida |
| `npm test --workspace @control/contracts` | Un enum del contrato que no coincide con `pg_enum`, un dato simulado que no cumple su esquema |
| `npm test --workspace @control/contracts` | Un recuento que ajuste el saldo sin escribir el libro, una transferencia que pise una edición ajena (bloqueo optimista), una conciliación que no vea la diferencia |
| `npm run verify:permissions` | Una ventana del mapa cuyo permiso no existe en el catálogo SQL, un permiso sembrado que el frontend no declara, un código que no respeta `resource.action` |
| `npm test --workspace @control/contracts` | Un período que acepte asientos después de cerrado, una reapertura sin motivo, un cierre con asientos en borrador |
| `npm test --workspace @control/contracts` | Un envío entregado sin fecha de entrega, 200 envíos con más de una conexión SSE, un tracking público que publique el nombre del cliente |
| `npm run verify:textos` | Una cadena de interfaz nueva escrita en un componente, o un archivo que ya estaba en la línea base y suma textos |
| `npm test --workspace @control/tokens` | Una paleta de inquilino que deje la tinta por debajo de AA, una plantilla con la geometría fuera de rango, una combinación plantilla × paleta que no cierre |

**El sistema de datos (F3).** `packages/contracts` define los esquemas Zod que reflejan los `pg_enum` del motor; la suite `enums-sync` los compara contra las migraciones de `db/` en ambos sentidos, así el contrato y la base no pueden diverger. `apps/web` consume datos por medio de `ApiClient`: en F3 es `SimuladoCliente` (resuelve en proceso y valida cada respuesta con Zod en el borde); con `NEXT_PUBLIC_API_MODE=http` se conecta al `HttpCliente` real contra `/api/v1` sin tocar un componente. El estado de cada ventana (filtro, página, orden) vive en la URL, no en estado cliente, de modo que recargar restaura la vista (regla A12).

### 12.6 Prototipo

`prototype/index.html` es el prototipo de diseño que `apps/web` reemplaza. Se conserva como referencia de los gráficos SVG y del switcher de empresa. Abrirlo en cualquier navegador: no requiere build ni servidor.

---

## 13. Roadmap

| Fase | Alcance |
|---|---|
| **1 · Cimientos** | Migraciones, RLS, tenancy middleware, Google SSO, RBAC, suite de tests de aislamiento en CI. |
| **2 · Comercial** | Catálogo con variantes y listas de precios, órdenes de venta, cobranzas, depósitos y stock. |
| **3 · Fiscal** | WSAA + WSFE en homologación, cola de reintentos, generación de PDF con identidad, notas de crédito. |
| **4 · Logística** | Envíos, torre de control, app del conductor offline-first, POD del cliente, SSE/WS. |
| **5 · Escala** | Dashboard con métricas en vivo, exportaciones masivas, plantillas por rubro, auditoría con hash chain. |
| **6 · Producto** | Alta autoservicio, planes y facturación de la plataforma, panel de soporte con impersonación auditada, onboarding guiado. |

### Pendientes conocidos

Estos puntos están identificados y no resueltos en esta entrega:

- **Firma CMS.** `signTra()` valida el par certificado/clave y calcula el digest, pero la construcción DER completa del `SignedData` está delegada a `./cms.ts` (no incluido). En producción usar `node-forge` o un binding a OpenSSL: implementar ASN.1 a mano es correcto pero verboso y con alta superficie de error.
- **Generación de PDF.** `PdfExportService` produce el HTML completo con la identidad aplicada; falta el *renderer* con Chromium headless (Playwright).
- **Definición de rutas HTTP.** Los servicios están implementados con sus dependencias inyectadas; resta el cableado de los handlers de Fastify.
- **Tests de integración** contra AFIP homologación con un CUIT de prueba.
- **Frontend de producción.** **F1 · Fundaciones**, **F2 · Identidad y acceso**, **F3 · Sistema de datos**, **F4 · Operación diaria**, **F5 · Inventario**, **F6 · Finanzas**, **F7 · Logística** y **F8 · Gobierno, marca y plataforma** están hechas: el sistema de diseño en `packages/tokens` (con las **4 paletas de inquilino** y las **5 plantillas** verificadas contra AA), los componentes base en `packages/ui`, `packages/contracts` (esquemas Zod espejo de `pg_enum`, más la lógica pura de la cadena de ventas, de inventario, del cierre de período y de logística), `apps/web` con la carcasa, las catorce ventanas, la sesión (ingreso SSO/credenciales + 2FA, recuperación, invitación, selector de empresa, impersonación), el `ApiClient` con adaptador simulado validado en el borde, la `DataTable` con los cinco estados y los filtros en URL, y las ventanas **Catálogo**, **Panel**, **Ventas**, **Facturación**, **Stock**, **Compras**, **Tesorería**, **Contabilidad** (con **Períodos**, donde el cierre se ve reflejado), **Fiscal**, **Logística** (con su **torre de control** en vivo) y **Configuración** (con el tema aplicado sin recargar) cableadas de punta a punta, más el **tracking público** `/t/[token]`, la **PWA del conductor** `/chofer` y la **consola de plataforma** `/plataforma/empresas`. F5 trajo el primer camino de **escritura** del frontend sobre el adaptador simulado; F6 cerró el hueco del RBAC (**51 permisos en 16 recursos**, con aserción en la base y el gate `verify:permissions`); F7 trajo el **canal de tiempo real** (una sola conexión SSE por pestaña, multiplexada por tópico); y F8 trajo el **lint de textos** (`verify:textos`), con trinquete: ninguna cadena de interfaz nueva queda en un componente sin que el gate lo note. Falta **F9 · Producción** según [`docs/PLAN-FRONTEND-PRODUCCION.md`](docs/PLAN-FRONTEND-PRODUCCION.md), que también lleva el catálogo de ~90 endpoints que el frontend necesita del backend. (Las sub-rutas de detalle de las 15 ventanas de Ventas y las 5 de Facturación quedan como seguimiento dentro de F4; las 5 de Catálogo y `transferencias/nueva` dentro de F5; las 33 de Compras, Tesorería, Contabilidad y Fiscal dentro de F6; las 8 de Logística y `chofer/entrega/[id]` dentro de F7; y las ventanas Equipo, Auditoría y Tareas —con sus sub-rutas— dentro de F8. En los cinco casos la base operable y las reglas de su puerta ya están.)
- **Reconciliación de stock.** El job `stock.reconciliation` está implementado en `job-runner.ts` (cron `30 4 * * *`) y **reporta sin autocorregir**: la divergencia es un síntoma y no se puede saber cuál de las dos vistas es la equivocada. Queda pendiente decidir si la diferencia debe generar una alerta además de quedar en el ledger.
- **Scheduler de infraestructura.** El ledger y el runner están implementados; falta el disparador externo (Kubernetes CronJob o el servicio gestionado que se elija) que invoque cada job según `JOB_SCHEDULE`. Mientras tanto, los jobs se pueden ejecutar a mano y quedan registrados igual.
- **Alertas de jobs atrasados.** `ops.v_job_health` expone `is_overdue`, pero falta conectar esa vista al sistema de alertas.

### Resuelto en esta entrega

- **Aislamiento RLS en tablas particionadas.** Las políticas declaradas sólo sobre el padre no alcanzaban a las particiones. Corregido en `0008`, con la barrera `assert_rls_coverage()` que falla el build ante cualquier tabla nueva sin política, y `0009` para que las particiones futuras nazcan protegidas. Ver [§3.5](#35-tablas-particionadas-las-políticas-no-se-heredan).
- **Mantenimiento de particiones y alerta de certificados sin invocación.** `0010` e `0011` crean el ledger de jobs y sus permisos; `job-runner.ts` los ejecuta con garantía de cierre. Ver [§3.7](#37-tareas-programadas-el-ledger-y-por-qué-existe).
- **La suite de aislamiento no probaba el aislamiento.** Se conectaba con un único DSN y nunca hacía `SET ROLE`: con un rol de superusuario —el caso normal, y el que usaba el propio CI— PostgreSQL ignora RLS aun con `FORCE ROW LEVEL SECURITY`, así que las aserciones de fuga daban falso en ambos sentidos. Ahora la suite exige un rol de aplicación (guardia que aborta con exit 2), recibe una segunda conexión administrativa para preparar el escenario, y el CI ejecuta una **prueba negativa** que verifica que la guardia efectivamente aborte. Ver [§12.4](#124-suite-automatizada-de-aislamiento).
- **La limpieza del escenario no limpiaba.** `setup()` usaba `SET LOCAL app.platform_admin = 'on'` suelto y borraba `audit.events` con un rol sin privilegios: la política `RESTRICTIVE USING (false)` hacía que el `DELETE` afectara 0 filas **sin lanzar error**. Ahora la preparación va por la conexión administrativa, con el camino validado `app.set_tenant_context(NULL, NULL, true)`, y el escenario se verifica antes de correr las pruebas.
- **Descubrimiento de esquemas unificado.** La suite y el lint usaban listas de esquemas fijas (`app`, `billing`, `logistics`, `audit`) mientras `assert_rls_coverage()` los descubre desde `pg_namespace`. Un esquema nuevo con datos de inquilino habría quedado sin cubrir por las tres herramientas a la vez. Los tres usan ahora el mismo criterio dinámico.
- **El remito no existía como documento y se podía facturar dos veces.** La migración `0021` (ADR `0006`) agrega `billing.delivery_notes` + `delivery_note_items` con `qty_invoiced`, y `billing.invoice_delivery_note()` factura en partes sin duplicar ni exceder lo despachado. El gate V-2 de E6 se **mide** en `tests/sales/run.mjs` y corre en el job `sales` del CI. Ver [§3.10](#310-el-remito-y-la-facturación-parcial-gate-v-2).
- **La devolución de cliente no existía como documento.** La migración `0022` (ADR `0006`) agrega `billing.customer_returns` + `customer_return_items` y `billing.apply_customer_return()`, que revierte el stock con un `return_in` trazable y emite la nota de crédito sin permitir devolver de más ni dos veces. El gate V-3 se mide en `tests/sales/run.mjs`. Ver [§3.11](#311-la-devolución-y-la-nota-de-crédito-gate-v-3).
- **El precio no tenía vigencia ni escalas, y cambiarlo reescribía el pasado.** La migración `0023` (ADR `0006`) agrega vigencia y escalas por cantidad a `app.price_list_items` y `app.price_for()`, con una `EXCLUDE` que impide dos escalas solapadas y un `UNIQUE` parcial que admite una sola lista por defecto. El gate V-4 se mide en `tests/sales/run.mjs`. Ver [§3.12](#312-listas-de-precios-con-vigencia-y-escalas-por-cantidad-gate-v-4).
- **Una empresa no podía tener dos variantes sin código de barras.** `0003` declaró `UNIQUE NULLS NOT DISTINCT (tenant_id, barcode)` sobre una columna **opcional**: con `NULLS NOT DISTINCT`, NULL cuenta como un valor y la segunda variante sin EAN era rechazada — mientras el índice parcial `idx_variants_barcode ... WHERE barcode IS NOT NULL` de la línea siguiente expresaba la intención contraria. Corregido en `0024` con `UNIQUE (tenant_id, barcode)` a secas. Es una relajación: admite filas antes rechazadas y no invalida ninguna existente.
- **La cotización con validez no existía, y era el último documento de E6.** La migración `0025` (ADR `0006`) agrega `billing.quotes` + `quote_items` con ciclo `draft → issued → accepted`, `add_quote_item()` que resuelve el precio desde la lista, y `accept_quote()` que **rechaza una oferta vencida** exigiendo reconfirmarla. El vencimiento se deriva (`v_quotes.effective_status`) en vez de almacenarse, y las dos negaciones que la definen se verifican: no emite movimientos de stock —ni una reserva— ni genera asiento. El gate V-1 se mide en `tests/sales/run.mjs`. Con esto **E6 queda completo**: V-1, V-2, V-3 y V-4 medidos. Ver [§3.13](#313-la-cotización-una-oferta-que-vence-y-no-compromete-nada-gate-v-1).
- **Dos jobs del CI no podían pasar nunca, y un job rojo esconde los otros diez.** El `tsconfig.json` de la raíz declaraba `include: []` **y** `files: []`, así que `npx tsc --noEmit` —el paso que el job `typecheck` corre en la raíz— abortaba con TS18002 **antes de compilar un archivo**: fallaba siempre, sin haber mirado una línea. El job `rls-lint` fallaba por otra vía: el lint escribía en stdout el aviso del paginador, la etiqueta de comando `CREATE VIEW` y una de sus dos líneas de recordatorio, y el filtro del CI no las descartaba, así que `OUT` nunca quedaba vacío. Con los dos jobs en rojo, las ~950 verificaciones de las suites corrían y su resultado se perdía detrás de un pipeline que no decía nada del código. Corregido en `477e89e`: el `include` raíz pasó a cubrir todos los workspaces, el lint manda sus recordatorios a stderr (`\warn`) y suprime las etiquetas de comando (`\set QUIET 1`), y el paso del CI dejó de tragarse los errores de `psql` con un `|| true` —que convertía un fallo de conexión en un verde—. Los **once** jobs quedaron verificados localmente. **Ese diseño del `tsconfig` raíz duró hasta la F1 del frontend**: cubría el TypeScript que resuelve para Node, y una aplicación web necesita JSX, tipos del DOM y resolución de empaquetador. En vez de exceptuar workspaces con un `exclude` —donde el olvido vuelve a ser silencioso—, el `tsconfig` raíz pasó a ser el índice de los cuatro proyectos y la cobertura la **afirma** `tools/check-workspace-typecheck.mjs`: un workspace que no declara su `typecheck` rompe el build con el mensaje que dice qué agregar.
- **El sistema de diseño y la arquitectura de ventanas del frontend.** `packages/tokens` deriva las tres escalas de doce pasos de los tres colores indicados —con el paso del ancla exacto, no interpolado— y **mide** el contraste de los 38 pares que la interfaz usa, en los dos temas. `apps/web` tiene las **catorce ventanas** navegables, cada una con su ruta, su permiso, su grupo y sus gráficos declarados en un único mapa (`src/rutas.ts`) del que salen el menú, las guardas y los tests. Dos puertas nuevas lo protegen: `check-token-literals.mjs` rompe el build ante un color escrito a mano, y la suite del mapa rompe si una ventana del menú no tiene su página. Ver [`PLAN-FRONTEND-PRODUCCION.md`](docs/PLAN-FRONTEND-PRODUCCION.md) §3 y §4.

---

## Licencia

Proyecto privado.
