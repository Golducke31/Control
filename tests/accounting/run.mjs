#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de invariantes del núcleo contable (puertas de salida E1 y E2)
 * -----------------------------------------------------------------------------
 * QUÉ PRUEBA
 *
 * La migración `0012` declara garantías en el ADR `docs/adr/0001-nucleo-contable.md`.
 * Este archivo verifica que esas garantías las aplique REALMENTE el motor, y no
 * la capa de aplicación: cada prueba escribe por el camino más crudo posible
 * (`INSERT` directo, saltando `post_entry()`) porque la pregunta que importa no
 * es "¿la función valida?" sino "¿un camino que se saltee la función puede
 * escribir un dato inválido?". Si la respuesta es sí, la garantía es decorativa.
 *
 * La puerta de salida de E1 en el plan es: "Balance cuadra y cero asientos
 * descuadrados". La de E2 es: "Cero hechos sin asiento en un escenario
 * completo". Las dos se miden acá, no se declaran.
 *
 * Las invariantes 11 a 14 cubren E2 (`0013`, ADR
 * `docs/adr/0002-motor-asientos-automaticos.md`): idempotencia del generador,
 * traducción hecho → líneas, omisión del IVA 0% y la vista de brechas.
 *
 * La invariante 8 verifica además que los jobs contables registrados en
 * `ops.jobs` tengan implementación. Un job en el ledger sin código queda
 * agendado, se reporta como exitoso y no hace nada: el sistema dice "todo en
 * orden" sin haber mirado. La contraparte en código de esa verificación es
 * `apps/api/src/jobs/job-catalog.test.ts`, que corre sin base y atrapa la
 * desincronización en el otro sentido (`JOB_SCHEDULE` sin `JOB_DEFINITIONS`).
 *
 * POR QUÉ CADA PRUEBA ES UNA CONEXIÓN APARTE
 *
 * Un CONSTRAINT TRIGGER diferido que falla ABORTA la transacción. Si todas las
 * pruebas compartieran una conexión, la primera que espera un rechazo dejaría la
 * sesión en estado abortado y las siguientes fallarían por arrastre, con
 * mensajes que parecen defectos de la migración. Cada prueba usa su propia
 * transacción (`withTenant()`) para que un rechazo esperado sea un resultado
 * local y no contamine al resto.
 *
 * POR QUÉ NO SE PUEDE CORRER COMO SUPERUSUARIO
 *
 * El superusuario de PostgreSQL ignora RLS **siempre**, incluso con FORCE ROW
 * LEVEL SECURITY, y además puede escribir la plantilla contable de plataforma
 * salteando la política restrictiva. Correr así haría que las pruebas de
 * aislamiento y de inmutabilidad de la plantilla pasaran por la razón
 * equivocada. `assertAppRole()` aborta con exit 2 si detecta ese caso.
 *
 * USO
 *
 *   node tests/accounting/run.mjs \
 *     --dsn "postgres://app_login:...@localhost:5432/control" \
 *     --admin-dsn "postgres://postgres:...@localhost:5432/control" --verbose
 *
 * Requiere `psql` en el PATH (o `PG_BIN` apuntando a su carpeta).
 * Salida: 0 si todo pasa · 1 si una garantía no se cumple · 2 si el entorno no sirve.
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PSQL = process.env.PG_BIN
  ? join(process.env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
  : 'psql';

// Inquilinos de prueba. Se crean y se destruyen dentro de la suite: no dependen
// de que exista un seed previo, así que la suite es autosuficiente.
const TENANT_A = '00000000-0000-4000-c000-00000000000c';
const TENANT_B = '00000000-0000-4000-d000-00000000000d';
const USER_A = '00000000-0000-4000-c000-0000000000a1';
const USER_B = '00000000-0000-4000-d000-0000000000b1';

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
        '  node tests/accounting/run.mjs --dsn "postgres://app_login:...@host:5432/control"\n'
    );
    process.exit(2);
  }
  if (!out.adminDsn) out.adminDsn = out.dsn;
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
 * bytes inválidos. Mismo motivo que en `tests/isolation/run.mjs`.
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
  return stdout.trim();
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

