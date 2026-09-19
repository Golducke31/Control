#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de la puerta de E6 · Documentos de venta (remito)
 * -----------------------------------------------------------------------------
 * QUÉ MIDE
 *
 * La fase E6 del plan tiene un gate medible, en §7.1:
 *
 *     "Remito facturado en partes sin duplicar cantidades"
 *
 * Este archivo lo MIDE en vez de declararlo, contra un motor PostgreSQL real. El
 * riesgo que cierra es que, al facturar un remito en varias partes, las cantidades
 * no se cuenten dos veces ni se excedan las despachadas. Hasta 0021 no había
 * documento de remito: el que viaja con la mercadería lo ocupaba
 * `logistics.shipments` (despacho operativo), y nada impedía facturar dos veces la
 * misma mercadería.
 *
 * LOS CRITERIOS (§6.2, módulo "Documentos de venta")
 *
 *   V-2  Remito facturado en partes: las cantidades no se duplican.      ← gate
 *   V-7  El CHECK de motor impide qty_invoiced > quantity.
 *
 * REGLA DE LA SUITE: no comparar el sistema consigo mismo. Los montos los
 * escribe como constantes cuando se puede; el acumulado se lee de la columna que
 * el motor garantiza, no de una conjetura.
 *
 * USO
 *   node tests/sales/run.mjs \
 *     --dsn "postgres://app_login:...@host:5432/control" \
 *     --admin-dsn "postgres://postgres:...@host:5432/control" --verbose
 *
 * Requiere `psql` en el PATH, o `PG_BIN` apuntando a la carpeta de binarios.
 * Salida: 0 si el gate pasa · 1 si falla · 2 si el entorno no sirve.
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PSQL = process.env.PG_BIN
  ? join(process.env.PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql')
  : 'psql';

// Empresas y usuarios de prueba. Rango `f6xx`, distinto de los demás suites.
const TENANT_A = '00000000-0000-4000-f600-0000000000a0';
const TENANT_B = '00000000-0000-4000-f600-0000000000b0';
const USER_A = '00000000-0000-4000-f600-0000000000a1';
const USER_B = '00000000-0000-4000-f600-0000000000b1';
const ROLE_OWNER = '11111111-1111-1111-1111-000000000001';

// IDs fijos del escenario para no tener que parsear RETURNING.
const CUST_A = 'd6000000-0000-4000-f600-0000000000a0';
const PROD_A = 'd6000000-0000-4000-f600-0000000000b0';
const VAR_A = 'd6000000-0000-4000-f600-0000000000c0';
const WH_A = 'd6000000-0000-4000-f600-0000000000d0';
const ORDER_A = 'd6000000-0000-4000-f600-0000000000e0';
const DN_A = 'd6000000-0000-4000-f600-0000000000f0';
const DN_ITEM_A = 'd6000000-0000-4000-f600-000000000010';
const REMITO_QTY = 100;

let VERBOSE = false;
let passCount = 0;
const failures = [];

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
    console.error('\nFalta el DSN de aplicación. node tests/sales/run.mjs --dsn "..."');
    process.exit(2);
  }
  if (!out.adminDsn) {
    console.error('\nFalta el DSN administrativo (--admin-dsn).');
    process.exit(2);
  }
  return out;
}

