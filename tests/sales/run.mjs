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

// --- Escenario de la devolución (V-3) -----------------------------------------
// La devolución se prueba sobre una FACTURA AUTORIZADA, que es su origen real:
// la nota de crédito que genera se aplica contra ella.
const INV_DEV          = 'd6000000-0000-4000-f600-000000000020';
const INV_DEV_DRAFT    = 'd6000000-0000-4000-f600-000000000021';
const RET_OK           = 'd6000000-0000-4000-f600-000000000030';
const RET_OVER         = 'd6000000-0000-4000-f600-000000000031';
const RET_DRAFT        = 'd6000000-0000-4000-f600-000000000032';
const RET_FRAC         = 'd6000000-0000-4000-f600-000000000033';
const RET_CROSS        = 'd6000000-0000-4000-f600-000000000034';
const RET_ON_DRAFT_INV = 'd6000000-0000-4000-f600-000000000035';
const DEV_INVOICED_QTY   = 10;    // lo que la factura facturó de la variante
const DEV_RETURN_QTY     = 4;     // lo que devuelve la devolución del camino feliz
const DEV_UNIT_PRICE     = 100;
const DEV_TAX_RATE       = 0.21;
const DEV_STOCK_INICIAL  = 5;
// 4 × 100 = 400 neto · 84 de IVA · 484 de total.
// Van como literales y no como producto en JS: `400 * 0.21` da 84.00000000000001
// en punto flotante, y ese valor interpolado en el SQL haría fallar la comparación
// contra un `numeric(14,2)` que el motor redondea a 84.00. La aritmética del
// sistema se mide contra el motor, no contra el redondeo binario de quien la escribe.
const DEV_NET   = 400;
const DEV_TAX   = 84;
const DEV_TOTAL = 484;

// --- Escenario de listas de precios (V-4) -------------------------------------
// `VAR_A` ya existe con `list_price = 100.00`, que es la base del multiplicador.
const LIST_MAY   = 'd6000000-0000-4000-f600-000000000040'; // multiplicador 0.85 + escalas
const LIST_RET   = 'd6000000-0000-4000-f600-000000000041'; // multiplicador 1.00, sin escalas
const LIST_PROMO = 'd6000000-0000-4000-f600-000000000042'; // multiplicador 0.80, sin escalas
const VAR_ZERO   = 'd6000000-0000-4000-f600-000000000043'; // list_price = 0 → sin precio
const PRICE_BASE = 100;   // list_price de VAR_A
const PRICE_T1   = 100;   // escala 1..9
const PRICE_T2   = 80;    // escala 10..49
const PRICE_T3   = 70;    // escala 50..∞
const PRICE_T4   = 120;   // escala 1..9 de la ventana futura
const PRICE_PROMO = 80;   // 100 × 0.80

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

