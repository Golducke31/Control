#!/usr/bin/env node
/**
 * =============================================================================
 * Control · Suite de invariantes de compras y cuentas por pagar (E3)
 * -----------------------------------------------------------------------------
 * QUÉ PRUEBA
 *
 * La migración `0014` promete cuatro cosas en su encabezado. Este archivo
 * verifica que las aplique el MOTOR y no la capa de aplicación. La pregunta que
 * importa no es "¿la función se porta bien?" sino "¿un camino que se saltee la
 * función puede dejar los datos en un estado que la promesa prohíbe?".
 *
 * El gate de salida de E3 en §7.1 del plan es **"Recepción parcial integrada con
 * stock y costo"**. Las invariantes 4 y 5 lo miden: 60 de 100, después 40, y el
 * costo promedio ponderado resultante. No se declara, se mide.
 *
 * LAS CUATRO PROMESAS
 *
 * 1. LA RECEPCIÓN NO ESCRIBE STOCK (invariante 3). Entra por
 *    `apply_stock_movement()`, así que el movimiento tiene que existir en el
 *    libro y el saldo tiene que haber cambiado por esa vía. Una recepción que
 *    escribiera `stock_levels` a mano dejaría el mismo saldo y ningún movimiento:
 *    la invariante 3 lo distingue.
 *
 * 2. EL ESTADO SE DERIVA (invariantes 4 y 5). `received_quantity` es la fuente;
 *    el estado de la línea y de la cabecera son consecuencias. Se prueban en las
 *    dos direcciones: lo que el motor NO debe permitir (sobre-recepción) y lo que
 *    debe hacer solo (pasar a `received` sin que nadie lo escriba).
 *
 * 3. LA SOBRE-RECEPCIÓN LA IMPIDE EL MOTOR (invariante 6). Se prueba por el
 *    camino crudo —un `UPDATE` que se saltea la función— porque una validación
 *    que sólo vive dentro de la función se saltea con un script.
 *
 * 4. EL SALDO SE CALCULA (invariante 7). Se verifica contra los documentos: el
 *    saldo tiene que reaccionar a un pago real y tiene que dar exactamente lo que
 *    la aritmética de los documentos dice. Y se verifica que no haya una columna
 *    `balance` que pueda discrepar.
 *
 * La invariante 1 (aislamiento) y la 2 (cobertura RLS) no prueban una promesa de
 * negocio sino la propiedad que hace que las cuatro anteriores sean confiables:
 * que ningún inquilino vea ni toque datos de otro.
 *
 * POR QUÉ CADA PRUEBA ES UNA CONEXIÓN APARTE
 *
 * Igual que en `tests/accounting/run.mjs`: un rechazo esperado aborta la
 * transacción. Compartir conexión haría que la primera prueba que ESPERA un
 * error dejara la sesión abortada y las siguientes fallaran por arrastre, con
 * mensajes que parecen defectos de la migración.
 *
 * POR QUÉ DOS DSN
 *
 * Las invariantes corren como rol de APLICACIÓN —la única forma de que el
 * aislamiento se pruebe de verdad— y la preparación y limpieza del escenario
 * como rol de PLATAFORMA. No es comodidad: `app.stock_movements` es append-only
 * y `control_app` no tiene DELETE sobre ella, así que un rol de aplicación no
 * puede limpiar su propio escenario.
 *
 * USO
 *
 *   node tests/purchasing/run.mjs \
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
const TENANT_A = '00000000-0000-4000-f100-0000000000a0';
const TENANT_B = '00000000-0000-4000-f200-0000000000b0';
const USER_A = '00000000-0000-4000-f100-0000000000a1';
const USER_B = '00000000-0000-4000-f200-0000000000b1';

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
        '  node tests/purchasing/run.mjs --dsn "postgres://app_login:...@host:5432/control"\n'
    );
    process.exit(2);
  }
  // El DSN administrativo NO cae al de aplicación: la limpieza borra
  // `app.stock_movements`, que es append-only para `control_app`.
  if (!out.adminDsn) {
    console.error(
      '\nFalta el DSN administrativo (`--admin-dsn`).\n\n' +
        'La preparación y la limpieza del escenario corren con el rol de plataforma.\n' +
        'El rol de aplicación no puede hacerlas: `app.stock_movements` es append-only\n' +
        'y `control_app` no tiene DELETE sobre ella.\n\n' +
        '  node tests/purchasing/run.mjs \\\n' +
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
  // depende, después el padre. Sin esto la segunda corrida arrastraría los
  // números de la primera y las aserciones de cantidad fallarían por un motivo
  // que no tiene nada que ver con lo que se está probando.
  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
DELETE FROM purchasing.payment_allocations    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_payments      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_invoice_items WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_invoices      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.goods_receipt_items    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.goods_receipts         WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_order_items   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM purchasing.supplier_orders        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.suppliers                     WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_balances       WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_lines          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.journal_entries        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.mapping_rules          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.account_roles          WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.periods                WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.fiscal_years           WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM accounting.accounts               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.stock_movements               WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.stock_levels                  WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.warehouses                    WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.product_variants              WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.products                      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.brands                        WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants                       WHERE id        IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users                         WHERE id        IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sqlAdmin(`
BEGIN;
SELECT app.set_tenant_context(NULL, NULL, true);
INSERT INTO app.users (id, google_sub, email, email_verified, full_name)
VALUES
  ('${USER_A}', 'pur-sub-a', 'compras-a@test.local', true, 'Comprador A'),
  ('${USER_B}', 'pur-sub-b', 'compras-b@test.local', true, 'Comprador B');

INSERT INTO app.tenants (id, slug, legal_name, display_name, status, currency)
VALUES
  ('${TENANT_A}', 'pur-a', 'Compras A S.A.',  'Compras A', 'active', 'ARS'),
  ('${TENANT_B}', 'pur-b', 'Compras B S.R.L.', 'Compras B', 'active', 'ARS');
COMMIT;
`);

  // Ejercicio, períodos, catálogo, depósito y configuración contable de compras.
  // Se prepara con el rol de APLICACIÓN y contexto de inquilino: si `control_app`
  // no puede preparar su propia operación, el módulo no sirve.
  for (const t of [TENANT_A, TENANT_B]) {
    const res = await trySql(
      withTenant(
        t,
        `
DO $$
DECLARE
  v_t uuid := '${t}';
  v_fy uuid;
  v_brand uuid;
  v_product uuid;
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

  -- Plan de cuentas + roles de compras + reglas de mapeo, en ese orden: la
  -- segunda función copia el plan si falta y resuelve los códigos contra él.
  PERFORM purchasing.seed_tenant_purchasing_config(v_t);

  INSERT INTO app.brands (tenant_id, name) VALUES (v_t, 'Marca Compras')
  RETURNING id INTO v_brand;

  INSERT INTO app.products (tenant_id, brand_id, sku, name)
  VALUES (v_t, v_brand, 'SKU-COMPRAS', 'Producto de compras')
  RETURNING id INTO v_product;

  INSERT INTO app.product_variants (tenant_id, product_id, sku, variant_name)
  VALUES (v_t, v_product, 'SKU-COMPRAS-V', 'Único');

  INSERT INTO app.warehouses (tenant_id, code, name)
  VALUES (v_t, 'DEP-COMPRAS', 'Depósito de compras');

  INSERT INTO app.suppliers (tenant_id, code, legal_name, doc_number, payment_term_days)
  VALUES (v_t, 'PROV-1', 'Proveedor Uno S.A.', '30111111111', 30);

  -- Una orden por 100 unidades a $1.500, aprobada: el estado de una orden
  -- recibible exige aprobador y fecha (CHECK po_approval_recorded).
  INSERT INTO purchasing.supplier_orders (
    tenant_id, number, supplier_id, status, approved_at, approved_by, warehouse_id,
    subtotal, tax_total, total
  )
  SELECT v_t, 'OC-00000001', s.id, 'approved', now(), '${USER_A}'::uuid, w.id,
         150000, 31500, 181500
  FROM app.suppliers s, app.warehouses w
  WHERE s.tenant_id = v_t AND s.code = 'PROV-1'
    AND w.tenant_id = v_t AND w.code = 'DEP-COMPRAS';

  INSERT INTO purchasing.supplier_order_items (
    tenant_id, order_id, variant_id, line_number, quantity, unit_cost, tax_rate
  )
  SELECT v_t, o.id, pv.id, 1, 100, 1500, 21
  FROM purchasing.supplier_orders o, app.product_variants pv
  WHERE o.tenant_id = v_t AND o.number = 'OC-00000001'
    AND pv.tenant_id = v_t AND pv.sku = 'SKU-COMPRAS-V';
END $$;
`
      )
    );
    if (!res.ok) {
      console.error(`\n  No se pudo preparar el escenario de ${t}:\n${res.err}`);
      process.exit(2);
    }
  }

  console.log('  \u2713 Escenario listo: dos empresas, plan contable, proveedor, orden de 100 y depósito');
}

/** Devuelve el id de la línea de orden de la empresa A. */
async function lineA() {
  return sql(
    withTenant(
      TENANT_A,
      `SELECT id FROM purchasing.supplier_order_items
        WHERE tenant_id = '${TENANT_A}' ORDER BY line_number LIMIT 1;`
    )
  );
}

