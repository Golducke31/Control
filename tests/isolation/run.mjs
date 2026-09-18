#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de aislamiento multi-tenant (F0.4 del plan de producción)
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Recorre el catálogo real de PostgreSQL —no una lista escrita a mano— y para
 * CADA tabla con `tenant_id` verifica, contra una base con datos de dos
 * inquilinos distintos, que:
 *
 *   A. COBERTURA    · la tabla tiene FORCE RLS y al menos una política; las
 *                     particiones tienen su propia cobertura.
 *   B. LECTURA      · autenticado como empresa A, `SELECT` no devuelve filas de
 *                     la empresa B.
 *   C. ESCRITURA    · autenticado como empresa A, `INSERT` de una fila con
 *                     `tenant_id` de B es rechazado; `UPDATE`/`DELETE` sobre
 *                     filas de B afectan 0 filas.
 *   D. FAIL-CLOSED  · sin contexto de sesión, toda lectura devuelve 0 filas.
 *
 * POR QUÉ ASÍ
 *
 * La lista de tablas se descubre desde `pg_class`, no se enumeran a mano. Un
 * dev que agrega una tabla y olvida la política queda cubierto por el test sin
 * que nadie tenga que acordarse de tocar este archivo — que es el único modo
 * de que el control sea real y no decorativo.
 *
 * USO
 *
 *   node tests/isolation/run.mjs --dsn "postgres://app_login:...@host:5432/db" \
 *                                --admin-dsn "postgres://postgres:...@host:5432/db" --verbose
 *
 *   DATABASE_URL="postgres://app_login:..." \
 *   ADMIN_DATABASE_URL="postgres://postgres:..." node tests/isolation/run.mjs
 *
 * LAS DOS CONEXIONES, Y POR QUÉ SON DOS
 *
 *   `--dsn`        (rol de APLICACIÓN)  · conduce las pruebas de aislamiento.
 *   `--admin-dsn`  (rol de PLATAFORMA)  · prepara y limpia el escenario.
 *
 * El rol de aplicación DEBE ser miembro de `control_app` y NO puede ser
 * superusuario ni tener BYPASSRLS: el superusuario de PostgreSQL ignora RLS
 * **siempre**, incluso con FORCE ROW LEVEL SECURITY, así que correr contra él
 * reportaría "OK" sin haber ejercitado una sola política. La guardia de `main()`
 * aborta con exit 2 si detecta ese caso. Es preferible un falso negativo ruidoso
 * que un falso positivo silencioso en la única barrera de aislamiento.
 *
 * La preparación, en cambio, necesita privilegios que la aplicación no tiene ni
 * debe tener: crear inquilinos y limpiar `audit.events` (cuya política es
 * RESTRICTIVE USING (false) — un DELETE con rol de aplicación afecta 0 filas sin
 * lanzar error). Por eso se usa una conexión administrativa aparte y el camino
 * validado `app.set_tenant_context(NULL, NULL, true)`, igual que job-runner.ts.
 *
 * Requiere `psql` en el PATH (viene con el cliente de PostgreSQL).
 * Salida: 0 si todo pasa · 1 si detecta una fuga · 2 si el entorno no sirve.
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Ejecuta un proceso con entrada estándar y captura de salida.
 *
 * Se usa `spawn` en vez de `execFile` porque el SQL se envía por STDIN (ver
 * `sql()`), y `execFile` no expone stdin: acepta una opción `input` que
 * **ignora en silencio**. El resultado no era "sin entrada" sino un proceso
 * esperando una entrada que nunca llegaba, que el entorno terminaba matando con
 * SIGTERM — otra vez sin mensaje.
 *
 * Rechaza si el proceso sale con código distinto de cero, para que el llamador
 * pueda ver stderr tal como venía haciendo.
 */
function spawnPsql(args, { env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (e) => {
      reject(Object.assign(new Error(e.message), { stderr: e.message, stdout: '' }));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          Object.assign(new Error(`psql salió con código ${code}`), { stdout, stderr, code })
        );
      }
    });

    // `end()` y no `write()`: sin cerrar stdin, psql espera más sentencias y
    // nunca llega a ejecutar las que ya recibió.
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Ruta al ejecutable de psql.
 *
 * `execFile` no usa el PATH del shell: hereda el del proceso. En Windows, una
 * consola que no pasó por el instalador de PostgreSQL no tiene
 * `C:\Program Files\PostgreSQL\16\bin` en el PATH, y el error resultante
 * («spawn psql ENOENT») no dice dónde se esperaba encontrarlo.
 *
 * Se respeta la variable `PG_BIN` cuando está definida — el mismo nombre que
 * usa `scripts/verify-isolation.ps1` — para que los dos caminos de verificación
 * se configuren igual.
 */
