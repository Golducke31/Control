/**
 * Control · Tenancy · Contexto de sesión y middleware de aislamiento
 * -----------------------------------------------------------------------------
 * Este archivo es la bisagra entre la aplicación y las políticas RLS. Si algo
 * aquí está mal, TODO el aislamiento multi-tenant se cae. Vale la pena entender
 * las cuatro decisiones centrales:
 *
 *  1. El tenant NUNCA viene del cliente.
 *     No se acepta un header `X-Tenant-Id` ni un query param. El tenant se
 *     deriva de la membresía activa del usuario autenticado, validada contra la
 *     DB. Un atacante que cambie un header no puede moverse de inquilino.
 *
 *  2. `SET LOCAL`, no `SET`.
 *     `SET LOCAL` muere con la transacción. Con un pool de conexiones, un `SET`
 *     sin LOCAL queda pegado a la conexión física y el siguiente request hereda
 *     el tenant anterior: esa es la clase de bug que produce una fuga silenciosa
 *     y que tarda meses en detectarse. Cada request abre su transacción, setea
 *     contexto, opera, y hace commit o rollback.
 *
 *  3. Una transacción por request = un contexto por request.
 *     `withTenantContext` es el único punto de entrada a la DB. Está prohibido
 *     tomar una conexión del pool en otro lugar del código.
 *
 *  4. Defensa en profundidad.
 *     RLS es la barrera principal, pero además: (a) se valida la membresía antes
 *     de setear contexto, (b) se compara el tenant resuelto contra el solicitado
 *     y se registra cualquier discrepancia como evento de seguridad, (c) el rol
 *     de DB no tiene BYPASSRLS.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// =============================================================================
// Tipos de identidad
// =============================================================================
export interface AuthenticatedUser {
  userId: string;
  email: string;
  /** Empresa activa elegida en el switcher del frontend. */
  activeTenantId: string;
  /** Todas las empresas donde el usuario tiene membresía activa. */
  memberships: Array<{ tenantId: string; roleCode: string; isOwner: boolean }>;
  permissions: Set<string>;
  sessionId: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Contexto propagado por AsyncLocalStorage durante todo el request. */
export interface RequestContext {
  requestId: string;
  user: AuthenticatedUser;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'No hay contexto de request activo. Todo acceso a datos debe ocurrir dentro de runWithContext().',
    );
  }
  return ctx;
}

