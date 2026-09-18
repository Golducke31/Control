#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de invariantes de cobros y tesorería (E4)
 * -----------------------------------------------------------------------------
 * QUÉ PRUEBA
 *
 * La fase E4 del plan tiene un gate medible, en §7.1: **"Saldo de tesorería
 * cuadra con movimientos"**. Este archivo lo MIDE en vez de declararlo, sobre los
 * criterios de §6.2, bloque "Cobros y tesorería":
 *
 *   T-1  un cobro imputado a varias facturas deja cada saldo correcto
 *   T-2  la nota de crédito aplicada reduce el saldo de su factura origen
 *   T-3  el saldo por cliente cuadra con los documentos abiertos
 *   T-4  un cheque rechazado revierte el movimiento de fondos
 *   T-5  un cheque depositado y no acreditado no aumenta el saldo disponible
 *   T-6  la conciliación bancaria cuadra el extracto contra los movimientos
 *   T-7  el saldo de tesorería cuadra con los movimientos
 *
 * T-1..T-3 son de `0015`, T-4..T-7 de `0016`. Se prueban juntos porque la
 * promesa es una sola cadena: el cliente debe → cobra → el dinero entra a una
 * cuenta → el saldo de esa cuenta refleja el cobro. Una suite que probara cada
 * migración por separado podría estar verde con la cadena rota en el medio.
 *
 * LA PREGUNTA QUE IMPORTA
 *
 * No es "¿la función se porta bien?" sino "¿un camino que se saltee la función
 * puede dejar los datos en un estado que la promesa prohíbe?". Por eso:
 *
 *   · El cheque se deposita y se acredita por `transition_check`, pero la
 *     invariante 5 verifica que el SALDO no se mueva hasta `cleared` —midiendo la
 *     cuenta y el conteo de movimientos, no el estado del cheque.
 *   · La invariante 6 (T-4) intenta un `UPDATE` directo sobre el movimiento para
 *     comprobar que el motor lo rechaza. Una validación que sólo vive adentro de
 *     una función se saltea con un script.
 *   · La invariante 10 verifica que NO exista una columna de saldo materializado
 *     en `treasury.accounts`, y que `assert_balances_reconcile()` levante una
 *     excepción si alguien la agrega. Es la forma en que el saldo acumulado
 *     vuelve al sistema después de haber sido diseñado afuera.
 *
 * POR QUÉ CADA PRUEBA ES UNA CONEXIÓN APARTE
 *
 * Igual que `tests/accounting/run.mjs` y `tests/purchasing/run.mjs`: un rechazo
 * esperado aborta la transacción. Compartir conexión haría que la primera prueba
 * que ESPERA un error dejara la sesión abortada y las siguientes fallaran por
 * arrastre, con mensajes que parecen defectos de la migración.
 *
 * POR QUÉ DOS DSN
 *
 * Las invariantes corren como rol de APLICACIÓN —la única forma de que el
 * aislamiento se pruebe de verdad— y la preparación y limpieza del escenario como
 * rol de PLATAFORMA. No es comodidad: `treasury.movements` es inmutable para el
 * rol de aplicación (el UPDATE está revocado Y hay un trigger que lo rechaza), así
 * que un rol de aplicación no puede limpiar su propio escenario.
 *
 * USO
 *
 *   node tests/treasury/run.mjs \
 *     --dsn "postgres://app_login:...@localhost:5432/control" \
 *     --admin-dsn "postgres://postgres:...@localhost:5432/control" --verbose
 *
 * Requiere `psql` en el PATH (o `PG_BIN` apuntando a su carpeta).
 * Salida: 0 si todo pasa · 1 si una promesa no se cumple · 2 si el entorno no sirve.
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PSQL = process.env.PG_BIN
  ? join(process.env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
  : 'psql';

// Empresas y usuarios de prueba. Se crean y destruyen dentro de la suite.
// El rango `f9xx` no lo usa ninguna otra suite (`f1xx` compras, `f2xx`
// aislamiento), así que pueden correr en la misma base sin pisarse.
const TENANT_A = '00000000-0000-4000-f900-0000000000a0';
const TENANT_B = '00000000-0000-4000-f900-0000000000b0';
const USER_A = '00000000-0000-4000-f900-0000000000a1';
const USER_B = '00000000-0000-4000-f900-0000000000b1';

const CAJA_A = '00000000-0000-4000-f900-0000000000c1';
const BANCO_A = '00000000-0000-4000-f900-0000000000c2';
const CAJA_B = '00000000-0000-4000-f900-0000000000c3';

const CHK_1 = '00000000-0000-4000-f900-0000000000d1';
const CHK_2 = '00000000-0000-4000-f900-0000000000d2';
const CHK_3 = '00000000-0000-4000-f900-0000000000d3';

// Rol de sistema `owner` (tenant_id NULL), sembrado por `db/seed/0001_system_catalog.sql`.
// Es el único rol que recibe TODOS los permisos, y la suite lo necesita: sin una
// membresía activa, `app.has_permission()` devuelve false para todo y la política
// `RESTRICTIVE invoices_insert` de `billing.invoices` rechaza la factura de la
// invariante 10. El síntoma era engañoso —un error de RLS en una prueba de
// cobros— porque la causa no estaba en `0015` sino en el escenario.
const ROLE_OWNER = '11111111-1111-1111-1111-000000000001';

let VERBOSE = false;
let passCount = 0;
const failures = [];

// -----------------------------------------------------------------------------
// Argumentos y conexiones
// -----------------------------------------------------------------------------
function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    dsn: process.env.DATABASE_URL || '',
    adminDsn: process.env.ADMIN_DATABASE_URL || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose') VERBOSE = true;
    else if (a === '--dsn') out.dsn = argv[i + 1] ?? '';
    else if (a === '--admin-dsn') out.adminDsn = argv[i + 1] ?? '';
  }
  if (!out.dsn) {
    console.error(
      '\nFalta el DSN de aplicación.\n' +
        '  node tests/treasury/run.mjs --dsn "postgres://app_login:...@host:5432/control"\n'
    );
    process.exit(2);
  }
  // El DSN administrativo NO cae al de aplicación: la limpieza borra
  // `treasury.movements`, que el rol de aplicación no puede modificar ni vaciar.
  if (!out.adminDsn) {
    console.error(
      '\nFalta el DSN administrativo (`--admin-dsn`).\n\n' +
        'La preparación y la limpieza del escenario corren con el rol de plataforma.\n' +
        'El rol de aplicación no puede hacerlas: `treasury.movements` es inmutable —el\n' +
        'UPDATE está revocado y hay un trigger que lo rechaza— así que no puede limpiar\n' +
        'su propio escenario.\n\n' +
        '  node tests/treasury/run.mjs \\\n' +
        '    --dsn "postgres://app_login:...@host:5432/control" \\\n' +
        '    --admin-dsn "postgres://postgres:...@host:5432/control"\n'
    );
    process.exit(2);
  }
  return out;
}

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

const { dsn: DSN, adminDsn: ADMIN_DSN } = parseArgs();
const APP_CONN = splitDsn(DSN);
const ADMIN_CONN = splitDsn(ADMIN_DSN);

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
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          Object.assign(new Error(`psql salió con código ${code}`), { stdout, stderr, code })
        );
    });
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Ejecuta SQL como una transacción única.
 *
 * El SQL va por STDIN y no por `-c`: en Windows el argumento usa la página de
 * códigos ANSI (cp1252) y los acentos del castellano llegan a PostgreSQL como
 * bytes inválidos. Mismo motivo que en el resto de las suites.
 */
async function sql(statements, { asAdmin = false } = {}) {
  const conn = asAdmin ? ADMIN_CONN : APP_CONN;
  const { stdout, stderr } = await spawnPsql(
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
      '-f', '-',
    ],
    {
      env: Object.assign({}, process.env, {
        PGPASSWORD: conn.password,
        PGCLIENTENCODING: 'UTF8',
      }),
      input: statements,
    }
  );
  // Se devuelve stdout Y stderr concatenados, no sólo stdout.
  //
  // Es lo contrario de lo que hace el resto de las suites, y es deliberado: acá el
  // stderr NO es sólo ruido de error, es el canal por donde viaja la marca
  // `RESULTADO=` de la que depende `expectRejection`. Devolver sólo stdout hacía
  // que la marca nunca llegara al veredicto y que TODA aserción de rechazo fallara
  // con "la marca no apareció" —incluso cuando el motor había rechazado bien—. Un
  // diagnóstico que no se lee miente igual que no tenerlo.
  //
  // El riesgo del canal único es que un NOTICE se cuele en medio de un valor que
  // una prueba compara por igualdad. Por eso `expectRejection` usa `\echo`, que
  // emite por STDOUT y sin el prefijo `NOTICE:`; y las pruebas que comparan
  // igualdad usan `output()`, que filtra las líneas de diagnóstico.
  return (stdout + (stderr ? '\n' + stderr : '')).trim();
}

/**
 * Sólo el resultado, sin las líneas de diagnóstico de psql.
 *
 * Las pruebas que comparan un valor por igualdad (`=== 'closed'`) tienen que usar
 * esto: si un `NOTICE` del motor se intercala en la salida, la comparación falla
 * por un motivo que no tiene nada que ver con lo que se está probando.
 */
function output(raw) {
  return String(raw)
    .split('\n')
    .filter((l) => !/^(NOTICE|WARNING|DETAIL|HINT|CONTEXT|INFO):/i.test(l.trim()))
    .filter((l) => !/^psql:/.test(l.trim()))
    .join('\n')
    .trim();
}

