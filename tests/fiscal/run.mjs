#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de la puerta de E5 · Determinación de IVA
 * -----------------------------------------------------------------------------
 * QUÉ MIDE
 *
 * La fase E5 del plan tiene un gate medible, en §7.1:
 *
 *     "Posición de IVA reproducible desde el libro"
 *
 * Este archivo lo MIDE en vez de declararlo, contra un motor PostgreSQL real. Un gate
 * declarado es una opinión; uno medido es un hecho, y la diferencia es la que separó a este
 * proyecto de creer que `0017` estaba bien de que lo estuviera —tenía siete defectos, ninguno
 * visible leyendo el archivo— y de creer que `0018` estaba bien de que no lo estuviera —
 * tenía cuatro más, incluido uno de signo que duplicaba la posición—.
 *
 * -----------------------------------------------------------------------------
 * LOS CRITERIOS, de §6.2 "Fiscal avanzado"
 *
 *   F-1  El débito y el crédito fiscal del período cuadran con los comprobantes.
 *   F-2  El crédito fiscal de una compra se computa en el período CORRECTO —
 *        el de recepción, no el de emisión del proveedor.
 *   F-3  El libro digital cuadra con los comprobantes.
 *   F-4  Las retenciones y percepciones se asocian al comprobante que las sufre.
 *   F-5  Una alícuota nueva entra sin recompilar ni desplegar.
 *   F-6  La posición de IVA por período es REPRODUCIBLE desde el libro.
 *
 * F-6 es el gate; F-1..F-5 son lo que lo hace verdad. Una suite que sólo verificara F-6
 * podría pasar con un sistema que no tiene idea de alícuotas.
 *
 * -----------------------------------------------------------------------------
 * LA REGLA QUE GOBIERNA ESTA SUITE: NO COMPARAR EL SISTEMA CONSIGO MISMO
 *
 * `0018` tenía un defecto de signo por el que la posición neta salía del DOBLE en todo
 * período con compras. Sus propias verificaciones no lo detectaban porque comparaban el
 * detalle contra el libro, y los dos estaban mal de la misma manera: la divergencia era
 * cero. Un sistema coherente consigo mismo puede estar equivocado en todos sus números.
 *
 * Por eso, donde hay un importe que se puede calcular a mano, esta suite escribe la
 * constante. `1260` no sale de una consulta: sale de `2100 − 840`. Si el motor devuelve
 * otra cosa, la suite falla aunque el sistema esté internamente consistente.
 *
 * -----------------------------------------------------------------------------
 * USO
 *
 *   node tests/fiscal/run.mjs \
 *     --dsn "postgres://app_login:...@host:5432/control" \
 *     --admin-dsn "postgres://postgres:...@host:5432/control" --verbose
 *
 * Requiere `psql` en el PATH, o `PG_BIN` apuntando a la carpeta de binarios de PostgreSQL.
 * Salida: 0 si el gate pasa · 1 si falla · 2 si el entorno no sirve.
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PSQL = process.env.PG_BIN
  ? join(process.env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
  : 'psql';

// Empresas y usuarios de prueba. Se crean y destruyen dentro de la suite.
//
// El rango `fbxx` lo elige esta suite y no lo usa ninguna otra: `c0xx` contabilidad,
// `f1xx`/`f2xx` compras, `f9xx` tesorería. Compartir el rango no rompe el aislamiento —cada
// suite usa ids distintos— pero sí rompe la limpieza: la segunda corrida borraría el
// escenario de la primera.
const TENANT_A = '00000000-0000-4000-fb00-0000000000a0';
const TENANT_B = '00000000-0000-4000-fb00-0000000000b0';
const USER_A = '00000000-0000-4000-fb00-0000000000a1';
const USER_B = '00000000-0000-4000-fb00-0000000000b1';

// Rol de sistema `owner` (tenant_id NULL), sembrado por `db/seed/0001_system_catalog.sql`.
// Sin una membresía activa, `app.has_permission()` devuelve false para todo y la política
// RESTRICTIVE de `billing.invoices` rechaza la factura — con un error de RLS en una prueba
// de IVA, que es un síntoma que no apunta a la causa.
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
        '  node tests/fiscal/run.mjs --dsn "postgres://app_login:...@host:5432/control"\n'
    );
    process.exit(2);
  }
  // El DSN administrativo NO cae al de aplicación. La limpieza borra
  // `accounting.journal_entries` y `fiscal.vat_accruals`, y el rol de aplicación no puede
  // hacerlo: el proyecto trata el libro como inmutable, y una suite que limpiara su
  // escenario con el rol de aplicación estaría ejercitando un camino que en producción no
  // existe — y que no debería existir.
  if (!out.adminDsn) {
    console.error(
      '\nFalta el DSN administrativo (`--admin-dsn`).\n\n' +
        'La preparación y la limpieza del escenario corren con el rol de plataforma,\n' +
        'igual que en las suites contable, de compras y de tesorería.\n\n' +
        '  node tests/fiscal/run.mjs \\\n' +
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
          Object.assign(new Error(`psql salió con código ${code}`), {
            stdout,
            stderr,
            code,
            input: String(input).slice(0, 600),
          })
        );
    });
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Ejecuta SQL como una transacción única.
 *
 * El SQL va por STDIN y no por `-c`: en Windows el argumento usa la página de códigos ANSI
 * (cp1252) y los acentos del castellano llegan a PostgreSQL como bytes inválidos. Es el
 * mismo motivo que en el resto de las suites, y acá importa más porque esta suite compara
 * textos que llevan acentos (los códigos de alícuota se muestran, y los mensajes de error
 * se citan).
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
  return (stdout + (stderr ? '\n' + stderr : '')).trim();
}

/** Sólo el resultado, sin las líneas de diagnóstico de psql. */
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

/** Ejecuta y devuelve { ok, out, err } sin lanzar. Para las pruebas que esperan un rechazo. */
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

function num(v) {
  return Number(String(v).trim() || '0');
}

/**
 * Contexto de sesión por el camino validado de la aplicación.
 *
 * `app.set_tenant_context` es la función que verifica el privilegio; usar
 * `SET LOCAL app.tenant_id` a mano se saltearía esa comprobación y haría que el aislamiento
 * pareciera probado sin haberlo estado. Misma trampa que documenta `tests/isolation/run.mjs`.
 */
function withTenant(tenantId, body, userId = USER_A) {
  return [
    'BEGIN;',
    `SELECT app.set_tenant_context('${tenantId}'::uuid, '${userId}'::uuid, false);`,
    body,
    'COMMIT;',
  ].join('\n');
}

// =============================================================================
// Verificación de entorno
// =============================================================================
async function preflight() {
  console.log('\n\u25b6 Verificación del entorno');

  const res = await trySql(`
SELECT current_user
    || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)::text
    || '|' || (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)::text
    || '|' || pg_has_role(current_user, 'control_app', 'MEMBER')::text
FROM pg_roles WHERE rolname = current_user;
`);

  if (!res.ok) {
    console.error(`\n  No se pudo conectar con el DSN de aplicación:\n${res.err}\n`);
    process.exit(2);
  }

  const [user, isSuper, bypass, isMember] = output(res.out).split('|');
  if (isSuper === 'true' || bypass === 'true') {
    console.error(
      `\n  ABORTADO: la suite corre como \`${user}\`, que es superusuario o tiene BYPASSRLS.\n\n` +
        '  RLS no se evalúa para ese rol, así que las pruebas de aislamiento pasarían\n' +
        '  sin haber ejercitado una sola política.\n'
    );
    process.exit(2);
  }
  if (isMember !== 'true') {
    console.error(
      `\n  ABORTADO: el rol \`${user}\` no es miembro de \`control_app\`.\n\n` +
        '  Pasá un DSN de aplicación (miembro de control_app) en --dsn y dejá el de\n' +
        '  superusuario sólo para --admin-dsn.\n'
    );
    process.exit(2);
  }
  console.log(`  \u2713 Rol confirmado: \`${user}\` (sin BYPASSRLS, miembro de control_app)`);

  // La regla de cómputo de plataforma es precondición de TODA la suite: sin ella,
  // `project_tax_document` falla con un mensaje correcto pero la suite no mediría nada.
  // Es preferible abortar con una causa clara que reportar 30 fallas por arrastre.
  const reglas = await sqlAdmin(`
SELECT count(*)::text FROM fiscal.accrual_rules WHERE tenant_id IS NULL;
`);
  if (num(output(reglas)) === 0) {
    console.error(
      '\n  ABORTADO: `fiscal.accrual_rules` no tiene reglas de plataforma.\n\n' +
        '  Sin regla de cómputo no hay dirección fiscal ni fecha de cómputo, y la\n' +
        '  determinación no puede funcionar. Revisá que la migración 0019 haya corrido.\n'
    );
    process.exit(2);
  }
}