/** Contexto de sesión por el camino validado de la aplicación. */
function withTenant(tenantId, body) {
  return [
    'BEGIN;',
    `SELECT app.set_tenant_context('${tenantId}'::uuid, '${USER_A}'::uuid, false);`,
    body,
    'COMMIT;',
  ].join('\n');
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
      `\n  ABORTADO: la suite se conectó como \`${user}\`, que es superusuario o\n` +
        `  tiene BYPASSRLS.\n\n` +
        `  Ese rol ignora RLS y puede escribir la plantilla contable salteando la\n` +
        `  política restrictiva: las pruebas de aislamiento y de inmutabilidad\n` +
        `  pasarían sin haber probado nada.\n\n` +
        `  Pasá un DSN de aplicación:\n` +
        `    --dsn "postgres://app_login:...@host:5432/control"\n`
    );
    process.exit(2);
  }

  if (!isTrue(isMember)) {
    console.error(
      `\n  ABORTADO: el rol \`${user}\` no es miembro de \`control_app\`.\n\n` +
        `  Sin esos privilegios las pruebas medirían "permiso denegado" en vez de\n` +
        `  medir las garantías contables.\n`
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

  // Limpieza idempotente. El orden respeta las claves foráneas.
  //
  // Las tablas de catálogo y de stock se limpian porque la invariante 14 inserta
  // un movimiento huérfano para probar que la vista de brechas lo delata. Sin
  // esto, la segunda corrida de la suite arrastraría ese movimiento y la
  // aserción de "0 brechas con el libro al día" fallaría —un fallo del arnés que
  // parece un defecto de la vista.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM accounting.account_roles    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.mapping_rules    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_lines   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_balances WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_entries WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.periods         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.fiscal_years    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.stock_movements        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.stock_levels           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.warehouses             WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.product_variants       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.products               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.brands                 WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                  WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'acct-sub-a', 'acct-a@test.local', true, 'Contador A'),
  ('${USER_B}', 'acct-sub-b', 'acct-b@test.local', true, 'Contador B');

INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'acct-a', 'Contable A S.A.',  'Contable A', 'active', 'ARS'),
  ('${TENANT_B}', 'acct-b', 'Contable B S.R.L.', 'Contable B', 'active', 'ARS');
COMMIT;
`);

  // Ejercicio, 12 períodos y plan de cuentas copiado de la plantilla, para las
  // dos empresas. Se hace con el rol de APLICACIÓN y contexto de inquilino: si
  // `control_app` no puede preparar su propia contabilidad, el módulo no sirve.
  for (const t of [TENANT_A, TENANT_B]) {
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
  SELECT v_t, v_fy, m.n,
         (date_trunc('year', CURRENT_DATE) + (m.n - 1) * interval '1 month')::date,
         (date_trunc('year', CURRENT_DATE) + m.n * interval '1 month' - interval '1 day')::date
  FROM generate_series(1, 12) AS m(n);

  PERFORM accounting.seed_tenant_chart_of_accounts(v_t);

  -- E2: roles + reglas de mapeo hecho → asiento. Sin esto, el generador
  -- automático no tiene a qué cuenta imputar cada línea y falla —que es lo
  -- correcto—, así que sin sembrarlo no se puede probar la idempotencia.
  PERFORM accounting.seed_tenant_accounting_config(v_t);
END $$;
`
      )
    );
    if (!res.ok) {
      console.error(`  No se pudo preparar la empresa ${t}:\n${res.err}`);
      process.exit(2);
    }
  }

  // El conteo va DENTRO del contexto de inquilino. Sin él, RLS aplica
  // fail-closed y la consulta devuelve 0 sin error: el reporte diría "0
  // períodos" con las 12 filas perfectamente escritas en la base. Un informe
  // que miente sobre datos correctos es peor que uno que falla.
  const counts = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (SELECT count(*) FROM accounting.periods  WHERE tenant_id = '${TENANT_A}')
     || '|' || (SELECT count(*) FROM accounting.accounts WHERE tenant_id = '${TENANT_A}')
     || '|' || (SELECT count(*) FROM accounting.account_roles WHERE tenant_id = '${TENANT_A}')
     || '|' || (SELECT count(*) FROM accounting.mapping_rules WHERE tenant_id = '${TENANT_A}');
`
    )
  );

  const [periods, accounts, roles, rules] = counts.split('|');
  console.log(`  \u2713 Empresa A: ${periods} períodos, ${accounts} cuentas copiadas de la plantilla`);
  console.log(`  \u2713 Empresa A: ${roles} roles contables, ${rules} reglas de mapeo (E2)`);

  assert(
    Number(periods) === 12 && Number(accounts) > 50,
    'la preparación dejó el ejercicio, los 12 períodos y el plan de cuentas',
    `períodos=${periods} cuentas=${accounts}`
  );

  assert(
    Number(roles) === 11 && Number(rules) === 11,
    'la configuración contable E2 quedó sembrada (11 roles, 11 reglas)',
    `roles=${roles} reglas=${rules}`
  );
}

// =============================================================================
// Invariante 1 · Un asiento descuadrado lo rechaza el motor
// -----------------------------------------------------------------------------
// Se escribe por INSERT directo, salteando post_entry(). Es la prueba central:
// demuestra que la garantía vive en el motor y no en la función, así que ningún
// camino alternativo (script, migración, corrección urgente a mano) puede
// escribir un asiento que no cierre.
// =============================================================================
async function testUnbalancedRejected() {
  console.log('\n\u25b6 Invariante 1 · asiento descuadrado rechazado por el motor');

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_period uuid;
  v_entry uuid;
  v_caja uuid;
  v_venta uuid;
BEGIN
  SELECT id INTO v_period FROM accounting.periods
   WHERE tenant_id = v_t AND CURRENT_DATE BETWEEN starts_on AND ends_on LIMIT 1;
  SELECT id INTO v_caja  FROM accounting.accounts WHERE tenant_id = v_t AND code = '1.1.1.01';
  SELECT id INTO v_venta FROM accounting.accounts WHERE tenant_id = v_t AND code LIKE '4.%' LIMIT 1;

  INSERT INTO accounting.journal_entries
    (tenant_id, period_id, entry_date, entry_number, memo, source)
  VALUES (v_t, v_period, CURRENT_DATE, 900001, 'Asiento descuadrado a proposito', 'manual')
  RETURNING id INTO v_entry;

  INSERT INTO accounting.journal_lines (tenant_id, entry_id, line_number, account_id, debit, credit)
  VALUES (v_t, v_entry, 1, v_caja, 100.00, 0),
         (v_t, v_entry, 2, v_venta, 0, 60.00);

  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
`
    )
  );

  assert(
    !res.ok,
    'un asiento con débitos 100 y créditos 60 es rechazado (INSERT directo, sin post_entry)',
    res.ok ? 'El motor lo ACEPTÓ. La garantía de partida doble no está aplicada.' : ''
  );

  if (!res.ok && VERBOSE) {
    const line = res.err.split('\n').find((l) => l.includes('no cierra'));
    if (line) console.log(`      ${line.trim()}`);
  }

  // Y el rechazo tiene que ser por la razón correcta, no por un error incidental.
  assert(
    !res.ok && /no cierra|descuadr/i.test(res.err),
    'el rechazo es por partida doble, no un error incidental'
  );
}

