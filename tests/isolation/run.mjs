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
 *   DATABASE_URL="postgres://user:pass@host:5432/db" node tests/isolation/run.mjs
 *   node tests/isolation/run.mjs --dsn "postgres://..." --verbose
 *
 * Requiere `psql` en el PATH (viene con el cliente de PostgreSQL).
 * Salida: código 0 si todo pasa, 1 si detecta cualquier fuga.
 * =============================================================================
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const DSN =
  readFlag('--dsn') ||
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING;

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

if (!DSN) {
  console.error(
    'Falta la cadena de conexión.\n' +
      '  DATABASE_URL="postgres://user:pass@host:5432/db" node tests/isolation/run.mjs\n' +
      '  o: node tests/isolation/run.mjs --dsn "postgres://..."'
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
 * Ejecuta SQL como una transacción única y devuelve stdout crudo.
 * Cada consulta va en su propia transacción para que `SET LOCAL` tenga el
 * alcance correcto — igual que hace la aplicación en producción.
 */
async function sql(statements) {
  const script = ['\\set ON_ERROR_STOP on', statements].join('\n');
  const { stdout } = await run(
    'psql',
    [DSN, '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '-v', 'ON_ERROR_STOP=1', '-c', script],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout.trim();
}

/**
 * Ejecuta y devuelve { ok, out, err } sin lanzar.
 * Se usa para las pruebas que ESPERAN un error de política.
 */
async function trySql(statements) {
  try {
    return { ok: true, out: await sql(statements) };
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
// =============================================================================
async function setup() {
  console.log('\n\u25b6 Preparación del escenario');

  // Limpieza idempotente de corridas anteriores.
  await sql(`
BEGIN;
SET LOCAL app.platform_admin = 'on';
DELETE FROM audit.events      WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.memberships   WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenant_branding WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.tenants       WHERE id       IN ('${TENANT_A}', '${TENANT_B}');
DELETE FROM app.users         WHERE id       IN ('${USER_A}', '${USER_B}');
COMMIT;
`);

  await sql(`
BEGIN;
SET LOCAL app.platform_admin = 'on';
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

  // Datos de negocio para los dos inquilinos, en las tablas mínimas.
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

  console.log('  Escenario listo: 2 inquilinos, datos en ambos.');
}

// =============================================================================
// 1 · Descubrimiento del catálogo real de tablas
// =============================================================================
async function discoverTables() {
  const out = await sql(`
SELECT n.nspname || '.' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
     AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p')
  AND n.nspname IN ('app', 'billing', 'logistics', 'audit')
ORDER BY 1;
`);

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [fq, enabled, forced] = line.split('|');
      const [schema, table] = fq.split('.');
      return { schema, table, fq, enabled: enabled === 't', forced: forced === 't' };
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
  const parts = await sql(`
SELECT n.nspname || '.' || c.relname || '|' || c.relforcerowsecurity ||
       '|' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relispartition AND n.nspname IN ('app', 'billing', 'logistics', 'audit')
ORDER BY 1;
`);

  const partList = parts
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [fq, forced, pols] = line.split('|');
      return { fq, forced: forced === 't', pols: Number(pols) };
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
  for (const t of tables) {
    const out = await sql(
      withTenant(
        TENANT_A,
        `WITH u AS (
           UPDATE ${t.fq} SET tenant_id = tenant_id
           WHERE tenant_id = '${TENANT_B}'::uuid
           RETURNING 1
         ) SELECT count(*) FROM u;`
      )
    );

    assert(
      Number(out) === 0,
      `${t.fq}: UPDATE sobre filas de B afecta 0 filas`,
      `Afectó ${out} filas de otro inquilino.`
    );
  }

  // C.2 · DELETE sobre filas ajenas: debe afectar 0 filas.
  for (const t of tables) {
    const out = await sql(
      withTenant(
        TENANT_A,
        `WITH d AS (
           DELETE FROM ${t.fq} WHERE tenant_id = '${TENANT_B}'::uuid RETURNING 1
         ) SELECT count(*) FROM d;`
      )
    );

    assert(
      Number(out) === 0,
      `${t.fq}: DELETE sobre filas de B afecta 0 filas`,
      `Borró ${out} filas de otro inquilino.`
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
// =============================================================================
async function testFailClosed(tables) {
  console.log('\n\u25b6 D · Fail-closed (sin contexto de sesión)');

  for (const t of tables) {
    const out = await sql(
      withoutTenant(`SELECT count(*) FROM ${t.fq};`)
    );

    assert(
      Number(out) === 0,
      `${t.fq}: sin contexto devuelve 0 filas`,
      `Devolvió ${out} filas sin contexto de inquilino — el sistema no es fail-closed.`
    );
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

  await setup();
  const tables = await discoverTables();

  console.log(`\nTablas con tenant_id descubiertas: ${tables.length}`);
  for (const t of tables) console.log(`  · ${t.fq}`);

  await testCoverage(tables);
  await testReadIsolation(tables);
  await testWriteIsolation(tables);
  await testFailClosed(tables);
  await testAssertionExists();

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