function spawnPsql(args, { env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, args, { env, windowsHide: true });
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

/**
 * Llamada al motor de facturación desde remito, con los tipos explícitos.
 *
 * POR QUÉ LOS CASTS. La firma es
 * `invoice_delivery_note(uuid, uuid, billing.doc_type, smallint, bigint, jsonb, uuid)`.
 * Escrita a mano, la llamada no resuelve: un literal `1` es `integer` y PostgreSQL no lo
 * estrecha a `smallint` al elegir la función, y `'B'` suelto queda `unknown`. El error
 * que produce es engañoso —«no existe la función ...(unknown, unknown, unknown, integer,
 * integer, jsonb)»— porque apunta a la función y no a los literales. La aplicación pasa
 * parámetros ya tipados; la suite, que escribe SQL como texto, tiene que declararlos.
 */
function invoiceFromRemito(tenantId, noteId, lineId, quantity, number) {
  return `SELECT billing.invoice_delivery_note(
    '${tenantId}'::uuid,
    '${noteId}'::uuid,
    'B'::billing.doc_type,
    1::smallint,
    ${number}::bigint,
    '[{"delivery_note_item_id":"${lineId}","quantity":${quantity}}]'::jsonb);`;
}

/**
 * Aplicación de una devolución, con los tipos explícitos.
 *
 * Misma razón que `invoiceFromRemito()`: `apply_customer_return(uuid, uuid,
 * billing.doc_type, smallint, bigint)` no resuelve con literales sin tipar —`1` es
 * `integer` y no se estrecha a `smallint`, y `'B'` queda `unknown`—.
 */
function applyReturn(tenantId, returnId, pointOfSale, number) {
  return `SELECT billing.apply_customer_return(
    '${tenantId}'::uuid,
    '${returnId}'::uuid,
    'B'::billing.doc_type,
    ${pointOfSale}::smallint,
    ${number}::bigint);`;
}

/**
 * Resolución de precio a una fecha y una cantidad.
 *
 * Se proyectan sólo `price` y `source` para que la salida de psql sea una línea
 * comparable. Salida vacía = 0 filas = «sin precio configurado», que es una respuesta
 * legítima de `app.price_for()` y no un error.
 */
function priceForSql(tenantId, listId, variantId, quantity, dateExpr) {
  return `SELECT price || '|' || source FROM app.price_for(
    '${tenantId}'::uuid,
    '${listId}'::uuid,
    '${variantId}'::uuid,
    ${quantity}::numeric,
    ${dateExpr});`;
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
    await sql(withTenant(TENANT_A, invoiceFromRemito(TENANT_A, DN_A, lineId, 60, 1)))
  );
  assert(!!inv1 && inv1.length > 0, 'facturar 60 del remito de 100 es aceptado', `inv1=${inv1}`);

  const q1 = num(
    output(await sql(withTenant(TENANT_A, `SELECT qty_invoiced FROM billing.delivery_note_items WHERE id = '${lineId}';`)))
  );
  assert(q1 === 60, 'el acumulado de la línea queda en 60 tras la primera factura', `qty_invoiced=${q1}`);

  const st1 = output(
    await sql(withTenant(TENANT_A, `SELECT status FROM billing.delivery_notes WHERE id = '${DN_A}';`))
  );
  assert(st1 === 'partially_invoiced', 'el remito queda en partially_invoiced', st1);

  // 2) Facturar los 40 restantes.
  const inv2 = output(
    await sql(withTenant(TENANT_A, invoiceFromRemito(TENANT_A, DN_A, lineId, 40, 2)))
  );
  assert(!!inv2 && inv2.length > 0, 'facturar los 40 restantes es aceptado', `inv2=${inv2}`);

  const q2 = num(
    output(await sql(withTenant(TENANT_A, `SELECT qty_invoiced FROM billing.delivery_note_items WHERE id = '${lineId}';`)))
  );
  assert(q2 === 100, 'el acumulado de la línea queda en 100 (60+40)', `qty_invoiced=${q2}`);

  const st2 = output(
    await sql(withTenant(TENANT_A, `SELECT status FROM billing.delivery_notes WHERE id = '${DN_A}';`))
  );
  assert(st2 === 'invoiced', 'el remito queda en invoiced', st2);

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
  assert(tot === 100, 'la suma de lo facturado de la línea es 100 (sin duplicar)', `total=${tot}`);

  // 4) Sobre-facturar 1 más: rechazado.
  const over = await trySql(withTenant(TENANT_A, invoiceFromRemito(TENANT_A, DN_A, lineId, 1, 3)));
  assert(!over.ok, 'facturar 1 más de lo despachado es rechazado', over.err);

  // 5) Volver a facturar 60 (ya en 100): rechazado.
  const dup = await trySql(withTenant(TENANT_A, invoiceFromRemito(TENANT_A, DN_A, lineId, 60, 4)));
  assert(!dup.ok, 'volver a facturar 60 ya facturado es rechazado', dup.err);

  // 6) El CHECK de motor protege aunque se saltee la función (V-7).
  const direct = await trySql(
    withTenant(TENANT_A, `UPDATE billing.delivery_note_items SET qty_invoiced = 200 WHERE id = '${lineId}';`)
  );
  assert(!direct.ok, 'el CHECK del motor impide qty_invoiced > quantity', direct.err);

  // 7) Aislamiento: la empresa B no puede facturar el remito de A.
  //    La sesión se abre como B con SU usuario (USER_B), no con el default USER_A: el
  //    contexto y el actor tienen que ser coherentes para que el escenario represente
  //    una sesión real de B. El rechazo lo produce el filtro explícito de la función
  //    (`tenant_id = p_tenant_id`), no RLS —`invoice_delivery_note` es SECURITY DEFINER
  //    y corre como el owner—, así que la prueba ejercita ese filtro y no la membresía.
  const cross = await trySql(
    withTenant(TENANT_B, invoiceFromRemito(TENANT_B, DN_A, lineId, 1, 5), USER_B)
  );
  assert(!cross.ok, 'una empresa no puede facturar el remito de otra (RLS)', cross.err);
}