// =============================================================================
// 1 · Aislamiento entre empresas
// =============================================================================
async function testIsolation() {
  console.log('\n\u25b6 Invariante 1 · aislamiento entre empresas');

  // La empresa B ve sus propias filas (tiene su propia orden) y ninguna de A.
  const vistasPorB = await sql(
    withTenant(
      TENANT_B,
      `
SELECT (SELECT count(*) FROM purchasing.supplier_orders)::text
    || '|' || (SELECT count(*) FROM purchasing.supplier_orders WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM app.suppliers WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM purchasing.supplier_order_items WHERE tenant_id = '${TENANT_A}')::text;
`
    )
  );

  const [propias, ordenesDeA, proveedoresDeA, lineasDeA] = vistasPorB.split('|');

  assert(Number(propias) === 1, 'B ve su propia orden de compra', `Vio ${propias}`);
  assert(Number(ordenesDeA) === 0, 'B NO ve las órdenes de compra de A', `Vio ${ordenesDeA}`);
  assert(Number(proveedoresDeA) === 0, 'B NO ve los proveedores de A', `Vio ${proveedoresDeA}`);
  assert(Number(lineasDeA) === 0, 'B NO ve las líneas de orden de A', `Vio ${lineasDeA}`);

  // Y no puede ESCRIBIR sobre recursos de A: el WITH CHECK de la política lo
  // impide aunque el INSERT nombre el tenant_id de A explícitamente.
  //
  // OJO — la assertion NO mira sólo si hubo error. Un `INSERT ... SELECT` que
  // lee sus datos de una tabla filtrada por RLS puede devolver CERO filas y
  // terminar en éxito sin haber escrito nada: el WITH CHECK nunca se evalúa
  // porque no hay fila que evaluar. Ese INSERT vacío "pasa la prueba" y deja el
  // agujero sin cubrir. Por eso el SELECT llega acá con las claves ya resueltas
  // (ver `idsDeA`), de modo que el INSERT *intenta* escribir de verdad y el
  // rechazo viene del WITH CHECK, no del azar de un join vacío.
  //
  // Los ids se resuelven desde el rol de plataforma: si los pidiera B, RLS le
  // devolvería vacío y volveríamos al INSERT que no inserta nada.
  const idsDeA = await sqlAdmin(
    `SELECT o.id::text || '|' || pv.id::text
       FROM purchasing.supplier_orders o, app.product_variants pv
      WHERE o.tenant_id = '${TENANT_A}' AND pv.tenant_id = '${TENANT_A}'
      LIMIT 1;`
  );

  const [orderIdDeA, variantIdDeA] = String(idsDeA).split('|').map((s) => s.trim());

  assert(
    !!orderIdDeA && !!variantIdDeA,
    'se resolvieron las claves de A para intentar la escritura cruzada',
    `idsDeA=${JSON.stringify(idsDeA)}. Sin claves, el INSERT de abajo no prueba nada.`
  );

  const escrituraCruzada = await trySql(
    withTenant(
      TENANT_B,
      `
INSERT INTO purchasing.supplier_order_items (
  tenant_id, order_id, variant_id, line_number, quantity, unit_cost
) VALUES (
  '${TENANT_A}', '${orderIdDeA}', '${variantIdDeA}', 99, 1, 1
);
`
    )
  );

  assert(
    !escrituraCruzada.ok,
    'B NO puede escribir una línea en una orden de A',
    'El INSERT cruzado pasó: el WITH CHECK de la política no está aplicando.'
  );

  // Y de fondo: la fila no existe. Una política que "rechaza" sin excepción
  // —silenciosamente, por RLS de lectura— dejaría también la tabla limpia, pero
  // distinguir ambos casos importa: acá verificamos que efectivamente no quedó
  // escritura cruzada, contada desde el rol de plataforma para que ningún RLS
  // pueda ocultar el residuo.
  const residuoCruzado = await sqlAdmin(
    `SELECT count(*)::text FROM purchasing.supplier_order_items
      WHERE tenant_id = '${TENANT_A}' AND line_number = 99;`
  );

  assert(
    Number(residuoCruzado) === 0,
    'el intento cruzado no dejó ninguna fila escrita para A',
    `Quedaron ${residuoCruzado} filas de A escritas por B.`
  );

  // El saldo del proveedor tampoco se filtra por la vista.
  const saldoCruzado = await sql(
    withTenant(
      TENANT_B,
      `SELECT count(*)::text FROM purchasing.v_supplier_balances WHERE tenant_id = '${TENANT_A}';`
    )
  );

  assert(
    Number(saldoCruzado) === 0,
    'la vista de saldos por proveedor respeta el aislamiento',
    `B vio ${saldoCruzado} filas de A. La vista perdió security_invoker.`
  );
}