function sqlAdmin(statements) {
  return sql(statements, { asAdmin: true });
}

/** Ejecuta y devuelve { ok, out, err } sin lanzar. Para las pruebas que ESPERAN un rechazo. */
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
    console.error(
      `  \u2717 ${label}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`
    );
  }
}

function isTrue(v) {
  return v === 'true' || v === 't' || v === true;
}

/**
 * Normaliza un importe a dos decimales para comparar.
 *
 * El SQL devuelve `10000.00`; el número de JavaScript lo lee como 10000. La
 * comparación se hace sobre el número, no sobre el texto, para que `0.00` y `0`
 * sean el mismo valor y una diferencia real de un centavo no se esconda detrás
 * de una diferencia de formato.
 */
function num(v) {
  return Number(String(v).trim() || '0');
}

/**
 * Contexto de sesión por el camino validado de la aplicación.
 *
 * `app.set_tenant_context` es la función que verifica el privilegio; usar
 * `SET LOCAL app.tenant_id` a mano se saltearía esa comprobación y haría que el
 * aislamiento pareciera probado sin haberlo estado. Es la misma trampa que
 * documentó `tests/isolation/run.mjs`.
 */
function withTenant(tenantId, body) {
  return [
    'BEGIN;',
    `SELECT app.set_tenant_context('${tenantId}'::uuid, '${USER_A}'::uuid, false);`,
    body,
    'COMMIT;',
  ].join('\n');
}

/**
 * Bloque que ESPERA un rechazo del motor y falla si no llega.
 *
 * Se usa un `DO` con `EXCEPTION` y no un `SAVEPOINT`/`ROLLBACK`: el `DO` deja el
 * script en un estado limpio —la excepción se atrapa adentro— así que una prueba
 * que espera un error no aborta las siguientes. Un `SAVEPOINT` exige que el
 * llamador se acuerde de volver atrás, y el día que se olvide la prueba siguiente
 * falla por arrastre con un mensaje que no tiene nada que ver.
 *
 * ESTA FUNCIÓN YA INCLUYE SU PROPIA TRANSACCIÓN Y SU PROPIO CONTEXTO DE TENANT.
 * No se la envuelve en `withTenant()`: hacerlo produce dos aperturas de transacción
 * anidadas y dos cierres, el script falla por SINTAXIS, y el veredicto —que busca la
 * marca `CTLVEREDICTO=`— no la encuentra y reporta "la operación pasó" cuando en
 * realidad nunca llegó a ejecutarse. Es un falso verde, y es peor que un falso
 * rojo: hace que una guarda rota parezca una guarda que funciona. Ése fue el
 * defecto que tuvo la primera versión de esta suite, y por eso la transacción se
 * arma acá adentro y en un solo lugar.
 *
 * (Los fragmentos SQL de este comentario se describen en prosa y no se escriben
 * textualmente: `tools/check-suite-sql.mjs` cuenta los `BEGIN` y `COMMIT` del
 * archivo y una frase que empiece con el verbo de apertura se cuenta como un bloque
 * real. El validador hace bien en ser literal; el comentario es el que se adapta.)
 */
function expectRejection(tenantId, body, userId = USER_A) {
  // El veredicto se emite con `RAISE NOTICE` y un prefijo propio y poco probable
  // (`CTLVEREDICTO=`), y `sql()` devuelve stdout Y stderr juntos, así que llega.
  //
  // La marca se emite SIEMPRE, en las dos ramas: `PASO` si el cuerpo terminó sin
  // excepción, `RECHAZADO <sqlstate>` si el motor lo rechazó. Que la marca falte
  // es entonces una señal distinta y muy específica: el script no llegó a
  // ejecutarse (sintaxis, permisos, conexión). Sin esa distinción, un bloque que
  // nunca corrió se lee como "la operación pasó" —el falso verde que esta suite ya
  // tuvo una vez y que es peor que un falso rojo.
  return `
BEGIN;
SELECT app.set_tenant_context('${tenantId}'::uuid, '${userId}'::uuid, false);
DO $block$
BEGIN
  ${body}
  RAISE NOTICE 'CTLVEREDICTO=PASO';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'CTLVEREDICTO=RECHAZADO %', SQLSTATE;
END $block$;
COMMIT;
`;
}

/** Extrae el veredicto de la salida de un `expectRejection`. */
function verdict(res) {
  const text = String(res.out || '') + '\n' + String(res.err || '');
  // La marca la emite `expectRejection` con `RAISE NOTICE`, que psql escribe como
  // `NOTICE:  CTLVEREDICTO=...`. Se busca la clave, no el prefijo de psql, para no
  // atarse al formato de salida de una versión.
  const m = text.match(/CTLVEREDICTO=(\w+)(?:\s+([0-9A-Z]{5}))?/);
  if (m && m[1] === 'RECHAZADO') {
    return { rejected: true, state: m[2] ?? null, raw: text, sawMarker: true };
  }
  // Sin marca, el script NI SIQUIERA llegó al `DO` —falló por sintaxis, permisos o
  // conexión antes de ejecutar el cuerpo—. Se distingue de "la operación pasó"
  // porque el diagnóstico es completamente distinto.
  if (!m) {
    return { rejected: false, state: null, raw: text, sawMarker: false };
  }
  return { rejected: false, state: null, raw: text, sawMarker: true };
}

/** Mensaje de diagnóstico según lo que realmente pasó. */
function verdictDetail(v, extra = '') {
  if (!v.sawMarker) {
    return (
      'La marca CTLVEREDICTO= no apareció: el bloque no llegó a ejecutarse (¿error ' +
      `de sintaxis, de permisos o de conexión antes del DO?). Salida: ${v.raw.trim().slice(0, 400)}` +
      (extra ? `\n${extra}` : '')
    );
  }
  return `La operación pasó y debía ser rechazada.${extra ? ` ${extra}` : ''}`;
}

// =============================================================================
// Guardia de rol
// =============================================================================
async function assertAppRole() {
  console.log('\n\u25b6 Guardia de rol (la suite debe correr como rol de aplicación)');

  const row = await sql(`
SELECT current_user
     || '|' || (rolsuper OR rolbypassrls)::text
     || '|' || pg_has_role(current_user, 'control_app', 'MEMBER')::text
FROM pg_roles WHERE rolname = current_user;
`);

  const [user, privileged, isMember] = row.split('|');

  if (isTrue(privileged)) {
    console.error(
      `\n  ABORTADO: la suite corre como \`${user}\`, que es superusuario o tiene BYPASSRLS.\n\n` +
        '  El superusuario de PostgreSQL ignora RLS siempre, incluso con FORCE ROW LEVEL\n' +
        '  SECURITY. Correr así haría que las pruebas de aislamiento pasaran por la razón\n' +
        '  equivocada, y el aislamiento es justamente lo que hay que verificar.\n\n' +
        '  Pasá un DSN de aplicación (miembro de control_app) en --dsn y dejá el de\n' +
        '  superusuario sólo para --admin-dsn.\n'
    );
    process.exit(2);
  }

  if (!isTrue(isMember)) {
    console.error(
      `\n  ABORTADO: el rol \`${user}\` no es miembro de \`control_app\`.\n\n` +
        '  Sin ese rol, los GRANT de la migración no lo alcanzan y todas las pruebas\n' +
        '  fallarían por permisos en vez de por las garantías que hay que verificar.\n'
    );
    process.exit(2);
  }

  console.log(`  \u2713 Rol confirmado: \`${user}\` (sin BYPASSRLS, miembro de control_app)`);
}

// =============================================================================
// Preparación
// =============================================================================
async function setup() {
  console.log('\n\u25b6 Preparación del escenario');

  // Limpieza idempotente. El orden respeta las claves foráneas: primero lo que
  // depende, después el padre. Sin esto la segunda corrida arrastraría los saldos
  // de la primera y las aserciones de monto fallarían por un motivo que no tiene
  // nada que ver con lo que se está probando.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM treasury.reconciliation_lines WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM treasury.reconciliations      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM treasury.cash_counts          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM treasury.checks               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM treasury.movements            WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.payment_allocations   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.credit_applications   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.payments              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM treasury.accounts             WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoice_items         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoices              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.customers                 WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_balances   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_lines      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_entries    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.mapping_rules      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_roles      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.periods            WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.fiscal_years       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.accounts           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
-- La membresía antes que la empresa y que el usuario: ON DELETE CASCADE la
-- borraría igual, pero el orden explícito documenta la dependencia y evita que un
-- cambio futuro de la FK deje filas huérfanas sin que nadie lo note.
DELETE FROM app.memberships               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                   WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                     WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'tes-sub-a', 'tesoreria-a@test.local', true, 'Tesorero A'),
  ('${USER_B}', 'tes-sub-b', 'tesoreria-b@test.local', true, 'Tesorero B');

INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'tes-a', 'Tesoreria A S.A.',  'Tesoreria A', 'active', 'ARS'),
  ('${TENANT_B}', 'tes-b', 'Tesoreria B S.R.L.', 'Tesoreria B', 'active', 'ARS');