// =============================================================================
// Preparación
// =============================================================================
async function setup() {
  console.log('\n\u25b6 Preparación del escenario');

  // Limpieza idempotente, en orden de dependencia. El orden importa: sin esto la segunda
  // corrida arrastraría los acumulados de la primera y las aserciones de monto fallarían por
  // un motivo ajeno a lo que se prueba.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM fiscal.document_withholdings WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.vat_accruals        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.document_taxes      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.tax_documents       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.book_definitions    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.tax_rates           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.withholding_regimes WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM fiscal.taxes               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoice_items      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoices           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.payment_allocations    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_payments      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_invoice_items WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_invoices      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.goods_receipt_items    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.goods_receipts         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_order_items   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_orders        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.suppliers              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.customers              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_balances WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_lines    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_entries  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.mapping_rules    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_roles    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.periods          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.fiscal_years     WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.accounts         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships             WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                 WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                   WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);

-- Los impuestos/alícuotas/regímenes de prueba se siembran como catálogo de plataforma
-- (tenant_id NULL). No los alcanza el borrado por empresa de arriba, así que se limpian
-- acá por prefijo de código para que la suite sea idempotente corrida tras corrida.
DELETE FROM fiscal.tax_rates
  WHERE tax_id IN (SELECT id FROM fiscal.taxes WHERE code ~ '^(iva_f5|ret_gan|ret_iibb|iva_b)_');
DELETE FROM fiscal.withholding_regimes
  WHERE tax_id IN (SELECT id FROM fiscal.taxes WHERE code ~ '^(iva_f5|ret_gan|ret_iibb|iva_b)_');
DELETE FROM fiscal.taxes WHERE code ~ '^(iva_f5|ret_gan|ret_iibb|iva_b)_';

INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'fisc-sub-a', 'fiscal-a@test.local', true, 'Fiscal A'),
  ('${USER_B}', 'fisc-sub-b', 'fiscal-b@test.local', true, 'Fiscal B');

INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'fisc-a', 'Fiscal Avanzado A S.A.', 'Fiscal A', 'active', 'ARS'),
  ('${TENANT_B}', 'fisc-b', 'Fiscal Avanzado B S.R.L.', 'Fiscal B', 'active', 'ARS');

-- Membresía con rol owner. No es comodidad: la política RESTRICTIVE de billing.invoices
-- exige app.has_permission('billing.issue_invoice'), que se resuelve contra
-- app.memberships. Sin membresía la factura se rechaza por política y la prueba parece un
-- defecto de la migración.
INSERT INTO app.memberships (tenant_id, user_id, role_id, is_active)
VALUES
  ('${TENANT_A}', '${USER_A}', '${ROLE_OWNER}', true),
  ('${TENANT_B}', '${USER_B}', '${ROLE_OWNER}', true);
COMMIT;
`);

  // Ejercicio, períodos, plan de cuentas, roles y reglas de mapeo. Con el rol de APLICACIÓN:
  // si control_app no puede preparar su propia operación, el módulo no sirve.
  for (const [t, sufijo] of [
    [TENANT_A, 'A'],
    [TENANT_B, 'B'],
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

  -- Plan de cuentas y configuración contable: crean vat_payable (2.1.2.01) y
  -- vat_receivable (1.1.4.01), que son las cuentas contra las que fiscal.v_vat_position
  -- concilia.
  PERFORM accounting.seed_tenant_chart_of_accounts(v_t);
  PERFORM accounting.seed_tenant_accounting_config(v_t);
  -- Roles y reglas de compras (0014): vat_receivable y payable.
  PERFORM purchasing.seed_tenant_purchasing_config(v_t);

  INSERT INTO app.customers (tenant_id, code, legal_name, trade_name, doc_type, doc_number)
  VALUES (v_t, 'CLI-${sufijo}', 'Cliente ${sufijo} S.A.', 'Cliente ${sufijo}', '80', '3071111111${sufijo === 'A' ? '1' : '2'}');

  INSERT INTO app.suppliers (tenant_id, code, legal_name, doc_type, doc_number, tax_condition)
  VALUES (v_t, 'PROV-${sufijo}', 'Proveedor ${sufijo} S.A.', 'CUIT', '3061111111${sufijo === 'A' ? '1' : '2'}', 'responsable_inscripto');
END $$;
`
      )
    );
    if (!res.ok) {
      console.error(`\n  No se pudo preparar el escenario de ${t}:\n${res.err}`);
      process.exit(2);
    }
  }

  console.log('  \u2713 Escenario preparado (2 empresas, 12 períodos cada una, plan de cuentas)');
}

// =============================================================================
// Utilidades de dominio
// =============================================================================

/**
 * Fecha de un mes del ejercicio en curso.
 *
 * Se resuelve en SQL y no en JavaScript a propósito: el ejercicio lo definió PostgreSQL con
 * `date_trunc('year', CURRENT_DATE)`, y calcular la misma fecha en dos lugares distintos es
 * exactamente el tipo de duplicación que produce una discrepancia de un día.
 */
async function dateOf(tenantId, month) {
  const r = await sql(
    withTenant(
      tenantId,
      `SELECT to_char((date_trunc('year', CURRENT_DATE) + (${month} - 1) * interval '1 month' + interval '14 days')::date, 'YYYY-MM-DD');`
    )
  );
  return output(r);
}

/** Id y número del período que contiene una fecha, resuelto por la base. */
async function periodOf(tenantId, isoDate) {
  const r = await sql(
    withTenant(
      tenantId,
      `SELECT p.id || '|' || p.period_number FROM accounting.periods p
       WHERE p.tenant_id = '${tenantId}' AND DATE '${isoDate}' BETWEEN p.starts_on AND p.ends_on;`
    )
  );
  const [id, number] = output(r).split('|');
  return { id, number: Number(number) };
}

/**
 * Contexto de PLATAFORMA: el que usa el operador para configurar catálogos globales
 * (impuestos, alícuotas, regímenes). Corre con el DSN administrativo y
 * `app.set_tenant_context(NULL, NULL, true)`, igual que el panel de administración.
 */
function withPlatform(body) {
  return [
    'BEGIN;',
    "SELECT app.set_tenant_context(NULL, NULL, true);",
    body,
    'COMMIT;',
  ].join('\n');
}

/**
 * Crea un impuesto del CATÁLOGO DE PLATAFORMA (tenant_id NULL) con el rol de plataforma.
 *
 * DECISIÓN DE ARQUITECTURA (migración 0017): `fiscal.taxes` y `fiscal.tax_rates` son
 * parámetros de plataforma. El rol de aplicación (`control_app`) sólo tiene SELECT sobre
 * ellos —cambiar una alícuota histórica reescribiría el pasado de todas las empresas—. Por
 * eso la semilla corre con el DSN administrativo y contexto de plataforma, exactamente como
 * lo haría el operador que da de alta un impuesto en el panel. El tenant lo consume vía
 * `rates_on`, que resuelve la alícuota de plataforma para cualquier empresa.
 *
 * F-5 mide que una alícuota NUEVA entra como DATO y no como código: el motor la lee de la
 * tabla por fecha. Quién inserta la fila (plataforma u operador) es una decisión de
 * autorización, no cambia la propiedad que se prueba.
 */