// =============================================================================
// Gate V-3 · Devolución: revierte stock y genera la nota de crédito aplicada
// =============================================================================
async function gateV3() {
  console.log('\n\u25b6 Gate V-3 · Devolución: revierte stock y genera la nota de crédito');

  // ---------------------------------------------------------------------------
  // Preparación: factura autorizada de origen, stock inicial y contabilidad.
  // ---------------------------------------------------------------------------
  const prep = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO billing.invoices (id, tenant_id, customer_id, kind, doc_type, point_of_sale,
                              number, issue_date, subtotal, tax_total, total,
                              receptor_name, receptor_doc_number, idempotency_key,
                              status, result, authorization_id)
VALUES
  ('${INV_DEV}',       '${TENANT_A}', '${CUST_A}', 'invoice', 'B', 3, 100, CURRENT_DATE,
   1000.00, 210.00, 1210.00, 'Cliente A S.A.', '30700000001', 'dev-inv-1', 'authorized', 'approved', '00000000000001'),
  ('${INV_DEV_DRAFT}', '${TENANT_A}', '${CUST_A}', 'invoice', 'B', 3, 101, CURRENT_DATE,
   1000.00, 210.00, 1210.00, 'Cliente A S.A.', '30700000001', 'dev-inv-2', 'draft', NULL, NULL);

INSERT INTO billing.invoice_items (tenant_id, invoice_id, variant_id, description, quantity,
                                   unit_price, discount_rate, tax_rate, net_amount, tax_amount, total_amount)
VALUES
  ('${TENANT_A}', '${INV_DEV}',       '${VAR_A}', 'Producto A', ${DEV_INVOICED_QTY}, 100.00, 0, 0.21, 1000.00, 210.00, 1210.00),
  ('${TENANT_A}', '${INV_DEV_DRAFT}', '${VAR_A}', 'Producto A', ${DEV_INVOICED_QTY}, 100.00, 0, 0.21, 1000.00, 210.00, 1210.00);

-- Stock inicial: el return_in tiene que AUMENTAR el saldo, no crearlo.
SELECT app.apply_stock_movement('${TENANT_A}', '${VAR_A}', '${WH_A}', 'adjustment_pos',
                                ${DEV_STOCK_INICIAL}, NULL, 'test_setup', NULL,
                                'stock inicial de la prueba de devolución');

INSERT INTO billing.customer_returns (id, tenant_id, number, customer_id, invoice_id, warehouse_id, status, reason)
VALUES
  ('${RET_OK}',           '${TENANT_A}', 'DEV-1', '${CUST_A}', '${INV_DEV}',       '${WH_A}', 'draft', 'Producto en mal estado'),
  ('${RET_OVER}',         '${TENANT_A}', 'DEV-2', '${CUST_A}', '${INV_DEV}',       '${WH_A}', 'draft', 'Excede lo facturado'),
  ('${RET_DRAFT}',        '${TENANT_A}', 'DEV-3', '${CUST_A}', '${INV_DEV}',       '${WH_A}', 'draft', 'Queda sin confirmar'),
  ('${RET_FRAC}',         '${TENANT_A}', 'DEV-4', '${CUST_A}', '${INV_DEV}',       '${WH_A}', 'draft', 'Cantidad fraccionaria'),
  ('${RET_CROSS}',        '${TENANT_A}', 'DEV-5', '${CUST_A}', '${INV_DEV}',       '${WH_A}', 'draft', 'Prueba de aislamiento'),
  ('${RET_ON_DRAFT_INV}', '${TENANT_A}', 'DEV-6', '${CUST_A}', '${INV_DEV_DRAFT}', '${WH_A}', 'draft', 'Devuelve sobre un borrador');

INSERT INTO billing.customer_return_items (tenant_id, customer_return_id, variant_id, description,
                                           quantity, unit_price, discount_rate, tax_rate, line_total)
VALUES
  ('${TENANT_A}', '${RET_OK}',           '${VAR_A}', 'Producto A', ${DEV_RETURN_QTY}, 100.00, 0, 0.21, 484.00),
  ('${TENANT_A}', '${RET_OVER}',         '${VAR_A}', 'Producto A', 8,   100.00, 0, 0.21, 968.00),
  ('${TENANT_A}', '${RET_DRAFT}',        '${VAR_A}', 'Producto A', 1,   100.00, 0, 0.21, 121.00),
  ('${TENANT_A}', '${RET_FRAC}',         '${VAR_A}', 'Producto A', 1.5, 100.00, 0, 0.21, 181.50),
  ('${TENANT_A}', '${RET_CROSS}',        '${VAR_A}', 'Producto A', 1,   100.00, 0, 0.21, 121.00),
  ('${TENANT_A}', '${RET_ON_DRAFT_INV}', '${VAR_A}', 'Producto A', 1,   100.00, 0, 0.21, 121.00);
`
    )
  );
  if (!prep.ok) {
    assert(false, 'V-3 · se pudo preparar el escenario de la devolución', prep.err);
    return;
  }

  // La contabilidad de la empresa: sin plan de cuentas ni reglas de mapeo no se
  // puede probar que la nota de crédito llegue al libro (integración con E2).
  const cfg = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
DECLARE
  v_t  uuid := '${TENANT_A}';
  v_fy uuid;
  v_n  integer;
BEGIN
  SELECT count(*) INTO v_n FROM accounting.accounts WHERE tenant_id = v_t;
  IF v_n > 0 THEN
    RETURN;
  END IF;

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
  PERFORM accounting.seed_tenant_accounting_config(v_t);
END $$;
`
    )
  );
  if (!cfg.ok) {
    assert(false, 'V-3 · se pudo sembrar el plan de cuentas y las reglas de mapeo', cfg.err);
    return;
  }

  // ---------------------------------------------------------------------------
  // 1) Estado inicial
  // ---------------------------------------------------------------------------
  const stock0 = num(
    output(await sql(withTenant(TENANT_A, `SELECT on_hand FROM app.stock_levels
      WHERE tenant_id = '${TENANT_A}' AND variant_id = '${VAR_A}' AND warehouse_id = '${WH_A}';`)))
  );
  assert(stock0 === DEV_STOCK_INICIAL, `el stock inicial de la variante es ${DEV_STOCK_INICIAL}`, `on_hand=${stock0}`);

  // ---------------------------------------------------------------------------
  // 2) Confirmar (draft → confirmed)
  // ---------------------------------------------------------------------------
  const conf = output(
    await sql(withTenant(TENANT_A, `SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_OK}'::uuid);`))
  );
  assert(conf === 'confirmed', 'confirmar la devolución la deja en confirmed', conf);

  const confAgain = output(
    await sql(withTenant(TENANT_A, `SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_OK}'::uuid);`))
  );
  assert(confAgain === 'confirmed', 'confirmar dos veces es idempotente', confAgain);

  // Las devoluciones de las pruebas negativas se confirman ANTES de intentar
  // aplicarlas. Si quedaran en borrador, el rechazo vendría del estado y no del
  // guard que cada prueba quiere ejercitar: una aserción que pasa por el motivo
  // equivocado no prueba nada. `RET_DRAFT` es la única que queda en borrador, a
  // propósito.
  const confOthers = await trySql(
    withTenant(
      TENANT_A,
      `
SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_OVER}'::uuid);
SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_FRAC}'::uuid);
SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_ON_DRAFT_INV}'::uuid);
SELECT billing.confirm_customer_return('${TENANT_A}'::uuid, '${RET_CROSS}'::uuid);
`
    )
  );
  assert(confOthers.ok, 'se confirman las devoluciones de las pruebas negativas', confOthers.err);

  // ---------------------------------------------------------------------------
  // 3) Aplicar (confirmed → applied): stock + nota de crédito
  // ---------------------------------------------------------------------------
  const ncId = output(await sql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_OK, 3, 1))));
  assert(/^[0-9a-f-]{36}$/.test(ncId), 'aplicar la devolución devuelve el id de la nota de crédito', ncId);

  const stock1 = num(
    output(await sql(withTenant(TENANT_A, `SELECT on_hand FROM app.stock_levels
      WHERE tenant_id = '${TENANT_A}' AND variant_id = '${VAR_A}' AND warehouse_id = '${WH_A}';`)))
  );
  assert(
    stock1 === stock0 + DEV_RETURN_QTY,
    `el stock sube exactamente ${DEV_RETURN_QTY} unidades (${stock0} → ${stock0 + DEV_RETURN_QTY})`,
    `on_hand=${stock1}`
  );

  const mov = output(
    await sql(withTenant(TENANT_A, `SELECT kind || '|' || quantity || '|' || source_type
      FROM app.stock_movements
      WHERE tenant_id = '${TENANT_A}' AND source_type = 'customer_return' AND source_id = '${RET_OK}';`))
  );
  assert(
    mov === `return_in|${DEV_RETURN_QTY}|customer_return`,
    'el movimiento de stock es un return_in trazable a la devolución',
    `movimiento=${mov}`
  );

  const ret = output(
    await sql(withTenant(TENANT_A, `SELECT status || '|' || credit_note_id FROM billing.customer_returns
      WHERE tenant_id = '${TENANT_A}' AND id = '${RET_OK}';`))
  );
  assert(ret === `applied|${ncId}`, 'la devolución queda aplicada y ligada a su nota de crédito', ret);

  const nc = output(
    await sql(withTenant(TENANT_A, `SELECT kind || '|' || status || '|' || subtotal || '|' || tax_total || '|' || total
      || '|' || (related_invoice_id = '${INV_DEV}')::text
      FROM billing.invoices WHERE tenant_id = '${TENANT_A}' AND id = '${ncId}';`))
  );
  assert(
    nc === `credit_note|draft|${DEV_NET}.00|${DEV_TAX}.00|${DEV_TOTAL}.00|true`,
    'la nota de crédito es un borrador ligado a la factura de origen, por el importe devuelto',
    `nc=${nc}`
  );

  const ncItems = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM billing.invoice_items
      WHERE tenant_id = '${TENANT_A}' AND invoice_id = '${ncId}';`)))
  );
  assert(ncItems === 1, 'la nota de crédito lleva el detalle de lo devuelto', `líneas=${ncItems}`);

  // ---------------------------------------------------------------------------
  // 4) La garantía: no se devuelve dos veces ni de más
  // ---------------------------------------------------------------------------
  const twice = await trySql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_OK, 3, 2)));
  assert(!twice.ok, 'aplicar dos veces la misma devolución es rechazado', twice.err);

  const over = await trySql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_OVER, 3, 3)));
  assert(
    !over.ok && /excede lo facturado/.test(String(over.err)),
    'una segunda devolución que excede lo facturado es rechazada por el motor',
    over.err
  );

  const draft = await trySql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_DRAFT, 3, 4)));
  assert(!draft.ok, 'aplicar una devolución sin confirmar es rechazado', draft.err);

  const frac = await trySql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_FRAC, 3, 5)));
  assert(
    !frac.ok && /no es entera/.test(String(frac.err)),
    'una cantidad fraccionaria se rechaza en vez de truncarse en silencio',
    frac.err
  );

  const onDraft = await trySql(withTenant(TENANT_A, applyReturn(TENANT_A, RET_ON_DRAFT_INV, 3, 6)));
  assert(!onDraft.ok, 'no se puede devolver sobre una factura que no está autorizada', onDraft.err);

  const cross = await trySql(withTenant(TENANT_B, applyReturn(TENANT_B, RET_CROSS, 1, 1), USER_B));
  assert(!cross.ok, 'una empresa no puede aplicar la devolución de otra (RLS + filtro de tenant)', cross.err);

  // ---------------------------------------------------------------------------
  // 5) Integración con E2 (contable) y E4 (saldo del cliente)
  // ---------------------------------------------------------------------------
  // Una nota de crédito en borrador todavía no es un hecho económico: no debe
  // figurar como hueco contable. Al autorizarse sí, y ahí el job la asienta.
  const gapsDraft = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM accounting.v_posting_gaps
      WHERE tenant_id = '${TENANT_A}' AND source_id = '${ncId}';`)))
  );
  assert(
    gapsDraft === 0,
    'una nota de crédito en borrador no es un hecho pendiente de asiento',
    `gaps=${gapsDraft}`
  );

  const auth = await trySql(
    withTenant(TENANT_A, `UPDATE billing.invoices
      SET status = 'authorized', result = 'approved', authorization_id = '00000000000002'
      WHERE tenant_id = '${TENANT_A}' AND id = '${ncId}';`)
  );
  assert(auth.ok, 'la nota de crédito se autoriza (simulación del paso AFIP)', auth.err);

  const gapsAuth = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM accounting.v_posting_gaps
      WHERE tenant_id = '${TENANT_A}' AND source_id = '${ncId}';`)))
  );
  assert(gapsAuth === 1, 'una nota de crédito autorizada aparece como hecho sin asiento', `gaps=${gapsAuth}`);

  // El asiento: debita Devoluciones (4.1.1.03) por el neto, debita IVA débito
  // fiscal por el impuesto y acredita Clientes por el total.
  const posted = await trySql(
    withTenant(
      TENANT_A,
      `SELECT accounting.post_entry_for_source(
        '${TENANT_A}'::uuid, 'invoice', '${ncId}'::uuid, 'credit_note', CURRENT_DATE,
        'Nota de crédito por devolución de cliente',
        '{"subtotal": ${DEV_NET}.00, "tax_total": ${DEV_TAX}.00, "total": ${DEV_TOTAL}.00}'::jsonb);`
    )
  );
  assert(posted.ok, 'la nota de crédito autorizada se asienta', posted.err);

  const descuadrados = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM (
      SELECT e.id FROM accounting.journal_entries e
      JOIN accounting.journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
      WHERE e.tenant_id = '${TENANT_A}' AND e.source_id = '${ncId}'
      GROUP BY e.id HAVING abs(sum(l.debit) - sum(l.credit)) > 0.01) AS d;`)))
  );
  assert(descuadrados === 0, 'el asiento de la devolución está balanceado', `descuadrados=${descuadrados}`);

  const devolucionesDebitadas = num(
    output(await sql(withTenant(TENANT_A, `SELECT COALESCE(sum(l.debit), 0) FROM accounting.journal_lines l
      JOIN accounting.journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      JOIN accounting.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = '${TENANT_A}' AND e.source_id = '${ncId}' AND a.code = '4.1.1.03';`)))
  );
  assert(
    devolucionesDebitadas === DEV_NET,
    `el asiento debita Devoluciones (4.1.1.03) por el neto devuelto (${DEV_NET})`,
    `debitado=${devolucionesDebitadas}`
  );

  // E4: la nota de crédito se aplica al saldo del cliente.
  const applied = await trySql(
    withTenant(TENANT_A, `SELECT billing.apply_credit_note(
      '${TENANT_A}'::uuid, '${ncId}'::uuid,
      '[{"invoice_id": "${INV_DEV}", "amount": ${DEV_TOTAL}.00}]'::jsonb);`)
  );
  assert(applied.ok, 'la nota de crédito se aplica a la factura de origen', applied.err);

  const credited = num(
    output(await sql(withTenant(TENANT_A, `SELECT credited_total FROM billing.invoices
      WHERE tenant_id = '${TENANT_A}' AND id = '${INV_DEV}';`)))
  );
  assert(credited === DEV_TOTAL, `la factura queda acreditada por ${DEV_TOTAL}`, `credited_total=${credited}`);

  const balance = num(
    output(await sql(withTenant(TENANT_A, `SELECT balance FROM billing.v_customer_balances
      WHERE tenant_id = '${TENANT_A}' AND customer_id = '${CUST_A}';`)))
  );
  assert(
    balance === 1210 - DEV_TOTAL,
    `el saldo del cliente baja al neto de la devolución (${1210 - DEV_TOTAL})`,
    `balance=${balance}`
  );
}

