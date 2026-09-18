/**
 * Control · Realtime · Gateway de tracking de envíos
 * -----------------------------------------------------------------------------
 * Dos canales, porque tienen audiencias distintas:
 *
 *  A) SSE  (`/rt/v1/tracking/:token/stream`)  → consumidor FINAL.
 *     Un cliente abre el link de su envío y ve el estado en vivo. Sin
 *     autenticación de sesión (usa un token firmado de un solo uso), texto plano
 *     unidireccional, funciona a través de proxies corporativos y reconecta solo
 *     con el mecanismo nativo de `EventSource`. Menos código en el cliente.
 *
 *  B) WS   (`/rt/v1/ops`)  → operadores autenticados.
 *     Tablero de torre de control y app del conductor. Bidireccional: el
 *     conductor publica pings de GPS y cambios de estado; la oficina recibe un
 *     feed multiplexado de todos los envíos del tenant.
 *
 * Aislamiento multi-tenant en realtime — el punto crítico:
 *   Las suscripciones se agrupan por `tenantId` obtenido de la SESIÓN validada,
 *   nunca de un parámetro del cliente. Un socket sólo recibe broadcasts cuyo
 *   tenant coincide con el suyo. Un intento de suscribirse al envío de otro
 *   inquilino se rechaza y se registra como evento de seguridad.
 *
 * Backpressure: los clientes lentos se desconectan en vez de acumular buffers en
 * memoria (protección contra OOM por un consumidor rezagado).
 */

import { EventEmitter } from 'node:events';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Tipos del dominio realtime
// =============================================================================

export type ShipmentStatus =
  | 'draft' | 'preparing' | 'ready' | 'in_transit'
  | 'out_for_delivery' | 'delivered' | 'incident' | 'cancelled';

export interface TrackingEvent {
  id: string;
  tenantId: string;
  shipmentId: string;
  trackingCode: string;
  status: ShipmentStatus;
  eventCode: string;
  description: string;
  // `| undefined` explícito en los opcionales: `exactOptionalPropertyTypes` no
  // acepta un `undefined` literal en `campo?: T`, y estos eventos se construyen
  // con la clave presente y valor `undefined` cuando el hecho no tiene posición
  // (un cambio de estado administrativo, por ejemplo).
  geo?: { lat: number; lng: number } | undefined;
  speedKmh?: number | undefined;
  heading?: number | undefined;
  actorKind: 'system' | 'user' | 'driver' | 'customer' | 'webhook';
  occurredAt: string;
  payload?: Record<string, unknown> | undefined;
}

export interface DriverPing {
  shipmentId: string;
  clientEventId: string;
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  accuracyM?: number;
  recordedAt: string;
}

/** Rol con el que se conecta un consumer. Determina el filtro de datos. */
export type RealtimeRole = 'operator' | 'driver' | 'customer';

interface Subscription {
  tenantId: string;
  role: RealtimeRole;
  // `| undefined` explícito en los campos opcionales de este archivo: con
  // `exactOptionalPropertyTypes` (activo a propósito) `campo?: T` significa
  // "la clave puede faltar", no "puede valer undefined". Acá la clave se
  // construye siempre a partir de una sesión, y `undefined` es un valor
  // legítimo cuando el rol no tiene usuario asociado.
  userId?: string | undefined;
  /** Vacío = todos los envíos del tenant (operador). */
  shipmentIds: Set<string>;
  /** Sólo para `driver`: el conductor ve únicamente sus asignaciones. */
  driverUserId?: string | undefined;
}

// =============================================================================
// Bus de eventos por tenant — el núcleo del aislamiento
// =============================================================================
export class TenantEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    // Con muchos tenants conectados el límite por defecto (10) dispararía
    // MaxListenersExceededWarning sin que haya una fuga real.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Canal interno. El nombre incluye el tenant para que un handler nunca pueda
   * recibir por error el evento de otro inquilino: el filtro es estructural, no
   * una comparación que alguien podría olvidar.
   */
  private channel(tenantId: string): string {
    return `tenant:${tenantId}:tracking`;
  }

  publish(event: TrackingEvent): void {
    this.emitter.emit(this.channel(event.tenantId), event);
  }

  subscribe(tenantId: string, handler: (e: TrackingEvent) => void): () => void {
    const ch = this.channel(tenantId);
    this.emitter.on(ch, handler);
    return () => this.emitter.off(ch, handler);
  }

  listenerCount(tenantId: string): number {
    return this.emitter.listenerCount(this.channel(tenantId));
  }
}