const PSQL = process.env.PG_BIN
  ? join(process.env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
  : 'psql';

/**
 * Interpreta el texto con que psql representa un boolean.
 *
 * psql no tiene una sola forma de escribirlos: con la salida alineada clásica
 * usa `t`/`f`, y con `--no-align` —las banderas que usa esta suite— usa
 * `true`/`false`. La versión anterior de la suite comparaba contra `'t'` en
 * varios lugares, así que con su propia configuración todas esas comparaciones
 * daban falso. El síntoma era peor que un error: la cobertura reportaba 17
 * tablas "sin FORCE RLS" que en realidad lo tenían, y la guardia de rol
 * abortaba un entorno válido. Un falso negativo masivo hace que uno deje de
 * creerle a la suite.
 *
 * Se usa `::text` en el SQL y esta función al leer, para que el formato de
 * salida no sea parte del contrato.
 */
const isTrue = (v) =>
  typeof v === 'string' && (v.trim() === 't' || v.trim() === 'true');

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// Conexión de APLICACIÓN: conduce las pruebas de aislamiento. Debe ser un rol
// miembro de `control_app`, sin BYPASSRLS. Su corrección la verifica assertAppRole().
const DSN =
  readFlag('--dsn') ||
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING;

// Conexión de PLATAFORMA: sólo para preparar y limpiar el escenario. Tiene los
// privilegios que la aplicación no tiene (crear inquilinos, purgar auditoría).
// Si no se provee, se cae al DSN de aplicación: así una base donde el mismo rol
// sirve para ambas cosas sigue funcionando — pero entonces la guardia de rol
// probablemente aborte, que es exactamente lo que queremos que pase.
const ADMIN_DSN =
  readFlag('--admin-dsn') ||
  process.env.ADMIN_DATABASE_URL ||
  DSN;

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

if (!DSN) {
  console.error(
    'Falta la cadena de conexión.\n' +
      '  node tests/isolation/run.mjs --dsn "postgres://app_login:...@host:5432/db" \\\n' +
      '                               --admin-dsn "postgres://postgres:...@host:5432/db"\n' +
      '  o: DATABASE_URL="postgres://..." ADMIN_DATABASE_URL="postgres://..." node tests/isolation/run.mjs'
  );
  process.exit(2);
}

// -----------------------------------------------------------------------------
// UUIDs fijos: la suite es reproducible y sus datos son reconocibles.
// Se usan inquilinos ficticios que jamás deberían existir en producción.
// -----------------------------------------------------------------------------
const TENANT_A = '00000000-0000-4000-a000-00000000000a';
const TENANT_B = '00000000-0000-4000-b000-00000000000b';
const USER_A = '00000000-0000-4000-a000-0000000000aa';
const USER_B = '00000000-0000-4000-b000-0000000000bb';
const ACTOR = '00000000-0000-4000-0000-0000000000ff';
// Rol de sistema `owner`, definido en db/seed/0001_system_catalog.sql.
const ROLE_OWNER = '11111111-1111-1111-1111-000000000001';

// -----------------------------------------------------------------------------
// Runner de SQL
// -----------------------------------------------------------------------------
let passCount = 0;
const failures = [];

/**
 * Traduce un DSN `postgres://usuario:clave@host:puerto/base` a los argumentos y
 * las variables de entorno que psql espera.
 *
 * POR QUÉ NO SE PASA EL DSN COMO ARGUMENTO
 *
 * La versión anterior invocaba `psql <dsn> --no-psqlrc ...`, con la cadena de
 * conexión en la PRIMERA posición. En este entorno esa forma mata el proceso
 * hijo con SIGTERM y —lo peor— **sin ningún mensaje**: ni stdout, ni stderr, ni
 * código de error. La suite entera terminaba en silencio, indistinguible de un
 * cuelgue. Se reprodujo aislado: `execFile('psql', ['--version'])` funciona;
 * `execFile('psql', ['postgres://…', …])` muere.
 *
 * Descomponer el DSN evita el argumento con forma de URL y, de paso, saca la
 * contraseña de la línea de comandos: `psql` la toma de PGPASSWORD, así que no
 * queda visible en el listado de procesos del equipo.
 */
function splitDsn(dsn) {
  let u;
  try {
    u = new URL(dsn);
  } catch {
    throw new Error(
      `DSN inválido: no se pudo interpretar como URL.\n` +
        `  Formato esperado: postgres://usuario:clave@host:puerto/base`
    );
  }
  return {
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || ''),
  };
}

const APP_CONN = splitDsn(DSN);
const ADMIN_CONN = splitDsn(ADMIN_DSN);

/**
 * Ejecuta SQL como una transacción única y devuelve stdout crudo.
 * Cada consulta va en su propia transacción para que `SET LOCAL` tenga el
 * alcance correcto — igual que hace la aplicación en producción.
 *
 * `asAdmin` es una decisión de privilegio, no una comodidad: cambiarlo cambia
 * qué está probando la suite. Ver el encabezado.
 */
async function sql(statements, { asAdmin = false } = {}) {
  const conn = asAdmin ? ADMIN_CONN : APP_CONN;
  const { stdout } = await spawnPsql(
    [
      '-U', conn.user,
      '-h', conn.host,
      '-p', conn.port,
      '-d', conn.database,
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '-v', 'ON_ERROR_STOP=1',
      // La sentencia va por STDIN, no por `-c`.
      //
      // En Windows el SQL viaja como argumento de línea de comandos, que usa la
      // página de códigos ANSI del sistema (cp1252 en español) y no UTF-8. Los
      // comentarios del proyecto están en español, así que cualquier `á`, `é` o
      // `ñ` llegaba a PostgreSQL como bytes inválidos y la consulta moría con
      // «secuencia de bytes no válida para codificación UTF8: 0xe1 0x20 0x65».
      // Por stdin los bytes se transmiten tal cual, sin pasar por el parser de
      // argumentos del sistema operativo.
      '-f', '-',
    ],
    {
      env: Object.assign({}, process.env, {
        PGPASSWORD: conn.password,
        // Explicitar la codificación del cliente: sin esto psql deduce la de la
        // consola, que en Windows suele ser distinta de la de la base.
        PGCLIENTENCODING: 'UTF8',
      }),
      input: statements,
    }
  );
  return stdout.trim();
}

/** Atajo: SQL con privilegios de plataforma (preparación del escenario). */
function sqlAdmin(statements) {
  return sql(statements, { asAdmin: true });
}

/**
 * Ejecuta y devuelve { ok, out, err } sin lanzar.
 * Se usa para las pruebas que ESPERAN un error de política.
 */