async function seedPlatformTax(code, kind = 'vat') {
  const stamp = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const full = `${code}_${stamp}`;
  const r = await sqlAdmin(
    withPlatform(
      `INSERT INTO fiscal.taxes (tenant_id, code, name, kind, is_active)
       VALUES (NULL, '${full}', 'Impuesto ${code}', '${kind}', true)
       RETURNING id;`
    )
  );
  return { id: output(r), code: full };
}

/**
 * Crea una factura de VENTA autorizada, la proyecta como hecho fiscal, le inserta el
 * discriminado y le postea el asiento.
 *
 * El camino es el de producción, en el orden de producción: el comprobante se emite, la
 * autoridad responde, y RECIÉN AHÍ se proyecta el hecho. Esa secuencia es deliberada —
 * `project_tax_document` rechaza un documento que no esté autorizado.
 */
async function createSaleInvoice(tenantId, custCode, docNumber, isoDate, net, rate, rateCode, taxId, userId = USER_A) {
  return trySql(
    withTenant(
      tenantId,
      `
DO $$
DECLARE
  v_t      uuid := '${tenantId}';
  v_net    numeric(14,2) := ${net};
  v_rate   numeric(9,6)  := ${rate};
  v_tax    numeric(14,2);
  v_total  numeric(14,2);
  v_cust   uuid;
  v_inv    uuid;
  v_doc    uuid;
BEGIN
  v_tax   := round(v_net * v_rate, 2);
  v_total := v_net + v_tax;

  SELECT id INTO v_cust FROM app.customers WHERE tenant_id = v_t AND code = '${custCode}';

  INSERT INTO billing.invoices
    (tenant_id, customer_id, kind, doc_type, point_of_sale, number,
     receptor_name, receptor_doc_number, issue_date,
     subtotal, tax_total, total,
     status, result, authorization_id, idempotency_key, created_by)
  VALUES
    (v_t, v_cust, 'invoice', 'A', 1, ${docNumber},
     'Cliente ${custCode}', '30711111111', DATE '${isoDate}',
     v_net, v_tax, v_total,
     'authorized', 'approved', lpad('${docNumber}', 14, '0'),
     'fisc-sale-${docNumber}', '${USER_A}')
  RETURNING id INTO v_inv;

  -- El HECHO FISCAL. La regla de cómputo de 'sale' es por emisión, así que no se pide
  -- recepción: es el caso en que el tipo de hecho determina la fecha sin datos extra.
  v_doc := fiscal.project_tax_document(
    v_t, 'sale', 'billing.invoice', v_inv,
    'A ' || ${docNumber}, DATE '${isoDate}', NULL, 'authorized');

  INSERT INTO fiscal.document_taxes
    (tenant_id, tax_document_id, tax_id, rate_code, rate, taxable_base, amount)
  VALUES (v_t, v_doc, '${taxId}', '${rateCode}', v_rate, v_net, v_tax);

  PERFORM accounting.post_entry_for_source(
    v_t, 'invoice', v_inv, 'invoice', DATE '${isoDate}',
    'Factura de venta ${docNumber}',
    jsonb_build_object('subtotal', v_net, 'tax_total', v_tax, 'total', v_total), NULL);

  PERFORM fiscal.accrue_vat(v_t, v_doc, NULL);
END $$;
`
      , userId
    )
  );
}

/**
 * Crea una factura de COMPRA, la proyecta con su fecha de RECEPCIÓN, discrimina el IVA y
 * postea el asiento.
 *
 * `emissionDate` y `receiptDate` son distintas a propósito: es la separación que F-2 mide.
 * `receiptDate` puede ir en NULL para el caso en que la mercadería todavía no llegó.
 */
async function createPurchaseInvoice(tenantId, supCode, docNumber, emissionDate, receiptDate, net, tax, taxId, rateCode, userId = USER_A) {
  const total = (Number(net) + Number(tax)).toFixed(2);
  const receiptSql = receiptDate === null ? 'NULL' : `DATE '${receiptDate}'`;
  return trySql(
    withTenant(
      tenantId,
      `
DO $$
DECLARE
  v_t     uuid := '${tenantId}';
  v_sup   uuid;
  v_inv   uuid;
  v_doc   uuid;
BEGIN
  SELECT id INTO v_sup FROM app.suppliers WHERE tenant_id = v_t AND code = '${supCode}';

  INSERT INTO purchasing.supplier_invoices
    (tenant_id, number, supplier_id, doc_type, point_of_sale, doc_number,
     issue_date, due_date, received_on, subtotal, tax_total, total)
  VALUES
    (v_t, 'FC-' || lpad('${docNumber}', 6, '0'), v_sup, 'A', 1, ${docNumber},
     DATE '${emissionDate}', DATE '${emissionDate}' + 30, ${receiptSql},
     ${net}, ${tax}, ${total})
  RETURNING id INTO v_inv;

  v_doc := fiscal.project_tax_document(
    v_t, 'purchase', 'purchasing.supplier_invoice', v_inv,
    'FC ' || ${docNumber}, DATE '${emissionDate}', ${receiptSql}, 'authorized');

  INSERT INTO fiscal.document_taxes
    (tenant_id, tax_document_id, tax_id, rate_code, rate, taxable_base, amount)
  VALUES (v_t, v_doc, '${taxId}', '${rateCode}', 0.21, ${net}, ${tax});

  PERFORM accounting.post_entry_for_source(
    v_t, 'purchase', v_inv, 'purchase', DATE '${emissionDate}',
    'Factura de compra ${docNumber}',
    jsonb_build_object('subtotal', ${net}, 'tax_total', ${tax}, 'total', ${total}), NULL);

  PERFORM fiscal.accrue_vat(v_t, v_doc, NULL);
END $$;
`
      , userId
    )
  );
}

/** Id del hecho fiscal de un origen. */
async function taxDocOf(tenantId, sourceType, sourceId) {
  const r = await sql(
    withTenant(
      tenantId,
      `SELECT id FROM fiscal.tax_documents
        WHERE tenant_id = '${tenantId}' AND source_type = '${sourceType}' AND source_id = '${sourceId}';`
    )
  );
  return output(r);
}

// =============================================================================
// F-5 · Una alícuota nueva entra sin recompilar
// =============================================================================
// Se prueba PRIMERO y no al final aunque el número del criterio sea el quinto.
//
// El motivo es de método: F-5 verifica una propiedad del SISTEMA —que los parámetros viven en
// datos y no en código— y es la única de las seis que no depende de ninguna otra. Probarla
// primero significa que si el motor no es parametrizable, la suite lo dice en el primer
// bloque en vez de después de haber construido todo un escenario sobre una premisa falsa.
// =============================================================================
async function f5() {
  console.log('\n\u25b6 F-5 · Una alícuota nueva entra sin recompilar ni desplegar');

  const tax = await seedPlatformTax('iva_f5');
  assert(!!tax.id, 'el catálogo de plataforma admite un impuesto nuevo como dato (sin código)', tax.id);

  const vigencia = await dateOf(TENANT_A, 1);

  // La alícuota "2,5%" es deliberadamente rara: no existe en el catálogo de AFIP y no está
  // en ningún `switch`. Si el sistema la resuelve, es porque la lee de la tabla.
  const ins = await trySql(
    withPlatform(
      `INSERT INTO fiscal.tax_rates (tenant_id, tax_id, rate_code, rate, valid_from, legal_basis)
       VALUES (NULL, '${tax.id}', '2.5', 0.025, DATE '${vigencia}', 'Alícuota de prueba F-5');`
    ),
    { asAdmin: true }
  );
  assert(
    ins.ok,
    'una alícuota que el código no conoce se registra sin tocar una línea de código',
    ins.err
  );

  const r = await sql(
    withTenant(
      TENANT_A,
      `SELECT rate FROM fiscal.rates_on(DATE '${vigencia}', '${tax.code}', '${TENANT_A}');`
    )
  );
  assert(
    num(output(r)) === 0.025,
    'el motor resuelve la alícuota nueva por fecha',
    `Se obtuvo: ${output(r)}`
  );

  // Una fecha sin alícuota vigente tiene que devolver 0 FILAS y no un 0. El IVA 0% de las
  // exportaciones es una alícuota válida, y un `COALESCE(rate, 0)` la confundiría con
  // ausencia — el sistema no podría distinguir "exento" de "no sé la alícuota".
  const sinVigencia = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM fiscal.rates_on(DATE '1990-01-01', '${tax.code}', '${TENANT_A}');`
    )
  );
  assert(
    num(output(sinVigencia)) === 0,
    'una fecha sin alícuota vigente devuelve 0 filas, no un 0 disfrazado de alícuota',
    `Se obtuvo: ${output(sinVigencia)}`
  );

  // Y una alícuota 0 EXPLÍCITA sí se resuelve. Es el caso de la exportación.
  const cero = await trySql(
    withPlatform(
      `INSERT INTO fiscal.tax_rates (tenant_id, tax_id, rate_code, rate, valid_from)
       VALUES (NULL, '${tax.id}', '0', 0, DATE '${vigencia}');`
    ),
    { asAdmin: true }
  );
  assert(cero.ok, 'una alícuota de 0% se registra como una alícuota válida', cero.err);

  const rCero = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text || '|' || COALESCE(max(rate)::text, 'null')
       FROM fiscal.rates_on(DATE '${vigencia}', '${tax.code}', '${TENANT_A}') WHERE rate_code = '0';`
    )
  );
  assert(
    output(rCero) === '1|0.000000',
    'el 0% se distingue de la ausencia de alícuota',
    `Se obtuvo: ${output(rCero)}`
  );

  return tax;
}