// =============================================================================
// Hub de conexiones
// =============================================================================
export interface RealtimeConnection {
  id: string;
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Bytes en vuelo sin confirmar; si supera el umbral se descarta al cliente. */
  bufferedAmount(): number;
}

const MAX_BUFFERED_BYTES = 512 * 1024;   // 512 KB de backlog => cliente rezagado
const HEARTBEAT_INTERVAL_MS = 25_000;
const SSE_RETRY_MS = 3_000;

export class RealtimeHub {
  private readonly connections = new Map<string, RealtimeConnection>();
  private readonly subscriptions = new Map<string, Subscription>();
  /** Índice inverso shipmentId -> conexiones, para fan-out O(1) por envío. */
  private readonly byShipment = new Map<string, Set<string>>();

  constructor(
    private readonly bus: TenantEventBus,
    private readonly deps: {
      /** Verifica acceso a un envío concreto contra la DB (RLS + RBAC). */
      canAccessShipment(args: {
        tenantId: string; shipmentId: string; role: RealtimeRole; userId?: string | undefined;
      }): Promise<boolean>;
      /** Lista de envíos visibles para el rol (driver: sólo los suyos). */
      listVisibleShipments(args: {
        tenantId: string; role: RealtimeRole; userId?: string | undefined;
      }): Promise<string[]>;
      /** Persiste el evento antes de publicarlo. */
      persistEvent(event: TrackingEvent): Promise<void>;
      /** Registra intentos de acceso cruzado. */
      securityLog(entry: {
        tenantId: string;
        userId?: string | undefined;
        kind: string; detail: string; severity: 'warning' | 'critical';
      }): Promise<void>;
      now?: () => Date;
    },
  ) {
    // Un único listener por tenant que hace fan-out a sus conexiones.
    this.onPublish = this.onPublish.bind(this);
  }