async function trySql(statements, opts = {}) {
  try {
    return { ok: true, out: await sql(statements, opts) };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message) };
  }
}

function assert(condition, label, detail = '') {
  if (condition) {
    passCount += 1;
    if (VERBOSE) console.log(`  \u2713 ${label}`);
  } else {
    failures.push({ label, detail });
    console.error(`  \u2717 ${label}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`);
  }
}

// -----------------------------------------------------------------------------
// Contexto de sesión: replica exactamente lo que hace TenantContextService.
// -----------------------------------------------------------------------------
function withTenant(tenantId, body) {
  return [
    'BEGIN;',
    `SELECT app.set_tenant_context('${tenantId}'::uuid, '${ACTOR}'::uuid, false);`,
    body,
    'COMMIT;',
  ].join('\n');
}

function withoutTenant(body) {
  return ['BEGIN;', body, 'COMMIT;'].join('\n');
}

// =============================================================================
// 0 · Preparación: inquilinos, usuarios y contexto mínimo
//
// Todo este bloque corre con la conexión ADMINISTRATIVA. La razón no es
// comodidad: `control_app` no tiene INSERT sobre `app.tenants` ni sobre
// `app.memberships` (sus políticas exigen is_platform_admin()), y `audit.events`
// tiene una política RESTRICTIVE USING (false) que haría que un DELETE con rol
// de aplicación afectara 0 filas **sin lanzar error** — limpieza que no limpia,
// en silencio, y escenario que se ensucia entre corridas.
//
// El contexto de plataforma se activa con `app.set_tenant_context(NULL, NULL,
// true)`, el mismo camino que usa job-runner.ts. Antes acá había un
// `SET LOCAL app.platform_admin = 'on'` suelto, que se saltea la verificación de
// privilegios de la propia función y por eso no detecta un DSN mal elegido.
// =============================================================================
async function setup() {
  console.log('\n\u25b6 Preparación del escenario (rol de plataforma)');

  // Limpieza idempotente de corridas anteriores. El orden respeta las claves
  // foráneas: primero lo que depende, después el padre.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM audit.events         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenant_branding  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants          WHERE id       IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users            WHERE id       IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'isolation-sub-a', 'a@isolation.test', true, 'Inquilino A'),
  ('${USER_B}', 'isolation-sub-b', 'b@isolation.test', true, 'Inquilino B');

INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'isolation-a', 'Empresa A S.A.',  'Empresa A', 'active', 'ARS'),
  ('${TENANT_B}', 'isolation-b', 'Empresa B S.R.L.', 'Empresa B', 'active', 'ARS');

INSERT INTO app.memberships (tenant_id, user_id, role_id, is_active)
VALUES
  ('${TENANT_A}', '${USER_A}', '${ROLE_OWNER}', true),
  ('${TENANT_B}', '${USER_B}', '${ROLE_OWNER}', true);
COMMIT;
`);

  // Los datos de negocio sí se insertan con el rol de APLICACIÓN y contexto de
  // inquilino. Es deliberado: si `control_app` no puede crear un cliente en su
  // propia empresa, el sistema no sirve, y queremos enterarnos acá y no en
  // producción. Además valida el camino `withTenant()` de punta a punta.
  await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_A}'::uuid, '${ACTOR}'::uuid, false);
INSERT INTO app.customers (id, tenant_id, code, legal_name, doc_number)
VALUES ('00000000-0000-4000-a000-00000000c001', '${TENANT_A}', 'C-A-1', 'Cliente de A', '30000000001');
INSERT INTO app.products (id, tenant_id, sku, name)
VALUES ('00000000-0000-4000-a000-00000000d001', '${TENANT_A}', 'SKU-A-1', 'Producto de A');
COMMIT;
`);

  await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_B}'::uuid, '${ACTOR}'::uuid, false);
INSERT INTO app.customers (id, tenant_id, code, legal_name, doc_number)
VALUES ('00000000-0000-4000-b000-00000000c002', '${TENANT_B}', 'C-B-1', 'Cliente de B', '30000000002');
INSERT INTO app.products (id, tenant_id, sku, name)
VALUES ('00000000-0000-4000-b000-00000000d002', '${TENANT_B}', 'SKU-B-1', 'Producto de B');
COMMIT;
`);

  // Confirmación de que el escenario quedó armado. Sin esto, un `INSERT` que no
  // insertó (por RLS, por un trigger, por lo que sea) se manifestaría más tarde
  // como "la empresa A no ve sus filas" — un síntoma a kilómetros del defecto.
  // Se consulta con el rol de aplicación, que es lo que el test va a ver.
  await verifyScenario();

  console.log('  Escenario listo: 2 inquilinos, datos en ambos.');
}

/**
 * Verifica que el escenario sea el que la suite cree que es.
 * Se corre con el rol de APLICACIÓN: si algo no es visible desde ahí, los tests
 * de la sección B darían un falso OK por vacío en vez de por aislamiento.
 */
async function verifyScenario() {
  const own = await sql(
    withTenant(
      TENANT_A,
      `SELECT (SELECT count(*) FROM app.customers WHERE tenant_id = '${TENANT_A}'::uuid)
             || '|' ||
             (SELECT count(*) FROM app.customers WHERE tenant_id = '${TENANT_B}'::uuid);`
    )
  );

  const [aCount, bCount] = own.split('|').map(Number);

  if (aCount < 1) {
    console.error(
      `\n  El escenario no quedó armado: la empresa A no ve su propio cliente.\n` +
        `  Sin datos propios, los tests de lectura darían un falso OK por vacío.\n` +
        `  Revisá los errores de preparación de arriba.`
    );
    process.exit(2);
  }

  if (bCount !== 0) {
    // Esto se detectaría igual en la sección B, pero acá el mensaje es más útil:
    // señala el escenario, no la política.
    console.error(
      `\n  El escenario está contaminado: desde A se ven ${bCount} clientes de B.\n` +
        `  Antes de culpar a las políticas, verificá que el DSN de aplicación\n` +
        `  corresponda a un rol miembro de control_app y sin BYPASSRLS.`
    );
    process.exit(2);
  }

  if (VERBOSE) {
    console.log(`  · Escenario verificado: A ve ${aCount} propio(s), 0 de B.`);
  }
}

// =============================================================================
// 1 · Descubrimiento del catálogo real de tablas
//
// Los esquemas se descubren desde `pg_namespace`, igual que hace
// `app.assert_rls_coverage()` (0008) y `lint_rls_coverage.sql`. Los tres tienen
// que coincidir: si este archivo usara una lista fija y la aserción no, podrían
// discrepar y dejar un esquema nuevo sin cubrir sin que nadie se entere.
//
// Se excluyen los esquemas de sistema, los temporales y los que pertenecen a una
// extensión — exactamente los mismos criterios que la aserción.
// =============================================================================
const PROJECT_SCHEMA_PREDICATE = `
  n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
  AND n.nspname NOT LIKE 'pg_temp%'
  AND n.nspname NOT LIKE 'pg_toast_temp%'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.objid
    WHERE d.objid = n.oid AND d.deptype = 'e'
  )
  -- 'ops' es infraestructura de plataforma: no tiene tenant_id y está exenta por
  -- nombre en assert_rls_coverage(). Se excluye acá para que las dos listas
  -- coincidan en vez de que ésta lo incluya por accidente.
  AND n.nspname <> 'ops'
