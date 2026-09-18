# Control · Plataforma Multiempresa (Multi-tenant) para Gestión Comercial, Stock y Logística

Especificación de arquitectura, esquema de base de datos con aislamiento por **Row Level Security (RLS)**, diseño de API, integración con **AFIP (WSAA + WSFE)**, motor de **whitelabel** por empresa y un **prototipo funcional** de dashboard con estética *glassmorphism*.

Diseñado para operar en Argentina, con foco en distribuidoras, comercios y operadores logísticos que necesitan facturación electrónica real, stock multidéposito y trazabilidad de entregas en tiempo real.

---

## Tabla de contenidos

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Modelo de datos y aislamiento RLS](#3-modelo-de-datos-y-aislamiento-rls) — incluye las trampas de RLS en tablas particionadas
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
    warehouses ||--o{ stock_levels : "almacena"
    warehouses ||--o{ stock_transfers : "origen y destino"

    customers ||--o{ sales_orders : "compra"
    sales_orders ||--o{ sales_order_items : "detalla"
    sales_orders ||--o{ invoices : "factura"
    invoices ||--o{ invoice_items : "detalla"
    invoices ||--o{ invoice_taxes : "desglosa IVA"
    invoices ||--o{ payments : "cobra"

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
        text idempotency_key UK
        text pdf_url
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
| `app` | `price_lists` / `price_list_items` | Listas de precios (retail/mayorista). | Sí |
| `app` | `warehouses` | Depósitos. | Sí |
| `app` | `stock_levels` | Saldo materializado por variante×depósito. | Sí |
| `app` | `stock_movements` | **Libro mayor append-only.** | Sí + no-mutate |
| `app` | `stock_transfers` / `_items` | Transferencias entre depósitos. | Sí |
| `billing` | `afip_credentials` | CRT/KEY cifrados, TA cacheado. | Sí + permiso estricto |
| `billing` | `sales_orders` / `_items` | Órdenes de venta. | Sí |
| `billing` | `invoices` | Comprobantes AFIP. **Inmutable tras CAE.** | Sí + no-mutate |
| `billing` | `invoice_items` | Líneas (snapshot fiscal). | Sí |
| `billing` | `invoice_taxes` | Desglose de IVA por alícuota. | Sí |
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

> **Regla operativa:** nunca crear una partición con `CREATE TABLE ... PARTITION OF` suelto. Usar `app.ensure_month_partition()`, que aplica la cobertura en la misma transacción. No existe ventana en la que la partición exista sin protección.

### 3.6 Vistas de monitoreo de particiones

`audit.v_default_partition_usage` expone cuántas filas cayeron en la partición `DEFAULT`. Cualquier valor mayor a cero significa que el job de mantenimiento se detuvo y los datos están entrando a un cajón sin política propia. Es una alerta temprana, no un reporte.

### 3.7 Rendimiento

- **Índices con `tenant_id` como primera columna.** `(tenant_id, created_at DESC)`. El planificador descarta el `tenant_id` en el filtro de índice y usa las siguientes columnas para ordenar, evitando un sort.
- **Índices parciales** para las consultas calientes: `WHERE status IN ('draft','queued')` sobre `invoices`, `WHERE available <= 0` sobre `stock_levels`.
- **Particionado** por rango mensual en `position_pings` (~2-5 M filas/mes en una flota mediana) y `audit.events`.
- **Filtro de fila temprano:** con RLS, PostgreSQL agrega el predicado de la política al plan. Si hay un índice sobre `tenant_id`, el costo por consulta es prácticamente el de un inquilino único.

### 3.8 Consistencia de stock

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
│       └── ci.yml                                # Migraciones, lint RLS, aislamiento, secretos
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
│   │   └── 0009_partition_maintenance.sql     # Creación de particiones con RLS heredado
│   └── seed/
│       └── 0001_system_catalog.sql            # Permisos, roles de sistema, plantillas
├── apps/
│   └── api/
│       └── src/
│           ├── modules/
│           │   ├── tenancy/
│           │   │   └── tenant-context.service.ts   # ★ Contexto, middleware, guards
│           │   ├── afip/
│           │   │   ├── wsaa.client.ts              # Autenticación AFIP (TRA, CMS, TA)
│           │   │   └── wsfe.client.ts              # Emisión de CAE (FECAESolicitar)
│           │   ├── fiscal/
│           │   │   ├── fiscal-driver.ts            # Contrato neutral multi-país
│           │   │   └── drivers/
│           │   │       └── afip.driver.ts          # Implementación AFIP del contrato
│           │   └── exports/
│           │       └── report.service.ts           # XLSX/PDF con identidad dinámica
│           └── realtime/
│               └── tracking.service.ts             # WS/SSE, bus por tenant, máquina de estados
├── tests/
│   └── isolation/
│       ├── run.mjs                             # ★ Suite de aislamiento multi-tenant
│       └── lint_rls_coverage.sql               # Lint de PR: tabla sin política
├── tools/
│   └── validate-workflow.mjs                   # Validador estructural del CI
├── docs/
│   └── PLAN-PRODUCCION.md                      # Plan a producción multinacional
└── prototype/
    └── index.html                                  # Dashboard glassmorphism funcional
```

### Archivos clave

| Archivo | Qué contiene |
|---|---|
| [`db/migrations/0006_rls_policies.sql`](db/migrations/0006_rls_policies.sql) | Las políticas RLS. Es el archivo que materializa el aislamiento. |
| [`db/migrations/0007_hardening_and_audit.sql`](db/migrations/0007_hardening_and_audit.sql) | Roles de DB, `set_tenant_context`, auditoría con hash chain, `apply_stock_movement`. |
| [`db/migrations/0008_rls_partition_coverage.sql`](db/migrations/0008_rls_partition_coverage.sql) | RLS en particiones (`apply_partition_rls`) y `assert_rls_coverage()`. |
| [`db/migrations/0009_partition_maintenance.sql`](db/migrations/0009_partition_maintenance.sql) | `ensure_month_partition()`: crear particiones sin perder el aislamiento. |
| [`apps/api/src/modules/tenancy/tenant-context.service.ts`](apps/api/src/modules/tenancy/tenant-context.service.ts) | `withTenant()`, middleware HTTP, guard de permisos. |
| [`apps/api/src/modules/afip/wsaa.client.ts`](apps/api/src/modules/afip/wsaa.client.ts) | TRA, firma CMS, login, cache y lock del TA. |
| [`apps/api/src/modules/afip/wsfe.client.ts`](apps/api/src/modules/afip/wsfe.client.ts) | Catálogos AFIP, armado del request, emisión, recuperación. |
| [`apps/api/src/modules/fiscal/fiscal-driver.ts`](apps/api/src/modules/fiscal/fiscal-driver.ts) | Contrato neutral para el motor fiscal multi-país. |
| [`apps/api/src/realtime/tracking.service.ts`](apps/api/src/realtime/tracking.service.ts) | Bus por tenant, SSE/WS, backpressure, máquina de estados. |
| [`apps/api/src/modules/exports/report.service.ts`](apps/api/src/modules/exports/report.service.ts) | Contraste WCAG, sanitizador, motor de temas, XLSX y PDF. |
| [`tests/isolation/run.mjs`](tests/isolation/run.mjs) | Suite de aislamiento: cobertura, lectura, escritura, fail-closed. |
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

### 12.2 Usuario de aplicación

El rol de login se crea fuera de las migraciones, con credenciales del gestor de secretos:

```sql
-- La contraseña va en el secret manager, nunca en el repositorio
CREATE ROLE app_login LOGIN PASSWORD :'app_password' IN ROLE control_app;
```

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
DATABASE_URL="postgres://user:pass@host:5432/control" node tests/isolation/run.mjs --verbose
```

La suite **descubre las tablas desde `pg_class`**, no desde una lista escrita a mano. Para cada tabla con `tenant_id` verifica:

| Grupo | Verificación |
|---|---|
| **A · Cobertura** | `FORCE RLS` activo, al menos una política, ninguna política permisiva con `USING (true)`, y cada partición con su propia cobertura. |
| **B · Lectura** | Con contexto de A, cero filas de B. Y A sí ve las suyas — un filtro demasiado agresivo también es un bug. |
| **C · Escritura** | `UPDATE`/`DELETE` sobre filas ajenas afectan 0 filas; `INSERT` con `tenant_id` ajeno y reasignación de una fila propia a otro inquilino fallan por `WITH CHECK`. |
| **D · Fail-closed** | Sin contexto, cero filas en todas las tablas. Además comprueba que un `SET` sin `LOCAL` no deja el inquilino pegado en la conexión. |
| **E · Aserción** | `app.assert_rls_coverage()` existe y pasa sobre el esquema actual. |

La suite corre en CI sobre una base migrada desde cero en cada PR ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Junto con `tests/isolation/lint_rls_coverage.sql`, materializa el criterio **F0-AC2** del plan: *un PR con una tabla nueva sin política RLS falla el pipeline antes de que lo vea un revisor.*

### 12.5 Prototipo

Abrir `prototype/index.html` en cualquier navegador. No requiere build ni servidor: es autocontenido. Funcionalidades demostrables:

- Switcher de empresa con cuatro inquilinos, cada uno con su paleta y densidad (el cambio de tokens es visible en toda la interfaz, gráficos incluidos).
- Gráficos SVG interactivos con tooltip (curva suavizada, dona, sparklines).
- Selección de plantilla por rubro.
- Simulación de eventos de tracking en vivo (botón e intervalo automático cada 9 s) con máquina de estados y toasts.
- Exportación simulada, mostrando qué identidad resuelve el servidor.

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
- **Frontend de producción.** El prototipo valida el diseño; falta la implementación en Next.js con componentes reutilizables.
- **Reconciliación de stock.** Se define la estructura del libro mayor; falta el job que detecta y reporta discrepancias entre `stock_levels` y la suma de `stock_movements`.
- **Job de mantenimiento de particiones.** `app.ensure_partitions_ahead()` está implementada y probada, pero falta el scheduler que la invoque mensualmente y la alerta sobre `audit.v_default_partition_usage`.

### Resuelto en esta entrega

- **Aislamiento RLS en tablas particionadas.** Las políticas declaradas sólo sobre el padre no alcanzaban a las particiones. Corregido en `0008`, con la barrera `assert_rls_coverage()` que falla el build ante cualquier tabla nueva sin política, y `0009` para que las particiones futuras nazcan protegidas. Ver [§3.5](#35-tablas-particionadas-las-políticas-no-se-heredan).

---

## Licencia

Proyecto privado.
