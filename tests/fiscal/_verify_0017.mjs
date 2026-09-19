/**
 * Verificación de comportamiento de `0017_fiscal_foundation.sql` contra un motor
 * real.
 *
 * POR QUÉ EXISTE
 *
 * La validación estructural de las migraciones (balance de paréntesis, comillas,
 * orden) no detecta un `COMMENT ON COLUMN` sobre una columna que todavía no se
 * agregó, ni una constraint que no protege el caso que importa, ni una extensión
 * que falta. Los tres defectos aparecieron en `0017` y ninguno era visible leyendo
 * el archivo.
 *
 * Estas aserciones son las que sí lo son.
 *
 * USO
 *   node tests/fiscal/_verify_0017.mjs [--dsn ...]
 */

import pg from 'pg';

const argv = process.argv.slice(2);
const i = argv.indexOf('--dsn');
const DSN =
  i >= 0
    ? argv[i + 1]
    : process.env.CONTROL_ADMIN_DSN ||
      'postgresql://postgres:P0stgres%21@127.0.0.1:5432/control_fiscal';

let ok = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    ok += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${label}${detail ? ' — ' + detail : ''}`);
  }
}

/** Ejecuta y devuelve true si la sentencia fue RECHAZADA por el motor. */
async function rejected(db, sql, params) {
  try {
    await db.query(sql, params);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const db = new pg.Client({ connectionString: DSN });
  await db.connect();

  // Datos únicos por corrida: la base puede tener residuos de una corrida previa.
  const stamp = Date.now().toString(36);
  const slugA = `fisc-a-${stamp}`;
  const slugB = `fisc-b-${stamp}`;

  // ---------------------------------------------------------------------------
  console.log('\n▶ 1 · El renombre de vocabulario (ADR 0003)');
  // ---------------------------------------------------------------------------
  const cols = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'billing' AND table_name = 'invoices'
      AND (column_name LIKE 'authorization%' OR column_name LIKE 'cae%' OR column_name = 'local_codes')
    ORDER BY 1
  `);
  const names = cols.rows.map((r) => r.column_name);
  check('existe authorization_id', names.includes('authorization_id'));
  check('existe authorization_expires_at', names.includes('authorization_expires_at'));
  check('existe local_codes', names.includes('local_codes'));
  check('la columna cae ya no existe', !names.includes('cae'));
  check('la columna cae_expires_at ya no existe', !names.includes('cae_expires_at'));

  const cons = await db.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'billing.invoices'::regclass
      AND (conname LIKE '%cae%' OR conname LIKE '%authoriz%')
  `);
  const cnames = cons.rows.map((r) => r.conname);
  check(
    'el CHECK de formato argentino fue eliminado',
    !cnames.includes('inv_cae_format'),
    cnames.join(', ')
  );
  check(
    'la invariante de dominio se conserva renombrada',
    cnames.includes('inv_authorized_has_authorization'),
    cnames.join(', ')
  );

  // ---------------------------------------------------------------------------
  console.log('\n▶ 2 · La inmutabilidad fiscal sobrevive al renombre');
  // ---------------------------------------------------------------------------
  const tA = (
    await db.query(
      `INSERT INTO app.tenants (slug, legal_name, display_name)
       VALUES ($1, 'Fiscal A SA', 'Fiscal A') RETURNING id`,
      [slugA]
    )
  ).rows[0].id;
  const uA = (
    await db.query(
      `INSERT INTO app.users (google_sub, email, full_name)
       VALUES ($1, $2, 'Verificador') RETURNING id`,
      [`sub-${stamp}`, `verif-${stamp}@control.test`]
    )
  ).rows[0].id;
  const custA = (
    await db.query(
      `INSERT INTO app.customers (tenant_id, code, legal_name, doc_number)
       VALUES ($1, 'C001', 'Cliente V', '20111111112') RETURNING id`,
      [tA]
    )
  ).rows[0].id;

  const invA = (
    await db.query(
      `INSERT INTO billing.invoices
         (tenant_id, customer_id, kind, doc_type, point_of_sale, number,
          receptor_name, receptor_doc_number, total, subtotal,
          status, result, authorization_id, idempotency_key, created_by)
       VALUES ($1,$2,'invoice','A',1,1,'Cliente V','20111111112',121.00,100.00,
               'authorized','approved','12345678901234',$3,$4)
       RETURNING id`,
      [tA, custA, `idem-${stamp}`, uA]
    )
  ).rows[0].id;

  // Los campos fiscales siguen siendo inmutables. El defecto que esta sección
  // cubre es sutil: `assert_invoice_immutable` es plpgsql y resuelve los nombres
  // de columna en TIEMPO DE EJECUCIÓN. Si el renombre no hubiera redefinido la
  // función, no fallaría al crear la migración — fallaría acá, en el primer
  // UPDATE de una factura autorizada, con un mensaje sobre una columna
  // inexistente que no menciona ni el renombre ni la inmutabilidad.
  for (const [campo, sql] of [
    ['total', 'total = 999'],
    ['receptor_name', "receptor_name = 'Otro'"],
    ['authorization_id', "authorization_id = '99999999999999'"],
    ['number', 'number = 42'],
    ['issue_date', "issue_date = '2020-01-01'"],
    ['idempotency_key', "idempotency_key = 'otra'"],
  ]) {
    const rec = await rejected(db, `UPDATE billing.invoices SET ${sql} WHERE id = $1`, [invA]);
    check(`modificar ${campo} de un comprobante autorizado es rechazado`, rec);
  }

  // Y los acumuladores de cobro SÍ se modifican: es la corrección de `0015` y una
  // regresión acá dejaría el cobro de facturas autorizadas imposible otra vez.
  const paidOk = !(await rejected(
    db,
    `UPDATE billing.invoices SET paid_total = 50.00 WHERE id = $1`,
    [invA]
  ));
  check('los acumuladores de cobro siguen siendo modificables', paidOk);

  // El `FOR UPDATE` es el camino del cobro: si esto devuelve 0 filas, la
  // imputación aborta con "la factura no existe en esta empresa".
  const lock = await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM billing.invoices WHERE id = $1 FOR UPDATE
     ) s`,
    [invA]
  );
  check('FOR UPDATE encuentra la factura autorizada', lock.rows[0].n === 1);

  // ---------------------------------------------------------------------------
  console.log('\n▶ 3 · La vigencia de alícuotas no se solapa (incluido plataforma)');
  // ---------------------------------------------------------------------------
  const taxTpl = (
    await db.query(
      `INSERT INTO fiscal.taxes (code, name, kind)
       VALUES ($1, 'IVA', 'vat') RETURNING id`,
      [`iva_${stamp}`]
    )
  ).rows[0].id;

  // DEFECTO CORREGIDO: con `EXCLUDE ... tenant_id WITH =`, dos filas con
  // `tenant_id IS NULL` no colisionan, porque en un EXCLUDE NULL se considera
  // distinto de NULL. El centinela en `COALESCE` es lo que hace que las
  // alícuotas de plataforma se protejan.
  await db.query(
    `INSERT INTO fiscal.tax_rates (tax_id, rate_code, rate, valid_from, valid_to)
     VALUES ($1, '21', 0.21, DATE '2024-01-01', DATE '2024-12-31')`,
    [taxTpl]
  );
  const overlapRejected = await rejected(
    db,
    `INSERT INTO fiscal.tax_rates (tax_id, rate_code, rate, valid_from, valid_to)
     VALUES ($1, '21', 0.105, DATE '2024-06-01', DATE '2025-06-30')`,
    [taxTpl]
  );
  check(
    'dos alícuotas de plataforma que se solapan son rechazadas',
    overlapRejected,
    'la constraint de exclusión no está protegiendo tenant_id NULL'
  );

  // Una adyacente sin solape (empieza el día que la otra termina) SÍ debe entrar:
  // una constraint que rechaza todo es tan inútil como una que no rechaza nada.
  const adjacentOk = !(await rejected(
    db,
    `INSERT INTO fiscal.tax_rates (tax_id, rate_code, rate, valid_from, valid_to)
     VALUES ($1, '21', 0.105, DATE '2025-01-01', NULL)`,
    [taxTpl]
  ));
  check('una vigencia adyacente sin solape es aceptada', adjacentOk);

  // ---------------------------------------------------------------------------
  console.log('\n▶ 4 · rates_on devuelve UNA alícuota por fecha');
  // ---------------------------------------------------------------------------
  for (const [fecha, esperado] of [
    ['2024-03-15', 0.21],
    ['2025-03-15', 0.105],
    ['2026-01-01', 0.105],
  ]) {
    const r = await db.query(`SELECT rate FROM fiscal.rates_on($1, $2)`, [
      fecha,
      `iva_${stamp}`,
    ]);
    check(
      `${fecha} -> ${esperado} (${r.rowCount} fila)`,
      r.rowCount === 1 && Number(r.rows[0].rate) === esperado,
      r.rows.map((x) => x.rate).join(', ')
    );
  }

  // ---------------------------------------------------------------------------
  console.log('\n▶ 5 · Precedencia empresa sobre plataforma');
  // ---------------------------------------------------------------------------
  const tB = (
    await db.query(
      `INSERT INTO app.tenants (slug, legal_name, display_name)
       VALUES ($1, 'Fiscal B SA', 'Fiscal B') RETURNING id`,
      [slugB]
    )
  ).rows[0].id;
  const taxOwn = (
    await db.query(
      `INSERT INTO fiscal.taxes (tenant_id, code, name, kind)
       VALUES ($1, $2, 'IVA propio', 'vat') RETURNING id`,
      [tB, `iva_${stamp}`]
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO fiscal.tax_rates (tenant_id, tax_id, rate_code, rate, valid_from)
     VALUES ($1, $2, '21', 0.105, DATE '2024-01-01')`,
    [tB, taxOwn]
  );

  const rOwn = await db.query(`SELECT rate FROM fiscal.rates_on($1, $2, $3)`, [
    '2024-03-15',
    `iva_${stamp}`,
    tB,
  ]);
  check(
    'la empresa con alícuota propia recibe la suya',
    rOwn.rowCount === 1 && Number(rOwn.rows[0].rate) === 0.105,
    rOwn.rows.map((x) => x.rate).join(', ')
  );

  const rPlat = await db.query(`SELECT rate FROM fiscal.rates_on($1, $2, NULL::uuid)`, [
    '2024-03-15',
    `iva_${stamp}`,
  ]);
  check(
    'la consulta de plataforma devuelve la de plataforma',
    rPlat.rowCount === 1 && Number(rPlat.rows[0].rate) === 0.21,
    rPlat.rows.map((x) => x.rate).join(', ')
  );

  // Una tercera empresa sin alícuota propia cae a la de plataforma; no ve la de B.
  const tC = (
    await db.query(
      `INSERT INTO app.tenants (slug, legal_name, display_name)
       VALUES ($1, 'Fiscal C SA', 'Fiscal C') RETURNING id`,
      [`fisc-c-${stamp}`]
    )
  ).rows[0].id;
  const rC = await db.query(`SELECT rate FROM fiscal.rates_on($1, $2, $3)`, [
    '2024-03-15',
    `iva_${stamp}`,
    tC,
  ]);
  check(
    'una empresa sin alícuota propia cae a la de plataforma y no ve la ajena',
    rC.rowCount === 1 && Number(rC.rows[0].rate) === 0.21,
    rC.rows.map((x) => x.rate).join(', ')
  );

  // ---------------------------------------------------------------------------
  console.log('\n▶ 6 · Aislamiento del catálogo: RLS, no FK compuesta');
  // ---------------------------------------------------------------------------
  // Tras 0020 el catálogo fiscal es COMPARTIDO y la referencia a un impuesto es
  // una FK SIMPLE (`tax_id` → `fiscal.taxes(id)`), no compuesta. La FK compuesta
  // se relajó adrede porque una fila de plataforma tiene `tenant_id = NULL` y la
  // compuesta nunca emparejaría. Lo que ahora garantiza el aislamiento NO es la FK
  // sino RLS sobre el catálogo: una empresa no debe VER el impuesto propio de otra,
  // pero SÍ debe ver el de plataforma (es lo que le permite registrar su IVA contra
  // el parámetro global). Lo medimos con el rol de aplicación, no con el
  // superusuario, porque RLS sólo se ejercita fuera de `postgres`.
  const app2 = new pg.Client({
    connectionString: DSN.replace(/\/\/postgres:([^@]*)@/, '//app_login:AppL0gin%21@'),
  });
  await app2.connect();
  await app2.query(`SELECT app.set_tenant_context($1, NULL, false)`, [tC]);

  const veOtra = await app2.query(
    `SELECT count(*)::int AS n FROM fiscal.taxes WHERE id = $1`,
    [taxOwn]
  );
  check('una empresa no ve el impuesto propio de otra (RLS)', veOtra.rows[0].n === 0);

  const vePlat = await app2.query(
    `SELECT count(*)::int AS n FROM fiscal.taxes WHERE code = $1 AND tenant_id IS NULL`,
    [`iva_${stamp}`]
  );
  check('una empresa sí ve el impuesto de plataforma (catálogo compartido)', vePlat.rows[0].n === 1);
  await app2.end();

  // ---------------------------------------------------------------------------
  console.log('\n▶ 7 · Cobertura RLS de las tablas nuevas');
  // ---------------------------------------------------------------------------
  const rls = await db.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fiscal' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  // Las tablas del esquema fiscal esperadas tras 0017+0018+0019. El bucle de
  // abajo sigue exigiendo RLS + FORCE + política sobre CADA tabla fiscal; esta
  // aserción garantiza además que ninguna de las introducidas se perdió. Es un
  // mínimo (>=), así que las fases siguientes pueden agregar tablas sin romperlo.
  const expectedFiscal = [
    'taxes',
    'tax_rates',
    'withholding_regimes',
    'document_taxes',
    'vat_accruals',
    'tax_documents',
    'accrual_rules',
    'document_withholdings',
  ];
  const gotFiscal = rls.rows.map((r) => r.relname);
  const faltanFiscal = expectedFiscal.filter((t) => !gotFiscal.includes(t));
  check(
    'el esquema fiscal tiene las 8 tablas esperadas y RLS',
    faltanFiscal.length === 0 && gotFiscal.length >= expectedFiscal.length,
    faltanFiscal.length ? `faltan: ${faltanFiscal.join(', ')}` : gotFiscal.join(', ')
  );
  for (const r of rls.rows) {
    check(
      `${r.relname}: RLS + FORCE + política`,
      r.relrowsecurity && r.relforcerowsecurity && r.policies > 0
    );
  }

  // ---------------------------------------------------------------------------
  console.log('\n▶ 8 · Privilegios: la app lee parámetros y no los escribe');
  // ---------------------------------------------------------------------------
  const app = new pg.Client({
    connectionString: DSN.replace(/\/\/postgres:([^@]*)@/, '//app_login:AppL0gin%21@'),
  });
  await app.connect();

  const canRead = !(await rejected(app, `SELECT count(*) FROM fiscal.taxes`));
  check('app_login puede leer fiscal.taxes', canRead);

  const canReadRates = !(await rejected(app, `SELECT count(*) FROM fiscal.tax_rates`));
  check('app_login puede leer fiscal.tax_rates', canReadRates);

  const cannotWriteParam = await rejected(
    app,
    `INSERT INTO fiscal.taxes (code, name, kind) VALUES ('hack', 'hack', 'vat')`
  );
  check('app_login NO puede escribir parámetros de plataforma', cannotWriteParam);

  await app.end();

  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(70)}`);
  if (fail === 0) {
    console.log(` RESULTADO: OK · ${ok} verificaciones aprobadas`);
  } else {
    console.error(` RESULTADO: FALLA · ${ok} aprobadas, ${fail} fallidas`);
  }
  console.log('='.repeat(70));

  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  process.exit(1);
});