`;

async function discoverTables() {
  // `::text` en cada booleano: con las banderas que usa esta suite
  // (`--tuples-only --no-align`), PostgreSQL 16 los renderiza `true`/`false`,
  // no `t`/`f`. Comparar contra `'t'` daba falso SIEMPRE y la suite reportaba
  // que ninguna tabla tiene FORCE RLS — un falso negativo masivo que habría
  // mandado a "arreglar" 17 tablas que ya estaban correctas.
  const out = await sql(`
SELECT n.nspname || '.' || c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
     AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p')
  AND ${PROJECT_SCHEMA_PREDICATE}
ORDER BY 1;
`);

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [fq, enabled, forced] = line.split('|');
      const [schema, table] = fq.split('.');
      return { schema, table, fq, enabled: isTrue(enabled), forced: isTrue(forced) };
    });
}

// =============================================================================
// A · Cobertura de políticas
// =============================================================================
async function testCoverage(tables) {
  console.log('\n\u25b6 A · Cobertura de políticas RLS');

  assert(tables.length > 0, 'Se descubrieron tablas con tenant_id');

  for (const t of tables) {
    assert(
      t.forced,
      `${t.fq}: FORCE ROW LEVEL SECURITY activo`,
      'Sin FORCE, el owner y las migraciones ven todos los inquilinos.'
    );

    const count = await sql(
      `SELECT count(*) FROM pg_policy WHERE polrelid = '${t.fq}'::regclass;`
    );

    assert(
      Number(count) > 0,
      `${t.fq}: tiene al menos una política`,
      'Una tabla con tenant_id y cero políticas no filtra nada.'
    );

    // Una política PERMISSIVE cuyo USING sea literalmente `true` anula el
    // aislamiento sin que el conteo lo delate. Hay que mirar la expresión.
    const permissiveTrue = await sql(`
SELECT count(*) FROM pg_policy p
WHERE p.polrelid = '${t.fq}'::regclass
  AND p.polpermissive
  AND pg_get_expr(p.polqual, p.polrelid) = 'true';
`);

    assert(
      Number(permissiveTrue) === 0,
      `${t.fq}: ninguna política permisiva con USING (true)`,
      'Una política permisiva incondicional abre la tabla entera.'
    );
  }

  // Particiones: cada una necesita su propia cobertura.
  //
  // Esto es el defecto que motivó la migración 0008. PostgreSQL evalúa las
  // políticas de la tabla CONSULTADA, no las del padre: una partición sin
  // políticas propias es una tabla sin RLS, aunque el padre tenga FORCE. Como
  // `audit.events` guarda el log encadenado por hash —incluidos los intentos de
  // acceso entre inquilinos—, una partición sin cubrir no es un detalle.
  const parts = await sql(`
SELECT n.nspname || '.' || c.relname || '|' || c.relforcerowsecurity::text ||
       '|' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relispartition
  AND c.relkind IN ('r', 'p')     -- excluir índices particionados (_pkey, _idx)
  AND ${PROJECT_SCHEMA_PREDICATE}