-- Membresía con rol owner. NO es un detalle de comodidad: las políticas RLS de
-- billing.invoices (0006) son RESTRICTIVE y exigen
-- app.has_permission('billing.issue_invoice'), que se resuelve contra
-- app.memberships. Sin la membresía, la factura de la invariante 10 se rechaza
-- con un error de política y la prueba parece un defecto de 0015.
-- Mismo patrón que tests/isolation/run.mjs: un usuario de la suite tiene que ser
-- un miembro real de la empresa, o las políticas que dependen del rol no se
-- ejercitan como se ejercitarían en producción.
INSERT INTO app.memberships (tenant_id, user_id, role_id, is_active)
VALUES
  ('${TENANT_A}', '${USER_A}', '${ROLE_OWNER}', true),
  ('${TENANT_B}', '${USER_B}', '${ROLE_OWNER}', true);
COMMIT;
`);

  // Ejercicio, períodos, plan de cuentas, configuración de cobros y de tesorería,
  // cliente y cuentas de fondos. Con el rol de APLICACIÓN y contexto de inquilino:
  // si `control_app` no puede preparar su propia operación, el módulo no sirve.
  for (const [t, caja, banco, sufijo] of [
    [TENANT_A, CAJA_A, BANCO_A, 'A'],
    [TENANT_B, CAJA_B, null, 'B'],
  ]) {
    const res = await trySql(
      withTenant(
        t,
        `
DO $$
DECLARE
  v_t uuid := '${t}';
  v_fy uuid;
BEGIN
  INSERT INTO accounting.fiscal_years (tenant_id, starts_on, ends_on)
  VALUES (v_t, date_trunc('year', CURRENT_DATE)::date,
               (date_trunc('year', CURRENT_DATE) + interval '1 year - 1 day')::date)
  RETURNING id INTO v_fy;

  INSERT INTO accounting.periods (tenant_id, fiscal_year_id, period_number, starts_on, ends_on)
  SELECT v_t, v_fy, g,
         (date_trunc('year', CURRENT_DATE) + (g - 1) * interval '1 month')::date,
         (date_trunc('year', CURRENT_DATE) + g * interval '1 month' - interval '1 day')::date
  FROM generate_series(1, 12) g;

  -- Plan de cuentas, roles y reglas: cobros (0015) y tesorería (0016). El orden
  -- importa: cada seed copia el plan si falta y resuelve códigos contra él.
  PERFORM billing.seed_tenant_collections_config(v_t);
  PERFORM treasury.seed_tenant_treasury_config(v_t);

  INSERT INTO app.customers (tenant_id, code, legal_name, trade_name, doc_type, doc_number)
  VALUES (v_t, 'CLI-${sufijo}', 'Cliente ${sufijo} S.A.', 'Cliente ${sufijo}', '80', '3071111111${sufijo === 'A' ? '1' : '2'}');
END $$;
`
      )
    );
    if (!res.ok) {
      console.error(`\n  No se pudo preparar el escenario de ${t}:\n${res.err}`);
      process.exit(2);
    }
  }

  // Cuentas de fondos. Caja con saldo inicial declarado 10.000 (que TIENE que
  // materializarse como movimiento: es lo que verifica la invariante 10) y banco
  // con 0, para que el saldo del banco arranque limpio y toda variación sea
  // atribuible a lo que la prueba hace.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO treasury.accounts (id, tenant_id, code, name, kind, currency, opening_balance, opened_on)
VALUES
  ('${CAJA_A}',  '${TENANT_A}', 'CAJA-A',  'Caja A',           'cash', 'ARS', 10000.00, CURRENT_DATE),
  ('${BANCO_A}', '${TENANT_A}', 'BANCO-A', 'Banco A cta cte',  'bank', 'ARS',     0.00, CURRENT_DATE),
  ('${CAJA_B}',  '${TENANT_B}', 'CAJA-B',  'Caja B',           'cash', 'ARS',  5000.00, CURRENT_DATE);
COMMIT;
`);

  console.log('  \u2713 Escenario preparado (2 empresas, 3 cuentas de fondos)');
}

// =============================================================================
// 1 · Aislamiento entre empresas
// =============================================================================
async function testIsolation() {
  console.log('\n\u25b6 Invariante 1 · aislamiento entre empresas');

  const vistasPorB = await sql(
    withTenant(
      TENANT_B,
      `
SELECT (SELECT count(*) FROM treasury.accounts  WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.checks    WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.v_account_balances WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.v_treasury_position WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.v_account_statement WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM treasury.v_check_portfolio WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM billing.v_customer_balances WHERE tenant_id = '${TENANT_A}')::text;
`
    )
  );

  const [cuentas, movs, cheques, v1, v2, v3, v4, vCobros] = vistasPorB.split('|').map(num);

  assert(cuentas === 0, 'B NO ve las cuentas de fondos de A', `Vio ${cuentas}`);
  assert(movs === 0, 'B NO ve los movimientos de A', `Vio ${movs}`);
  assert(cheques === 0, 'B NO ve los cheques de A', `Vio ${cheques}`);
  assert(v1 === 0, 'la vista de saldos respeta el aislamiento', `Vio ${v1} filas de A. La vista perdió security_invoker.`);
  assert(v2 === 0, 'la vista de posición de tesorería respeta el aislamiento', `Vio ${v2} filas de A.`);
  assert(v3 === 0, 'el extracto de cuenta respeta el aislamiento', `Vio ${v3} filas de A.`);
  assert(v4 === 0, 'la cartera de cheques respeta el aislamiento', `Vio ${v4} filas de A.`);
  assert(vCobros === 0, 'la vista de saldos por cliente respeta el aislamiento (0015)', `Vio ${vCobros} filas de A.`);

  // Escritura cruzada. Las claves se resuelven desde el rol de plataforma: si las
  // pidiera B, RLS le devolvería vacío y el INSERT no intentaría escribir nada —un
  // `INSERT ... SELECT` vacío termina en éxito sin que el WITH CHECK se evalúe— y
  // la prueba pasaría sin haber probado nada.
  const idsDeA = await sqlAdmin(
    `SELECT id::text FROM treasury.accounts
      WHERE tenant_id = '${TENANT_A}' AND code = 'CAJA-A' LIMIT 1;`
  );
  const cajaDeA = String(idsDeA).trim();

  assert(!!cajaDeA, 'se resolvió la cuenta de A para intentar la escritura cruzada', `id=${cajaDeA}`);

  const escrituraCruzada = await trySql(
    withTenant(
      TENANT_B,
      `
INSERT INTO treasury.checks
  (tenant_id, check_number, drawer_name, amount, due_date, received_on, state)
VALUES ('${TENANT_A}', 'CH-CRUZADO', 'Intruso', 1000, CURRENT_DATE, CURRENT_DATE, 'in_portfolio');
`
    )
  );

  assert(
    !escrituraCruzada.ok,
    'B NO puede escribir un cheque en nombre de A',
    'El INSERT cruzado pasó: el WITH CHECK de la política no está aplicando.'
  );

  const residuo = await sqlAdmin(
    `SELECT count(*)::text FROM treasury.checks
      WHERE tenant_id = '${TENANT_A}' AND check_number = 'CH-CRUZADO';`
  );
  assert(num(residuo) === 0, 'el intento cruzado no dejó ninguna fila escrita para A', `Quedaron ${residuo} filas.`);

  // Un cobro apuntando a una cuenta de OTRA empresa tiene que ser imposible: la FK
  // es compuesta (tenant_id, treasury_account_id), así que ni con el tenant
  // correcto se puede referenciar un recurso ajeno.
  const fkCruzada = await trySql(
    withTenant(
      TENANT_B,
      `
INSERT INTO billing.payments
  (tenant_id, customer_id, method, amount, treasury_account_id)
SELECT '${TENANT_B}', c.id, 'cash', 100, '${cajaDeA}'
FROM app.customers c WHERE c.tenant_id = '${TENANT_B}' LIMIT 1;
`
    )
  );

  assert(
    !fkCruzada.ok,
    'un cobro de B NO puede apuntar a una cuenta de fondos de A',
    'La FK compuesta (tenant_id, treasury_account_id) no está aplicando.'
  );
}

// =============================================================================
// 2 · Cobertura RLS del esquema de tesorería
// =============================================================================
async function testRlsCoverage() {
  console.log('\n\u25b6 Invariante 2 · cobertura RLS de las tablas de tesorería');

  const row = await sql(`
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'treasury' AND c.relkind = 'r')::text
  || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'treasury' AND c.relkind = 'r' AND c.relforcerowsecurity)::text
  || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'treasury' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                  AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))::text
  || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'treasury' AND c.relkind = 'v'
      AND 'security_invoker=true' = ANY(COALESCE(c.reloptions, '{}')))::text
  || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'treasury' AND c.relkind = 'v')::text;
`);

  const [tablas, conForce, sinPolitica, vistasSi, vistas] = row.split('|').map(num);

  assert(tablas >= 7, 'las tablas del esquema treasury existen', `Encontró ${tablas}`);
  assert(
    conForce === tablas - 1,
    'todas las tablas con tenant_id tienen FORCE RLS (la de transiciones está exenta)',
    `Con FORCE: ${conForce} de ${tablas}. La única exenta es treasury.check_state_transitions, que es de plataforma.`
  );
  assert(sinPolitica === 0, 'ninguna tabla con tenant_id quedó sin política', `${sinPolitica} sin política`);
  assert(
    vistasSi === vistas,
    'TODAS las vistas de tesorería tienen security_invoker',
    `${vistasSi} de ${vistas}. Una vista sin security_invoker lee datos de todas las empresas en silencio.`
  );

  // La aserción del motor tiene que pasar. Es la barrera que corre en la migración
  // y en el lint de CI; si acá falla, el lint también va a fallar, pero acá el
  // mensaje llega antes.
  const cobertura = await trySql('SELECT app.assert_rls_coverage();');
  assert(cobertura.ok, 'app.assert_rls_coverage() pasa', cobertura.err || '');
}