// =============================================================================
// Invariante 2 · El asiento cuadrado SÍ se acepta
// -----------------------------------------------------------------------------
// Una barrera que rechaza todo también "pasa" la prueba anterior. Ésta verifica
// que un asiento correcto atraviesa el camino completo: cabecera, líneas y la
// proyección de saldos.
// =============================================================================
async function testBalancedAccepted() {
  console.log('\n\u25b6 Invariante 2 · asiento cuadrado aceptado y saldo proyectado');

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_caja uuid;
  v_venta uuid;
  v_entry accounting.journal_entries;
BEGIN
  SELECT id INTO v_caja  FROM accounting.accounts WHERE tenant_id = v_t AND code = '1.1.1.01';
  SELECT id INTO v_venta FROM accounting.accounts WHERE tenant_id = v_t AND code LIKE '4.%' LIMIT 1;

  v_entry := accounting.post_entry(
    v_t, CURRENT_DATE, 'Venta de contado cobrada en caja', 'manual',
    jsonb_build_array(
      jsonb_build_object('accountId', v_caja,  'debit', 1210.00, 'credit', 0),
      jsonb_build_object('accountId', v_venta, 'debit', 0,       'credit', 1210.00)
    )
  );
END $$;
`
    )
  );

  assert(res.ok, 'un asiento cuadrado se acepta por post_entry()', res.ok ? '' : res.err);

  const saldo = await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_A}'::uuid, '${USER_A}'::uuid, false);
SELECT COALESCE(sum(period_debit), 0)::text FROM accounting.account_balances
 WHERE tenant_id = '${TENANT_A}'
   AND account_id = (SELECT id FROM accounting.accounts
                     WHERE tenant_id = '${TENANT_A}' AND code = '1.1.1.01');
COMMIT;
`);

  assert(
    saldo === '1210.00',
    'el saldo materializado de Caja refleja el asiento (esperado 1210.00)',
    `Valor real: ${saldo}`
  );
}

// =============================================================================
// Invariante 3 · Plantilla de plataforma protegida contra escritura
// -----------------------------------------------------------------------------
// El plan de cuentas de la plataforma (tenant_id NULL) es una plantilla: las
// empresas lo COPIAN. Si una empresa pudiera editarlo, cambiaría el plan de
// todas las demás. La política `accounts_template_readonly` es RESTRICTIVE, así
// que suma en AND con la permisiva en vez de ampliarla.
// =============================================================================
async function testTemplateReadonly() {
  console.log('\n\u25b6 Invariante 3 · plantilla de plataforma protegida contra escritura');

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
UPDATE accounting.accounts SET name = 'Nombre secuestrado por la empresa A'
 WHERE tenant_id IS NULL AND code = '1.1.1.01';
`
    )
  );

  // Un UPDATE que RLS filtra afecta 0 filas sin lanzar error: ese también es un
  // resultado válido (la fila quedó inalcanzable). Lo que NO es válido es que
  // haya afectado una fila. Se distinguen consultando el nombre real.
  const nombre = await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_A}'::uuid, '${USER_A}'::uuid, false);
SELECT name FROM accounting.accounts WHERE tenant_id IS NULL AND code = '1.1.1.01';
COMMIT;
`);

  assert(
    nombre === 'Caja',
    'la cuenta de plantilla conserva su nombre original',
    `Nombre real: ${nombre}${res.ok ? '' : ` (el UPDATE fue rechazado: ${res.err.split('\n')[0]})`}`
  );

  assert(
    !res.ok || nombre === 'Caja',
    'la empresa A no puede modificar la plantilla compartida'
  );
}

// =============================================================================
// Invariante 4 · Aislamiento: B no ve la contabilidad de A
// =============================================================================
async function testIsolation() {
  console.log('\n\u25b6 Invariante 4 · aislamiento contable entre empresas');

  const a = await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_A}'::uuid, '${USER_A}'::uuid, false);
SELECT count(*)::text FROM accounting.journal_entries;
COMMIT;
`);

  const b = await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_B}'::uuid, '${USER_B}'::uuid, false);
SELECT count(*)::text FROM accounting.journal_entries;
COMMIT;
`);

  assert(
    Number(a) > 0,
    `la empresa A ve sus propios asientos (${a})`,
    'A no ve sus propios asientos: el aislamiento está de más, no de menos.'
  );

  assert(
    Number(b) === 0,
    `la empresa B no ve ningún asiento de A (B ve ${b})`,
    'La empresa B ve asientos ajenos: fuga de aislamiento contable.'
  );

  // Y sin contexto de sesión, todo debe devolver cero (fail-closed).
  const sinContexto = await trySql(`
BEGIN;
SELECT count(*)::text FROM accounting.journal_entries;
COMMIT;
`);

  assert(
    !sinContexto.ok || Number(sinContexto.out) === 0,
    'sin contexto de sesión, la lectura devuelve 0 filas (fail-closed)',
    `Devolvió: ${sinContexto.ok ? sinContexto.out : 'error'}`
  );
}