ORDER BY 1;
`);

  const partList = parts
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [fq, forced, pols] = line.split('|');
      return { fq, forced: isTrue(forced), pols: Number(pols) };
    });

  if (partList.length === 0) {
    console.log('  (sin particiones que verificar)');
  }

  for (const p of partList) {
    assert(
      p.forced && p.pols > 0,
      `${p.fq} (partición): FORCE=${p.forced}, políticas=${p.pols}`,
      'PostgreSQL no propaga las políticas del padre: la partición necesita las suyas.'
    );
  }

  return partList;
}

// =============================================================================
// B · Aislamiento de lectura
// =============================================================================
async function testReadIsolation(tables) {
  console.log('\n\u25b6 B · Aislamiento de lectura (empresa A no ve datos de B)');

  for (const t of tables) {
    // Con contexto de A, ninguna fila de B debe aparecer.
    const leaked = await sql(
      withTenant(
        TENANT_A,
        `SELECT count(*) FROM ${t.fq} WHERE tenant_id = '${TENANT_B}'::uuid;`
      )
    );

    assert(
      Number(leaked) === 0,
      `${t.fq}: 0 filas de la empresa B visibles desde A`,
      `Se filtraron ${leaked} filas cruzadas.`
    );

    // Y el complemento: A SÍ debe ver sus propias filas. Un test que sólo
    // busca fugas pasaría con una tabla que no devuelve nada nunca.
    const own = await sql(
      withTenant(
        TENANT_A,
        `SELECT count(*) FROM ${t.fq} WHERE tenant_id = '${TENANT_A}'::uuid;`
      )
    );

    if (own === '0') {
      if (VERBOSE) console.log(`  · ${t.fq}: sin datos propios (tabla sin filas de A)`);
    } else {
      assert(
        Number(own) > 0,
        `${t.fq}: la empresa A ve sus propias filas (${own})`,
        'Un filtro demasiado agresivo es un bug tan grave como una fuga.'
      );
    }
  }
}

// =============================================================================
// C · Aislamiento de escritura
// =============================================================================
async function testWriteIsolation(tables) {
  console.log('\n\u25b6 C · Aislamiento de escritura (A no puede escribir en B)');

  // C.1 · UPDATE sobre filas ajenas: debe afectar 0 filas, no lanzar error.
  //
  // Se acepta también el RECHAZO por privilegio. Hay dos capas que pueden
  // frenar la escritura —el privilegio de tabla (GRANT) y la política RLS— y
  // cuál de las dos actúa primero depende de la tabla: las append-only
  // (`audit.events`, `app.stock_movements`, `logistics.tracking_events`) no
  // otorgan UPDATE a la aplicación, así que PostgreSQL corta antes de evaluar
  // RLS. Exigir "0 filas afectadas y sin error" obligaba a OTORGAR un privilegio
  // que el diseño prohíbe, sólo para poder medir la política de abajo. Un
  // rechazo por privilegio es una garantía más fuerte que un UPDATE que no
  // encuentra filas: la escritura no se intentó siquiera.
  for (const t of tables) {
    const res = await trySql(
      withTenant(
        TENANT_A,
        `WITH u AS (
           UPDATE ${t.fq} SET tenant_id = tenant_id
           WHERE tenant_id = '${TENANT_B}'::uuid
           RETURNING 1
         ) SELECT count(*) FROM u;`
      )
    );

    if (!res.ok) {
      assert(
        /permiso denegado|permission denied/i.test(res.err),
        `${t.fq}: UPDATE sobre filas de B rechazado`,
        `Falló por un motivo distinto al esperado: ${res.err}`
      );
      continue;
    }

    assert(
      Number(res.out) === 0,
      `${t.fq}: UPDATE sobre filas de B afecta 0 filas`,
      `Afectó ${res.out} filas de otro inquilino.`
    );
  }

  // C.2 · DELETE sobre filas ajenas: debe afectar 0 filas o ser rechazado.
  for (const t of tables) {
    const res = await trySql(
      withTenant(
        TENANT_A,
        `WITH d AS (
           DELETE FROM ${t.fq} WHERE tenant_id = '${TENANT_B}'::uuid RETURNING 1
         ) SELECT count(*) FROM d;`
      )
    );

    if (!res.ok) {
      assert(
        /permiso denegado|permission denied/i.test(res.err),
        `${t.fq}: DELETE sobre filas de B rechazado`,
        `Falló por un motivo distinto al esperado: ${res.err}`
      );
      continue;
    }

    assert(
      Number(res.out) === 0,
      `${t.fq}: DELETE sobre filas de B afecta 0 filas`,
      `Borró ${res.out} filas de otro inquilino.`
    );
  }

  // C.3 · INSERT suplantando a B: debe fallar por WITH CHECK.
  const insertable = [
    { fq: 'app.customers', cols: '(tenant_id, code, legal_name, doc_number)',
      vals: (tid) => `('${tid}'::uuid, 'SUPLANT', 'Suplantación', '99999999999')` },
    { fq: 'app.products', cols: '(tenant_id, sku, name)',
      vals: (tid) => `('${tid}'::uuid, 'SUPLANT', 'Suplantación')` },
  ];

  for (const t of insertable) {
    const res = await trySql(
      withTenant(
        TENANT_A,
        `INSERT INTO ${t.fq} ${t.cols} VALUES ${t.vals(TENANT_B)};`
      )
    );

    assert(
      !res.ok,
      `${t.fq}: INSERT con tenant_id de B es rechazado`,
      'La política WITH CHECK debe impedir mover filas a otro inquilino.'
    );
  }

  // C.4 · Mover una fila propia a otro inquilino vía UPDATE: debe fallar.
  for (const t of insertable) {
    const res = await trySql(
      withTenant(
        TENANT_A,
        `UPDATE ${t.fq} SET tenant_id = '${TENANT_B}'::uuid
         WHERE tenant_id = '${TENANT_A}'::uuid;`
      )
    );

    assert(
      !res.ok,
      `${t.fq}: reasignar una fila propia a B es rechazado`,
      'WITH CHECK también aplica al valor nuevo de un UPDATE.'
    );
  }
}

// =============================================================================
// D · Fail-closed sin contexto
//
// El invariante es: sin contexto de inquilino, la consulta no devuelve NINGUNA
// fila de NINGUNA empresa. No es lo mismo que "devuelve 0 filas" a secas.
//
// `app.roles` rompía esa igualdad sin romper el aislamiento: su `tenant_id` es
// NULLABLE a propósito, porque los roles de sistema (owner, admin, vendedor…)
// viven una sola vez y son compartidos. `roles_select` los expone con
// `tenant_id IS NULL` y son 7 filas legítimas. La versión anterior medía
// `count(*)` sobre la tabla entera, así que contaba esos 7 roles globales como
// una fuga — un falso positivo que empujaba a "arreglar" un diseño correcto.
//
// La medición correcta cuenta sólo las filas CON inquilino: ésas son las que no
// deben verse jamás sin contexto. Las filas globales no son de nadie, así que
// no hay nada que filtrar.
// =============================================================================
async function testFailClosed(tables) {
  console.log('\n\u25b6 D · Fail-closed (sin contexto de sesión)');

  for (const t of tables) {
    // Filas que pertenecen a un inquilino concreto: deben ser 0 sin contexto.
    const scoped = await sql(
      withoutTenant(`SELECT count(*) FROM ${t.fq} WHERE tenant_id IS NOT NULL;`)
    );

    assert(
      Number(scoped) === 0,
      `${t.fq}: sin contexto no expone filas de ningún inquilino`,
      `Devolvió ${scoped} filas con tenant_id — el sistema no es fail-closed.`
    );

    // Y de paso: si la tabla tiene filas globales, que se sepa. No es un fallo
    // —hay tablas cuyo tenant_id es anulable por diseño— pero deja constancia
    // de qué se está viendo sin contexto y por qué no cuenta como fuga.
    const global = await sql(
      withoutTenant(`SELECT count(*) FROM ${t.fq} WHERE tenant_id IS NULL;`)
    );

    if (Number(global) > 0) {
      console.log(
        `  · ${t.fq}: ${global} fila(s) global(es) visibles sin contexto ` +
          '(tenant_id NULL por diseño: catálogo compartido)'
      );
    }
  }

  // `SET` sin `LOCAL` sobrevive al COMMIT y contamina la conexión siguiente.
  // Esto verifica que el valor no persiste entre transacciones.
  await trySql(
    `SET app.tenant_id = '${TENANT_A}';` // a propósito, sin LOCAL
  );
  const after = await sql(`SELECT coalesce(current_setting('app.tenant_id', true), '');`);
  assert(
    after === '' || after === 'null',
    'SET sin LOCAL no deja el tenant pegado en la conexión',
    `current_setting quedó en "${after}". Con pooling, eso filtra el inquilino al request siguiente.`
  );
}

// =============================================================================
// E · La aserción de build existe y es invocable
// =============================================================================
async function testAssertionExists() {
  console.log('\n\u25b6 E · Aserción de cobertura instalada');

  const exists = await sql(
    `SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app' AND p.proname = 'assert_rls_coverage';`
  );

  assert(
    Number(exists) === 1,
    'app.assert_rls_coverage() existe',
    'Es la barrera que falla el build ante una tabla nueva sin política (F0-AC2).'
  );

  if (Number(exists) === 1) {
    const res = await trySql('SELECT app.assert_rls_coverage();');
    assert(
      res.ok,
      'app.assert_rls_coverage() pasa sobre el esquema actual',
      res.err || ''
    );
  }
}