// =============================================================================
// 3 · T-5 · El cheque no es dinero hasta que se acredita
// =============================================================================
async function testCheckIsNotMoneyUntilCleared() {
  console.log('\n\u25b6 Invariante 3 · T-5 · un cheque en cartera o depositado NO es fondos');

  // Cheque de 50.000 que entra a cartera apuntando al banco.
  await sql(
    withTenant(
      TENANT_A,
      `
INSERT INTO treasury.checks (id, tenant_id, check_number, drawer_name, amount, due_date,
                             received_on, state, account_id)
VALUES ('${CHK_1}', '${TENANT_A}', 'CH-1001', 'Librador Uno S.A.', 50000.00,
        CURRENT_DATE, CURRENT_DATE, 'in_portfolio', '${BANCO_A}');
`
    )
  );

  // En cartera: el saldo del banco tiene que seguir en 0 y no puede haber
  // movimiento. La cartera SÍ muestra los 50.000 como activo: la distinción es
  // entre "activo contingente" y "dinero disponible".
  const cartera = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements WHERE account_id = '${BANCO_A}')::text
    || '|' || (SELECT COALESCE(SUM(amount), 0)::text FROM treasury.v_check_portfolio
                WHERE state = 'in_portfolio' AND tenant_id = '${TENANT_A}')::text;
`
    )
  );
  const [saldoCartera, movsCartera, activoCartera] = cartera.split('|');

  assert(num(saldoCartera) === 0, 'T-5 · en cartera el saldo del banco es 0', `Saldo ${saldoCartera}`);
  assert(num(movsCartera) === 0, 'T-5 · en cartera no se emitió ningún movimiento', `${movsCartera} movimientos`);
  assert(num(activoCartera) === 50000, 'T-5 · el cheque figura como activo en cartera', `${activoCartera}`);

  // Depositar. Sigue sin ser dinero: el banco todavía no lo acreditó.
  await sql(
    withTenant(
      TENANT_A,
      `SELECT treasury.transition_check('${TENANT_A}', '${CHK_1}', 'deposited', CURRENT_DATE, '${BANCO_A}');`
    )
  );

  const depositado = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements WHERE account_id = '${BANCO_A}')::text;
`
    )
  );
  const [saldoDep, movsDep] = depositado.split('|');

  assert(num(saldoDep) === 0, 'T-5 · depositado y NO acreditado el saldo sigue en 0', `Saldo ${saldoDep}`);
  assert(num(movsDep) === 0, 'T-5 · depositado y NO acreditado no hay movimiento', `${movsDep} movimientos`);

  // Acreditar. ACÁ nace el dinero.
  await sql(
    withTenant(
      TENANT_A,
      `SELECT treasury.transition_check('${TENANT_A}', '${CHK_1}', 'cleared', CURRENT_DATE, '${BANCO_A}');`
    )
  );

  const acreditado = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements WHERE account_id = '${BANCO_A}')::text
    || '|' || (SELECT movement_id IS NOT NULL FROM treasury.checks WHERE id = '${CHK_1}')::text;
`
    )
  );
  const [saldoAcred, movsAcred, tieneMov] = acreditado.split('|');

  assert(num(saldoAcred) === 50000, 'T-5 · acreditado el saldo del banco pasa a 50.000', `Saldo ${saldoAcred}`);
  assert(num(movsAcred) === 1, 'T-5 · acreditado se emite exactamente un movimiento', `${movsAcred} movimientos`);
  assert(isTrue(tieneMov), 'T-5 · el cheque acreditado queda ligado a su movimiento', 'movement_id NULL');
}

// =============================================================================
// 4 · T-4 · El rechazo revierte el movimiento de fondos
// =============================================================================
async function testRejectionReversesFunds() {
  console.log('\n\u25b6 Invariante 4 · T-4 · un cheque rechazado revierte el movimiento de fondos');

  // Se parte del saldo que dejó la invariante 3 (50.000 en el banco).
  const antes = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text;`)
  ));

  await sql(
    withTenant(
      TENANT_A,
      `
INSERT INTO treasury.checks (id, tenant_id, check_number, drawer_name, amount, due_date,
                             received_on, state, account_id)
VALUES ('${CHK_2}', '${TENANT_A}', 'CH-1002', 'Librador Dos S.R.L.', 30000.00,
        CURRENT_DATE, CURRENT_DATE, 'in_portfolio', '${BANCO_A}');
SELECT treasury.transition_check('${TENANT_A}', '${CHK_2}', 'deposited', CURRENT_DATE, '${BANCO_A}');
SELECT treasury.transition_check('${TENANT_A}', '${CHK_2}', 'cleared',   CURRENT_DATE, '${BANCO_A}');
`
    )
  );

  const trasAcreditar = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text;`)
  ));
  assert(
    trasAcreditar === antes + 30000,
    'T-4 · acreditar el segundo cheque suma 30.000 al saldo',
    `Esperado ${antes + 30000}, obtenido ${trasAcreditar}`
  );

  // EL RECHAZO. El cheque ya estaba acreditado, así que existe un movimiento que
  // revertir: es el caso que el criterio describe.
  await sql(
    withTenant(
      TENANT_A,
      `SELECT treasury.transition_check('${TENANT_A}', '${CHK_2}', 'rejected', CURRENT_DATE, NULL, 'sin fondos');`
    )
  );

  const trasRechazar = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements
                WHERE account_id = '${BANCO_A}' AND reverses_id IS NOT NULL)::text
    || '|' || (SELECT movement_id IS NULL FROM treasury.checks WHERE id = '${CHK_2}')::text
    || '|' || (SELECT rejection_reason FROM treasury.checks WHERE id = '${CHK_2}')::text
    || '|' || (SELECT count(*) FROM treasury.movements
                WHERE source_id = '${CHK_2}' AND kind = 'check_cleared')::text
    || '|' || (SELECT count(*) FROM treasury.movements
                WHERE source_id = '${CHK_2}' AND kind = 'check_rejected')::text;
`
    )
  );
  const [saldoFinal, revertidos, movLimpiado, motivo, originales, reversas] = trasRechazar.split('|');

  assert(
    num(saldoFinal) === antes,
    'T-4 · el rechazo devuelve el saldo exactamente a donde estaba',
    `Esperado ${antes}, obtenido ${saldoFinal}`
  );
  assert(num(revertidos) === 1, 'T-4 · se emitió un contramovimiento', `${revertidos} reversas`);
  assert(isTrue(movLimpiado), 'T-4 · el cheque rechazado ya no apunta a un movimiento', 'movement_id no está NULL');
  assert(String(motivo).includes('sin fondos'), 'T-4 · el motivo del rechazo queda registrado', `motivo=${motivo}`);
  // El movimiento ORIGINAL no se borra: el extracto tiene que mostrar las dos
  // operaciones, porque las dos ocurrieron.
  assert(num(originales) === 1, 'T-4 · el movimiento original NO se borró (es inmutable)', `${originales} originales`);
  assert(num(reversas) === 1, 'T-4 · existe el par original + contramovimiento', `${reversas} reversas`);

  // El contramovimiento apunta al original por `reverses_id`, y su dirección es la
  // opuesta. Sin esto, "revirtió" sería una afirmación sin respaldo.
  const par = await sql(
    withTenant(
      TENANT_A,
      `
SELECT o.direction::text || '|' || o.amount::text
    || '|' || r.direction::text || '|' || r.amount::text
    || '|' || (r.reverses_id = o.id)::text
FROM treasury.movements o
JOIN treasury.movements r ON r.reverses_id = o.id AND r.tenant_id = o.tenant_id
WHERE o.source_id = '${CHK_2}' AND o.kind = 'check_cleared';
`
    )
  );
  const [dirOrig, montoOrig, dirRev, montoRev, apunta] = par.split('|');

  assert(dirOrig === 'credit' && dirRev === 'debit', 'T-4 · el contramovimiento va en dirección opuesta', `${dirOrig} → ${dirRev}`);
  assert(num(montoOrig) === num(montoRev) && num(montoOrig) === 30000, 'T-4 · el contramovimiento es por el mismo monto', `${montoOrig} vs ${montoRev}`);
  assert(isTrue(apunta), 'T-4 · el contramovimiento referencia al original', 'reverses_id no apunta al original');
}

// =============================================================================
// 5 · El rechazo de un cheque nunca acreditado NO inventa un contramovimiento
// =============================================================================
async function testRejectUncreditedDoesNotReverse() {
  console.log('\n\u25b6 Invariante 5 · rechazar un cheque no acreditado no inventa una reversión');

  const antes = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text;`)
  ));

  await sql(
    withTenant(
      TENANT_A,
      `
INSERT INTO treasury.checks (id, tenant_id, check_number, drawer_name, amount, due_date,
                             received_on, state, account_id)
VALUES ('${CHK_3}', '${TENANT_A}', 'CH-1003', 'Librador Tres S.A.', 7000.00,
        CURRENT_DATE, CURRENT_DATE, 'in_portfolio', '${BANCO_A}');
SELECT treasury.transition_check('${TENANT_A}', '${CHK_3}', 'deposited', CURRENT_DATE, '${BANCO_A}');
SELECT treasury.transition_check('${TENANT_A}', '${CHK_3}', 'rejected',  CURRENT_DATE, NULL, 'cuenta cerrada');
`
    )
  );

  const despues = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements WHERE source_id = '${CHK_3}')::text;
`
    )
  );
  const [saldo, movs] = despues.split('|');

  assert(
    num(saldo) === antes,
    'rechazar un cheque nunca acreditado deja el saldo intacto',
    `Esperado ${antes}, obtenido ${saldo}`
  );
  // CERO movimientos: el cheque nunca movió fondos, así que no hay nada que
  // revertir. Emitir un contramovimiento acá inventaría dinero de la nada.
  assert(
    num(movs) === 0,
    'no se emite ningún movimiento por un cheque que nunca acreditó',
    `${movs} movimientos. Un cheque que no movió fondos no tiene nada que revertir.`
  );
}