function splitDsn(dsn) {
  let u;
  try {
    u = new URL(dsn);
  } catch {
    throw new Error('DSN inválido: ' + dsn);
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

function spawnPsql(args, { input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, args, { env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (e) =>
      reject(Object.assign(new Error(e.message), { stderr: e.message, stdout: '' }))
    );
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

async function sql(statements, { asAdmin = false } = {}) {
  const conn = asAdmin ? ADMIN_CONN : APP_CONN;
  const { stdout, stderr } = await spawnPsql(
    [
      '-U', conn.user, '-h', conn.host, '-p', conn.port, '-d', conn.database,
      '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '-v', 'ON_ERROR_STOP=1', '-f', '-',
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

function sqlAdmin(statements) {
  return sql(statements, { asAdmin: true });
}

async function trySql(statements) {
  try {
    return { ok: true, out: await sql(statements) };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message) };
  }
}

/** Contexto de sesión por el camino validado de la aplicación. */
function withTenant(tenantId, body, userId = USER_A) {
  return [
    'BEGIN;',
    `SELECT app.set_tenant_context('${tenantId}'::uuid, '${userId}'::uuid, false);`,
    body,
    'COMMIT;',
  ].join('\n');
}

function output(raw) {
  return String(raw)
    .split('\n')
    .filter((l) => !/^(NOTICE|WARNING|DETAIL|HINT|CONTEXT|INFO):/i.test(l.trim()))
    .filter((l) => !/^psql:/.test(l.trim()))
    .join('\n')
    .trim();
}

function num(v) {
  return Number(String(v).trim() || '0');
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
FROM pg_roles WHERE rolname = current_user;`);

  if (!res.ok) {
    console.error(`\n  No se pudo conectar con el DSN de aplicación:\n${res.err}\n`);
    process.exit(2);
  }
  const [user, isSuper, bypass, isMember] = output(res.out).split('|');
  if (isSuper === 'true' || bypass === 'true') {
    console.error(
      `\n  ABORTADO: la suite corre como \`${user}\`, que es superusuario o tiene BYPASSRLS.\n` +
        '  RLS no se evalúa para ese rol y el aislamiento parecería probado sin haberlo estado.\n'
    );
    process.exit(2);
  }
  if (isMember !== 'true') {
    console.error(`\n  ABORTADO: el rol \`${user}\` no es miembro de \`control_app\`.\n`);
    process.exit(2);
  }
  console.log(`  \u2713 Rol confirmado: \`${user}\` (sin BYPASSRLS, miembro de control_app)`);
}

// =============================================================================
// Preparación
// =============================================================================
async function setup() {
  console.log('\n\u25b6 Preparación del escenario');

  // Limpieza idempotente (orden de dependencia inverso).
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM billing.invoice_items        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoices             WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_note_items  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_notes       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_order_items    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_orders         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.product_variants         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.products                 WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.warehouses               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.customers                WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                  WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                    WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'sales-sub-a', 'sales-a@test.local', true, 'Sales A'),
  ('${USER_B}', 'sales-sub-b', 'sales-b@test.local', true, 'Sales B');
INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'sales-a', 'Sales Avanzado A S.A.', 'Sales A', 'active', 'ARS'),
  ('${TENANT_B}', 'sales-b', 'Sales Avanzado B S.R.L.', 'Sales B', 'active', 'ARS');
INSERT INTO app.memberships (tenant_id, user_id, role_id, is_active)
VALUES
  ('${TENANT_A}', '${USER_A}', '${ROLE_OWNER}', true),
  ('${TENANT_B}', '${USER_B}', '${ROLE_OWNER}', true);
COMMIT;
`);

  // Datos de negocio como el rol de aplicación (con contexto de tenant).
  const res = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO app.customers (id, tenant_id, code, legal_name, doc_type, doc_number, tax_condition)
VALUES ('${CUST_A}', '${TENANT_A}', 'CLI-A', 'Cliente A S.A.', 'CUIT', '30700000001', 'responsable_inscripto');

INSERT INTO app.products (id, tenant_id, sku, name, unit)
VALUES ('${PROD_A}', '${TENANT_A}', 'SKU-A', 'Producto A', 'un');

INSERT INTO app.product_variants (id, tenant_id, product_id, sku, list_price)
VALUES ('${VAR_A}', '${TENANT_A}', '${PROD_A}', 'SKU-A-1', 100.00);

INSERT INTO app.warehouses (id, tenant_id, code, name)
VALUES ('${WH_A}', '${TENANT_A}', 'W-A', 'Depósito A');

INSERT INTO billing.sales_orders (id, tenant_id, number, customer_id, status, subtotal, total)
VALUES ('${ORDER_A}', '${TENANT_A}', 'ORD-1', '${CUST_A}', 'confirmed', 12100.00, 12100.00);

INSERT INTO billing.sales_order_items (id, tenant_id, order_id, variant_id, description, quantity, unit_price, tax_rate)
VALUES (gen_random_uuid(), '${TENANT_A}', '${ORDER_A}', '${VAR_A}', 'Producto A', ${REMITO_QTY}, 100.00, 0.21);

-- El remito: documento propio que autoriza la salida y es origen de la facturación.
INSERT INTO billing.delivery_notes (id, tenant_id, number, order_id, customer_id, warehouse_id, status)
VALUES ('${DN_A}', '${TENANT_A}', 'REM-1', '${ORDER_A}', '${CUST_A}', '${WH_A}', 'issued');

INSERT INTO billing.delivery_note_items
  (id, tenant_id, delivery_note_id, variant_id, description, quantity, qty_invoiced, unit_price, discount_rate, tax_rate, line_total)
VALUES
  ('${DN_ITEM_A}', '${TENANT_A}', '${DN_A}', '${VAR_A}', 'Producto A', ${REMITO_QTY}, 0, 100.00, 0, 0.21, 12100.00);
`
    )
  );
  if (!res.ok) {
    console.error(`\n  No se pudo preparar el escenario: ${res.err}`);
    process.exit(2);
  }
  console.log('  \u2713 Escenario preparado (remito de 100 unidades listo para facturar en partes)');
}