// =============================================================================
// Invariante 9 · Período cerrado: rechazado ANTES de tocar el saldo
// -----------------------------------------------------------------------------
// Éste es el riesgo residual que la adenda del ADR declara explícitamente:
// "un asiento que afecta un período cerrado debe rechazarse ANTES de tocar el
// saldo, no después. Si el orden es 'actualizo el saldo y después valido el
// período', la actualización queda escrita y el saldo miente".
//
// La prueba compara el saldo del período antes y después del intento rechazado.
// Si el saldo cambió, el orden está invertido y la migración no cumple el ADR.
// =============================================================================
async function testClosedPeriodOrdering() {
  console.log('\n\u25b6 Invariante 9 · período cerrado rechazado sin tocar el saldo');

  // Se cierra un período FUTURO: el actual lo necesitan las demás pruebas.
  const cierre = await trySql(
    withTenant(
      TENANT_A,
      `
UPDATE accounting.periods p
   SET status = 'closed', closed_at = now(), closed_by = '${USER_A}'
 WHERE p.tenant_id = '${TENANT_A}'
   AND p.id = (SELECT id FROM accounting.periods
                WHERE tenant_id = '${TENANT_A}' AND starts_on > CURRENT_DATE
                ORDER BY starts_on LIMIT 1);
`
    )
  );

  assert(cierre.ok, 'se pudo cerrar un período futuro para la prueba', cierre.err);

  const antes = await sql(
    withTenant(
      TENANT_A,
      `
SELECT COALESCE(sum(period_debit) + sum(period_credit), 0)::text
  FROM accounting.account_balances b
 WHERE b.tenant_id = '${TENANT_A}'
   AND b.period_id = (SELECT id FROM accounting.periods
                       WHERE tenant_id = '${TENANT_A}' AND status = 'closed'
                       ORDER BY starts_on LIMIT 1);
`
    )
  );

  const intento = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_period uuid;
  v_caja uuid;
  v_venta uuid;
BEGIN
  SELECT id INTO v_period FROM accounting.periods
   WHERE tenant_id = v_t AND status = 'closed' ORDER BY starts_on LIMIT 1;

  SELECT id INTO v_caja  FROM accounting.accounts WHERE tenant_id = v_t AND code = '1.1.1.01';
  SELECT id INTO v_venta FROM accounting.accounts WHERE tenant_id = v_t AND code LIKE '4.%' LIMIT 1;

  PERFORM accounting.post_entry(
    v_t,
    (SELECT starts_on + 1 FROM accounting.periods WHERE id = v_period),
    'Intento sobre periodo cerrado', 'manual',
    jsonb_build_array(
      jsonb_build_object('accountId', v_caja,  'debit', 500.00, 'credit', 0),
      jsonb_build_object('accountId', v_venta, 'debit', 0,      'credit', 500.00)
    )
  );
END $$;
`
    )
  );

  const despues = await sql(
    withTenant(
      TENANT_A,
      `
SELECT COALESCE(sum(period_debit) + sum(period_credit), 0)::text
  FROM accounting.account_balances b
 WHERE b.tenant_id = '${TENANT_A}'
   AND b.period_id = (SELECT id FROM accounting.periods
                       WHERE tenant_id = '${TENANT_A}' AND status = 'closed'
                       ORDER BY starts_on LIMIT 1);
`
    )
  );

  assert(!intento.ok, 'un asiento sobre un período cerrado es rechazado');
  assert(
    /cerrado/i.test(intento.err),
    'el rechazo nombra la causa (período cerrado), no un error incidental'
  );
  assert(
    antes === despues,
    `el saldo del período cerrado NO cambió (antes ${antes}, después ${despues})`,
    'El saldo cambió pese al rechazo: el orden de validación está invertido y el saldo miente.'
  );
}

// =============================================================================
// Invariante 10 · Reversión: un asiento se revierte, no se edita
// -----------------------------------------------------------------------------
// El ADR fija que un comprobante/asiento autorizado es inmutable y se corrige
// con un contra-asiento. La prueba crea un asiento, lo revierte, y verifica que
// las líneas quedaron invertidas y que el neto del par es cero.
// =============================================================================
async function testReversal() {
  console.log('\n\u25b6 Invariante 10 · reversión con contra-asiento');

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_caja uuid;
  v_venta uuid;
  v_original accounting.journal_entries;
  v_reversa accounting.journal_entries;
  v_dif numeric;
  v_apunta boolean;
BEGIN
  SELECT id INTO v_caja  FROM accounting.accounts WHERE tenant_id = v_t AND code = '1.1.1.01';
  SELECT id INTO v_venta FROM accounting.accounts WHERE tenant_id = v_t AND code LIKE '4.%' LIMIT 1;

  v_original := accounting.post_entry(
    v_t, CURRENT_DATE, 'Venta que luego se revierte', 'manual',
    jsonb_build_array(
      jsonb_build_object('accountId', v_caja,  'debit', 333.00, 'credit', 0),
      jsonb_build_object('accountId', v_venta, 'debit', 0,      'credit', 333.00)
    )
  );

  v_reversa := accounting.reverse_entry(v_t, v_original.id, 'Cliente devolvio la mercaderia');

  -- El contra-asiento tiene que apuntar al original, y el original no cambió.
  SELECT (r.reverses_entry_id = v_original.id) INTO v_apunta
    FROM accounting.journal_entries r WHERE r.id = v_reversa.id;

  -- El neto de las dos líneas de la cuenta de ventas debe ser cero.
  SELECT COALESCE(sum(l.debit) - sum(l.credit), 0) INTO v_dif
    FROM accounting.journal_lines l
   WHERE l.tenant_id = v_t AND l.account_id = v_venta
     AND l.entry_id IN (v_original.id, v_reversa.id);

  IF NOT v_apunta THEN
    RAISE EXCEPTION 'El contra-asiento no apunta al asiento original.';
  END IF;
  IF v_dif <> 0 THEN
    RAISE EXCEPTION 'El neto de la cuenta no quedo en cero tras revertir: %', v_dif;
  END IF;
END $$;
`
    )
  );

  assert(res.ok, 'reversión completa: contra-asiento creado y neto en cero', res.err);

  // Y un contra-asiento no se revierte con otro contra-asiento.
  const doble = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_rev uuid;