// =============================================================================
// 6 · La transición inválida la impide el motor
// =============================================================================
async function testInvalidTransitionsBlocked() {
  console.log('\n\u25b6 Invariante 6 · la máquina de estados la impide el motor');

  // `cleared → endorsed` endosaría un cheque cuyo dinero ya está cobrado: sería
  // vender un activo que ya no existe. La arista está ausente a propósito.
  const endoso = verdict(
    await trySql(
      expectRejection(TENANT_A, `PERFORM treasury.transition_check('${TENANT_A}', '${CHK_1}', 'endorsed', CURRENT_DATE, NULL);`)
    )
  );
  assert(endoso.rejected, 'no se puede endosar un cheque ya acreditado', verdictDetail(endoso));

  // `rejected → cleared` saltearía el banco, que es donde se determina si hay
  // fondos. Re-presentarlo es `→ deposited`; acreditarlo directo sería afirmar que
  // el banco lo aceptó sin que lo haya visto.
  const directo = verdict(
    await trySql(
      expectRejection(TENANT_A, `PERFORM treasury.transition_check('${TENANT_A}', '${CHK_3}', 'cleared', CURRENT_DATE, '${BANCO_A}');`)
    )
  );
  assert(directo.rejected, 'no se puede acreditar un cheque rechazado sin re-depositarlo', verdictDetail(directo));

  // Una transición a sí misma no es una transición.
  const misma = verdict(
    await trySql(
      expectRejection(TENANT_A, `PERFORM treasury.transition_check('${TENANT_A}', '${CHK_1}', 'cleared', CURRENT_DATE, '${BANCO_A}');`)
    )
  );
  assert(misma.rejected, 'un cheque no puede "transicionar" al estado en el que ya está', verdictDetail(misma));

  // Y la máquina de estados es una tabla consultable: si el conjunto de aristas
  // válidas estuviera vacío, todas las pruebas de arriba pasarían por la razón
  // equivocada (todo rechaza porque nada está permitido).
  const aristas = num(
    await sql(withTenant(TENANT_B, `SELECT count(*)::text FROM treasury.check_state_transitions;`))
  );
  assert(aristas >= 7, 'la tabla de transiciones tiene las aristas declaradas', `${aristas} aristas`);
}

// =============================================================================
// 7 · El movimiento es inmutable
// =============================================================================
async function testMovementImmutable() {
  console.log('\n\u25b6 Invariante 7 · un movimiento de tesorería no se edita');

  // Por la vía cruda: un UPDATE directo, no una llamada a la función.
  const update = verdict(
    await trySql(
      expectRejection(
        TENANT_A,
        `UPDATE treasury.movements SET amount = 1
          WHERE source_id = '${CHK_1}' AND kind = 'check_cleared';`
      )
    )
  );

  assert(update.rejected, 'un UPDATE directo sobre un movimiento es rechazado', verdictDetail(update));

  // Y el monto no cambió. Una política que "rechaza" sin excepción dejaría también
  // el dato intacto, pero distinguir ambos casos importa.
  const monto = await sqlAdmin(
    `SELECT amount::text FROM treasury.movements
      WHERE source_id = '${CHK_1}' AND kind = 'check_cleared';`
  );
  assert(num(monto) === 50000, 'el monto del movimiento no cambió', `Quedó en ${monto}`);

  // Revertir dos veces el mismo movimiento invertiría el saldo por segunda vez.
  const doble = verdict(
    await trySql(
      expectRejection(
        TENANT_A,
        `PERFORM treasury.reverse_movement('${TENANT_A}',
           (SELECT id FROM treasury.movements
             WHERE source_id = '${CHK_2}' AND kind = 'check_cleared'),
           CURRENT_DATE, 'segunda reversión');`
      )
    )
  );
  assert(doble.rejected, 'un movimiento ya revertido no se puede revertir de nuevo', verdictDetail(doble));

  // El rol de aplicación ni siquiera tiene el privilegio de UPDATE: la defensa está
  // en dos niveles y el trigger no llega a evaluarse. Se verifica el privilegio
  // porque es lo que hace que un script futuro no pueda editar el libro.
  const privilegio = await sql(`
SELECT has_table_privilege(current_user, 'treasury.movements', 'UPDATE')::text;
`);
  assert(
    !isTrue(privilegio),
    'el rol de aplicación NO tiene UPDATE sobre treasury.movements',
    'El privilegio está otorgado: la defensa de más abajo quedó abierta.'
  );
}

// =============================================================================
// 8 · T-7 · El saldo de tesorería cuadra con los movimientos (GATE DE E4)
// =============================================================================
async function testTreasuryBalanceReconciles() {
  console.log('\n\u25b6 Invariante 8 · T-7 · GATE de E4 · el saldo de tesorería cuadra con los movimientos');

  // El gate del motor.
  const gate = await trySql('SELECT treasury.assert_balances_reconcile();');
  assert(gate.ok, 'T-7 · treasury.assert_balances_reconcile() pasa', gate.err || '');

  // Y la igualdad, medida por fuera: para CADA cuenta, la función y la suma directa
  // tienen que dar lo mismo. Se comparan los dos caminos por separado porque el gate
  // podría estar comparando dos veces el mismo cálculo —y entonces pasaría siempre,
  // incluso con el saldo mal.
  const cuentas = await sql(
    withTenant(
      TENANT_A,
      `
SELECT a.code
    || '|' || treasury.account_balance(a.tenant_id, a.id)::text
    || '|' || COALESCE((SELECT SUM(CASE m.direction WHEN 'credit' THEN m.amount
                                                      ELSE -m.amount END)::numeric
                          FROM treasury.movements m
                          WHERE m.tenant_id = a.tenant_id AND m.account_id = a.id), 0)::text
FROM treasury.accounts a WHERE a.tenant_id = '${TENANT_A}' ORDER BY a.code;
`
    )
  );

  const filas = cuentas.split('\n').filter(Boolean).map((l) => l.split('|'));
  assert(filas.length === 2, 'se midieron las dos cuentas de A', `${filas.length} cuentas`);

  for (const [code, desdeFuncion, desdeSuma] of filas) {
    assert(
      num(desdeFuncion) === num(desdeSuma),
      `T-7 · el saldo de ${code} coincide con la suma de sus movimientos`,
      `Función ${desdeFuncion} vs suma directa ${desdeSuma}`
    );
  }

  // El saldo esperado, calculado de forma independiente del motor: caja 10.000 de
  // apertura (sin otros movimientos) y banco 50.000 (la acreditación de CH-1001,
  // con CH-1002 acreditado y revertido y CH-1003 nunca acreditado, que netean 0).
  const caja = filas.find((f) => f[0] === 'CAJA-A');
  const banco = filas.find((f) => f[0] === 'BANCO-A');

  assert(num(caja[1]) === 10000, 'T-7 · la caja cuadra con su saldo inicial', `Caja ${caja[1]}`);
  assert(
    num(banco[1]) === 50000,
    'T-7 · el banco cuadra con lo efectivamente acreditado',
    `Banco ${banco[1]}. Esperado 50000 = 50000 (CH-1001) + 30000 (CH-1002) − 30000 (reversión) + 0 (CH-1003 nunca acreditó)`
  );

  // La vista expone el mismo número que la función: dos pantallas mostrando dos
  // saldos distintos para la misma cuenta sería el defecto que este gate previene.
  const vista = await sql(
    withTenant(
      TENANT_A,
      `
SELECT account_id::text || '|' || balance::text
FROM treasury.v_account_balances WHERE tenant_id = '${TENANT_A}' ORDER BY code;
`
    )
  );
  for (const linea of vista.split('\n').filter(Boolean)) {
    const [accountId, balance] = linea.split('|');
    const esperado = filas.find((f) => {
      const code = f[0];
      return (code === 'CAJA-A' && accountId === CAJA_A) || (code === 'BANCO-A' && accountId === BANCO_A);
    });
    assert(
      esperado !== undefined && num(esperado[1]) === num(balance),
      `T-7 · la vista coincide con la función para la cuenta ${accountId.slice(0, 8)}`,
      `Vista ${balance} vs función ${esperado ? esperado[1] : '(no encontrada)'}`
    );
  }

  // La posición total por moneda tiene que ser la suma de las cuentas. Es la vista
  // que alimenta un reporte de fondos, y si divergiera el reporte mentiría.
  const posicion = await sql(
    withTenant(
      TENANT_A,
      `SELECT total_balance::text FROM treasury.v_treasury_position
        WHERE tenant_id = '${TENANT_A}' AND currency = 'ARS';`
    )
  );
  assert(
    num(posicion) === 60000,
    'T-7 · la posición total de tesorería es la suma de las cuentas',
    `${posicion}. Esperado 60000 = 10000 (caja) + 50000 (banco)`
  );
}