// =============================================================================
// Gate V-4 · Listas de precios con vigencia y escalas por cantidad
// =============================================================================
async function gateV4() {
  console.log('\n\u25b6 Gate V-4 · Listas de precios con vigencia y escalas por cantidad');

  const prep = await trySql(
    withTenant(
      TENANT_A,
      `
-- Una variante sin precio cargado: 'list_price' es NOT NULL DEFAULT 0 en 0003, así
-- que el 0 hace de centinela de «sin configurar» y la resolución no debe inventar
-- un precio 0.
INSERT INTO app.product_variants (id, tenant_id, product_id, sku, list_price)
VALUES ('${VAR_ZERO}', '${TENANT_A}', '${PROD_A}', 'SKU-A-0', 0);

INSERT INTO app.price_lists (id, tenant_id, name, currency, multiplier, is_default)
VALUES
  ('${LIST_MAY}',   '${TENANT_A}', 'Mayorista', 'ARS', 0.8500, true),
  ('${LIST_RET}',   '${TENANT_A}', 'Retail',    'ARS', 1.0000, false),
  ('${LIST_PROMO}', '${TENANT_A}', 'Promo',     'ARS', 0.8000, false);

-- Tres tramos de cantidad sobre la MISMA ventana de vigencia y un cuarto tramo sobre
-- una ventana posterior. La constraint EXCLUDE tiene que aceptar los tres primeros
-- —se solapan en fecha pero no en cantidad— y también el cuarto, que se solapa en
-- cantidad pero no en fecha. Es la prueba de que la garantía es del rango, no de la
-- columna.
--
-- La ventana vieja CIERRA (valid_to) antes de que empiece la nueva. Es la única forma
-- correcta de expresar un cambio de precio: con valid_to NULL la ventana se extiende
-- para siempre y cualquier ventana futura se solaparía —lo detectó la propia EXCLUDE
-- cuando el escenario se escribió con la ventana vieja abierta—.
INSERT INTO app.price_list_items
  (tenant_id, price_list_id, variant_id, price, min_quantity, max_quantity, valid_from, valid_to)
VALUES
  ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', ${PRICE_T1}.00, 1,  9,    CURRENT_DATE, CURRENT_DATE + 364),
  ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', ${PRICE_T2}.00, 10, 49,   CURRENT_DATE, CURRENT_DATE + 364),
  ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', ${PRICE_T3}.00, 50, NULL, CURRENT_DATE, CURRENT_DATE + 364),
  ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', ${PRICE_T4}.00, 1,  9,    CURRENT_DATE + 365, NULL);
`
    )
  );
  if (!prep.ok) {
    assert(false, 'V-4 · se pudo preparar el escenario de listas de precios', prep.err);
    return;
  }

  // El escenario necesita una SEGUNDA variante sin código de barras. `0003` lo
  // impedía —`UNIQUE NULLS NOT DISTINCT (tenant_id, barcode)` sobre una columna
  // opcional— y `0024` lo corrigió. Si la restricción volviera, el INSERT de arriba
  // fallaría; la aserción explícita lo deja dicho en vez de como efecto colateral.
  const sinBarcode = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM app.product_variants
      WHERE tenant_id = '${TENANT_A}' AND barcode IS NULL;`)))
  );
  assert(
    sinBarcode >= 2,
    'dos variantes sin código de barras coexisten en la misma empresa',
    `variantes sin barcode=${sinBarcode}`
  );

  const priceOf = (listId, variantId, quantity, dateExpr, tenant = TENANT_A) =>
    sql(withTenant(tenant, priceForSql(tenant, listId, variantId, quantity, dateExpr))).then(output);

  // ---------------------------------------------------------------------------
  // 1) Gana la escala que cubre la cantidad, con los bordes inclusivos
  // ---------------------------------------------------------------------------
  let got = await priceOf(LIST_MAY, VAR_A, 1, 'CURRENT_DATE');
  assert(got === `${PRICE_T1}.00|tier`, `cantidad 1 → escala 1..9 (${PRICE_T1})`, got);

  got = await priceOf(LIST_MAY, VAR_A, 9, 'CURRENT_DATE');
  assert(got === `${PRICE_T1}.00|tier`, `cantidad 9 → sigue en la escala 1..9 (borde superior inclusivo)`, got);

  got = await priceOf(LIST_MAY, VAR_A, 10, 'CURRENT_DATE');
  assert(got === `${PRICE_T2}.00|tier`, `cantidad 10 → escala 10..49 (borde inferior inclusivo)`, got);

  got = await priceOf(LIST_MAY, VAR_A, 49, 'CURRENT_DATE');
  assert(got === `${PRICE_T2}.00|tier`, `cantidad 49 → sigue en la escala 10..49`, got);

  got = await priceOf(LIST_MAY, VAR_A, 50, 'CURRENT_DATE');
  assert(got === `${PRICE_T3}.00|tier`, `cantidad 50 → escala 50..sin tope`, got);

  got = await priceOf(LIST_MAY, VAR_A, 100000, 'CURRENT_DATE');
  assert(got === `${PRICE_T3}.00|tier`, `cantidad muy alta → la escala sin tope superior sigue aplicando`, got);

  // ---------------------------------------------------------------------------
  // 2) La vigencia: la fecha decide qué precio rige, y no reescribe el pasado
  // ---------------------------------------------------------------------------
  got = await priceOf(LIST_MAY, VAR_A, 1, 'CURRENT_DATE + 365');
  assert(got === `${PRICE_T4}.00|tier`, `en la ventana futura rige el precio nuevo (${PRICE_T4})`, got);

  got = await priceOf(LIST_MAY, VAR_A, 1, 'CURRENT_DATE');
  assert(
    got === `${PRICE_T1}.00|tier`,
    `cargar una vigencia futura NO cambia el precio de hoy: la cotización vieja sigue siendo reproducible`,
    got
  );

  // ---------------------------------------------------------------------------
  // 3) Sin escala: el precio de lista por el multiplicador de la lista
  // ---------------------------------------------------------------------------
  got = await priceOf(LIST_RET, VAR_A, 1, 'CURRENT_DATE');
  assert(got === `${PRICE_BASE}.00|list_multiplier`, `sin escalas, multiplicador 1.00 → ${PRICE_BASE}`, got);

  got = await priceOf(LIST_PROMO, VAR_A, 1, 'CURRENT_DATE');
  assert(
    got === `${PRICE_PROMO}.00|list_multiplier`,
    `sin escalas, multiplicador 0.80 → ${PRICE_PROMO} (${PRICE_BASE} × 0,80)`,
    got
  );

  // ---------------------------------------------------------------------------
  // 4) Sin precio configurado: 0 filas, no un 0 inventado
  // ---------------------------------------------------------------------------
  got = await priceOf(LIST_RET, VAR_ZERO, 1, 'CURRENT_DATE');
  assert(got === '', 'una variante con list_price = 0 y sin escalas no devuelve precio (0 filas)', `salida=${JSON.stringify(got)}`);

  got = await priceOf(LIST_RET, VAR_ZERO, 1, 'CURRENT_DATE + 3650');
  assert(got === '', 'tampoco lo inventa en otra fecha', `salida=${JSON.stringify(got)}`);

  // ---------------------------------------------------------------------------
  // 5) Determinismo: la resolución devuelve UNA fila, nunca dos
  // ---------------------------------------------------------------------------
  const rows = num(
    output(await sql(withTenant(TENANT_A, `SELECT count(*) FROM app.price_for(
      '${TENANT_A}'::uuid, '${LIST_MAY}'::uuid, '${VAR_A}'::uuid, 10::numeric, CURRENT_DATE);`)))
  );
  assert(rows === 1, 'la resolución devuelve exactamente una fila (la EXCLUDE impide dos escalas vigentes)', `filas=${rows}`);

  // ---------------------------------------------------------------------------
  // 6) Garantías de motor: solapamiento de escalas y lista por defecto única
  // ---------------------------------------------------------------------------
  const overlap = await trySql(
    withTenant(
      TENANT_A,
      `INSERT INTO app.price_list_items
         (tenant_id, price_list_id, variant_id, price, min_quantity, max_quantity, valid_from, valid_to)
       VALUES ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', 90.00, 5, 20, CURRENT_DATE, NULL);`
    )
  );
  assert(
    !overlap.ok && /pli_no_overlap/.test(String(overlap.err)),
    'el motor rechaza dos escalas solapadas en cantidad Y fecha (EXCLUDE pli_no_overlap)',
    overlap.err
  );

  const dateOverlap = await trySql(
    withTenant(
      TENANT_A,
      `INSERT INTO app.price_list_items
         (tenant_id, price_list_id, variant_id, price, min_quantity, max_quantity, valid_from, valid_to)
       VALUES ('${TENANT_A}', '${LIST_MAY}', '${VAR_A}', 130.00, 1, 9, CURRENT_DATE + 180, NULL);`
    )
  );
  assert(
    !dateOverlap.ok && /pli_no_overlap/.test(String(dateOverlap.err)),
    'el motor rechaza dos precios para el mismo tramo de cantidad con vigencias solapadas',
    dateOverlap.err
  );

  const secondDefault = await trySql(
    withTenant(
      TENANT_A,
      `INSERT INTO app.price_lists (tenant_id, name, currency, multiplier, is_default)
       VALUES ('${TENANT_A}', 'Otra por defecto', 'ARS', 1.0000, true);`
    )
  );
  assert(
    !secondDefault.ok && /price_lists_one_default_per_tenant/.test(String(secondDefault.err)),
    'el motor impide una segunda lista por defecto en la misma empresa',
    secondDefault.err
  );

  // ---------------------------------------------------------------------------
  // 7) Aislamiento: la lista de una empresa no resuelve para otra
  // ---------------------------------------------------------------------------
  got = await priceOf(LIST_MAY, VAR_A, 1, 'CURRENT_DATE', TENANT_B);
  assert(got === '', 'otra empresa no resuelve el precio de una lista ajena (RLS + filtro de tenant)', `salida=${JSON.stringify(got)}`);
}