// =============================================================================
// F · Ledger de jobs: invariantes de concurrencia y de exención de tenant
//
// `ops` es infraestructura de plataforma y `0011` le hizo REVOKE ALL a
// `control_app`: la aplicación de negocio no toca el ledger. Por eso las
// escrituras de esta sección van por la conexión administrativa, y la lectura
// se hace por donde corresponda según el privilegio que se quiera verificar.
// =============================================================================
async function testJobLedger() {
  console.log('\n\u25b6 F · Ledger de jobs programados');

  // F.1 · El ledger existe. Sin él, "el job corrió" no es verificable.
  const tables = await sql(`
SELECT count(*) FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ops' AND c.relname IN ('jobs', 'job_runs') AND c.relkind = 'r';
`);

  assert(
    Number(tables) === 2,
    'ops.jobs y ops.job_runs existen',
    'El ledger es lo que permite responder "¿cuándo corrió esto por última vez?".'
  );

  if (Number(tables) !== 2) return;

  // F.2 · El catálogo tiene los jobs declarados. Un ledger vacío es
  //       indistinguible de "nunca corrió nada".
  const jobs = await sqlAdmin(`SELECT count(*) FROM ops.jobs WHERE is_active;`);
  assert(
    Number(jobs) >= 4,
    `ops.jobs tiene los jobs esperados (${jobs})`,
    'Un catálogo vacío haría que la vista de salud no reporte nada.'
  );

  // F.3 · ops NO debe tener tenant_id. Es infraestructura de plataforma, y la
  //       aserción de cobertura lo exime por nombre. Si alguien le agregara
  //       tenant_id, la exención quedaría mal y el aislamiento sin cubrir.
  const tenantCol = await sql(`
SELECT count(*) FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ops' AND a.attname = 'tenant_id'
  AND a.attnum > 0 AND NOT a.attisdropped;
`);

  assert(
    Number(tenantCol) === 0,
    'ops no tiene columna tenant_id (infraestructura, no dato de negocio)',
    'Si ops tuviera tenant_id, la exención en assert_rls_coverage() sería incorrecta.'
  );

  // F.4 · El índice único que impide dos ejecuciones simultáneas del mismo job.
  const uniq = await sql(`
SELECT count(*) FROM pg_indexes
WHERE schemaname = 'ops' AND indexname = 'uq_job_runs_one_running';
`);

  assert(
    Number(uniq) === 1,
    'existe el índice único de una sola ejecución por job',
    'Sin este índice, dos réplicas podrían correr el mismo job a la vez.'
  );

  // F.5 · El invariante se cumple de verdad: insertar dos ejecuciones vivas del
  //       mismo job debe fallar en la segunda.
  const dup = await trySql(
    `
BEGIN;
INSERT INTO ops.job_runs (job_code, status) VALUES ('partition.maintenance', 'running');
INSERT INTO ops.job_runs (job_code, status) VALUES ('partition.maintenance', 'running');
COMMIT;
`,
    { asAdmin: true }
  );

  assert(
    !dup.ok,
    'dos ejecuciones simultáneas del mismo job son rechazadas por el motor',
    dup.ok ? 'El índice único no está funcionando.' : ''
  );

  // Limpiar la fila que quedó de la prueba.
  await sqlAdmin(
    `DELETE FROM ops.job_runs WHERE job_code = 'partition.maintenance';`
  );

  // F.6 · begin_job_run devuelve NULL cuando ya hay una ejecución en curso, en
  //       vez de lanzar. Es lo que permite que la segunda instancia saltee.
  //
  // Las dos llamadas van en transacciones separadas a propósito: la primera
  // deja la fila viva (COMMIT), la segunda tiene que encontrarla y devolver NULL.
  const first = await sqlAdmin(`
BEGIN;
SELECT COALESCE(ops.begin_job_run('partition.maintenance', 'test-host-1')::text, 'NULL') AS r;
COMMIT;
`);

  assert(
    first !== 'NULL' && first !== '',
    'begin_job_run devuelve un id cuando el job está libre',
    `Devolvió "${first}".`
  );

  const second = await sqlAdmin(`
BEGIN;
SELECT COALESCE(ops.begin_job_run('partition.maintenance', 'test-host-2')::text, 'NULL') AS r;
ROLLBACK;
`);

  assert(
    second === 'NULL' || second === '',
    'begin_job_run devuelve NULL si ya hay una ejecución en curso',
    `Devolvió "${second}". La segunda instancia debe saltear, no fallar.`
  );

  // La primera fila quedó viva tras el COMMIT: cerrarla es parte del contrato.
  await sqlAdmin(`
BEGIN;
SELECT ops.finish_job_run(id, true, '{}'::jsonb, NULL) FROM ops.job_runs
WHERE job_code = 'partition.maintenance' AND status = 'running';
COMMIT;
`);

  // F.7 · La vista de salud responde. Es la consulta que consume el monitoreo.
  const health = await trySql('SELECT code, is_overdue FROM ops.v_job_health;', {
    asAdmin: true,
  });
  assert(health.ok, 'ops.v_job_health es consultable', health.err || '');

  // F.8 · Cerrar una ejecución deja la fila cerrada, no colgada.
  //
  // `finish_job_run` devuelve `void`: `SELECT` sobre ella da una celda VACÍA, no
  // una fila con datos. La versión anterior de esta prueba afirmaba
  // `closed !== ''` sobre ese vacío, así que **nunca podía pasar** — un defecto
  // de la prueba, no del código. Lo que hay que verificar es el efecto sobre la
  // fila: que pase de `running` a `succeeded` y que `finished_at` quede puesto.
  // Un ledger que dice "corrió" pero deja la fila abierta bloquea el job para
  // siempre, que es justo lo que el índice único parcial castiga.
  await sqlAdmin(`
BEGIN;
INSERT INTO ops.job_runs (job_code, status) VALUES ('partition.retention', 'running');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT ops.finish_job_run(id, true, '{}'::jsonb, NULL) FROM ops.job_runs
WHERE job_code = 'partition.retention' AND status = 'running';
COMMIT;
`);

  const closedState = await sqlAdmin(`
SELECT status || '|' || (finished_at IS NOT NULL)::text FROM ops.job_runs
WHERE job_code = 'partition.retention'
ORDER BY id DESC LIMIT 1;
`);

  assert(
    closedState === 'succeeded|true',
    'finish_job_run cerró la ejecución viva',
    `La fila quedó en "${closedState}" (esperado "succeeded|true"): ` +
      'la ejecución no se cerró y el job quedaría bloqueado.'
  );

  // Segunda pasada: ya no hay filas en 'running', así que el SELECT no devuelve
  // nada. El punto es que NO falle por eso — el cierre tiene que ser idempotente.
  const closedAgain = await trySql(
    `
BEGIN;
SELECT ops.finish_job_run(id, true, '{}'::jsonb, NULL) FROM ops.job_runs
WHERE job_code = 'partition.retention';
COMMIT;
`,
    { asAdmin: true }
  );

  assert(
    closedAgain.ok,
    'finish_job_run es idempotente (cerrar dos veces no falla)',
    closedAgain.err || ''
  );

  // F.9 · La aplicación NO debe poder escribir el ledger. Si `control_app`
  //       pudiera, el ledger dejaría de ser evidencia de plataforma: la empresa
  //       podría inventar sus propias ejecuciones.
  const appWrite = await trySql(
    `INSERT INTO ops.job_runs (job_code, status) VALUES ('partition.maintenance', 'running');`
  );

  assert(
    !appWrite.ok,
    'la aplicación no puede escribir en ops.job_runs (el ledger es de plataforma)',
    'Si control_app pudiera insertar, el ledger dejaría de ser evidencia confiable.'
  );

  await sqlAdmin(`DELETE FROM ops.job_runs WHERE job_code IN ('partition.maintenance', 'partition.retention');`);
}