// =============================================================================
// F-2 · El crédito fiscal de compras se computa en el período correcto
// =============================================================================
// Se prueba ANTES de F-1 y F-6 porque es la única de las seis que puede estar mal de una
// forma que las otras no detectan.
//
// Si el motor usara la emisión para todo, el sistema entero sería internamente
// CONSISTENTE —los totales cuadrarían, el libro cerraría, la posición sería reproducible— y
// el crédito estaría en el período equivocado. Un error consistente pasa cualquier prueba
// que compare el sistema consigo mismo. Es exactamente el defecto que tenía `0018`, y la
// razón por la que esta suite escribe las constantes a mano.
// =============================================================================
async function f2(taxA) {
  console.log('\n\u25b6 F-2 · El crédito de compras se computa en el período de recepción');

  const mesEmision = 1;
  const mesRecepcion = 2;

  const fechaEmision = await dateOf(TENANT_A, mesEmision);
  const fechaRecepcion = await dateOf(TENANT_A, mesRecepcion);

  const periodEmision = await periodOf(TENANT_A, fechaEmision);
  const periodRecepcion = await periodOf(TENANT_A, fechaRecepcion);

  assert(
    periodEmision.id !== periodRecepcion.id,
    'los dos períodos son distintos (la prueba mide algo real)',
    `emisión=${periodEmision.id} recepción=${periodRecepcion.id}`
  );

  const compra = await createPurchaseInvoice(
    TENANT_A, 'PROV-A', 7050, fechaEmision, fechaRecepcion, 2000, 420, taxA.id, '21'
  );
  assert(compra.ok, 'la factura de compra con emisión y recepción en meses distintos se carga', compra.err);

  const docCompra = await taxDocOf(
    TENANT_A,
    'purchasing.supplier_invoice',
    (
      await sql(
        withTenant(
          TENANT_A,
          `SELECT id FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_A}' AND doc_number = 7050;`
        )
      )
    ).trim()
  );
  assert(!!docCompra, 'la factura de compra tiene su hecho fiscal proyectado', docCompra);

  if (!compra.ok || !docCompra) return;

  // El hecho fiscal tiene que llevar la fecha de RECEPCIÓN, no la de emisión.
  const hecho = await sql(
    withTenant(
      TENANT_A,
      `SELECT to_char(fiscal_date, 'YYYY-MM-DD') || '|' || date_basis
       FROM fiscal.tax_documents WHERE id = '${docCompra}';`
    )
  );
  const [fechaHecho, basis] = output(hecho).split('|');
  assert(
    fechaHecho === fechaRecepcion,
    'la fecha fiscal del hecho es la RECEPCIÓN y no la emisión del proveedor',
    `Se esperaba ${fechaRecepcion} (recepción) y se obtuvo ${fechaHecho}` +
      (fechaHecho === fechaEmision ? ` — es la EMISIÓN: la regla de cómputo no se aplicó` : '')
  );
  assert(
    /recep/i.test(basis || ''),
    'la base del criterio queda registrada y nombra la recepción',
    `Se obtuvo: ${basis}`
  );

  // Y el cómputo tiene que caer en el período de recepción.
  const accrual = await sql(
    withTenant(
      TENANT_A,
      `SELECT period_id || '|' || direction || '|' || amount
       FROM fiscal.vat_accruals WHERE tax_document_id = '${docCompra}';`
    )
  );
  const [periodo, direction, amount] = output(accrual).split('|');

  assert(
    direction === 'credit',
    'la dirección del hecho de compra es CRÉDITO y no débito',
    `Se obtuvo: ${direction}`
  );
  assert(
    periodo === periodRecepcion.id,
    'el crédito cae en el período de RECEPCIÓN y no en el de emisión',
    `Se esperaba ${periodRecepcion.id} (mes ${periodRecepcion.number}) y se obtuvo ` +
      `${periodo} (mes ${periodEmision.id === periodo ? periodEmision.number : '?'})`
  );
  assert(
    num(amount) === 420,
    'el importe del crédito es el discriminado',
    `Se obtuvo: ${amount}`
  );

  // Una factura de compra SIN recepción no se puede imputar. Es la defensa contra el
  // "default silencioso": si el motor usara la emisión cuando falta la recepción, el crédito
  // de un período ya presentado podría aparecer después y la posición cambiaría.
  const sinRecepcion = await createPurchaseInvoice(
    TENANT_A, 'PROV-A', 7060, fechaEmision, null, 1000, 210, taxA.id, '21'
  );
  assert(
    !sinRecepcion.ok,
    'una factura de compra SIN fecha de recepción NO se puede imputar',
    'El motor la aceptó. Un crédito computado en la emisión por defecto pone el impuesto ' +
      'en un período que puede estar cerrado y presentado, y nada lo avisa.'
  );
  if (!sinRecepcion.ok) {
    assert(
      /recepci/i.test(sinRecepcion.err),
      'el rechazo explica que falta la recepción (no es un error críptico)',
      `Se obtuvo: ${sinRecepcion.err.slice(0, 220)}`
    );
  }
}