// =============================================================================
// 9 · El saldo NO se materializa
// =============================================================================
async function testNoMaterializedBalance() {
  console.log('\n\u25b6 Invariante 9 · no existe una columna de saldo materializado');

  // Mientras no exista la columna, el gate pasa. Después se INYECTA la columna y
  // se verifica que el gate falle: una aserción que sólo puede pasar no verifica
  // nada, y la manera de saber que detecta el defecto es provocar el defecto.
  const sinColumna = await sqlAdmin(`
SELECT count(*)::text FROM pg_attribute a
WHERE a.attrelid = 'treasury.accounts'::regclass
  AND a.attname IN ('balance', 'current_balance', 'saldo')
  AND a.attnum > 0 AND NOT a.attisdropped;
`);
  assert(num(sinColumna) === 0, 'treasury.accounts no tiene columnas de saldo', `${sinColumna} columnas`);

  // Se agrega la columna con el rol de plataforma, se prueba el gate, y se saca.
  // El `ROLLBACK` garantiza que el esquema quede como estaba aunque algo falle en
  // el medio: la suite no puede dejar la base con una columna de más.
  const mutado = await sqlAdmin(`
BEGIN;
ALTER TABLE treasury.accounts ADD COLUMN balance numeric(14,2);
DO $$
BEGIN
  PERFORM treasury.assert_balances_reconcile(NULL);
  RAISE NOTICE 'CTLVEREDICTO=PASO';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CTLVEREDICTO=RECHAZADO %', SQLSTATE;
END $$;
ROLLBACK;
`);
  const m = verdict({ out: mutado });

  assert(
    m.rejected,
    'el gate DETECTA una columna de saldo inyectada (ensayo de mutación)',
    verdictDetail(m, 'El gate pasó con una columna `balance` presente: la aserción es vacua.')
  );

  // Y la base quedó sin la columna.
  const despues = await sqlAdmin(`
SELECT count(*)::text FROM pg_attribute a
WHERE a.attrelid = 'treasury.accounts'::regclass
  AND a.attname = 'balance' AND a.attnum > 0 AND NOT a.attisdropped;
`);
  assert(num(despues) === 0, 'la columna inyectada se revirtió (el esquema quedó limpio)', `${despues} columnas`);
}

// =============================================================================
// 10 · T-1/T-2/T-3 · Cuentas por cobrar, encadenadas con la tesorería
// =============================================================================
async function testReceivablesChain() {
  console.log('\n\u25b6 Invariante 10 · T-1/T-2/T-3 · cobros imputados y saldo por cliente');

  // Tres facturas: 100.000, 50.000 y 20.000. Un cobro de 150.000 imputado a las
  // dos primeras —T-1: una cobranza sobre varias facturas deja cada saldo
  // correcto— y una nota de crédito de 5.000 sobre la tercera (T-2).
  const armado = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t      uuid := '${TENANT_A}';
  v_cust   uuid;
  v_inv1   uuid := gen_random_uuid();
  v_inv2   uuid := gen_random_uuid();
  v_inv3   uuid := gen_random_uuid();
  v_nc     uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_cust FROM app.customers WHERE tenant_id = v_t AND code = 'CLI-A';

  -- receptor_name e idempotency_key son NOT NULL sin valor por defecto: son parte
  -- de lo que hace fiscalmente válido a un comprobante (identificar al receptor y
  -- no duplicar el CAE). Se completan con datos del cliente, no con constantes,
  -- porque una constante vacía pasaría el NOT NULL y no probaría nada.
  INSERT INTO billing.invoices (id, tenant_id, kind, point_of_sale, doc_type, number,
                                customer_id, issue_date, due_date, subtotal, tax_total, total,
                                receptor_name, receptor_doc_number, idempotency_key, status)
  VALUES
    (v_inv1, v_t, 'invoice', 1, 'B', 1, v_cust, CURRENT_DATE, CURRENT_DATE + 30, 100000, 0, 100000,
     'Cliente A S.A.', '30711111111', 'tes-inv-1', 'authorized'),
    (v_inv2, v_t, 'invoice', 1, 'B', 2, v_cust, CURRENT_DATE, CURRENT_DATE + 30,  50000, 0,  50000,
     'Cliente A S.A.', '30711111111', 'tes-inv-2', 'authorized'),
    (v_inv3, v_t, 'invoice', 1, 'B', 3, v_cust, CURRENT_DATE, CURRENT_DATE + 30,  20000, 0,  20000,
     'Cliente A S.A.', '30711111111', 'tes-inv-3', 'authorized');

  -- T-1: un cobro de 150.000 imputado a las facturas 1 y 2.
  -- La clave del array es invoice_id (snake_case), no invoiceId: el contrato de
  -- estas funciones es SQL y los nombres de sus claves JSON siguen la convención de
  -- las columnas que representan.
  PERFORM billing.apply_customer_collection(
    v_t, v_cust, CURRENT_DATE, 'cash', 150000,
    jsonb_build_array(
      jsonb_build_object('invoice_id', v_inv1, 'amount', 100000),
      jsonb_build_object('invoice_id', v_inv2, 'amount',  50000)
    )
  );

  -- T-2: nota de crédito de 5.000 sobre la factura 3.
  INSERT INTO billing.invoices (id, tenant_id, kind, related_invoice_id, point_of_sale,
                                doc_type, number, customer_id, issue_date, due_date,
                                subtotal, tax_total, total,
                                receptor_name, receptor_doc_number, idempotency_key, status)
  VALUES (v_nc, v_t, 'credit_note', v_inv3, 2, 'B', 1, v_cust, CURRENT_DATE,
          CURRENT_DATE, 5000, 0, 5000,
          'Cliente A S.A.', '30711111111', 'tes-nc-1', 'authorized');

  PERFORM billing.apply_credit_note(v_t, v_nc,
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv3, 'amount', 5000)));
END $$;
SELECT 'FACTURAS=' || string_agg(id::text || ':' || total::text || ':' || COALESCE(paid_total,0)::text
                                 || ':' || COALESCE(credited_total,0)::text
                                 || ':' || COALESCE(payment_status,'NULL'), ','
                                 ORDER BY number)
FROM billing.invoices
WHERE tenant_id = '${TENANT_A}' AND kind = 'invoice';
`
    )
  );

  if (!armado.ok) {
    assert(false, 'T-1/T-2 · se pudo armar el escenario de cobros', armado.err);
    return;
  }

  // El DO no devuelve filas, así que el estado se lee después.
  const estado = await sql(
    withTenant(
      TENANT_A,
      `
SELECT number::text
    || '|' || total::text
    || '|' || COALESCE(paid_total, 0)::text
    || '|' || COALESCE(credited_total, 0)::text
    || '|' || COALESCE(payment_status, 'NULL')
    || '|' || (total - COALESCE(paid_total,0) - COALESCE(credited_total,0) - COALESCE(withheld_total,0))::text
FROM billing.invoices
WHERE tenant_id = '${TENANT_A}' AND kind = 'invoice' AND doc_type = 'B'
ORDER BY number;
`
    )
  );

  const facturas = estado.split('\n').filter(Boolean).map((l) => l.split('|'));
  assert(facturas.length === 3, 'T-1 · se crearon las tres facturas', `${facturas.length} facturas`);

  if (facturas.length === 3) {
    const [f1, f2, f3] = facturas;

    assert(num(f1[2]) === 100000 && num(f1[5]) === 0, 'T-1 · la factura 1 quedó saldada', `Pagado ${f1[2]}, saldo ${f1[5]}`);
    assert(f1[4] === 'paid', 'T-1 · la factura 1 derivó a `paid` sin que nadie lo escriba', `Estado ${f1[4]}`);
    assert(num(f2[2]) === 50000 && num(f2[5]) === 0, 'T-1 · la factura 2 quedó saldada', `Pagado ${f2[2]}, saldo ${f2[5]}`);
    assert(f2[4] === 'paid', 'T-1 · la factura 2 derivó a `paid`', `Estado ${f2[4]}`);

    // T-2: la NC de 5.000 sobre la factura 3 la deja en 15.000 y `partial`.
    assert(num(f3[3]) === 5000, 'T-2 · la nota de crédito se acreditó sobre su factura origen', `Acreditado ${f3[3]}`);
    assert(num(f3[5]) === 15000, 'T-2 · el saldo de la factura origen bajó de 20.000 a 15.000', `Saldo ${f3[5]}`);
    assert(f3[4] === 'partial', 'T-2 · la factura origen quedó en `partial`', `Estado ${f3[4]}`);
  }

  // T-3: el saldo por cliente tiene que ser EXACTAMENTE la suma de los saldos
  // abiertos. Si la vista sumara de más o de menos, acá se ve.
  const saldoCliente = await sql(
    withTenant(
      TENANT_A,
      `
SELECT COALESCE(balance, 0)::text
    || '|' || (SELECT COALESCE(SUM(total - COALESCE(paid_total,0) - COALESCE(credited_total,0)
                                    - COALESCE(withheld_total,0)), 0)::text
                FROM billing.invoices
                WHERE tenant_id = '${TENANT_A}' AND status = 'authorized' AND kind = 'invoice')::text