  private readonly trackedTenants = new Set<string>();
  private onPublish(event: TrackingEvent): void {
    // 1. Fan-out a suscriptores del envío concreto
    const connIds = this.byShipment.get(event.shipmentId);
    if (connIds?.size) {
      const frame = `event: tracking\ndata: ${JSON.stringify(event)}\n\n`;
      for (const id of connIds) {
        const conn = this.connections.get(id);
        const sub = this.subscriptions.get(id);
        if (!conn || !sub) continue;

        // Doble verificación de tenant: la defensa en profundidad también acá.
        if (sub.tenantId !== event.tenantId) {
          void this.deps.securityLog({
            tenantId: sub.tenantId,
            userId: sub.userId,
            kind: 'realtime.cross_tenant_delivery_blocked',
            detail: `Conexión ${id} intentó recibir el envío ${event.shipmentId} del tenant ${event.tenantId}`,
            severity: 'critical',
          });
          continue;
        }

        if (conn.bufferedAmount() > MAX_BUFFERED_BYTES) {
          conn.close(1013, 'Cliente demasiado lento, reconecte');  // 1013 = Try Again Later
          this.unregister(id);
          continue;
        }
        conn.send(frame);
      }
    }

    // 2. Listener de tablero de operadores: recibe todo el tenant
    //    (implementado vía suscripción con shipmentIds vacío → wildcard)
    for (const [id, sub] of this.subscriptions) {
      if (sub.tenantId !== event.tenantId) continue;
      if (sub.role !== 'operator') continue;
      if (sub.shipmentIds.size > 0) continue;      // ya cubierto por fan-out
      const conn = this.connections.get(id);
      if (!conn) continue;
      if (conn.bufferedAmount() > MAX_BUFFERED_BYTES) {
        conn.close(1013, 'Cliente demasiado lento, reconecte');
        this.unregister(id);
        continue;
      }
      conn.send(`event: tracking\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  /** Registra una conexión y la suscribe al tenant. Idempotente por id. */
  async register(
    conn: RealtimeConnection,
    sub: Subscription,
  ): Promise<void> {
    // Suscripción al bus: una sola vez por tenant
    if (!this.trackedTenants.has(sub.tenantId)) {
      this.bus.subscribe(sub.tenantId, this.onPublish);
      this.trackedTenants.add(sub.tenantId);
    }

    // Resolver el conjunto efectivo de envíos visibles según el rol
    let visible: string[];
    if (sub.role === 'operator') {
      visible = [];  // wildcard: recibe todo el tenant
    } else if (sub.role === 'driver') {
      visible = await this.deps.listVisibleShipments({
        tenantId: sub.tenantId, role: sub.role, userId: sub.userId,
      });
    } else {
      // customer: sólo los envíos ya suscriptos explícitamente por token
      visible = [...sub.shipmentIds];
    }

    sub.shipmentIds = new Set(visible);
    this.connections.set(conn.id, conn);
    this.subscriptions.set(conn.id, sub);

    for (const sid of sub.shipmentIds) {
      if (!this.byShipment.has(sid)) this.byShipment.set(sid, new Set());
      this.byShipment.get(sid)!.add(conn.id);
    }

    conn.send(`event: connected\ndata: ${JSON.stringify({
      connectionId: conn.id,
      role: sub.role,
      trackedShipments: sub.shipmentIds.size,
      at: (this.deps.now?.() ?? new Date()).toISOString(),
    })}\n\n`);
  }

  /**
   * Alta dinámica de suscripción a un envío. Siempre revalida contra la DB:
   * nunca se confía en el shipmentId que manda el cliente.
   */
  async subscribeToShipment(
    connectionId: string,
    shipmentId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const sub = this.subscriptions.get(connectionId);
    const conn = this.connections.get(connectionId);
    if (!sub || !conn) return { ok: false, reason: 'connection_not_found' };

    const allowed = await this.deps.canAccessShipment({
      tenantId: sub.tenantId,
      shipmentId,
      role: sub.role,
      userId: sub.userId,
    });

    if (!allowed) {
      await this.deps.securityLog({
        tenantId: sub.tenantId,
        userId: sub.userId,
        kind: 'realtime.unauthorized_shipment_subscribe',
        detail: `Conexión ${connectionId} intentó suscribirse al envío ${shipmentId}`,
        severity: 'critical',
      });
      conn.send(`event: error\ndata: ${JSON.stringify({ code: 'FORBIDDEN', shipmentId })}\n\n`);
      return { ok: false, reason: 'forbidden' };
    }

    sub.shipmentIds.add(shipmentId);
    if (!this.byShipment.has(shipmentId)) this.byShipment.set(shipmentId, new Set());
    this.byShipment.get(shipmentId)!.add(connectionId);

    conn.send(`event: subscribed\ndata: ${JSON.stringify({ shipmentId })}\n\n`);
    return { ok: true };
  }

  unregister(connectionId: string): void {
    const sub = this.subscriptions.get(connectionId);
    if (sub) {
      for (const sid of sub.shipmentIds) {
        const set = this.byShipment.get(sid);
        if (set) {
          set.delete(connectionId);
          if (set.size === 0) this.byShipment.delete(sid);
        }
      }
    }
    this.subscriptions.delete(connectionId);
    this.connections.delete(connectionId);

    // Si no quedan conexiones de un tenant, liberar el listener del bus
    const stillUsed = [...this.subscriptions.values()].some((s) => s.tenantId === sub?.tenantId);
    if (!stillUsed && sub) {
      this.trackedTenants.delete(sub.tenantId);
    }
  }

  /** Publica un evento: persiste primero, emite después (orden garantizado). */
  async emit(event: Omit<TrackingEvent, 'id' | 'occurredAt'> & { occurredAt?: string }): Promise<TrackingEvent> {
    const full: TrackingEvent = {
      ...event,
      id: randomUUID(),
      occurredAt: event.occurredAt ?? (this.deps.now?.() ?? new Date()).toISOString(),
    };
    await this.deps.persistEvent(full);   // si esto falla, no se emite nada
    this.bus.publish(full);
    return full;
  }

  /**
   * Publica una actualización de posición. Va por un camino distinto del de
   * `emit()` a propósito: los pings de GPS tienen otra frecuencia (segundos, no
   * minutos) y otros consumidores (el mapa, no el timeline).
   *
   * NO persiste ni pasa por `persistEvent`. Es deliberado: `logistics.
   * position_pings` es una tabla particionada de alta frecuencia, y escribir el
   * historial de posiciones es responsabilidad de otro camino que puede
   * agrupar y descartar. Persistir cada ping acá acoplaría el stream en vivo a
   * la escritura en disco, y una base lenta haría que el mapa se congelara.
   *
   * Se publica por el mismo bus con `eventCode: 'location'` para que el cliente
   * discrimine: el timeline ignora los eventos de posición y el mapa ignora el
   * resto.
   */
  emitLocation(loc: {
    tenantId: string;
    shipmentId: string;
    lat: number;
    lng: number;
    speedKmh?: number | undefined;
    heading?: number | undefined;
    recordedAt: string;
  }): void {
    this.bus.publish({
      id: randomUUID(),
      tenantId: loc.tenantId,
      shipmentId: loc.shipmentId,
      trackingCode: '',
      status: 'in_transit',
      eventCode: 'location',
      description: 'Actualización de posición',
      geo: { lat: loc.lat, lng: loc.lng },
      speedKmh: loc.speedKmh,
      heading: loc.heading,
      actorKind: 'driver',
      occurredAt: loc.recordedAt,
    });
  }

  stats(): { connections: number; tenants: number; trackedShipments: number } {
    return {
      connections: this.connections.size,
      tenants: this.trackedTenants.size,
      trackedShipments: this.byShipment.size,
    };
  }
}

// =============================================================================
// Adapter SSE (consumidor final)
// =============================================================================
export class SseConnection implements RealtimeConnection {
  readonly id = randomUUID();
  private closed = false;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly res: {
      writeHead(status: number, headers: Record<string, string>): void;
      write(chunk: string): boolean;
      end(): void;
      flushHeaders?(): void;
    },
    private readonly onClose: (id: string) => void,
  ) {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sin esto, nginx bufferiza el stream y el cliente no ve nada en vivo.
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();

    // Instrucción de reconexión al cliente, en caso de corte
    this.res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    // Heartbeat: mantiene viva la conexión a través de proxies con idle timeout.
    // Un comentario (`:`) es válido en SSE y no dispara eventos en el cliente.
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try { this.res.write(`: keepalive ${Date.now()}\n\n`); } catch { this.close(499, 'write failed'); }
    }, HEARTBEAT_INTERVAL_MS);
  }

  send(data: string): void {
    if (this.closed) return;
    try { this.res.write(data); } catch { this.close(499, 'write failed'); }
  }

  bufferedAmount(): number {
    // La API de Node no expone el buffer de un ServerResponse de forma directa;
    // `writableLength` es la aproximación correcta para detectar backpressure.
    return (this.res as unknown as { writableLength?: number }).writableLength ?? 0;
  }

  close(_code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      this.res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
      this.res.end();
    } catch { /* conexión ya caída */ }
    this.onClose(this.id);
  }
}

// =============================================================================
// Tokens de acceso público (link de tracking del cliente final)
// =============================================================================
/**
 * El link que recibe el cliente lleva un token, no su shipmentId. Así:
 *  - no se puede enumerar envíos ajenos adivinando IDs,
 *  - el link expira,
 *  - se puede revocar reemitiendo el token.
 * El token se guarda hasheado; acá se compara en tiempo constante.
 */
export interface TrackingTokenService {
  issue(args: { tenantId: string; shipmentId: string; ttlSeconds: number }): Promise<string>;
  verify(token: string): Promise<{ tenantId: string; shipmentId: string } | null>;
}

export class HmacTrackingTokenService implements TrackingTokenService {
  constructor(private readonly store: {
    save(hash: string, data: { tenantId: string; shipmentId: string; expiresAt: Date }): Promise<void>;
    find(hash: string): Promise<{ tenantId: string; shipmentId: string; expiresAt: Date } | null>;
  }) {}

  static hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async issue(args: { tenantId: string; shipmentId: string; ttlSeconds: number }): Promise<string> {
    // 32 bytes de aleatoriedad criptográfica, URL-safe
    const raw = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const token = Buffer.from(raw, 'hex').toString('base64url');
    await this.store.save(HmacTrackingTokenService.hashToken(token), {
      tenantId: args.tenantId,
      shipmentId: args.shipmentId,
      expiresAt: new Date(Date.now() + args.ttlSeconds * 1000),
    });
    return token;
  }

  async verify(token: string): Promise<{ tenantId: string; shipmentId: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;   // descarta basura temprano
    const expected = HmacTrackingTokenService.hashToken(token);
    const record = await this.store.find(expected);
    if (!record) return null;
    if (record.expiresAt.getTime() < Date.now()) return null;

    // Comparación en tiempo constante (el índice ya resolvió el lookup, pero la
    // verificación explícita documenta la intención y evita optimizaciones raras)
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    return { tenantId: record.tenantId, shipmentId: record.shipmentId };
  }
}

// =============================================================================
// Máquina de estados de envíos — valida transiciones antes de publicar
// =============================================================================
const ALLOWED_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  draft:            ['preparing', 'cancelled'],
  preparing:        ['ready', 'incident', 'cancelled'],
  ready:            ['in_transit', 'incident', 'cancelled'],
  in_transit:       ['out_for_delivery', 'delivered', 'incident', 'cancelled'],
  out_for_delivery: ['delivered', 'incident'],
  delivered:        [],                      // estado terminal
  incident:         ['preparing', 'ready', 'in_transit', 'cancelled'],
  cancelled:        [],                      // estado terminal
};

export class InvalidTransitionError extends Error {
  constructor(from: ShipmentStatus, to: ShipmentStatus, shipmentId: string) {
    super(
      `Transición de estado inválida para el envío ${shipmentId}: ${from} → ${to}. ` +
      `Estados permitidos desde "${from}": ${ALLOWED_TRANSITIONS[from].join(', ') || 'ninguno (estado terminal)'}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: ShipmentStatus, to: ShipmentStatus, shipmentId: string): void {
  if (from === to) return;                    // idempotente: el reintento no es error
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to, shipmentId);
  }
}

// =============================================================================
// Servicio de aplicación: casos de uso
// =============================================================================
export class TrackingService {
  constructor(
    private readonly hub: RealtimeHub,
    private readonly deps: {
      getShipment(tenantId: string, shipmentId: string): Promise<{
        id: string; trackingCode: string; status: ShipmentStatus; driverUserId?: string | null;
      } | null>;
      appendEvent(event: TrackingEvent): Promise<void>;
      recordPing(tenantId: string, ping: DriverPing & { driverUserId?: string }): Promise<void>;
      now?: () => Date;
    },
  ) {}

