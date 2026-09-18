/**
 * =============================================================================
 * Control · Punto de entrada del worker de tareas programadas
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Conecta a la base, construye un `JobScheduler` y lo pone a correr. Es el
 * proceso que un orquestador (systemd, Kubernetes, un servicio de Windows) deja
 * vivo.
 *
 * POR QUÉ HAY UN MODO `--once`
 *
 * El modo de un solo barrido (`--once`) es el que hace testeable a todo esto: sin
 * él, verificar el scheduler exigiría esperar una ventana de reloj real, y lo que
 * se puede probar es que la DECISIÓN sea correcta —no que el reloj dé la hora.
 * También es el modo que usa un CronJob externo, si se prefiere esa forma de
 * despliegue sobre el proceso de larga vida.
 *
 * APAGADO ORDENADO
 *
 * Ante SIGINT/SIGTERM se pide `stop()`, que deja terminar el barrido en curso.
 * Cortar en seco en medio de un barrido dejaría una ejecución en `running`; no es
 * irrecuperable —`reap_stuck_job_runs()` la destraba— pero es mejor cerrar bien.
 * El apagado forzado después de un plazo acotado existe para no quedarse
 * esperando un job que se colgó.
 * =============================================================================
 */

import { Pool } from 'pg';
import { hostname } from 'node:os';
import { JobScheduler, type JobLogger } from './scheduler.js';

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------
function connectionString(): string {
  const dsn = process.env.DATABASE_URL || process.env.ADMIN_DATABASE_URL;
  if (!dsn) {
    console.error(
      'Falta DATABASE_URL.\n' +
        '  Ejemplo: DATABASE_URL="postgres://usuario:clave@host:5432/control" node dist/jobs/worker.js'
    );
    process.exit(2);
  }
  return dsn;
}

// El rol del worker necesita pertenecer a `control_platform`: los jobs
// transversales activan el modo plataforma y sin ese privilegio leerían cero
// filas por RLS reportando éxito. Se avisa acá para que el error de arranque
// explique qué falta, en vez de aparecer como "el job corrió y no encontró nada".
const RUNNER_ROLE_HINT =
  'El rol del worker debe pertenecer a `control_platform` para que los jobs ' +
  'transversales puedan activar el modo plataforma.';

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function readFlag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const tickMs = Number(readFlag('--every') ?? '60000');
const onlyRaw = readFlag('--only');
const ONLY = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

if (!Number.isFinite(tickMs) || tickMs < 1000) {
  console.error(`--every debe ser un número de milisegundos >= 1000 (recibido: ${tickMs}).`);
  process.exit(2);
}

/**
 * Sin `--verbose`, el scheduler sólo reporta lo que decide (qué está vencido) y
 * los errores. Con `--verbose` se agrega el detalle por job.
 *
 * El silencioso no se descarta a `console`: en un barrido programado nadie lee
 * la salida, pero cuando algo sale mal el operador necesita el rastro. Se
 * conserva `warn` y `error` siempre, y se reserva el ruido de `info` para
 * `--verbose`, que es el modo que se usa a mano.
 */
const logger: JobLogger = VERBOSE
  ? console
  : {
      info: () => undefined,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: connectionString(),
  // Un worker de jobs no debe abrir decenas de conexiones: los jobs corren en
  // secuencia, así que dos alcanzan y el resto es contención contra el pool de
  // la aplicación.
  max: 2,
  idleTimeoutMillis: 30_000,
});

const scheduler = new JobScheduler(
  pool,
  process.env.HOSTNAME || hostname(),
  logger
);

// -----------------------------------------------------------------------------
// Apagado ordenado
// -----------------------------------------------------------------------------
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] ${signal} recibido; terminando el barrido en curso…`);
  scheduler.stop();

  // Plazo acotado: si un job se colgó, no se espera indefinidamente. El residuo
  // queda en `running` y lo destraba `outbox.reaper`.
  const force = setTimeout(() => {
    console.error('[worker] el apagado ordenado no terminó a tiempo; se fuerza la salida.');
    process.exit(1);
  }, 30_000);
  if (typeof force.unref === 'function') force.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// -----------------------------------------------------------------------------
// Ejecución
// -----------------------------------------------------------------------------
try {
  const results = await scheduler.run({ tickMs, once: ONCE, only: ONLY });

  if (results.length === 0) {
    console.info(ONCE ? '[worker] un barrido: sin jobs vencidos.' : '[worker] sin ejecuciones.');
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(
      `[worker] ${failed.length} job(s) fallaron: ` +
        failed.map((r) => `${r.code} (${r.error ?? 'sin detalle'})`).join(', ')
    );
  }

  await pool.end();

  // Código de salida: distinto de cero si algún job falló. Un worker que
  // reportara 0 con jobs fallidos rompería cualquier monitoreo basado en el
  // código de salida — que es justamente cómo se detecta que algo anda mal.
  process.exit(failed.length > 0 ? 1 : 0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[worker] error fatal: ${message}`);
  console.error(RUNNER_ROLE_HINT);
  await pool.end().catch(() => undefined);
  process.exit(2);
}