// =============================================================================
// 2 · Cobertura RLS de las tablas nuevas
// =============================================================================
async function testRlsCoverage() {
  console.log('\n\u25b6 Invariante 2 · cobertura RLS de las tablas de compras');

  // Se descubre desde `pg_class`, no desde una lista escrita a mano: una lista
  // manual se desactualiza en silencio y deja de proteger.
  const malCubiertas = await sqlAdmin(`
SELECT COALESCE(string_agg(n.nspname || '.' || c.relname, ', '), '') FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND c.relispartition = false
  AND n.nspname = 'purchasing'
  AND (
    NOT c.relrowsecurity
    OR NOT c.relforcerowsecurity
    OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  );
`);

  assert(
    malCubiertas === '',
    'toda tabla de `purchasing` tiene ENABLE + FORCE y al menos una política',
    `Sin cobertura: ${malCubiertas || '(ninguna, pero la aserción devolvió vacío de forma inesperada)'}`
  );

  // La contraparte: la cantidad descubierta tiene que ser la esperada, para que
  // la aserción anterior no pase por no haber encontrado ninguna tabla.
  const total = await sqlAdmin(`
SELECT count(*)::text FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND c.relispartition = false AND n.nspname = 'purchasing';
`);

  assert(
    Number(total) >= 8,
    'la suite está mirando las 8 tablas de compras (más `app.suppliers`)',
    `Encontró ${total}. Si el esquema no existe, la invariante anterior pasaría sin controlar nada.`
  );

  // `app.suppliers` vive en `app` y la cubre la barrera general, pero se
  // verifica igual: una tabla de negocio con `tenant_id` no puede quedar afuera.
  const suppliersForzada = await sqlAdmin(`
SELECT relforcerowsecurity::text FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relname = 'suppliers';
`);

  assert(
    isTrue(suppliersForzada),
    '`app.suppliers` tiene FORCE ROW LEVEL SECURITY',
    `relforcerowsecurity = ${suppliersForzada}`
  );

  // La barrera oficial del proyecto tiene que correr sin violaciones.
  const cobertura = await sqlAdmin(`
SELECT COALESCE(string_agg(v::text, '; '), '') FROM (
  SELECT app.assert_rls_coverage() AS v
) s WHERE v IS NOT NULL;
`);

  assert(
    cobertura === '',
    '`app.assert_rls_coverage()` no reporta violaciones',
    cobertura
  );
}