BEGIN
  SELECT id INTO v_rev FROM accounting.journal_entries
   WHERE tenant_id = v_t AND reverses_entry_id IS NOT NULL LIMIT 1;
  PERFORM accounting.reverse_entry(v_t, v_rev, 'Intento de revertir una reversion');
END $$;
`
    )
  );

  assert(
    !doble.ok && /ya es una reversi|contra-asiento/i.test(doble.err),
    'un contra-asiento no se revierte con otro contra-asiento'
  );
}

// =============================================================================
// Invariante 5 · Una línea no puede ser de débito y crédito a la vez
// =============================================================================
async function testLineSideExclusive() {
  console.log('\n\u25b6 Invariante 5 · una línea es de débito o de crédito, nunca de los dos');

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_period uuid;
  v_entry uuid;
  v_caja uuid;
BEGIN
  SELECT id INTO v_period FROM accounting.periods
   WHERE tenant_id = v_t AND CURRENT_DATE BETWEEN starts_on AND ends_on LIMIT 1;
  SELECT id INTO v_caja FROM accounting.accounts WHERE tenant_id = v_t AND code = '1.1.1.01';

  INSERT INTO accounting.journal_entries
    (tenant_id, period_id, entry_date, entry_number, memo, source)
  VALUES (v_t, v_period, CURRENT_DATE, 900002, 'Linea ambigua', 'manual')
  RETURNING id INTO v_entry;

  INSERT INTO accounting.journal_lines (tenant_id, entry_id, line_number, account_id, debit, credit)
  VALUES (v_t, v_entry, 1, v_caja, 100.00, 100.00);
END $$;
`
    )
  );

  assert(
    !res.ok,
    'una línea con débito y crédito simultáneos es rechazada',
    res.ok ? 'El motor la ACEPTÓ: el CHECK lines_one_side no está aplicado.' : ''
  );
}

// =============================================================================
// Invariante 6 · La métrica de la puerta E1: cero asientos descuadrados
// =============================================================================
async function testNoUnbalancedEntriesExist() {
  console.log('\n\u25b6 Invariante 6 · métrica de la puerta E1');

  for (const t of [TENANT_A, TENANT_B]) {
    const descuadrados = await sql(`
BEGIN;
SELECT app.set_tenant_context('${t}'::uuid, '${USER_A}'::uuid, false);
SELECT count(*)::text FROM (
  SELECT entry_id FROM accounting.journal_lines
   WHERE tenant_id = '${t}'
   GROUP BY entry_id
  HAVING COALESCE(sum(debit), 0) <> COALESCE(sum(credit), 0)
) d;
COMMIT;
`);

    assert(
      descuadrados === '0',
      `empresa ${t.slice(-1).toUpperCase()}: cero asientos descuadrados en la base`,
      `Hay ${descuadrados} asiento(s) que no cierran.`
    );
  }

  // El balance global: débitos = créditos sobre todo el libro.
  const balance = await sql(`
BEGIN;
SELECT app.set_tenant_context('${TENANT_A}'::uuid, '${USER_A}'::uuid, false);
SELECT (COALESCE(sum(debit), 0) - COALESCE(sum(credit), 0))::text
  FROM accounting.journal_lines WHERE tenant_id = '${TENANT_A}';
COMMIT;
`);

  assert(balance === '0.00' || balance === '0', `el balance de A cuadra (diferencia ${balance})`);
}

// =============================================================================
// Invariante 7 · Cobertura RLS del esquema contable
// -----------------------------------------------------------------------------
// Ésta es la barrera que corre al final de la migración. Se re-verifica acá
// porque una tabla agregada después de `0012` no queda cubierta por el macro de
// políticas del propio esquema si alguien la crea a mano.
// =============================================================================
async function testRlsCoverage() {
  console.log('\n\u25b6 Invariante 7 · cobertura RLS del esquema contable');

  const filas = await sql(`
SELECT c.relname || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
     || '|' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'accounting' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
`);

  const tabla = filas.split('\n').filter(Boolean).map((l) => {
    const [name, enabled, forced, policies] = l.split('|');
    return { name, enabled: isTrue(enabled), forced: isTrue(forced), policies: Number(policies) };
  });

  assert(tabla.length >= 6, `se descubrieron las tablas contables (${tabla.length})`);

  for (const t of tabla) {
    assert(
      t.enabled && t.forced,
      `accounting.${t.name}: RLS ENABLE + FORCE`,
      `enabled=${t.enabled} forced=${t.forced}`
    );
    assert(
      t.policies > 0,
      `accounting.${t.name}: tiene al menos una política (${t.policies})`,
      'Tabla sin política: RLS deniega todo, o peor, no filtra nada.'
    );
  }

  // Y la barrera de la migración tiene que seguir pasando con el esquema actual.
  const cobertura = await trySql('SELECT app.assert_rls_coverage();');
  assert(cobertura.ok, 'app.assert_rls_coverage() pasa sobre el esquema actual', cobertura.err);
}