// =============================================================================
async function main() {
  await preflight();
  await setup();
  await gateV2();
  await gateV3();
  await gateV4();

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
-- Billing: primero lo que referencia a 'invoices' con ON DELETE RESTRICT.
DELETE FROM billing.credit_applications   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.customer_return_items WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.customer_returns      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoice_items         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.invoices              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_note_items   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.delivery_notes        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_order_items     WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM billing.sales_orders          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
-- Contabilidad: las líneas antes que los asientos, y los asientos antes que los
-- períodos y ejercicios a los que apuntan.
DELETE FROM accounting.account_roles      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.mapping_rules      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_lines      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_balances   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_entries    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.periods            WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.fiscal_years       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
-- Stock: 'stock_movements' referencia variante y depósito con ON DELETE RESTRICT,
-- así que tiene que borrarse ANTES que ellos. Sin estas dos líneas la limpieza
-- falla en cuanto una prueba mueve stock, que es lo que hace el gate V-3.
DELETE FROM app.stock_movements           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.stock_levels              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
-- Precios: las escalas referencian la lista y la variante, así que van antes que ambas.
DELETE FROM app.price_list_items          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.price_lists               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.product_variants          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.products                  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.warehouses                WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.customers                 WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                   WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                     WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);
  } catch (e) {
    console.error('Advertencia: no se pudo limpiar el escenario:', e.message);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  // El `stderr` de psql trae el error real del motor (y `input`, la sentencia que falló).
  // Imprimir sólo `e.message` deja «psql salió con código 3», que no dice nada: el
  // diagnóstico se vuelve a ciegas y obliga a reproducir la sentencia a mano.
  console.error('Error inesperado:', e.message);
  if (e.stderr) console.error('--- psql stderr ---\n' + String(e.stderr).trim());
  if (e.stdout) console.error('--- psql stdout ---\n' + String(e.stdout).trim());
  if (e.input) console.error('--- sentencia ---\n' + String(e.input).trim());
  process.exit(1);
});