// =============================================================================
// Cliente de base de datos
// =============================================================================
export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Pool {
  /** Toma una conexión. El caller DEBE liberarla. */
  connect(): Promise<DbConnection>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface DbConnection extends DbClient {
  release(): void;
  /** BEGIN / COMMIT / ROLLBACK. */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

// =============================================================================
// Núcleo: ejecución con contexto de tenant
// =============================================================================
export interface WithTenantOptions {
  /** UUID de la empresa. Debe haber sido validado contra las membresías. */
  tenantId: string;
  /** UUID del usuario autenticado. */
  userId: string;
  /** Sólo para operaciones de soporte de plataforma. Requiere rol control_platform. */
  platformAdmin?: boolean;
  /** Nivel de aislamiento. REPEATABLE READ para reportes que leen varias tablas. */
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /** Reintentos ante serialization_failure. */
  retries?: number;
}

export class TenantContextService {
  constructor(
    private readonly pool: Pool,
    private readonly deps: {
      /** Verifica que el usuario sea miembro activo del tenant. */
      assertMembership(args: { userId: string; tenantId: string }): Promise<{
        roleCode: string; isOwner: boolean; isActive: boolean;
      } | null>;
      securityLog(entry: {
        kind: string;
        detail: string;
        severity: 'warning' | 'critical';
        userId?: string;
        tenantId?: string;
      }): Promise<void>;
      now?: () => number;
    },
  ) {}

  /**
   * Ejecuta `fn` dentro de una transacción con el contexto de tenant seteado.
   *
   * Invariantes que garantiza:
   *  - El contexto se setea con `set_config(..., true)` (equivalente a SET LOCAL):
   *    se revierte automáticamente al cerrar la transacción.
   *  - Si `fn` lanza, se hace ROLLBACK y se libera la conexión. Nunca queda una
   *    conexión "sucia" con el tenant de un request anterior.
   *  - Los reintentos por deadlock/serialización son seguros porque toda la
   *    operación es transaccional.
   */
  async withTenant<T>(
    opts: WithTenantOptions,
    fn: (db: DbClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = (opts.retries ?? 0) + 1;

    // --- Validación previa: la membresía se comprueba ANTES de tocar datos ---
    const membership = await this.deps.assertMembership({
      userId: opts.userId,
      tenantId: opts.tenantId,
    });

    if (!membership?.isActive) {
      await this.deps.securityLog({
        kind: 'tenancy.membership_denied',
        detail: `Usuario ${opts.userId} intentó operar sobre el tenant ${opts.tenantId} sin membresía activa`,
        severity: 'critical',
        userId: opts.userId,
        tenantId: opts.tenantId,
      });
      throw new ForbiddenTenantError(opts.tenantId, opts.userId);
    }

    // Un usuario no-owner no puede activar el modo plataforma ni por error.
    if (opts.platformAdmin && !membership.isOwner) {
      await this.deps.securityLog({
        kind: 'tenancy.illegal_platform_mode',
        detail: `Usuario ${opts.userId} intentó habilitar modo plataforma sin privilegio`,
        severity: 'critical',
        userId: opts.userId,
        tenantId: opts.tenantId,
      });
      throw new Error('Modo plataforma no autorizado para este usuario');
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const conn = await this.pool.connect();

      try {
        await conn.begin();

        if (opts.isolation && opts.isolation !== 'READ COMMITTED') {
          // Debe ejecutarse antes de la primera query de la transacción
          await conn.query(`SET TRANSACTION ISOLATION LEVEL ${opts.isolation}`);
        }

        // --- Inyección del contexto. Este es el único lugar donde se hace. ---
        await conn.query(
          `SELECT app.set_tenant_context($1::uuid, $2::uuid, $3::boolean)`,
          [opts.tenantId, opts.userId, opts.platformAdmin ?? false],
        );

        // Verificación defensiva: si por alguna razón el contexto no quedó
        // seteado, abortar antes de ejecutar la operación del negocio.
        const check = await conn.query<{ tenant_setting: string | null }>(
          `SELECT current_setting('app.tenant_id', true) AS tenant_setting`,
        );
        const applied = check.rows[0]?.tenant_setting;

        if (applied !== opts.tenantId) {
          throw new Error(
            `Contexto de tenant no aplicado. Esperado ${opts.tenantId}, obtenido ${applied ?? 'NULL'}. ` +
            'Abortando para evitar fuga de datos entre inquilinos.',
          );
        }

        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await safeRollback(conn);
        lastError = err;

        if (isRetryable(err) && attempt < maxAttempts) {
          // Backoff exponencial con jitter: evita que los reintentos de muchos
          // workers se sincronicen y vuelvan a chocar.
          const delay = Math.min(1000, 40 * 2 ** attempt) * (0.5 + Math.random());
          await sleep(delay);
          continue;
        }

        throw err;
      } finally {
        // Liberar SIEMPRE. Un `release` olvidado agota el pool en minutos.
        conn.release();
      }
    }

    throw lastError ?? new Error('withTenant falló sin error registrado');
  }

  /**
   * Ejecución sin contexto de tenant. Reservado para:
   *  - Login (resolver membresías a partir del `sub` de Google)
   *  - Jobs de plataforma
   *  - Migraciones
   * Con RLS activo, las tablas con tenant_id devuelven cero filas sin contexto:
   * esto no es un agujero, es el comportamiento fail-closed.
   */
  async withoutTenant<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    try {
      await conn.begin();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await safeRollback(conn);
      throw err;
    } finally {
      conn.release();
    }
  }
}

// =============================================================================
// Middleware HTTP
// =============================================================================
export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Query params ya parseados. */
  query: Record<string, string | undefined>;
  /** Cookies parseadas. */
  cookies: Record<string, string | undefined>;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

/**
 * Resuelve la identidad a partir de la sesión.
 *
 * Por qué NO se usa el header para el tenant:
 *   El frontend tiene un switcher de empresa, y el reflejo natural es mandar
 *   `X-Tenant-Id`. Eso convierte el aislamiento en una responsabilidad del
 *   cliente. En su lugar, la empresa activa vive en la SESIÓN del servidor: el
 *   switcher hace un POST que revalida la membresía y actualiza la sesión. El
 *   resto de los requests no transportan el tenant en absoluto.
 */
export type SessionResolver = (req: HttpRequest) => Promise<AuthenticatedUser | null>;

export class TenancyMiddleware {
  constructor(
    private readonly sessions: SessionResolver,
    private readonly tenancy: TenantContextService,
    private readonly deps: {
      securityLog(entry: {
        kind: string; detail: string; severity: 'warning' | 'critical';
        userId?: string; tenantId?: string; ipAddress?: string; userAgent?: string;
      }): Promise<void>;
    },
  ) {}

  /**
   * Envuelve un handler: resuelve identidad, corre en AsyncLocalStorage y
   * garantiza que el contexto esté disponible en todo el árbol de llamadas.
   */
  handler<T>(
    fn: (req: HttpRequest, res: HttpResponse, ctx: RequestContext) => Promise<T>,
  ): (req: HttpRequest, res: HttpResponse) => Promise<void> {
    return async (req, res) => {
      const requestId = headerValue(req.headers['x-request-id']) ?? randomUUID();
      res.setHeader('X-Request-Id', requestId);

      const user = await this.sessions(req);

      if (!user) {
        await this.deps.securityLog({
          kind: 'auth.unauthenticated',
          detail: `${req.method} ${req.path} sin sesión válida`,
          severity: 'warning',
          ipAddress: clientIp(req),
          userAgent: headerValue(req.headers['user-agent']),
        });
        res.status(401).json({ error: 'unauthenticated', requestId });
        return;
      }

      // --- Validación cruzada: el tenant activo debe estar en las membresías ---
      const membership = user.memberships.find((m) => m.tenantId === user.activeTenantId);
      if (!membership) {
        await this.deps.securityLog({
          kind: 'tenancy.active_tenant_not_in_memberships',
          detail:
            `El usuario ${user.userId} tiene activeTenantId=${user.activeTenantId}, ` +
            `que no figura entre sus membresías. Posible manipulación de sesión.`,
          severity: 'critical',
          userId: user.userId,
          tenantId: user.activeTenantId,
          ipAddress: clientIp(req),
          userAgent: headerValue(req.headers['user-agent']),
        });
        res.status(403).json({ error: 'invalid_tenant_context', requestId });
        return;
      }

      // --- Detección de intento de override por header ------------------------
      const headerTenant = headerValue(req.headers['x-tenant-id'])
        ?? (typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);

      if (headerTenant && headerTenant !== user.activeTenantId) {
        await this.deps.securityLog({
          kind: 'tenancy.header_override_attempt',
          detail:
            `El cliente intentó operar sobre el tenant ${headerTenant} mientras su sesión ` +
            `está activa en ${user.activeTenantId}. El intento fue ignorado.`,
          severity: 'critical',
          userId: user.userId,
          tenantId: headerTenant,
          ipAddress: clientIp(req),
          userAgent: headerValue(req.headers['user-agent']),
        });
        // Se continúa con el tenant de la sesión: la discrepancia se registra
        // pero no rompe la operación legítima del usuario.
      }

      const ctx: RequestContext = {
        requestId,
        user,
        startedAt: Date.now(),
      };

      try {
        // Todo lo que ocurra dentro de `fn` ve este contexto vía AsyncLocalStorage
        await als.run(ctx, async () => {
          await fn(req, res, ctx);
        });
      } catch (err) {
        const isAppError = err instanceof AppError;
        if (!isAppError) {
          // Un error inesperado nunca debe filtrar el mensaje crudo al cliente:
          // puede contener SQL, rutas internas o nombres de tablas.
          console.error(`[${requestId}] Error no controlado:`, err);
        }
        if (!res.headersSent) {
          res.status(isAppError ? err.status : 500).json({
            error: isAppError ? err.code : 'internal_error',
            message: isAppError ? err.message : 'Error interno. Contacte a soporte con el requestId.',
            requestId,
          });
        }
      }
    };
  }

  /** Atajo: corre una operación con el tenant del contexto activo. */
  async withActiveTenant<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    return this.tenancy.withTenant(
      { tenantId: ctx.user.activeTenantId, userId: ctx.user.userId },
      fn,
    );
  }
}

// =============================================================================
// Guard de permisos (se combina con RLS, no lo reemplaza)
// =============================================================================
/**
 * RLS aísla ENTRE empresas. Los permisos controlan QUÉ puede hacer un miembro
 * DENTRO de su empresa. Son capas distintas y se aplican ambas: RLS sola dejaría
 * que cualquier miembro viera la facturación, y permisos solos no impedirían que
 * un admin de la empresa A leyera los datos de la empresa B.
 */
export function requirePermission(permission: string): void {
  const ctx = currentContext();
  if (!ctx.user.permissions.has(permission)) {
    throw new AppError(
      'forbidden',
      `Falta el permiso requerido: ${permission}`,
      403,
    );
  }
}

export function maybePermission(permission: string): boolean {
  return currentContext().user.permissions.has(permission);
}

// =============================================================================
// Errores
// =============================================================================
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ForbiddenTenantError extends AppError {
  constructor(tenantId: string, userId: string) {
    // Mensaje deliberadamente vago hacia el cliente: no confirma si el tenant
    // existe. El detalle real queda en el log de seguridad.
    super('forbidden', 'No tiene acceso a este recurso.', 403, undefined);
    this.name = 'ForbiddenTenantError';
    void tenantId; void userId;
  }
}

// =============================================================================
// Helpers
// =============================================================================
function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function clientIp(req: HttpRequest): string | undefined {
  // Trust proxy debe estar bien configurado: si no, X-Forwarded-For es spoofable
  // y el log de seguridad apunta a una IP falsa.
  const fwd = headerValue(req.headers['x-forwarded-for']);
  if (fwd) return fwd.split(',')[0]?.trim();
  return headerValue(req.headers['x-real-ip']);
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // 40001 = serialization_failure, 40P01 = deadlock_detected
  return code === '40001' || code === '40P01';
}

async function safeRollback(conn: DbConnection): Promise<void> {
  try {
    await conn.rollback();
  } catch {
    // La conexión ya está rota; el pool la descartará al liberarla.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Augmentación para el handler de respuesta (usado en el catch)
declare module './tenancy.middleware.js' {
  interface HttpResponse {
    readonly headersSent?: boolean;
  }
}