FROM billing.v_customer_balances
WHERE tenant_id = '${TENANT_A}';
`
    )
  );
  const [saldoVista, saldoDocumentos] = saldoCliente.split('|');

  assert(
    num(saldoVista) === num(saldoDocumentos),
    'T-3 · el saldo por cliente cuadra con los documentos abiertos',
    `Vista ${saldoVista} vs documentos ${saldoDocumentos}`
  );
  assert(num(saldoVista) === 15000, 'T-3 · el saldo del cliente es 15.000', `Saldo ${saldoVista}`);

  // El estado de cuenta muestra el cobro partido en dos imputaciones: una cobranza
  // sobre varias facturas tiene que verse como pagos separados por factura.
  const estadoCuenta = num(
    await sql(
      withTenant(
        TENANT_A,
        `SELECT count(*)::text FROM billing.v_customer_statement WHERE tenant_id = '${TENANT_A}';`
      )
    )
  );
  assert(estadoCuenta >= 6, 'T-3 · el estado de cuenta refleja facturas, cobro y nota de crédito', `${estadoCuenta} filas`);
}

// =============================================================================
// 11 · T-6 · La conciliación bancaria cuadra el extracto
// =============================================================================
async function testBankReconciliation() {
  console.log('\n\u25b6 Invariante 11 · T-6 · la conciliación cuadra el extracto contra los movimientos');

  // Estado actual del banco: 50.000 (CH-1001 acreditado; CH-1002 neto 0; CH-1003
  // nunca acreditó). Se abre una conciliación con el saldo del extracto igual al
  // saldo derivado: tiene que cerrar sin diferencia.
  const conc = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.open_reconciliation('${TENANT_A}', '${BANCO_A}',
         date_trunc('year', CURRENT_DATE)::date, CURRENT_DATE,
         treasury.account_balance('${TENANT_A}', '${BANCO_A}'))::text;
`
    )
  );

  // El id viene en la representación de la fila; se toma de la tabla.
  const recId = String(
    await sql(
      withTenant(
        TENANT_A,
        `SELECT id::text FROM treasury.reconciliations
          WHERE tenant_id = '${TENANT_A}' AND account_id = '${BANCO_A}' ORDER BY created_at DESC LIMIT 1;`
      )
    )
  ).trim();

  assert(!!recId, 'T-6 · la conciliación se abrió', `id=${recId}. Salida: ${conc}`);

  if (recId) {
    const cierre = await trySql(
      withTenant(
        TENANT_A,
        `
SELECT (treasury.close_reconciliation('${TENANT_A}', '${recId}', '${USER_A}', NULL)).status::text;
`
      )
    );
    assert(cierre.ok, 'T-6 · una conciliación que cuadra se cierra sin diferencia', cierre.err || '');
    assert(String(cierre.out).trim() === 'closed', 'T-6 · la conciliación queda en estado `closed`', `Estado ${cierre.out}`);

    // Cerrarla dos veces no es una operación: el estado ya no admite el cambio.
    const recerrar = verdict(
      await trySql(
        expectRejection(
          TENANT_A,
          `PERFORM treasury.close_reconciliation('${TENANT_A}', '${recId}', '${USER_A}', NULL);`
        )
      )
    );
    assert(recerrar.rejected, 'T-6 · no se puede cerrar una conciliación ya cerrada', verdictDetail(recerrar));
  }

  // UNA CONCILIACIÓN QUE NO CUADRA NO SE CIERRA SIN EXPLICAR LA DIFERENCIA.
  // Se abre una segunda con un saldo de extracto deliberadamente distinto y se
  // verifica que el cierre falle; después se cierra CON la nota y tiene que pasar.
  //
  // El período tiene que ser DISTINTO del de la conciliación anterior: hay un
  // UNIQUE (tenant_id, account_id, period_start, period_end) y la primera ya tomó
  // date_trunc('year') .. CURRENT_DATE. Reusarlo no probaba el cierre con
  // diferencia —probaba el índice único— y el error hablaba de "ya hay una
  // conciliación para ese período", que no tiene nada que ver con lo que esta
  // prueba quiere medir. Se usa una ventana de un solo día, hacia atrás.
  const recId2 = String(
    await sql(
      withTenant(
        TENANT_A,
        `
DO $$
DECLARE v_id uuid;
BEGIN
  v_id := (treasury.open_reconciliation('${TENANT_A}', '${BANCO_A}',
            CURRENT_DATE - 1, CURRENT_DATE - 1, 99999.00)).id;
  RAISE NOTICE 'REC2=%', v_id;
END $$;
`
      )
    )
  );

  const sinNota = verdict(
    await trySql(
      expectRejection(
        TENANT_A,
        `PERFORM treasury.close_reconciliation('${TENANT_A}',
           (SELECT id FROM treasury.reconciliations
             WHERE tenant_id = '${TENANT_A}' AND account_id = '${BANCO_A}'
               AND status = 'open' ORDER BY created_at DESC LIMIT 1),
           '${USER_A}', NULL);`
      )
    )
  );
  assert(
    sinNota.rejected,
    'T-6 · una diferencia sin explicar impide cerrar la conciliación',
    verdictDetail(sinNota, 'El cierre pasó con una diferencia de 49.999 sin documentar.')
  );

  const conNota = await trySql(
    withTenant(
      TENANT_A,
      `
SELECT (treasury.close_reconciliation('${TENANT_A}',
          (SELECT id FROM treasury.reconciliations
            WHERE tenant_id = '${TENANT_A}' AND account_id = '${BANCO_A}'
              AND status = 'open' ORDER BY created_at DESC LIMIT 1),
          '${USER_A}', 'Diferencia de la comisión bancaria no informada: $49.999')).status::text;
`
    )
  );
  assert(conNota.ok, 'T-6 · con la diferencia documentada la conciliación cierra', conNota.err || '');
}

// =============================================================================
// 12 · El cobro en efectivo mueve fondos; el cheque no
// =============================================================================
async function testPaymentTriggersMovement() {
  console.log('\n\u25b6 Invariante 12 · el medio de pago decide si hay movimiento de fondos');

  const antes = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${CAJA_A}')::text;`)
  ));

  // Un cobro en efectivo sobre la caja: tiene que dejar un movimiento.
  const cobroEfectivo = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO billing.payments (tenant_id, customer_id, method, amount, treasury_account_id)
SELECT '${TENANT_A}', c.id, 'cash', 3000, '${CAJA_A}'
FROM app.customers c WHERE c.tenant_id = '${TENANT_A}' AND c.code = 'CLI-A';
`
    )
  );
  assert(cobroEfectivo.ok, 'se pudo registrar un cobro en efectivo', cobroEfectivo.err || '');

  const trasEfectivo = await sql(
    withTenant(
      TENANT_A,
      `
SELECT treasury.account_balance('${TENANT_A}', '${CAJA_A}')::text
    || '|' || (SELECT count(*) FROM treasury.movements
                WHERE account_id = '${CAJA_A}' AND kind = 'customer_payment')::text;
`
    )
  );
  const [saldoEfectivo, movsEfectivo] = trasEfectivo.split('|');

  assert(
    num(saldoEfectivo) === antes + 3000,
    'un cobro en efectivo aumenta el saldo de la caja',
    `Esperado ${antes + 3000}, obtenido ${saldoEfectivo}`
  );
  assert(num(movsEfectivo) === 1, 'el cobro en efectivo emitió un movimiento', `${movsEfectivo} movimientos`);

  // Un cobro con cheque NO tiene que mover fondos: el movimiento lo emite la
  // acreditación. Si el trigger lo registrara igual, el dinero se contaría dos
  // veces —una al recibir el cheque y otra al acreditarlo.
  const antesBanco = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text;`)
  ));

  const cobroCheque = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO billing.payments (tenant_id, customer_id, method, amount, treasury_account_id)
SELECT '${TENANT_A}', c.id, 'cheque', 9000, '${BANCO_A}'
FROM app.customers c WHERE c.tenant_id = '${TENANT_A}' AND c.code = 'CLI-A';
`
    )
  );
  assert(cobroCheque.ok, 'se pudo registrar un cobro con cheque', cobroCheque.err || '');

  const trasCheque = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${BANCO_A}')::text;`)
  ));
  assert(
    trasCheque === antesBanco,
    'un cobro con cheque NO mueve fondos al registrarse',
    `El banco pasó de ${antesBanco} a ${trasCheque}. El dinero se contaría dos veces: una acá y otra al acreditar.`
  );

  // El gate sigue en verde después de todo esto.
  const gate = await trySql('SELECT treasury.assert_balances_reconcile();');
  assert(gate.ok, 'el gate sigue en verde tras los movimientos de cobro', gate.err || '');
}

// =============================================================================
// 13 · T-6 bis · El arqueo de caja
// =============================================================================
async function testCashCount() {
  console.log('\n\u25b6 Invariante 13 · el arqueo de caja deriva la diferencia');

  const esperado = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${CAJA_A}')::text;`)
  ));

  // El conteo físico es 200 menos: un faltante.
  const conteo = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO treasury.cash_counts
  (tenant_id, account_id, counted_on, counted_amount, expected_amount, difference, counted_by)