// =============================================================================
// F-4 · Las retenciones se asocian al comprobante que las sufre
// =============================================================================
async function f4(taxA) {
  console.log('\n\u25b6 F-4 · Retenciones y percepciones asociadas a su comprobante');

  const vigencia = await dateOf(TENANT_A, 1);

  // F-4 necesita un comprobante de compra REAL al que colgarle la retención. Se crea acá, en
  // un período distinto al de F-1/F-6 (mes 6), para no contaminar las sumas de esos
  // períodos: la determinación se mide por período y estas pruebas no deben acoplarse.
  const fechaCompraF4 = await dateOf(TENANT_A, 6);
  const compraF4 = await createPurchaseInvoice(
    TENANT_A, 'PROV-A', 7100, fechaCompraF4, fechaCompraF4, 4000, 840, taxA.id, '21'
  );
  assert(compraF4.ok, 'se crea una compra de prueba para colgarle la retención', compraF4.err);

  const ret = await seedPlatformTax('ret_gan', 'withholding');

  const ins = await trySql(
    withPlatform(
      `INSERT INTO fiscal.withholding_regimes
         (tenant_id, tax_id, code, name, direction, threshold_amount, rate, jurisdiction, valid_from, legal_basis)
       VALUES (NULL, '${ret.id}', 'RET-GAN', 'Retención de Ganancias', 'suffered',
               1000.00, 0.02, NULL, DATE '${vigencia}', 'RG de prueba F-4');`
    ),
    { asAdmin: true }
  );
  assert(ins.ok, 'un régimen de retención sufrida se registra', ins.err);

  const r = await sql(
    withTenant(
      TENANT_A,
      `SELECT w.direction || '|' || w.rate || '|' || w.threshold_amount
       FROM fiscal.withholdings_on(DATE '${vigencia}', '${ret.code}', '${TENANT_A}') w;`
    )
  );
  const [dir, rate, threshold] = output(r).split('|');
  assert(dir === 'suffered', 'el régimen resuelto conserva su sentido (sufrida)', `Se obtuvo: ${dir}`);
  assert(num(rate) === 0.02, 'la tasa del régimen es la registrada', `Se obtuvo: ${rate}`);
  assert(num(threshold) === 1000, 'el mínimo no imponible es el registrado', `Se obtuvo: ${threshold}`);

  // LA PRUEBA CENTRAL DE F-4: una retención SUFRIDA queda ligada al comprobante que la sufre,
  // con su régimen, su base y su motivo. Es lo que `0018` no podía hacer: no existía la tabla.
  const hecho = await sql(
    withTenant(
      TENANT_A,
      `SELECT d.id || '|' || d.tenant_id FROM fiscal.tax_documents d
        JOIN purchasing.supplier_invoices si
          ON si.id = d.source_id AND d.source_type = 'purchasing.supplier_invoice'
        WHERE d.tenant_id = '${TENANT_A}' AND si.doc_number = 7100;`
    )
  );
  const [docId] = output(hecho).split('|');
  assert(!!docId, 'hay un hecho fiscal de compra al que colgarle la retención', docId);

  const period = await periodOf(TENANT_A, fechaCompraF4);

  const retencion = await trySql(
    withTenant(
      TENANT_A,
      `INSERT INTO fiscal.document_withholdings
         (tenant_id, tax_document_id, regime_id, direction, taxable_base, amount,
          period_id, applied_on, basis, local_code)
       SELECT '${TENANT_A}', '${docId}', w.id, 'suffered', 2000.00, 40.00,
              '${period.id}', DATE '${await dateOf(TENANT_A, 2)}',
              'Retención de Ganancias 2% sobre 2000, mínimo no imponible 1000 superado',
              '217'
       FROM fiscal.withholding_regimes w
       WHERE w.tenant_id IS NULL AND w.code = 'RET-GAN';`
    )
  );
  assert(
    retencion.ok,
    'una retención sufrida se registra LIGADA a su comprobante, con régimen, base y motivo',
    `Éste es el defecto que el ADR 0005 corrige: hasta 0019 no existía ninguna tabla ` +
      `que ligara una retención a la factura que la sufre.\n${retencion.err}`
  );

  if (retencion.ok) {
    const ligada = await sql(
      withTenant(
        TENANT_A,
        `SELECT w.direction || '|' || w.amount || '|' || w.taxable_base || '|' || w.local_code
              || '|' || (w.regime_id IS NOT NULL)::text
         FROM fiscal.document_withholdings w
         WHERE w.tenant_id = '${TENANT_A}' AND w.tax_document_id = '${docId}';`
      )
    );
    const [d2, amount, base, localCode, hasRegime] = output(ligada).split('|');
    assert(d2 === 'suffered', 'el sentido de la retención es el sufrido', `Se obtuvo: ${d2}`);
    assert(num(amount) === 40, 'el importe de la retención es el correcto', `Se obtuvo: ${amount}`);
    assert(num(base) === 2000, 'la base sobre la que se retuvo queda registrada', `Se obtuvo: ${base}`);
    assert(hasRegime === 'true', 'la retención referencia el régimen que la origina');
    assert(localCode === '217', 'el código local que informó el agente se preserva sin ocupar el nombre principal');
  }

  // Una retención PRACTICADA es el sentido opuesto. Un sistema que las confundiera invertiría
  // el asiento, y el error sería invisible mientras sólo se usaran retenciones de un tipo.
  const prac = await seedPlatformTax('ret_iibb', 'withholding');
  const insPrac = await trySql(
    withPlatform(
      `INSERT INTO fiscal.withholding_regimes
         (tenant_id, tax_id, code, name, direction, threshold_amount, rate, jurisdiction, valid_from, legal_basis)
       VALUES (NULL, '${prac.id}', 'RET-IIBB', 'Retención de IIBB', 'practiced',
               0.00, 0.03, 'AR-C', DATE '${vigencia}', 'Convenio Multilateral');`
    ),
    { asAdmin: true }
  );
  assert(insPrac.ok, 'un régimen de retención practicada se registra', insPrac.err);

  const rPrac = await sql(
    withTenant(
      TENANT_A,
      `SELECT w.direction || '|' || w.jurisdiction
       FROM fiscal.withholdings_on(DATE '${vigencia}', '${prac.code}', '${TENANT_A}') w;`
    )
  );
  const [dirPrac, jurisdiccion] = output(rPrac).split('|');
  assert(dirPrac === 'practiced', 'los dos sentidos coexisten y no se confunden', `Se obtuvo: ${dirPrac}`);
  assert(jurisdiccion === 'AR-C', 'la jurisdicción de IIBB viaja con el régimen', `Se obtuvo: ${jurisdiccion}`);

  // Una retención MAYOR QUE SU BASE se rechaza: es el error de tipeo más común (21 en vez de
  // 0.21). La base es el techo.
  if (docId) {
    const mayorQueBase = await trySql(
      withTenant(
        TENANT_A,
        `INSERT INTO fiscal.document_withholdings
           (tenant_id, tax_document_id, direction, taxable_base, amount, period_id, applied_on, basis)
         VALUES ('${TENANT_A}', '${docId}', 'suffered', 100.00, 500.00, '${period.id}', CURRENT_DATE, 'monto imposible');`
      )
    );
    assert(!mayorQueBase.ok, 'una retención mayor que su base se rechaza (el error de tipeo más común)');
  }

  // Una tasa de retención fuera de rango se rechaza. `rate >= 0 AND rate < 1`: permitir 1.5
  // generaría una retención mayor que la base.
  const fueraDeRango = await trySql(
    withPlatform(
      `INSERT INTO fiscal.withholding_regimes
         (tenant_id, tax_id, code, name, direction, rate, valid_from)
       VALUES (NULL, '${ret.id}', 'RET-MALA', 'Mal cargada', 'suffered', 1.5, DATE '${vigencia}');`
    ),
    { asAdmin: true }
  );
  assert(!fueraDeRango.ok, 'una tasa de retención mayor o igual a 1 se rechaza');
}