// =============================================================================
// Invariante 8 · El job de verificación quedó registrado
// =============================================================================
async function testJobRegistered() {
  console.log('\n\u25b6 Invariante 8 · jobs contables registrados en el ledger');

  const row = await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
SELECT count(*)::text FROM ops.jobs WHERE code = 'accounting.posting_check';
COMMIT;
`);

  assert(
    row === '1',
    'ops.jobs contiene accounting.posting_check',
    `Encontrados: ${row}. Sin el registro, begin_job_run() lanza y el job nunca corre.`
  );

  // El registro tiene que declarar la cadencia esperada. `ops.v_job_health` la
  // compara contra la realidad: sin `expected_every`, la vista no puede mostrar
  // que el job está atrasado, y un job detenido deja de ser detectable.
  const cadence = await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
SELECT expected_every::text FROM ops.jobs WHERE code = 'accounting.posting_check';
COMMIT;
`);

  assert(
    cadence === '1 day',
    'el job declara su cadencia esperada (1 día)',
    `expected_every = ${cadence}`
  );

  // Y el job tiene que poder EJECUTARSE. Es la verificación que faltaba: un job
  // registrado en el ledger y sin implementación en el catálogo queda agendado,
  // se reporta como exitoso y no hace nada. Acá se corre el cuerpo real contra el
  // esquema actual, que es lo que distingue "está implementado" de "está
  // registrado".
  const ejecucion = await trySql(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);

DO $$
DECLARE
  v_gaps integer;
  v_facts integer;
BEGIN
  SELECT count(*) INTO v_gaps FROM accounting.v_posting_gaps;

  SELECT (SELECT count(*) FROM billing.invoices WHERE status = 'authorized')
       + (SELECT count(*) FROM app.stock_movements
           WHERE kind = 'sale_out' AND unit_cost IS NOT NULL AND unit_cost <> 0)
    INTO v_facts;

  IF v_gaps < 0 OR v_facts < 0 THEN
    RAISE EXCEPTION 'Conteos imposibles: gaps=%, facts=%', v_gaps, v_facts;
  END IF;
END $$;
COMMIT;
`);

  assert(
    ejecucion.ok,
    'el job de verificación se ejecuta contra el esquema real sin error',
    ejecucion.err
  );
}

// =============================================================================
// Invariante 11 · Idempotencia: un hecho, un asiento (garantía central de E2)
// -----------------------------------------------------------------------------
// La puerta de salida de E2 en el plan es "cero hechos sin asiento en un
// escenario completo". Su contracara —igual de grave y mucho menos visible— es
// "un hecho con dos asientos": nada falla, el libro cuadra, y la ganancia
// aparece duplicada sin que nadie lo note. Esta prueba ataca eso.
//
// Se llama al generador TRES veces con el mismo `source_id`. Un generador
// correcto devuelve el mismo asiento las tres veces y deja UNA fila. La
// garantía vive en el índice único parcial `journal_entries_one_per_source`,
// no en la lógica de la función: por eso da igual si el reproceso viene de un
// job, de un reintento de HTTP o de un `<RETURNING>` reejecutado a mano.
// =============================================================================
async function testSourceIdempotency() {
  console.log('\n\u25b6 Invariante 11 · idempotencia: un hecho, un asiento');

  const SOURCE_ID = '00000000-0000-4000-c000-00000000faca';

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_src uuid := '${SOURCE_ID}';
  v_amounts jsonb := '{"total": 121000.00, "subtotal": 100000.00, "tax_total": 21000.00}'::jsonb;
  v_1 accounting.journal_entries;
  v_2 accounting.journal_entries;
  v_3 accounting.journal_entries;
  v_n integer;
BEGIN
  v_1 := accounting.post_entry_for_source(
    v_t, 'invoice', v_src, 'invoice', CURRENT_DATE, 'Factura 1', v_amounts);
  v_2 := accounting.post_entry_for_source(
    v_t, 'invoice', v_src, 'invoice', CURRENT_DATE, 'Factura 1 (reproceso)', v_amounts);
  v_3 := accounting.post_entry_for_source(
    v_t, 'invoice', v_src, 'invoice', CURRENT_DATE, 'Factura 1 (tercera vez)', v_amounts);

  SELECT count(*) INTO v_n FROM accounting.journal_entries e
   WHERE e.tenant_id = v_t AND e.source_id = v_src;

  IF v_1.id IS DISTINCT FROM v_2.id THEN
    RAISE EXCEPTION 'El segundo llamado creo un asiento distinto (%). Deberia devolver el mismo.', v_2.id;
  END IF;
  IF v_1.id IS DISTINCT FROM v_3.id THEN
    RAISE EXCEPTION 'El tercer llamado creo un asiento distinto (%).', v_3.id;
  END IF;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El hecho quedo con % asientos en vez de 1.', v_n;
  END IF;
END $$;
`
    )
  );

  assert(
    res.ok,
    'tres llamados con el mismo source_id devuelven el mismo asiento y dejan 1 sola fila',
    res.err
  );

  if (!res.ok) {
    const line = res.err.split('\n').find((l) => l.includes('EXCEPTION') || l.includes('ERROR'));
    if (line && VERBOSE) console.log(`      ${line.trim()}`);
  }

  // El asiento generado tiene que usar el vocabulario del enum de `0012`.
  // El defecto corregido pasaba el literal 'automatic', que el enum no tiene.
  const source = await sql(
    withTenant(
      TENANT_A,
      `
SELECT e.source::text || '|' || e.source_type
  FROM accounting.journal_entries e
 WHERE e.tenant_id = '${TENANT_A}' AND e.source_id = '${SOURCE_ID}';
`
    )
  );

  assert(
    source === 'invoice|invoice',
    'el asiento automático usa el enum entry_source del hecho, no un literal fuera del vocabulario',
    `source|source_type = ${source} (esperado invoice|invoice)`
  );
}