// =============================================================================
// Gate V-2 · Remito facturado en partes sin duplicar cantidades
// =============================================================================
async function gateV2() {
  console.log('\n\u25b6 Gate V-2 · Remito facturado en partes sin duplicar cantidades');

  const lineId = DN_ITEM_A;

  // 1) Facturar 60 de 100.
  const inv1 = output(
    await sql(
      withTenant(
        TENANT_A,
        `SELECT billing.invoice_delivery_note('${TENANT_A}', '${DN_A}', 'B', 1, 1,
          '[{"delivery_note_item_id":"${lineId}","quantity":60}]'::jsonb);`
      )
    )
  );
  assert('facturar 60 del remito de 100 es aceptado', !!inv1 && inv1.length > 0, `inv1=${inv1}`);

  const q1 = num(
    output(await sql(withTenant(TENANT_A, `SELECT qty_invoiced FROM billing.delivery_note_items WHERE id = '${lineId}';`)))
  );
  assert('el acumulado de la línea queda en 60 tras la primera factura', q1 === 60, `qty_invoiced=${q1}`);

  const st1 = output(
    await sql(withTenant(TENANT_A, `SELECT status FROM billing.delivery_notes WHERE id = '${DN_A}';`))
  );
  assert('el remito queda en partially_invoiced', st1 === 'partially_invoiced', st1);

  // 2) Facturar los 40 restantes.
  const inv2 = output(
    await sql(
      withTenant(
        TENANT_A,
        `SELECT billing.invoice_delivery_note('${TENANT_A}', '${DN_A}', 'B', 1, 2,
          '[{"delivery_note_item_id":"${lineId}","quantity":40}]'::jsonb);`
      )
    )
  );
  assert('facturar los 40 restantes es aceptado', !!inv2 && inv2.length > 0, `inv2=${inv2}`);

  const q2 = num(
    output(await sql(withTenant(TENANT_A, `SELECT qty_invoiced FROM billing.delivery_note_items WHERE id = '${lineId}';`)))
  );
  assert('el acumulado de la línea queda en 100 (60+40)', q2 === 100, `qty_invoiced=${q2}`);

  const st2 = output(
    await sql(withTenant(TENANT_A, `SELECT status FROM billing.delivery_notes WHERE id = '${DN_A}';`))
  );
  assert('el remito queda en invoiced', st2 === 'invoiced', st2);

  // 3) La suma de lo facturado de la línea es 100, no 160 ni 200.
  const tot = num(
    output(
      await sql(
        withTenant(
          TENANT_A,
          `SELECT COALESCE(sum(quantity), 0) FROM billing.invoice_items WHERE delivery_note_item_id = '${lineId}';`
        )
      )
    )
  );
  assert('la suma de lo facturado de la línea es 100 (sin duplicar)', tot === 100, `total=${tot}`);

  // 4) Sobre-facturar 1 más: rechazado.
  const over = await trySql(
    withTenant(
      TENANT_A,
      `SELECT billing.invoice_delivery_note('${TENANT_A}', '${DN_A}', 'B', 1, 3,
        '[{"delivery_note_item_id":"${lineId}","quantity":1}]'::jsonb);`
    )
  );
  assert('facturar 1 más de lo despachado es rechazado', !over.ok, over.err);

  // 5) Volver a facturar 60 (ya en 100): rechazado.
  const dup = await trySql(
    withTenant(
      TENANT_A,
      `SELECT billing.invoice_delivery_note('${TENANT_A}', '${DN_A}', 'B', 1, 4,
        '[{"delivery_note_item_id":"${lineId}","quantity":60}]'::jsonb);`
    )
  );
  assert('volver a facturar 60 ya facturado es rechazado', !dup.ok, dup.err);

  // 6) El CHECK de motor protege aunque se saltee la función (V-7).
  const direct = await trySql(
    withTenant(TENANT_A, `UPDATE billing.delivery_note_items SET qty_invoiced = 200 WHERE id = '${lineId}';`)
  );
  assert('el CHECK del motor impide qty_invoiced > quantity', !direct.ok, direct.err);

  // 7) Aislamiento: la empresa B no puede facturar el remito de A (RLS + filtro de función).
  const cross = await trySql(
    withTenant(
      TENANT_B,
      `SELECT billing.invoice_delivery_note('${TENANT_B}', '${DN_A}', 'B', 1, 5,
        '[{"delivery_note_item_id":"${lineId}","quantity":1}]'::jsonb);`
    )
  );
  assert('una empresa no puede facturar el remito de otra (RLS)', !cross.ok, cross.err);
}

// =============================================================================
async function main() {
  preflight();
  await setup();
  await gateV2();

  console.log(`\n${'='.repeat(70)}`);
  if (failures.length === 0) {
    console.log(` RESULTADO: OK · ${passCount} verificaciones aprobadas`);
  } else {
    console.error(` RESULTADO: FALLA · ${passCount} aprobadas, ${failures.length} fallidas`);
  }
  console.log('='.repeat(70));

  // Limpieza del escenario (con rol de plataforma).
  try {
    await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM billing.invoice_items        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoices             WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_note_items  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_notes       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_order_items    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_orders         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.product_variants         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.products                 WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.warehouses               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.customers                WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                  WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                    WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);
  } catch (e) {
    console.error('Advertencia: no se pudo limpiar el escenario:', e.message);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  process.exit(1);
});