// =============================================================================
// 3 · La recepción entra al stock por apply_stock_movement
// =============================================================================
async function testReceiptGoesThroughStockFunction() {
  console.log('\n\u25b6 Invariante 3 · la recepción escribe stock por la función del motor');

  const id = await lineA();

  const antes = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM app.stock_movements WHERE tenant_id = '${TENANT_A}';`
    )
  );

  const recibido = await trySql(
    withTenant(
      TENANT_A,
      `SELECT quantity::text FROM purchasing.receive_order_line(
         '${TENANT_A}', '${id}', 60, 1500, NULL, 'RTO-INV3');`
    )
  );

  assert(recibido.ok, 'la recepción de 60 unidades se ejecuta', recibido.err);

  // El movimiento tiene que existir en el LIBRO, no sólo el saldo haber cambiado.
  // Una implementación que escribiera `stock_levels` a mano dejaría el mismo
  // saldo y este conteo en cero: es exactamente lo que esta aserción distingue.
  const despues = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (SELECT count(*) FROM app.stock_movements WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM app.stock_movements
                WHERE tenant_id = '${TENANT_A}' AND kind = 'purchase_in')::text
    || '|' || (SELECT COALESCE(sum(quantity), 0) FROM app.stock_movements
                WHERE tenant_id = '${TENANT_A}' AND kind = 'purchase_in')::text
    || '|' || (SELECT count(*) FROM purchasing.goods_receipt_items
                WHERE tenant_id = '${TENANT_A}' AND stock_movement_id IS NOT NULL)::text;
`
    )
  );

  const [total, entradas, cantidad, conTrazabilidad] = despues.split('|');

  assert(
    Number(total) === Number(antes) + 1,
    'la recepción dejó exactamente un movimiento de stock en el libro',
    `Antes ${antes}, después ${total}`
  );
  assert(Number(entradas) === 1, 'el movimiento es de tipo purchase_in', `Tipo contado: ${entradas}`);
  assert(Number(cantidad) === 60, 'el movimiento es de 60 unidades', `Cantidad: ${cantidad}`);
  assert(
    Number(conTrazabilidad) === 1,
    'la recepción guarda el id del movimiento que generó',
    `${conTrazabilidad} filas con ` + '`stock_movement_id`'
  );

  // El saldo del depósito lo escribió la función del motor: 60 unidades a 1500.
  const saldo = await sql(
    withTenant(
      TENANT_A,
      `SELECT on_hand::text || '|' || avg_cost::text FROM app.stock_levels
        WHERE tenant_id = '${TENANT_A}';`
    )
  );

  const [onHand, avgCost] = saldo.split('|');

  assert(Number(onHand) === 60, 'el saldo del depósito quedó en 60', `on_hand = ${onHand}`);
  assert(
    Number(avgCost) === 1500,
    'el costo promedio quedó en 1500 (lo calculó apply_stock_movement)',
    `avg_cost = ${avgCost}`
  );
}

// =============================================================================
// 4 · Recepción parcial: el estado se deriva
// =============================================================================
async function testPartialReceipt() {
  console.log('\n\u25b6 Invariante 4 · recepción parcial: el estado se deriva de la línea');

  const estado = await sql(
    withTenant(
      TENANT_A,
      `
SELECT i.received_quantity::text
    || '|' || i.status
    || '|' || o.status
    || '|' || (SELECT COALESCE(sum(pending_quantity), 0) FROM purchasing.v_pending_receipts
                WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM purchasing.goods_receipts
                WHERE tenant_id = '${TENANT_A}')::text
FROM purchasing.supplier_order_items i
JOIN purchasing.supplier_orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
WHERE i.tenant_id = '${TENANT_A}' ORDER BY i.line_number LIMIT 1;
`
    )
  );

  const [recibido, estadoLinea, estadoCabecera, pendiente, recepciones] = estado.split('|');

  assert(Number(recibido) === 60, 'la línea acumula 60 recibidas', `received_quantity = ${recibido}`);
  assert(
    estadoLinea === 'partial',
    'el estado de la LÍNEA es `partial` (derivado, no escrito)',
    `status = ${estadoLinea}`
  );
  assert(
    estadoCabecera === 'partially_received',
    'el estado de la CABECERA es `partially_received` (derivado de sus líneas)',
    `status = ${estadoCabecera}`
  );
  assert(
    Number(pendiente) === 40,
    'la vista de pendientes dice 40 — no se perdió la referencia a lo que falta',
    `pendiente = ${pendiente}. Si dijera 100, la recepción parcial sería invisible.`
  );
  assert(
    Number(recepciones) === 1,
    'la recepción es UN documento, no un cambio de estado de la orden',
    `recepciones = ${recepciones}`
  );
}