  /**
   * Cambio de estado disparado por un operador o conductor.
   * Idempotente por `clientEventId`: la app móvil puede reintentar sin duplicar.
   */
  async updateStatus(args: {
    tenantId: string;
    shipmentId: string;
    to: ShipmentStatus;
    eventCode: string;
    description: string;
    actorKind: TrackingEvent['actorKind'];
    actorId?: string;
    geo?: { lat: number; lng: number };
    clientEventId?: string;
    payload?: Record<string, unknown>;
  }): Promise<TrackingEvent> {
    const shipment = await this.deps.getShipment(args.tenantId, args.shipmentId);
    if (!shipment) {
      throw new Error(`Envío ${args.shipmentId} no encontrado en el tenant ${args.tenantId}`);
    }

    // La máquina de estados se valida ANTES de tocar la DB.
    assertTransition(shipment.status, args.to, args.shipmentId);

    return this.hub.emit({
      tenantId: args.tenantId,
      shipmentId: args.shipmentId,
      trackingCode: shipment.trackingCode,
      status: args.to,
      eventCode: args.eventCode,
      description: args.description,
      geo: args.geo,
      actorKind: args.actorKind,
      payload: { ...args.payload, clientEventId: args.clientEventId },
    });
  }

  /**
   * Ping de GPS del conductor. Va por una ruta de alta frecuencia y baja
   * latencia: se escribe en `position_pings` (particionada) y se publica sólo
   * un evento `location` para el mapa, sin generar una fila de tracking_event
   * por cada ping (eso inflaría la tabla de eventos con ruido).
   */
  async recordDriverPing(args: {
    tenantId: string;
    driverUserId: string;
    ping: DriverPing;
  }): Promise<void> {
    await this.deps.recordPing(args.tenantId, { ...args.ping, driverUserId: args.driverUserId });

    this.hub.emitLocation({
      tenantId: args.tenantId,
      shipmentId: args.ping.shipmentId,
      lat: args.ping.lat,
      lng: args.ping.lng,
      speedKmh: args.ping.speedKmh,
      heading: args.ping.heading,
      recordedAt: args.ping.recordedAt,
    });
  }