VALUES ('${TENANT_A}', '${CAJA_A}', CURRENT_DATE, ${esperado - 200}, ${esperado}, -200, '${USER_A}')
RETURNING difference::text;
`
    )
  );
  assert(conteo.ok, 'se pudo registrar un arqueo con faltante', conteo.err || '');
  assert(num(conteo.out) === -200, 'el arqueo registra la diferencia de -200', `Diferencia ${conteo.out}`);

  // La diferencia está atada a los dos montos por un CHECK: guardar una fila cuya
  // diferencia no sea la resta tiene que fallar.
  const inconsistente = verdict(
    await trySql(
      expectRejection(
        TENANT_A,
        `INSERT INTO treasury.cash_counts
           (tenant_id, account_id, counted_on, counted_amount, expected_amount, difference)
         VALUES ('${TENANT_A}', '${CAJA_A}', CURRENT_DATE, 100, 1000, 0);`
      )
    )
  );
  assert(
    inconsistente.rejected,
    'un arqueo con una diferencia que no es la resta es rechazado',
    verdictDetail(inconsistente, 'El INSERT pasó: la diferencia no está atada a los montos.')
  );

  // Ajuste de arqueo: el libro converge al conteo físico. El faltante entra como
  // débito, así que el saldo baja 200.
  const ajuste = await trySql(
    withTenant(
      TENANT_A,
      `SELECT treasury.record_movement('${TENANT_A}', '${CAJA_A}', 'adjustment', 'debit',
                                        200, CURRENT_DATE, 'Faltante de arqueo');`
    )
  );
  assert(ajuste.ok, 'se pudo registrar el ajuste de arqueo', ajuste.err || '');

  const trasAjuste = num(await sql(
    withTenant(TENANT_A, `SELECT treasury.account_balance('${TENANT_A}', '${CAJA_A}')::text;`)
  ));
  assert(
    trasAjuste === esperado - 200,
    'el ajuste hace converger el saldo al conteo físico',
    `Esperado ${esperado - 200}, obtenido ${trasAjuste}`
  );

  const gate = await trySql('SELECT treasury.assert_balances_reconcile();');
  assert(gate.ok, 'el gate sigue en verde tras el ajuste de arqueo', gate.err || '');
}

// =============================================================================
// 14 · Transferencia entre cuentas propias
// =============================================================================
async function testTransferBetweenAccounts() {
  console.log('\n\u25b6 Invariante 14 · la transferencia entre cuentas propias no cambia el total');

  const posicionAntes = num(await sql(
    withTenant(
      TENANT_A,
      `SELECT total_balance::text FROM treasury.v_treasury_position
        WHERE tenant_id = '${TENANT_A}' AND currency = 'ARS';`
    )
  ));

  const movs = num(
    await sql(
      withTenant(
        TENANT_A,
        `SELECT treasury.transfer_between_accounts('${TENANT_A}', '${BANCO_A}', '${CAJA_A}',
                                                    5000, CURRENT_DATE, 'Pase de fondos')::text;`
      )
    )
  );
  assert(movs === 2, 'la transferencia emite exactamente dos movimientos', `${movs} movimientos`);

  const posicionDespues = num(await sql(
    withTenant(
      TENANT_A,
      `SELECT total_balance::text FROM treasury.v_treasury_position
        WHERE tenant_id = '${TENANT_A}' AND currency = 'ARS';`
    )
  ));
  assert(
    posicionAntes === posicionDespues,
    'la transferencia no cambia la posición total de tesorería',
    `${posicionAntes} → ${posicionDespues}. Mover dinero entre cuentas propias no crea ni destruye fondos.`
  );

  // A la misma cuenta no es una transferencia.
  const mismaCuenta = verdict(
    await trySql(
      expectRejection(
        TENANT_A,
        `PERFORM treasury.transfer_between_accounts('${TENANT_A}', '${CAJA_A}', '${CAJA_A}', 100);`
      )
    )
  );
  assert(mismaCuenta.rejected, 'no se puede transferir de una cuenta a sí misma', verdictDetail(mismaCuenta));

  const gate = await trySql('SELECT treasury.assert_balances_reconcile();');
  assert(gate.ok, 'el gate sigue en verde tras la transferencia', gate.err || '');
}

// =============================================================================
// 15 · Brechas de asiento
// =============================================================================
async function testPostingGapsCoverTreasury() {
  console.log('\n\u25b6 Invariante 15 · la vista de brechas cubre los hechos de tesorería');

  // La consulta va con contexto de inquilino: `v_posting_gaps` es
  // `security_invoker`, así que sin contexto la RLS devuelve cero filas para TODAS
  // las ramas y la prueba pasaría a estar midiendo el aislamiento en vez de la
  // cobertura de las ramas. (El síntoma era "0" en las tres, que se lee como
  // "faltan las ramas" y en realidad era "faltaba el contexto".)
  const row = await sql(
    withTenant(
      TENANT_A,
      `
SELECT
  (SELECT count(*) FROM accounting.v_posting_gaps)::text
  || '|' || (SELECT count(*) FROM accounting.v_posting_gaps WHERE source_type = 'check_cleared')::text
  || '|' || (SELECT count(*) FROM accounting.v_posting_gaps WHERE source_type = 'customer_payment')::text
  || '|' || (SELECT count(*) FROM accounting.v_posting_gaps WHERE source_type = 'credit_note')::text
  || '|' || (SELECT count(*) FROM accounting.v_posting_gaps WHERE source_type = 'purchase')::text;
`
    )
  );

  const [total, checks, cobros, notas, compras] = row.split('|').map(num);

  // Las ramas de las migraciones anteriores NO pueden haberse perdido al
  // reemplazar la vista: una rama que desaparece al hacer CREATE OR REPLACE deja
  // de detectar lo que detectaba, en silencio.
  assert(checks >= 1, 'la vista de brechas incluye acreditaciones de cheque sin asiento', `${checks}`);
  assert(cobros >= 1, 'la vista de brechas conserva los cobros a cliente (0015)', `${cobros}`);
  assert(notas >= 1, 'la vista de brechas conserva las notas de crédito (0015)', `${notas}`);
  assert(total >= compras, 'la vista de brechas conserva todas las ramas anteriores', `total ${total}, compras ${compras}`);

  // La vista es security_invoker: sin la opción, correría como su dueño (que tiene
  // BYPASSRLS) y devolvería hechos de todas las empresas sin ningún error.
  const invoker = await sql(`
SELECT ('security_invoker=true' = ANY(COALESCE(c.reloptions, '{}')))::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'accounting' AND c.relname = 'v_posting_gaps';
`);
  assert(isTrue(invoker), 'v_posting_gaps mantiene security_invoker tras el reemplazo', `reloptions=${invoker}`);
}

// =============================================================================
// 16 · El job está registrado en el ledger
// =============================================================================
async function testJobRegistered() {
  console.log('\n\u25b6 Invariante 16 · el job de conciliación está en el ledger');

  // Se consulta con el rol ADMINISTRATIVO, y eso es una decisión, no una
  // comodidad: `ops` es de plataforma. `0011` sólo le da USAGE a
  // `control_platform` y `control_readonly`; el rol de aplicación NO puede leer el
  // ledger. Que no pueda es correcto —un inquilino no tiene por qué ver los jobs de
  // la plataforma— así que la verificación del registro va por el rol que sí debe
  // verlo. Con `sql()` la prueba fallaba con "permiso denegado al esquema ops", que
  // se lee como un defecto de la migración y en realidad es el aislamiento
  // funcionando.
  const job = await sqlAdmin(`
SELECT code || '|' || expected_every::text
FROM ops.jobs WHERE code = 'treasury.reconciliation';
`);

  assert(!!job, 'treasury.reconciliation está registrado en ops.jobs', 'No está');

  if (job) {
    const [code, cadence] = job.split('|');
    assert(code === 'treasury.reconciliation', 'el código del job es el esperado', code);
    assert(cadence.includes('1 day'), 'el job tiene cadencia diaria declarada', `expected_every = ${cadence}`);
  }

  // El ledger vive en la base y no en un log: la pregunta "¿corrió la conciliación
  // este mes?" tiene que responderse con una consulta.
  const ledger = await sqlAdmin(`
SELECT count(*)::text FROM information_schema.tables
WHERE table_schema = 'ops' AND table_name IN ('jobs', 'job_runs');
`);
  assert(num(ledger) === 2, 'el ledger de ejecuciones existe', `${ledger} de 2 tablas`);

  // Y el rol de aplicación NO debe poder leerlo. Es la contracara de lo anterior:
  // si `control_app` pudiera, el ledger de plataforma estaría expuesto a cualquier
  // inquilino.
  const sinAcceso = await trySql(`SELECT count(*) FROM ops.jobs;`);
  assert(
    !sinAcceso.ok,
    'el rol de aplicación NO puede leer el ledger de plataforma',
    'control_app pudo leer ops.jobs: el ledger quedó expuesto a los inquilinos.'
  );
}

// =============================================================================
// Ejecución
// =============================================================================
async function main() {
  console.log('='.repeat(70));
  console.log(' Suite de invariantes de cobros y tesorería · Control');
  console.log(' Gate de E4: el saldo de tesorería cuadra con los movimientos');
  console.log('='.repeat(70));

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

  await assertAppRole();
  await setup();

  await testIsolation();
  await testRlsCoverage();
  await testCheckIsNotMoneyUntilCleared();
  await testRejectionReversesFunds();
  await testRejectUncreditedDoesNotReverse();
  await testInvalidTransitionsBlocked();
  await testMovementImmutable();
  await testTreasuryBalanceReconciles();
  await testNoMaterializedBalance();
  await testReceivablesChain();
  await testBankReconciliation();
  await testPaymentTriggersMovement();
  await testCashCount();
  await testTransferBetweenAccounts();
  await testPostingGapsCoverTreasury();
  await testJobRegistered();

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