// =============================================================================
// 5 · Segunda recepción: cierra la orden y pondera el costo
// =============================================================================
async function testSecondReceiptClosesOrder() {
  console.log('\n\u25b6 Invariante 5 · segunda recepción: cierra la orden y pondera el costo');

  const id = await lineA();

  // 60 a 1500 y ahora 40 a 1600: el promedio ponderado exacto es 1540.
  const segunda = await trySql(
    withTenant(
      TENANT_A,
      `SELECT quantity::text FROM purchasing.receive_order_line(
         '${TENANT_A}', '${id}', 40, 1600, NULL, 'RTO-INV5');`
    )
  );

  assert(segunda.ok, 'la segunda recepción de 40 unidades se ejecuta', segunda.err);

  const estado = await sql(
    withTenant(
      TENANT_A,
      `
SELECT i.received_quantity::text
    || '|' || i.status
    || '|' || o.status
    || '|' || (SELECT count(*) FROM purchasing.v_pending_receipts
                WHERE tenant_id = '${TENANT_A}')::text
FROM purchasing.supplier_order_items i
JOIN purchasing.supplier_orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
WHERE i.tenant_id = '${TENANT_A}' ORDER BY i.line_number LIMIT 1;
`
    )
  );

  const [recibido, estadoLinea, estadoCabecera, pendientes] = estado.split('|');

  assert(Number(recibido) === 100, 'la línea acumula las 100 unidades', `received_quantity = ${recibido}`);
  assert(estadoLinea === 'received', 'la línea pasa a `received` sola', `status = ${estadoLinea}`);
  assert(
    estadoCabecera === 'received',
    'la cabecera pasa a `received` sola (derivada de sus líneas)',
    `status = ${estadoCabecera}`
  );
  assert(
    Number(pendientes) === 0,
    'no queda nada pendiente de recibir',
    `La vista de pendientes devuelve ${pendientes} filas.`
  );

  // EL COSTO PROMEDIO PONDERADO. Es el corazón del gate de E3: la mercadería
  // entró por dos recepciones a costos distintos y el sistema tiene que saber
  // cuánto vale lo que tiene. La aritmética la hace `apply_stock_movement` de
  // `0007`; acá se verifica que la composición de las dos recepciones dé el
  // número correcto y no el costo de la última.
  const saldo = await sql(
    withTenant(
      TENANT_A,
      `SELECT on_hand::text || '|' || avg_cost::text FROM app.stock_levels
        WHERE tenant_id = '${TENANT_A}';`
    )
  );

  const [onHand, avgCost] = saldo.split('|');

  assert(Number(onHand) === 100, 'el saldo quedó en 100 unidades', `on_hand = ${onHand}`);
  assert(
    Number(avgCost) === 1540,
    'el costo promedio ponderado es 1540: (60x1500 + 40x1600) / 100',
    `avg_cost = ${avgCost}. Si fuera 1500 o 1600, se estaría quedando con el costo de una sola recepción.`
  );

  // Las dos recepciones son dos documentos distintos.
  const recepciones = await sql(
    withTenant(
      TENANT_A,
      `SELECT count(*)::text FROM purchasing.goods_receipts WHERE tenant_id = '${TENANT_A}';`
    )
  );

  assert(
    Number(recepciones) === 2,
    'quedaron dos recepciones: recibir en dos veces son dos hechos con dos remitos',
    `recepciones = ${recepciones}`
  );
}

// =============================================================================
// 6 · La sobre-recepción la impide el MOTOR, no la función
// =============================================================================
async function testOverReceiptBlockedByEngine() {
  console.log('\n\u25b6 Invariante 6 · la sobre-recepción la impide el motor');

  const id = await lineA();

  // Camino 1: por la función. Debe fallar, y con un mensaje que diga CUÁNTO
  // queda. Un operador con el remito en la mano necesita el número.
  const porFuncion = await trySql(
    withTenant(
      TENANT_A,
      `SELECT purchasing.receive_order_line('${TENANT_A}', '${id}', 10, 1500, NULL, 'RTO-OVER');`
    )
  );

  assert(!porFuncion.ok, 'una recepción por encima de lo pedido es RECHAZADA', 'La recepción de 10 sobre una línea ya completa pasó.');

  assert(
    /\b0(\.0+)?\s*pendiente/.test(porFuncion.err) || /quedan/.test(porFuncion.err),
    'el mensaje del rechazo dice cuánto queda pendiente',
    `Mensaje: ${porFuncion.err.slice(0, 300)}`
  );

  // Camino 2: un UPDATE crudo que se saltea la función.
  //
  // Es la prueba que importa. Si la única defensa fuera la comprobación previa
  // dentro de `receive_order_line`, este UPDATE escribiría `received_quantity =
  // 150` sobre una línea de 100 y el estado de la orden pasaría a ser una
  // mentira. El CHECK de la tabla es el que tiene que impedirlo.
  const porUpdate = await trySql(
    withTenant(
      TENANT_A,
      `UPDATE purchasing.supplier_order_items SET received_quantity = 150
        WHERE tenant_id = '${TENANT_A}' AND id = '${id}';`
    )
  );

  assert(
    !porUpdate.ok,
    'un UPDATE directo que se saltea la función también es RECHAZADO por el CHECK',
    'Un camino que se saltea la función pudo escribir received_quantity > quantity. La garantía es decorativa.'
  );

  assert(
    /poi_not_over_received|received_quantity/.test(porUpdate.err),
    'el rechazo del UPDATE nombra la restricción que lo impide',
    `Mensaje: ${porUpdate.err.slice(0, 300)}`
  );

  // Y el dato no cambió: el rechazo fue total, no parcial.
  const intacto = await sql(
    withTenant(
      TENANT_A,
      `SELECT received_quantity::text FROM purchasing.supplier_order_items
        WHERE tenant_id = '${TENANT_A}' AND id = '${id}';`
    )
  );

  assert(
    Number(intacto) === 100,
    'tras los dos rechazos la línea sigue en 100 recibidas',
    `received_quantity = ${intacto}`
  );
}