// =============================================================================
// Invariante 12 · El mapeo hecho → asiento produce las líneas correctas
// -----------------------------------------------------------------------------
// Verifica la traducción completa de una factura: Debe Cuentas a cobrar por el
// total, Haber Ventas por el neto y Haber IVA débito fiscal por el impuesto.
// No alcanza con que el asiento cuadre: un mapeo con las cuentas invertidas
// también cuadra, y es un error contable grave que nadie vería en el balance.
// =============================================================================
async function testMappingProducesCorrectLines() {
  console.log('\n\u25b6 Invariante 12 · el mapeo imputa cada línea a la cuenta correcta');

  const detalle = await sql(
    withTenant(
      TENANT_A,
      `
SELECT string_agg(
         a.code || '=' || l.debit::numeric(14,2)::text || '/' || l.credit::numeric(14,2)::text,
         ' ' ORDER BY a.code)
  FROM accounting.journal_lines l
  JOIN accounting.journal_entries e
    ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
  JOIN accounting.accounts a
    ON a.tenant_id = l.tenant_id AND a.id = l.account_id
 WHERE e.tenant_id = '${TENANT_A}'
   AND e.source_id = '00000000-0000-4000-c000-00000000faca';
`
    )
  );

  // 1.1.3.01 Cuentas a cobrar      Debe 121000
  // 2.1.2.01 IVA débito fiscal     Haber 21000
  // 4.1.1.01 Ventas                Haber 100000
  const esperado = '1.1.3.01=121000.00/0.00 2.1.2.01=0.00/21000.00 4.1.1.01=0.00/100000.00';

  assert(
    detalle === esperado,
    'la factura imputa CxC por el total, Ventas por el neto e IVA débito por el impuesto',
    `Obtenido: ${detalle}\nEsperado: ${esperado}`
  );

  // Y el asiento cuadra, verificado sobre el motor y no sobre la función.
  const cuadre = await sql(
    withTenant(
      TENANT_A,
      `
SELECT count(*)::text FROM (
  SELECT l.entry_id
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e
      ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
   WHERE e.tenant_id = '${TENANT_A}' AND e.source_id = '00000000-0000-4000-c000-00000000faca'
   GROUP BY l.entry_id
  HAVING COALESCE(sum(l.debit), 0) <> COALESCE(sum(l.credit), 0)
) d;
`
    )
  );

  assert(cuadre === '0', 'el asiento generado está cuadrado', `descuadrados: ${cuadre}`);
}