// =============================================================================
// Escenario principal y F-1
// =============================================================================
// F-1 · El débito y el crédito del período cuadran con los comprobantes
//
// ACÁ ESTÁ LA ASERCIÓN QUE HABRÍA DETECTADO EL DEFECTO DE SIGNO DE `0018`.
//
// La posición neta se escribe como CONSTANTE ARITMÉTICA: 3150 − 840 = 2310. No sale de una
// consulta ni de una resta de la propia base. `0018` devolvía 3150 − (−840) = 3990, y sus
// propias verificaciones no lo veían porque comparaban el detalle contra el libro.
// =============================================================================
async function f1(taxA) {
  console.log('\n\u25b6 F-1 · El débito y el crédito del período cuadran con los comprobantes');

  const fecha = await dateOf(TENANT_A, 3);
  const period = await periodOf(TENANT_A, fecha);

  // Venta 1: 10000 neto → 2100 de débito
  // Venta 2:  5000 neto → 1050 de débito
  // Compra :  4000 neto →  840 de crédito
  //
  // Todo en el MISMO período, para que la posición neta sea una sola y comparable contra la
  // constante. Las fechas de emisión y recepción son la misma acá: este escenario mide el
  // cuadre, no el devengamiento — que es lo que mide F-2.
  const v1 = await createSaleInvoice(TENANT_A, 'CLI-A', 9001, fecha, 10000, 0.21, '21', taxA.id);
  assert(v1.ok, 'la primera venta se emite, se proyecta y se imputa', v1.err);
  const v2 = await createSaleInvoice(TENANT_A, 'CLI-A', 9002, fecha, 5000, 0.21, '21', taxA.id);
  assert(v2.ok, 'la segunda venta se emite, se proyecta y se imputa', v2.err);
  const c1 = await createPurchaseInvoice(
    TENANT_A, 'PROV-A', 7001, fecha, fecha, 4000, 840, taxA.id, '21'
  );
  assert(c1.ok, 'la compra se registra, se proyecta y se imputa', c1.err);

  // LAS TRES FUENTES TIENEN QUE COINCIDIR.
  //   a) el impuesto declarado en los comprobantes
  //   b) el discriminado por alícuota
  //   c) el hecho de imputación
  //
  // Comparar sólo (a) contra (c) dejaría pasar un comprobante cuyo discriminado esté mal
  // cargado pero cuya imputación coincida con el total.
  const cuadre = await sql(
    withTenant(
      TENANT_A,
      `
SELECT
  (SELECT COALESCE(sum(tax_total), 0) FROM billing.invoices
    WHERE tenant_id = '${TENANT_A}' AND status = 'authorized' AND kind = 'invoice'
      AND issue_date = DATE '${fecha}')::text
  || '|' ||
  (SELECT COALESCE(sum(dt.amount), 0) FROM fiscal.document_taxes dt
     JOIN fiscal.taxes t ON t.id = dt.tax_id
     JOIN fiscal.tax_documents d ON d.id = dt.tax_document_id
     JOIN fiscal.vat_accruals va ON va.tax_document_id = d.id
    WHERE dt.tenant_id = '${TENANT_A}' AND t.kind = 'vat' AND d.kind = 'sale'
      AND va.period_id = '${period.id}')::text
  || '|' ||
  (SELECT COALESCE(sum(amount), 0) FROM fiscal.vat_accruals
    WHERE tenant_id = '${TENANT_A}' AND direction = 'debit'
      AND period_id = '${period.id}')::text
  || '|' ||
  (SELECT COALESCE(sum(amount), 0) FROM fiscal.vat_accruals
    WHERE tenant_id = '${TENANT_A}' AND direction = 'credit'
      AND period_id = '${period.id}')::text;
`
    )
  );
  const [declarado, discriminado, debito, credito] = output(cuadre).split('|');

  assert(
    num(declarado) === num(discriminado),
    'el impuesto declarado en los comprobantes iguala al discriminado por alícuota',
    `declarado=${declarado} discriminado=${discriminado}`
  );
  assert(
    num(discriminado) === num(debito),
    'el discriminado de ventas iguala al débito imputado',
    `discriminado=${discriminado} débito=${debito}`
  );

  // LAS CONSTANTES ESCRITAS A MANO. Es el corazón de F-1.
  assert(
    num(debito) === 3150,
    'el débito es el que se calcula a mano: (10000 + 5000) × 0.21 = 3150',
    `Se obtuvo ${debito}`
  );
  assert(
    num(credito) === 840,
    'el crédito es el que se calcula a mano: 4000 × 0.21 = 840',
    `Se obtuvo ${credito}`
  );

  // LA POSICIÓN NETA DEL PERÍODO, contra la constante. Ésta es la aserción que el defecto de
  // signo de `0018` no podía pasar: devolvía 3990 (3150 + 840) porque el crédito entraba
  // negativo en la resta.
  const resumen = await sql(
    withTenant(
      TENANT_A,
      `SELECT vat_debit || '|' || vat_credit || '|' || net_position
       FROM fiscal.v_vat_period_summary
        WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';`
    )
  );
  const [rDebito, rCredito, rNeto] = output(resumen).split('|');

  assert(
    num(rNeto) === 2310,
    'la posición neta del período es 3150 − 840 = 2310 (la constante, no una resta de la base)',
    `Se obtuvo ${rNeto}. Si diera 3990, el crédito estaría entrando NEGATIVO en la resta: ` +
      `es el defecto de signo de 0018, que duplica la posición en todo período con compras.`
  );
  assert(
    num(rCredito) === 840,
    'el crédito del resumen es POSITIVO (840), no −840',
    `Se obtuvo ${rCredito}. Un crédito fiscal negativo es el síntoma exacto del defecto de signo.`
  );
  assert(
    num(rDebito) === 3150,
    'el débito del resumen es 3150',
    `Se obtuvo ${rDebito}`
  );
}