// =============================================================================
// 7 · Los asientos de compra y el saldo calculado
// =============================================================================
async function testPurchaseEntryAndBalance() {
  console.log('\n\u25b6 Invariante 7 · asientos de compra y saldo calculado desde documentos');

  // Factura de compra: neto 150.000 + IVA 31.500 = 181.500.
  const factura = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO purchasing.supplier_invoices (
  tenant_id, number, supplier_id, doc_type, point_of_sale, doc_number,
  issue_date, due_date, subtotal, tax_total, total
)
SELECT '${TENANT_A}', purchasing.next_invoice_number('${TENANT_A}'), s.id,
       'A', 1, 4242, CURRENT_DATE, CURRENT_DATE + 30, 150000, 31500, 181500
FROM app.suppliers s
WHERE s.tenant_id = '${TENANT_A}' AND s.code = 'PROV-1';

SELECT accounting.post_entry_for_source(
  '${TENANT_A}', 'purchase',
  (SELECT id FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_A}' LIMIT 1),
  'purchase', CURRENT_DATE, 'Factura de compra de prueba',
  jsonb_build_object('subtotal', 150000, 'tax_total', 31500, 'total', 181500), NULL);
`
    )
  );

  assert(factura.ok, 'la factura de compra se registra y genera su asiento', factura.err);

  // El asiento tiene que tener las tres patas en las cuentas correctas.
  const lineas = await sql(
    withTenant(
      TENANT_A,
      `
SELECT string_agg(a.code || '=' || l.debit || '/' || l.credit, ' ' ORDER BY a.code)
FROM accounting.journal_lines l
JOIN accounting.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
JOIN accounting.journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
WHERE l.tenant_id = '${TENANT_A}' AND e.source_type = 'purchase';
`
    )
  );

  assert(
    lineas === '1.1.4.01=31500.00/0.00 2.1.1.01=0.00/181500.00 5.1.1.01=150000.00/0.00',
    'el asiento imputa costo, IVA crédito y proveedor con los importes correctos',
    `Se obtuvo: ${lineas}`
  );

  // El cuadre del asiento es la garantía del motor, no de la aplicación.
  const cuadre = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (sum(l.debit) - sum(l.credit))::text
FROM accounting.journal_lines l
JOIN accounting.journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
WHERE l.tenant_id = '${TENANT_A}' AND e.source_type = 'purchase';
`
    )
  );

  assert(Number(cuadre) === 0, 'el asiento de compra cuadra (débitos = créditos)', `Diferencia: ${cuadre}`);

  // Sin columnas de saldo materializadas: el saldo se deriva de los documentos.
  const columnaSaldo = await sqlAdmin(`
SELECT count(*)::text FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'suppliers' AND column_name = 'balance';
`);

  assert(
    Number(columnaSaldo) === 0,
    '`app.suppliers` no tiene una columna de saldo almacenada',
    'Un saldo materializado puede discrepar de los documentos que dice resumir.'
  );

  const saldoInicial = await sql(
    withTenant(
      TENANT_A,
      `SELECT COALESCE(sum(outstanding_total), 0)::text FROM purchasing.v_supplier_balances
        WHERE tenant_id = '${TENANT_A}';`
    )
  );

  assert(
    Number(saldoInicial) === 181500,
    'el saldo del proveedor es 181.500, derivado de la factura',
    `Saldo: ${saldoInicial}`
  );

  // Un pago parcial tiene que mover el saldo por el monto exacto.
  const pago = await trySql(
    withTenant(
      TENANT_A,
      `
SELECT purchasing.apply_supplier_payment(
  '${TENANT_A}',
  (SELECT id FROM app.suppliers WHERE tenant_id = '${TENANT_A}' AND code = 'PROV-1'),
  CURRENT_DATE, 'transfer', 81500,
  jsonb_build_array(jsonb_build_object(
    'invoice_id', (SELECT id FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_A}' LIMIT 1),
    'amount', 81500)), 'TRF-INV7', NULL);
`
    )
  );

  assert(pago.ok, 'el pago parcial se registra y se imputa', pago.err);

  const saldoFinal = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (SELECT COALESCE(sum(outstanding_total), 0) FROM purchasing.v_supplier_balances
         WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT status FROM purchasing.supplier_invoices
                WHERE tenant_id = '${TENANT_A}' LIMIT 1)::text
    || '|' || (SELECT paid_total::text FROM purchasing.supplier_invoices
                WHERE tenant_id = '${TENANT_A}' LIMIT 1);