// =============================================================================
// Guardia de rol · Defecto A
//
// El superusuario de PostgreSQL ignora RLS **siempre**, incluso con FORCE ROW
// LEVEL SECURITY, y `BYPASSRLS` hace lo mismo para un rol no superusuario. Si la
// suite corre con ese DSN, cada `SELECT count(*)` devuelve las filas de todos los
// inquilinos, las aserciones de fuga fallan... o peor: si nadie mira, un DSN de
// superusuario con las tablas vacías reporta OK sin haber probado nada.
//
// Por eso la guardia aborta en vez de advertir. Un falso negativo ruidoso es
// infinitamente preferible a un falso positivo silencioso en la única barrera
// que impide que una empresa lea los datos de otra.
//
// Se consulta `pg_has_role` en lugar del nombre del rol: así la suite funciona
// con cualquier login (`app_login`, `app_test`, el que sea) mientras sea miembro
// de `control_app`. Atarlo a un nombre obligaría a tocar este archivo cada vez
// que alguien cambie cómo se llama el rol.
// =============================================================================
async function assertAppRole() {
  console.log('\n\u25b6 Guardia de rol (la suite debe correr como rol de aplicación)');

  // `::text` en cada booleano en vez de confiar en cómo psql lo formatee.
  //
  // Con `--no-align`, PostgreSQL 16 renderiza un boolean como `true`/`false`;
  // con la salida alineada clásica, como `t`/`f`. La versión anterior comparaba
  // contra `'t'`, así que con las banderas que realmente usa esta suite
  // (`--tuples-only --no-align`) la comparación daba siempre falsa y la guardia
  // abortaba un entorno perfectamente válido. El mensaje culpaba a la
  // membresía del rol, que estaba bien: el defecto era de formato, no de
  // permisos. Castear en el SQL elimina la dependencia del formato de psql.
  const row = await sql(`
SELECT current_user
     || '|' || (rolsuper OR rolbypassrls)::text
     || '|' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcanlogin)::text
     || '|' || pg_has_role(current_user, 'control_app', 'MEMBER')::text
     || '|' || (SELECT count(*) FROM pg_roles WHERE rolname = 'control_app')::text
FROM pg_roles
WHERE rolname = current_user;
`);

  const [user, privileged, canLogin, isMember, parentExists] = row.split('|');

  if (Number(parentExists) === 0) {
    console.error(
      `\n  El rol \`control_app\` no existe en esta base.\n` +
        `  Lo crea la migración 0007. ¿Se aplicaron las migraciones?\n`
    );
    process.exit(2);
  }

  if (isTrue(privileged)) {
    console.error(
      `\n  ABORTADO: la suite se conectó como \`${user}\`, que es superusuario o\n` +
        `  tiene BYPASSRLS.\n\n` +
        `  Ese rol IGNORA las políticas RLS aunque las tablas tengan FORCE ROW\n` +
        `  LEVEL SECURITY. Correr la suite así no probaría el aislamiento: daría\n` +
        `  "OK" con las políticas rotas.\n\n` +
        `  Pasá un DSN de aplicación:\n` +
        `    --dsn "postgres://app_login:...@host:5432/db"\n` +
        `  y dejá el de superusuario sólo para --admin-dsn.\n`
    );
    process.exit(2);
  }

  if (!isTrue(isMember)) {
    console.error(
      `\n  ABORTADO: el rol \`${user}\` no es miembro de \`control_app\`.\n\n` +
        `  La suite necesita los privilegios de ese rol para ejercitar las\n` +
        `  políticas reales de la aplicación. Un rol sin privilegios reportaría\n` +
        `  "permiso denegado" en vez de medir aislamiento, y un rol demasiado\n` +
        `  privilegiado saltearía las políticas.\n\n` +
        `  Creá el login con:\n` +
        `    CREATE ROLE app_login LOGIN PASSWORD '...' IN ROLE control_app;\n`
    );
    process.exit(2);
  }

  if (!isTrue(canLogin)) {
    console.warn(
      `  Aviso: \`${user}\` no tiene LOGIN pero la conexión funcionó (¿SET ROLE desde psqlrc?).`
    );
  }

  console.log(`  \u2713 Rol de aplicación confirmado: \`${user}\` (miembro de control_app, sin BYPASSRLS)`);

  if (DSN === ADMIN_DSN) {
    console.warn(
      '  Aviso: --admin-dsn no se especificó; se usa el mismo DSN de aplicación\n' +
        '         para preparar el escenario. Si la preparación falla por permisos,\n' +
        '         pasá un DSN administrativo aparte.'
    );
  }
}