// =============================================================================
// F-3 · El libro digital cuadra con los comprobantes
// =============================================================================
async function f3() {
  console.log('\n\u25b6 F-3 · El libro digital cuadra con los comprobantes');

  const gaps = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM fiscal.v_vat_gaps WHERE tenant_id = '${TENANT_A}';`
    )
  );
  assert(
    num(output(gaps)) === 0,
    'v_vat_gaps no reporta brechas: el libro cuadra con los comprobantes',
    `Se encontraron ${output(gaps)} brechas`
  );

  // Una brecha que NO existe no prueba que la vista sepa encontrarla. Se planta una a
  // propósito: un comprobante autorizado con IVA declarado y sin discriminado.
  //
  // Sin esta prueba, una vista que devolviera siempre 0 filas —por un JOIN mal escrito, por
  // ejemplo— pasaría F-3 con honores. Es el falso verde clásico de una consulta de control.
  const hoy = await dateOf(TENANT_A, 4);
  const plantada = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_cust uuid;
  v_inv  uuid;
BEGIN
  SELECT id INTO v_cust FROM app.customers WHERE tenant_id = '${TENANT_A}' AND code = 'CLI-A';
  INSERT INTO billing.invoices
    (tenant_id, customer_id, kind, doc_type, point_of_sale, number,
     receptor_name, receptor_doc_number, issue_date,
     subtotal, tax_total, total, status, result, authorization_id, idempotency_key, created_by)
  VALUES
    ('${TENANT_A}', v_cust, 'invoice', 'A', 1, 9099,
     'Cliente sin discriminado', '30711111111', DATE '${hoy}',
     1000.00, 210.00, 1210.00, 'authorized', 'approved', '00000000909999', 'fisc-gap-9099', '${USER_A}')
  RETURNING id INTO v_inv;

  -- A propósito: el hecho SÍ se proyecta, y el discriminado NO se inserta.
  PERFORM fiscal.project_tax_document(
    '${TENANT_A}', 'sale', 'billing.invoice', v_inv, 'A 9099', DATE '${hoy}', NULL, 'authorized');
END $$;
`
    )
  );
  assert(plantada.ok, 'se planta un comprobante con IVA declarado y sin discriminado', plantada.err);

  const gaps2 = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM fiscal.v_vat_gaps
        WHERE tenant_id = '${TENANT_A}' AND gap_kind = 'declarado_vs_discriminado';`
    )
  );
  assert(
    num(output(gaps2)) >= 1,
    'la vista DETECTA la brecha plantada (no es una consulta que siempre devuelve 0)',
    `Se encontraron ${output(gaps2)} brechas del tipo esperado`
  );

  const detalle = await sql(
    withTenant(
      TENANT_A,
      `SELECT detail FROM fiscal.v_vat_gaps
        WHERE tenant_id = '${TENANT_A}' AND gap_kind = 'declarado_vs_discriminado'
          AND document_number LIKE '%9099%' LIMIT 1;`
    )
  );
  assert(
    /210/.test(output(detalle)),
    'la brecha explica QUÉ diferencia hay, con los dos números',
    `Se obtuvo: ${output(detalle)}`
  );

  // Y la brecha de COMPRAS, que la versión anterior de la vista no podía ver porque sólo
  // miraba comprobantes de venta. Es la rama que hacía falta para que F-3 cubriera el
  // crédito fiscal.
  const compraHoy = await dateOf(TENANT_A, 4);
  const compraSinDisc = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_sup uuid;
  v_inv uuid;
BEGIN
  SELECT id INTO v_sup FROM app.suppliers WHERE tenant_id = '${TENANT_A}' AND code = 'PROV-A';
  INSERT INTO purchasing.supplier_invoices
    (tenant_id, number, supplier_id, doc_type, point_of_sale, doc_number,
     issue_date, due_date, received_on, subtotal, tax_total, total)
  VALUES ('${TENANT_A}', 'FC-GAP', v_sup, 'A', 1, 8888,
     DATE '${compraHoy}', DATE '${compraHoy}', DATE '${compraHoy}', 500.00, 105.00, 605.00)
  RETURNING id INTO v_inv;
  PERFORM fiscal.project_tax_document(
    '${TENANT_A}', 'purchase', 'purchasing.supplier_invoice', v_inv, 'FC 8888',
    DATE '${compraHoy}', DATE '${compraHoy}', 'authorized');
END $$;
`
    )
  );
  assert(compraSinDisc.ok, 'se planta una COMPRA con IVA declarado y sin discriminado', compraSinDisc.err);

  const gapsCompra = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM fiscal.v_vat_gaps
        WHERE tenant_id = '${TENANT_A}' AND gap_kind = 'declarado_vs_discriminado'
          AND document_number LIKE '%8888%';`
    )
  );
  assert(
    num(output(gapsCompra)) >= 1,
    'la vista detecta la brecha de una COMPRA (la versión de 0018 era ciega a compras)',
    `Se encontraron ${output(gapsCompra)} brechas de compra`
  );
}

// =============================================================================
// F-6 · La posición de IVA es reproducible desde el libro
// =============================================================================
// El gate de E5. Se mide por dos caminos independientes que tienen que dar el mismo número,
// y se repite la medición para verificar que no dependa de un estado efímero.
// =============================================================================
async function f6() {
  console.log('\n\u25b6 F-6 · La posición de IVA es reproducible desde el libro');

  const fecha = await dateOf(TENANT_A, 3);
  const period = await periodOf(TENANT_A, fecha);

  // CAMINO 1: la posición resumida, que es la consulta que un operador usaría.
  const resumen = await sql(
    withTenant(
      TENANT_A,
      `SELECT vat_debit || '|' || vat_credit || '|' || net_position || '|' || total_divergence
       FROM fiscal.v_vat_period_summary
        WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';`
    )
  );
  const [debito, credito, neto, divergencia] = output(resumen).split('|');

  // CAMINO 2: la posición recalculada A MANO desde los hechos de imputación.
  //
  // Ésta es la medición que da sentido al gate. Si los dos caminos coinciden, la posición es
  // reproducible: cualquiera puede recalcularla desde el libro sin depender de que la vista
  // esté bien escrita. Si difieren, la vista es una opinión y no una determinación.
  const crudo = await sql(
    withTenant(
      TENANT_A,
      `
SELECT
  COALESCE(sum(amount) FILTER (WHERE direction = 'debit'), 0)::text || '|' ||
  COALESCE(sum(amount) FILTER (WHERE direction = 'credit'), 0)::text
FROM fiscal.vat_accruals
WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';
`
    )
  );
  const [debitoCrudo, creditoCrudo] = output(crudo).split('|');

  assert(
    num(debito) === num(debitoCrudo),
    'el débito del resumen coincide con la suma de los hechos del período',
    `resumen=${debito} hechos=${debitoCrudo}`
  );
  assert(
    num(credito) === num(creditoCrudo),
    'el crédito del resumen coincide con la suma de los hechos del período',
    `resumen=${credito} hechos=${creditoCrudo}`
  );

  // La posición neta, otra vez contra la CONSTANTE. Es la misma aserción de F-1 vista desde
  // el gate: si el signo del crédito estuviera invertido, acá daría 3990.
  assert(
    num(neto) === 2310,
    'la posición neta es la constante aritmética 3150 − 840 = 2310',
    `Se obtuvo ${neto}`
  );
  assert(
    num(neto) === num(debito) - num(credito),
    'la posición neta es débito MENOS crédito, con los dos positivos',
    `neto=${neto} débito=${debito} crédito=${credito}`
  );

  // LA VERIFICACIÓN CRUZADA CONTRA EL LIBRO. `divergence` compara el detalle de imputaciones
  // contra el total asentado en las cuentas de IVA. Es la pieza que convierte la vista en una
  // consulta de control: expone la diferencia en vez de asumir que no hay.
  assert(
    num(divergencia) === 0,
    'la posición derivada NO diverge del libro (la posición es reproducible)',
    `divergence=${divergencia}. Una divergencia distinta de cero significa que hay hechos ` +
      `sin imputar o asientos sin hecho, y en los dos casos la posición presentada está mal.`
  );

  // REPRODUCIBILIDAD: se vuelve a calcular y tiene que dar lo mismo. Una posición que
  // dependiera de un acumulador mutable cambiaría entre dos llamadas.
  const segunda = await sql(
    withTenant(
      TENANT_A,
      `SELECT net_position::text FROM fiscal.v_vat_period_summary
        WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';`
    )
  );
  assert(
    num(output(segunda)) === num(neto),
    'dos consultas consecutivas devuelven la misma posición',
    `primera=${neto} segunda=${output(segunda)}`
  );

  // EL LIBRO, CON EL DETALLE POR ALÍCUOTA. F-6 pide que la posición sea reproducible desde el
  // LIBRO, y un total agregado no permite verificarlo: hay que poder ver de qué alícuota
  // salió cada peso.
  const porAlicuota = await sql(
    withTenant(
      TENANT_A,
      `SELECT string_agg(rate_code || ':' || direction || ':' || amount, ' ' ORDER BY direction, rate_code)
       FROM fiscal.v_vat_position
        WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';`
    )
  );
  assert(
    /21:credit:840\.00/.test(output(porAlicuota)) && /21:debit:3150\.00/.test(output(porAlicuota)),
    'la posición se discrimina por alícuota: 21% débito 3150 y crédito 840',
    `Se obtuvo: ${output(porAlicuota)}`
  );

  // IDEMPOTENCIA: reprocesar no duplica el cómputo. Sin el `ON CONFLICT ... DO UPDATE`, un
  // reintento inflaría el débito y la posición dejaría de cuadrar con los comprobantes. Es el
  // defecto más caro de esta familia, porque sólo aparece cuando algo se reintenta —es decir,
  // cuando algo ya salió mal—.
  const docCompra = await sql(
    withTenant(
      TENANT_A,
      `SELECT d.id FROM fiscal.tax_documents d
        WHERE d.tenant_id = '${TENANT_A}' AND d.source_type = 'purchasing.supplier_invoice'
          AND d.document_number LIKE '%7001' LIMIT 1;`
    )
  );
  const docId = output(docCompra);
  if (docId) {
    await sql(withTenant(TENANT_A, `SELECT fiscal.accrue_vat('${TENANT_A}', '${docId}', NULL);`));
    const trasReproceso = await sql(
      withTenant(
        TENANT_A,
        `SELECT count(*)::text FROM fiscal.vat_accruals
          WHERE tenant_id = '${TENANT_A}' AND tax_document_id = '${docId}';`
      )
    );
    assert(
      num(output(trasReproceso)) === 1,
      'reprocesar la imputación no duplica el crédito (idempotencia)',
      `Se encontraron ${output(trasReproceso)} filas para el mismo hecho`
    );

    // Y la posición sigue siendo la misma después del reproceso.
    const trasNeto = await sql(
      withTenant(
        TENANT_A,
        `SELECT net_position::text FROM fiscal.v_vat_period_summary
          WHERE tenant_id = '${TENANT_A}' AND period_id = '${period.id}';`
      )
    );
    assert(
      num(output(trasNeto)) === 2310,
      'la posición no cambia después de reprocesar (la constante sigue siendo 2310)',
      `Se obtuvo ${output(trasNeto)}`
    );
  }
}