`
    )
  );

  const [saldo, estado, pagado] = saldoFinal.split('|');

  assert(Number(saldo) === 100000, 'tras pagar 81.500 el saldo es 100.000', `Saldo: ${saldo}`);
  assert(Number(pagado) === 81500, 'la factura acumula 81.500 pagados', `paid_total = ${pagado}`);
  assert(
    estado === 'partial',
    'la factura queda en `partial` (estado derivado del monto, no escrito)',
    `status = ${estado}`
  );

  // Un pago cuyas imputaciones no suman el monto deja plata sin destino conocido.
  const desimputado = await trySql(
    withTenant(
      TENANT_A,
      `
SELECT purchasing.apply_supplier_payment(
  '${TENANT_A}',
  (SELECT id FROM app.suppliers WHERE tenant_id = '${TENANT_A}' AND code = 'PROV-1'),
  CURRENT_DATE, 'cash', 50000,
  jsonb_build_array(jsonb_build_object(
    'invoice_id', (SELECT id FROM purchasing.supplier_invoices WHERE tenant_id = '${TENANT_A}' LIMIT 1),
    'amount', 30000)), 'TRF-DESIMPUTADO', NULL);
`
    )
  );

  assert(
    !desimputado.ok,
    'un pago cuyas imputaciones no suman el monto es RECHAZADO',
    'Un pago de 50.000 imputado por 30.000 pasó: quedarían 20.000 sin destino y el saldo del proveedor mentiría.'
  );

  // La antigüedad de saldos tiene que ubicar el vencimiento en el tramo correcto.
  // La factura vence en +30 días: está dentro de `current`, no vencida.
  const antiguedad = await sql(
    withTenant(
      TENANT_A,
      `
SELECT current_amount::text || '|' || bucket_0_30::text || '|' || total_outstanding::text
FROM purchasing.v_payables_aging WHERE tenant_id = '${TENANT_A}';
`
    )
  );

  const [corriente, tramo0a30, totalAging] = antiguedad.split('|');

  assert(
    Number(corriente) === 100000,
    'la antigüedad ubica el saldo no vencido en `current`',
    `current = ${corriente}, 0-30 = ${tramo0a30}`
  );
  assert(
    Number(totalAging) === 100000,
    'la antigüedad total coincide con el saldo por proveedor',
    `aging = ${totalAging} contra saldo = 100.000. Si difieren, una de las dos vistas miente.`
  );
}

// =============================================================================
// 8 · La vista de brechas cubre compras
// =============================================================================
async function testPostingGapsCoverPurchases() {
  console.log('\n\u25b6 Invariante 8 · la vista de brechas delata una compra sin asiento');

  // La aserción es sobre el DELTA, no sobre el total. Para cuando este invariante
  // corre, la suite ya dejó hechos propios sin asiento (la factura de compra del
  // invariante 7 se asienta, pero hay documentos que legítimamente no generan
  // asiento). Afirmar `total === 0` obligaría a que la suite no hubiera hecho
  // nada antes — una aserción sobre el orden de los tests, no sobre la vista.
  //
  // Lo que importa es: (a) la vista ve lo que había, y (b) al agregar un hecho
  // sin asiento, la vista lo DELATA. Un `WHERE false` pasa (a) y falla (b).
  const brechasAntes = await sql(
    withTenant(
      TENANT_A,
      `SELECT coalesce(string_agg(source_id::text, ','), '')
         FROM accounting.v_posting_gaps WHERE tenant_id = '${TENANT_A}';`
    )
  );

  const idsAntes = new Set(brechasAntes ? brechasAntes.split(',') : []);

  // Se registra una factura de compra y NO se asienta: la vista tiene que delatarla.
  //
  // Sin esta dirección, una vista con `WHERE false` pasaría la aserción anterior
  // y la suite diría que las brechas están controladas sin controlarlas.
  const huerfana = await trySql(
    withTenant(
      TENANT_A,
      `
INSERT INTO purchasing.supplier_invoices (
  tenant_id, number, supplier_id, doc_type, point_of_sale, doc_number,
  issue_date, due_date, subtotal, tax_total, total
)
SELECT '${TENANT_A}', purchasing.next_invoice_number('${TENANT_A}'), s.id,
       'B', 1, 4243, CURRENT_DATE, CURRENT_DATE + 30, 10000, 2100, 12100
FROM app.suppliers s
WHERE s.tenant_id = '${TENANT_A}' AND s.code = 'PROV-1'
RETURNING id::text;
`
    )
  );

  assert(huerfana.ok, 'se registró una factura de compra sin asiento', huerfana.err);

  const idHuerfano = String(huerfana.out).trim();

  const detectada = await sql(
    withTenant(
      TENANT_A,
      `
SELECT count(*)::text || '|' || COALESCE(string_agg(DISTINCT source_type, ','), '')
    || '|' || COALESCE(bool_or(source_id::text = '${idHuerfano}')::text, 'false')