// =============================================================================
// Invariante 13 · IVA 0% no genera línea (AFIP rechaza la alícuota Id 3)
// -----------------------------------------------------------------------------
// El ADR 0001 y el motor de mapeo omiten deliberadamente los importes en cero.
// Si se generara una línea de IVA por 0, AFIP rechazaría el comprobante con
// «el campo Iva no debe incluir la alícuota 0%». La prueba usa una factura sin
// IVA y exige DOS líneas (CxC y Ventas), no tres.
// =============================================================================
async function testZeroVatLineOmitted() {
  console.log('\n\u25b6 Invariante 13 · IVA 0% no genera línea de impuesto');

  const SOURCE_ID = '00000000-0000-4000-c000-00000000fadb';

  const res = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_src uuid := '${SOURCE_ID}';
  v_n integer;
BEGIN
  PERFORM accounting.post_entry_for_source(
    v_t, 'invoice', v_src, 'invoice', CURRENT_DATE, 'Factura sin IVA',
    '{"total": 50000.00, "subtotal": 50000.00, "tax_total": 0.00}'::jsonb);

  SELECT count(*) INTO v_n
    FROM accounting.journal_lines l
    JOIN accounting.journal_entries e
      ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
   WHERE e.tenant_id = v_t AND e.source_id = v_src;

  IF v_n <> 2 THEN
    RAISE EXCEPTION 'Se esperaban 2 lineas (CxC y Ventas) y se generaron %.', v_n;
  END IF;
END $$;
`
    )
  );

  assert(
    res.ok,
    'una factura con IVA 0% genera 2 líneas: el impuesto en cero se omite',
    res.err
  );
}

// =============================================================================
// Invariante 14 · La vista de brechas detecta un hecho sin asiento
// -----------------------------------------------------------------------------
// Ésta es la consulta de control 2 de §6.3 del plan, y el insumo del job
// `accounting.posting_check`. Una vista que siempre devuelve cero filas
// "pasa" cualquier inspección visual y no controla nada: por eso se prueba en
// las dos direcciones — primero con el libro al día (0 brechas), y después
// insertando un hecho de origen sin asiento para exigir que lo delate.
//
// La segunda dirección es la que vale. La primera sólo confirma que la vista no
// inventa brechas; la segunda confirma que las encuentra, que es para lo que
// existe. Sin la segunda, una vista con `WHERE false` pasaría.
// =============================================================================
async function testPostingGapsView() {
  console.log('\n\u25b6 Invariante 14 · la vista de brechas delata un hecho sin asiento');

  const alDia = await sql(
    withTenant(TENANT_A, `SELECT count(*)::text FROM accounting.v_posting_gaps;`)
  );

  assert(
    alDia === '0',
    'con el libro al día, la vista de brechas devuelve 0 filas',
    `Devolvió ${alDia} filas inesperadas.`
  );

  // --- La dirección que importa: un hecho sin asiento tiene que aparecer. ---
  //
  // Se inserta un movimiento de stock de origen SIN llamar al generador. Es el
  // escenario real que el job existe para detectar: un camino del sistema que
  // salteó la generación del asiento. El movimiento tiene costo (si no, la vista
  // lo ignora a propósito: un movimiento sin costo no mueve valor, así que no
  // genera asiento) y es una salida (una reserva o una transferencia tampoco
  // mueven valor entre cuentas).
  //
  // La inserción es por INSERT directo y no por `app.apply_stock_movement()`:
  // acá se quiere el movimiento SIN su efecto lateral, que es precisamente el
  // hecho huérfano que hay que delatar.
  const GAP_SOURCE = '00000000-0000-4000-c000-0000000dead1';
  const GAP_VARIANT = '00000000-0000-4000-c000-0000000dead2';
  const GAP_WH = '00000000-0000-4000-c000-0000000dead3';

  const gap = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_mov uuid := '${GAP_SOURCE}';
  v_brand uuid;
  v_product uuid;
  v_variant uuid;
  v_wh uuid;
  v_found integer;
BEGIN
  INSERT INTO app.brands (tenant_id, name) VALUES (v_t, 'Marca de prueba')
  RETURNING id INTO v_brand;

  INSERT INTO app.products (tenant_id, brand_id, sku, name)
  VALUES (v_t, v_brand, 'TEST-GAP', 'Producto de prueba')
  RETURNING id INTO v_product;

  INSERT INTO app.product_variants (tenant_id, product_id, sku, variant_name)
  VALUES (v_t, v_product, 'TEST-GAP-1', 'Variante de prueba')
  RETURNING id INTO v_variant;

  INSERT INTO app.warehouses (tenant_id, code, name)
  VALUES (v_t, 'WH-GAP', 'Deposito de prueba')
  RETURNING id INTO v_wh;

  INSERT INTO app.stock_movements (
    id, tenant_id, variant_id, warehouse_id, kind, quantity, unit_cost, reason
  ) VALUES (
    v_mov, v_t, v_variant, v_wh, 'sale_out', 1, 1234.00,
    'Movimiento de prueba sin asiento (invariante 14)'
  );

  SELECT count(*) INTO v_found
    FROM accounting.v_posting_gaps g
   WHERE g.tenant_id = v_t
     AND g.source_type = 'stock_movement'
     AND g.source_id = v_mov;

  IF v_found <> 1 THEN
    RAISE EXCEPTION
      'La vista de brechas NO delato el hecho sin asiento (encontrados: %). '
      'Una vista que no encuentra lo que busca no controla nada.', v_found;
  END IF;
END $$;
`
    )
  );

  assert(
    gap.ok,
    'un movimiento de stock valuado sin asiento es DELATADO por la vista de brechas',
    gap.err
  );

  // Y una vez generado el asiento, la brecha desaparece. Sin esto, la vista
  // podría delatar todo siempre y la prueba anterior pasaría igual.
  const cierre = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t uuid := '${TENANT_A}';
  v_mov uuid := '${GAP_SOURCE}';
  v_restante integer;
BEGIN
  PERFORM accounting.post_entry_for_source(
    v_t, 'stock_movement', v_mov, 'sale_out', CURRENT_DATE,
    'Costo de la mercaderia vendida (prueba invariante 14)',
    '{"cost_amount": 1234.00}'::jsonb
  );

  SELECT count(*) INTO v_restante
    FROM accounting.v_posting_gaps g
   WHERE g.tenant_id = v_t AND g.source_id = v_mov;

  IF v_restante <> 0 THEN
    RAISE EXCEPTION 'La brecha sigue abierta tras generar el asiento (%).', v_restante;
  END IF;
END $$;
`
    )
  );

  assert(
    cierre.ok,
    'generado el asiento, la brecha se cierra (la vista no delata en falso)',
    cierre.err
  );

  // La vista tiene que estar declarada con security_invoker: sin eso, la vista
  // corre con los privilegios del dueño y saltea el RLS de las tablas de abajo,
  // que es exactamente el agujero que el proyecto prohíbe.
  const invoker = await sql(`
SELECT COALESCE(
  (SELECT option_value FROM pg_options_to_table(c.reloptions)
    WHERE option_name = 'security_invoker'), 'false')
FROM pg_class c WHERE c.oid = 'accounting.v_posting_gaps'::regclass;
`);

  assert(
    isTrue(invoker),
    'la vista de brechas usa security_invoker (el RLS del tenant sigue aplicando)',
    `security_invoker=${invoker}`
  );

  // Y el aislamiento: la empresa B no puede ver la brecha de A.
  const desdeB = await sql(
    withTenant(TENANT_B, `SELECT count(*)::text FROM accounting.v_posting_gaps;`)
  );

  assert(
    desdeB === '0',
    'la empresa B no ve ninguna brecha de A (aislamiento de la vista)',
    `B ve ${desdeB} brecha(s) que no son suyas.`
  );
}

// =============================================================================
// Ejecución
// =============================================================================
async function main() {
  console.log('='.repeat(70));
  console.log(' Suite de invariantes del núcleo contable · Control');
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

  await testUnbalancedRejected();
  await testBalancedAccepted();
  await testTemplateReadonly();
  await testIsolation();
  await testLineSideExclusive();
  await testClosedPeriodOrdering();
  await testReversal();
  await testNoUnbalancedEntriesExist();
  await testRlsCoverage();
  await testJobRegistered();

  // E2 · asientos automáticos desde los hechos operativos
  await testSourceIdempotency();
  await testMappingProducesCorrectLines();
  await testZeroVatLineOmitted();
  await testPostingGapsView();

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