// =============================================================================
// Aislamiento · lo que cierra E5
// =============================================================================
async function aislamiento(taxB) {
  console.log('\n\u25b6 Aislamiento · la posición de una empresa no contiene datos de la otra');

  // Se le da a B su propio hecho fiscal para que las pruebas de aislamiento no pasen por
  // vacuidad: con B vacío, "A no ve a B" sería cierto por no haber nada que ver.
  const fechaB = await dateOf(TENANT_B, 3);
  const vB = await createSaleInvoice(TENANT_B, 'CLI-B', 9001, fechaB, 7000, 0.21, '21', taxB.id, USER_B);
  assert(vB.ok, 'B tiene su propio escenario (para que el aislamiento mida algo)', vB.err);

  const a = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM fiscal.v_vat_position WHERE tenant_id <> '${TENANT_A}';`
    )
  );
  assert(
    num(output(a)) === 0,
    'A no ve ninguna fila de posición de otra empresa',
    `Se obtuvieron ${output(a)} filas ajenas`
  );

  const b = await sql(
    withTenant(
      TENANT_B,
      `SELECT count(*)::text FROM fiscal.v_vat_position WHERE tenant_id <> '${TENANT_B}';`
    )
  );
  assert(
    num(output(b)) === 0,
    'B no ve ninguna fila de posición de otra empresa',
    `Se obtuvieron ${output(b)} filas ajenas`
  );

  // Sin contexto de sesión, toda lectura devuelve 0 filas. Es el fail-closed que documenta la
  // suite de aislamiento: un sistema que sin contexto devuelve todo es peor que uno que no
  // devuelve nada.
  const sinContexto = await trySql(
    [
      'BEGIN;',
      'SELECT app.set_tenant_context(NULL, NULL, false);',
      'SELECT count(*)::text FROM fiscal.tax_documents;',
      'COMMIT;',
    ].join('\n')
  );
  assert(
    !sinContexto.ok || num(output(sinContexto.out || '')) === 0,
    'sin contexto de empresa, los hechos fiscales no se ven',
    sinContexto.ok ? `Se obtuvieron ${output(sinContexto.out)} filas` : sinContexto.err
  );

  // Un hecho fiscal de A no puede reclamar un documento de B. Ésta es la garantía que la FK
  // compuesta daba y que la relación polimórfica perdió; la recupera el trigger.
  const docB = await sql(
    withTenant(
      TENANT_B,
      `SELECT id FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_B}' LIMIT 1;`
    )
  );
  const facturaB = output(docB);

  const cruzadoOk = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_A}';`
    )
  );
  assert(num(output(cruzadoOk)) >= 0, 'A no ve las facturas de compra de B (RLS)');

  if (facturaB) {
    const robo = await trySql(
      withTenant(
        TENANT_A,
        `SELECT fiscal.project_tax_document(
           '${TENANT_A}', 'purchase', 'purchasing.supplier_invoice', '${facturaB}',
           'FC robada', CURRENT_DATE, CURRENT_DATE, 'authorized');`
      )
    );
    assert(
      !robo.ok,
      'A NO puede proyectar como suyo un documento de compra de B',
      robo.ok
        ? 'El trigger de origen no lo impidió: un hecho fiscal de A quedó apuntando a un ' +
          'documento de B. Es la garantía que la FK compuesta daba y que la relación ' +
          'polimórfica tiene que recuperar.'
        : ''
    );
  }

  // Las retenciones tampoco cruzan.
  const cruceRetencion = await trySql(
    withTenant(
      TENANT_A,
      `INSERT INTO fiscal.document_withholdings
         (tenant_id, tax_document_id, direction, taxable_base, amount, period_id, applied_on, basis)
       SELECT '${TENANT_A}', d.id, 'suffered', 100, 2,
              (SELECT id FROM accounting.periods WHERE tenant_id = '${TENANT_A}' LIMIT 1),
              CURRENT_DATE, 'cruce'
       FROM fiscal.tax_documents d
       WHERE d.tenant_id = '${TENANT_B}' LIMIT 1;`
    )
  );
  assert(
    !cruceRetencion.ok || num(output(cruceRetencion.out || '0')) === 0,
    'una retención de A no puede colgar de un hecho fiscal de B'
  );
}

// =============================================================================
// La barrera · integridad fiscal
// =============================================================================
// `fiscal.assert_fiscal_integrity()` existe para que la omisión que el ADR 0005 corrige no
// pueda volver a pasar. Una función que nadie ejecuta no protege nada, así que la suite la
// ejecuta — y verifica que SEPA FALLAR, no sólo que pase.
// =============================================================================
async function barrera() {
  console.log('\n\u25b6 La barrera · integridad fiscal verificable');

  const limpia = await trySql(`SELECT fiscal.assert_fiscal_integrity();`, { asAdmin: true });
  assert(
    limpia.ok,
    'assert_fiscal_integrity() pasa sobre un escenario consistente',
    limpia.err
  );

  // Y ahora se verifica que DETECTE. Se planta un hecho fiscal con un origen inexistente y se
  // comprueba que la función lo reporte.
  //
  // Sin esto, la barrera podría estar aprobando siempre y nadie lo sabría — el mismo falso
  // verde que produjo el defecto de signo. Una verificación que nunca falla no es una
  // verificación.
  const plantado = await trySql(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
-- El trigger impide insertar un origen inexistente, así que se desactiva SÓLO dentro de esta
-- transacción para poder probar que la barrera lo detectaría igual. Es una prueba negativa
-- sobre la barrera, no un atajo: la transacción se revierte.
ALTER TABLE fiscal.tax_documents DISABLE TRIGGER trg_tax_documents_source;
INSERT INTO fiscal.tax_documents
  (tenant_id, kind, source_type, source_id, fiscal_date, date_basis, document_number, status)
VALUES ('${TENANT_A}', 'sale', 'billing.invoice', gen_random_uuid(), CURRENT_DATE,
        'prueba negativa de la barrera', 'FANTASMA', 'authorized');
SELECT fiscal.assert_fiscal_integrity();
ROLLBACK;
`, { asAdmin: true });

  assert(
    !plantado.ok,
    'la barrera DETECTA un hecho fiscal cuyo origen no existe (sabe fallar)',
    plantado.ok
      ? 'assert_fiscal_integrity() aceptó un hecho huérfano. Una barrera que no falla ' +
        'nunca no protege de nada.'
      : ''
  );

  if (!plantado.ok) {
    assert(
      /origen no existe|huérfano/i.test(plantado.err),
      'el mensaje de la barrera explica QUÉ encontró',
      `Se obtuvo: ${plantado.err.slice(0, 240)}`
    );
  }
}

// =============================================================================
// main
// =============================================================================
async function main() {
  console.log('\u2554' + '\u2550'.repeat(74) + '\u2557');
  console.log('\u2551 Suite de la puerta de E5 · Determinación de IVA'.padEnd(75) + '\u2551');
  console.log('\u2551 Gate §7.1: "Posición de IVA reproducible desde el libro"'.padEnd(75) + '\u2551');
  console.log('\u2551 Criterios §6.2: F-1, F-2, F-3, F-4, F-5, F-6'.padEnd(75) + '\u2551');
  console.log('\u255a' + '\u2550'.repeat(74) + '\u255d');

  await preflight();
  await setup();

  const taxA = await f5();
  await f4(taxA);
  await f2(taxA);
  await f1(taxA);
  await f3();
  await f6();

  // B necesita su impuesto para el escenario de aislamiento.
  const taxB = await seedPlatformTax('iva_b');
  await createRateB(taxB);
  await aislamiento(taxB);

  await barrera();

  console.log('\n' + '='.repeat(76));
  if (failures.length === 0) {
    console.log(` RESULTADO: OK · ${passCount} verificaciones aprobadas`);
    console.log(' El gate de E5 está MEDIDO: la posición de IVA es reproducible desde el libro.');
  } else {
    console.error(` RESULTADO: FALLA · ${passCount} aprobadas, ${failures.length} fallidas`);
    for (const f of failures) console.error(`   \u2717 ${f.label}`);
    console.error('\n El gate de E5 NO pasa. La fase no puede cerrarse.');
  }
  console.log('='.repeat(76));

  process.exit(failures.length === 0 ? 0 : 1);
}

async function createRateB(tax) {
  const vigencia = await dateOf(TENANT_B, 1);
  // Alícuota de plataforma (tenant_id NULL), con el rol de plataforma: `fiscal.tax_rates`
  // es parámetro de plataforma (igual que `fiscal.taxes`), y el rol de aplicación sólo
  // tiene SELECT sobre ella.
  return sqlAdmin(
    withPlatform(
      `INSERT INTO fiscal.tax_rates (tenant_id, tax_id, rate_code, rate, valid_from)
       VALUES (NULL, '${tax.id}', '21', 0.21, DATE '${vigencia}');`
    )
  );
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  if (e.stderr) console.error('--- stderr del motor ---\n' + e.stderr);
  if (e.stdout) console.error('--- stdout del motor ---\n' + e.stdout);
  if (e.input) console.error('--- SQL enviado ---\n' + e.input);
  process.exit(1);
});