// =============================================================================
// Ejecución
// =============================================================================
async function main() {
  console.log('='.repeat(70));
  console.log(' Suite de aislamiento multi-tenant · Control');
  console.log('='.repeat(70));

  // Verificar que psql responde antes de empezar.
  try {
    await sql('SELECT 1;');
  } catch (e) {
    console.error(
      '\nNo se pudo conectar a PostgreSQL.\n' +
        'Verificá que `psql` esté en el PATH y que la cadena de conexión sea válida.\n\n' +
        String(e.stderr || e.message)
    );
    process.exit(2);
  }

  // La guardia va ANTES de tocar nada: si el rol no sirve, todo lo que venga
  // después es ruido.
  await assertAppRole();

  await setup();
  const tables = await discoverTables();

  console.log(`\nTablas con tenant_id descubiertas: ${tables.length}`);
  for (const t of tables) console.log(`  · ${t.fq}`);

  await testCoverage(tables);
  await testReadIsolation(tables);
  await testWriteIsolation(tables);
  await testFailClosed(tables);
  await testAssertionExists();
  await testJobLedger();

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log(` RESULTADO: OK · ${passCount} verificaciones aprobadas`);
    console.log('='.repeat(70));
    process.exit(0);
  } else {
    console.log(` RESULTADO: FALLA · ${failures.length} problema(s), ${passCount} aprobadas`);
    console.log('='.repeat(70));
    for (const f of failures) console.log(`\n\u2717 ${f.label}\n  ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nError inesperado en la suite:', e);
  process.exit(2);
});