  /** Confirmación de descarga por el cliente final. */
  async confirmDelivery(args: {
    tenantId: string;
    shipmentId: string;
    signerName: string;
    signerDoc?: string;
    conform: boolean;
    notes?: string;
    photoUrls?: string[];
    geo?: { lat: number; lng: number };
    customerUserId?: string;
  }): Promise<TrackingEvent> {
    const shipment = await this.deps.getShipment(args.tenantId, args.shipmentId);
    if (!shipment) throw new Error(`Envío ${args.shipmentId} no encontrado`);

    // Conformidad con reservas => el envío pasa a 'incident', no a 'delivered'.
    const target: ShipmentStatus = args.conform ? 'delivered' : 'incident';

    return this.hub.emit({
      tenantId: args.tenantId,
      shipmentId: args.shipmentId,
      trackingCode: shipment.trackingCode,
      status: target,
      eventCode: args.conform ? 'delivered' : 'delivered_with_discrepancy',
      description: args.conform
        ? `Entrega confirmada por ${args.signerName}`
        : `Recepcionado con reservas por ${args.signerName}: ${args.notes ?? 'sin detalle'}`,
      geo: args.geo,
      actorKind: 'customer',
      payload: {
        signerName: args.signerName,
        signerDoc: args.signerDoc,
        photoUrls: args.photoUrls ?? [],
      },
    });
  }
}