FROM accounting.v_posting_gaps WHERE tenant_id = '${TENANT_A}';
`
    )
  );

  const [cantidad, tipos, incluyeHuerfana] = detectada.split('|');

  // (a) No desapareció nada de lo que la vista ya veía: descartamos que el
  //     `CREATE OR REPLACE` haya perdido ramas al extender la vista para compras.
  const idsDespues = await sql(
    withTenant(
      TENANT_A,
      `SELECT coalesce(string_agg(source_id::text, ','), '')
         FROM accounting.v_posting_gaps WHERE tenant_id = '${TENANT_A}';`
    )
  );

  const idsDespuesSet = new Set(idsDespues ? idsDespues.split(',') : []);
  const perdidas = [...idsAntes].filter((id) => id && !idsDespuesSet.has(id));

  assert(
    perdidas.length === 0,
    'extender la vista a compras no perdió ninguna brecha previa',
    `Desaparecieron ${perdidas.length} brechas: ${perdidas.join(', ')}. ` +
      'Un CREATE OR REPLACE que no repite todas las ramas las descarta en silencio.'
  );

  // (b) La brecha nueva aparece, y aparece identificada.
  assert(
    incluyeHuerfana === 'true',
    'una factura de compra sin asiento es DETECTADA por la vista de brechas',
    `La vista no incluyó la factura ${idHuerfano} entre sus ${cantidad} brechas. ` +
      'Una vista que nunca encuentra nada no controla nada.'
  );
  assert(
    tipos.includes('purchase'),
    'la brecha detectada es del tipo `purchase`',
    `Tipos detectados: ${tipos}`
  );

  // Y B sigue sin verla: la vista conserva security_invoker.
  const brechasDeB = await sql(
    withTenant(
      TENANT_B,
      `SELECT count(*)::text FROM accounting.v_posting_gaps WHERE tenant_id = '${TENANT_A}';`
    )
  );

  assert(
    Number(brechasDeB) === 0,
    'la vista de brechas respeta el aislamiento entre empresas',
    `B vio ${brechasDeB} brechas de A. La vista perdió security_invoker al ser reemplazada.`
  );
}

// =============================================================================
// 9 · Atomicidad: un rechazo no deja residuo
// =============================================================================
async function testAtomicity() {
  console.log('\n\u25b6 Invariante 9 · un rechazo no deja residuo');

  const estadoAntes = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (SELECT count(*) FROM purchasing.goods_receipts WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM app.stock_movements WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT COALESCE(sum(on_hand), 0) FROM app.stock_levels WHERE tenant_id = '${TENANT_A}')::text;
`
    )
  );

  // Se intenta una recepción imposible sobre una línea ya completa. La función
  // escribe el movimiento de stock ANTES de actualizar la línea, así que si el
  // UPDATE fallara sin transacción, quedaría un movimiento huérfano: stock que
  // entró al libro sin documento que lo respalde.
  //
  // Acá la sobre-recepción se detecta temprano, así que el caso que prueba la
  // atomicidad es otro: se fuerza el rechazo por el CHECK de la línea con un
  // UPDATE que sí llega al motor.
  const rechazo = await trySql(
    withTenant(
      TENANT_A,
      `
DO $$
BEGIN
  UPDATE purchasing.supplier_order_items
     SET received_quantity = quantity + 1
   WHERE tenant_id = '${TENANT_A}';
END $$;
`
    )
  );

  assert(!rechazo.ok, 'el UPDATE que excede la cantidad pedida es rechazado', 'El UPDATE pasó.');

  const estadoDespues = await sql(
    withTenant(
      TENANT_A,
      `
SELECT (SELECT count(*) FROM purchasing.goods_receipts WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT count(*) FROM app.stock_movements WHERE tenant_id = '${TENANT_A}')::text
    || '|' || (SELECT COALESCE(sum(on_hand), 0) FROM app.stock_levels WHERE tenant_id = '${TENANT_A}')::text;
`
    )
  );

  assert(
    estadoAntes === estadoDespues,
    'tras el rechazo no quedó ninguna recepción, movimiento ni saldo de más',
    `Antes ${estadoAntes}, después ${estadoDespues}`
  );
}

// =============================================================================
// 10 · El job de conciliación está registrado
// =============================================================================
async function testJobRegistered() {
  console.log('\n\u25b6 Invariante 10 · el job de conciliación está en el ledger');

  // El ledger vive en la base y la aplicación no lo toca: se consulta con el rol
  // de plataforma. Un job registrado sin implementación se agenda, se reporta
  // como exitoso y no hace nada — la falla más traicionera del sistema.
  const job = await sqlAdmin(`
SELECT code || '|' || expected_every::text
FROM ops.jobs WHERE code = 'purchasing.receivables_check';
`);

  assert(job !== '', 'el job `purchasing.receivables_check` está registrado en ops.jobs', 'No aparece en el ledger.');

  if (job !== '') {
    const [code, cadence] = job.split('|');
    assert(code === 'purchasing.receivables_check', 'el código del job es el esperado', code);
    assert(
      cadence.includes('1 day'),
      'el job tiene cadencia diaria declarada',
      `expected_every = ${cadence}`
    );
  }
}

// =============================================================================
// Ejecución
// =============================================================================
async function main() {
  console.log('='.repeat(70));
  console.log(' Suite de invariantes de compras y cuentas por pagar · Control');
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
  await testReceiptGoesThroughStockFunction();
  await testPartialReceipt();
  await testSecondReceiptClosesOrder();
  await testOverReceiptBlockedByEngine();
  await testPurchaseEntryAndBalance();
  await testPostingGapsCoverPurchases();
  await testAtomicity();
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
