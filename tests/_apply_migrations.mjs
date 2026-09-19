/**
 * Aplica todas las migraciones de `db/migrations` contra una base limpia, usando
 * el cliente `pg` de Node en vez de `psql`.
 *
 * POR QUÉ EXISTE
 *
 * El entorno de trabajo no tiene `psql`, `docker` ni `wsl` utilizables, y la
 * documentación del proyecto asumía que por eso no se podía ejecutar SQL. No es
 * así: `psql` es un CLIENTE, no el motor. El servidor PostgreSQL 16 corre en la
 * máquina y acepta conexiones TCP, así que el módulo `pg` —que ya es dependencia
 * del proyecto— alcanza para aplicar migraciones y verificar comportamiento real.
 *
 * La diferencia importa: la validación estructural (balance de paréntesis,
 * comillas, orden de migraciones) no detecta un nombre de columna mal escrito ni
 * un tipo incompatible ni una extensión faltante. Correr contra un motor sí.
 *
 * USO
 *   node tests/_apply_migrations.mjs --db control_fiscal
 * Requiere el DSN de superusuario en CONTROL_ADMIN_DSN o el default de abajo.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const ADMIN_DSN =
  process.env.CONTROL_ADMIN_DSN ||
  'postgresql://postgres:P0stgres%21@127.0.0.1:5432/postgres';

const argv = process.argv.slice(2);
const dbIdx = argv.indexOf('--db');
const DB_NAME = dbIdx >= 0 ? argv[dbIdx + 1] : 'control_fiscal';

if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) {
  console.error(`Nombre de base inválido: ${DB_NAME}`);
  process.exit(2);
}

/** Reemplaza el nombre de base en el DSN. */
function dsnFor(name) {
  const u = new URL(ADMIN_DSN);
  u.pathname = '/' + name;
  return u.toString();
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1 · Los roles de la aplicación se crean ANTES de migrar.
  //
  //     POR QUÉ EL ORDEN IMPORTA, y por qué un `GRANT` al final es la solución
  //     equivocada: cada migración otorga sus privilegios con
  //     `GRANT ... TO control_app` al final de su propio archivo. Si el rol no
  //     existe todavía, ese `GRANT` falla con un warning que la migración no
  //     propaga — la migración "pasa" y la tabla queda sin privilegios.
  //
  //     La tentación es arreglarlo al final con un
  //     `GRANT ALL ON ALL TABLES IN SCHEMA x`. Es peor: otorga lo que una
  //     migración REVOCÓ a propósito. `0016` deja `treasury.movements` sin UPDATE
  //     deliberadamente (un movimiento no se edita, se compensa), y el GRANT
  //     global reabría esa defensa. La suite de tesorería lo detectó.
  //
  //     Crear los roles primero deja que cada migración aplique SUS privilegios,
  //     incluidas sus excepciones, sin que nadie las pise. Mismo criterio que CI:
  //     el job crea `app_login` antes de correr las suites.
  // ---------------------------------------------------------------------------
  const admin = new pg.Client({ connectionString: dsnFor('postgres') });
  await admin.connect();

  for (const rol of ['control_app', 'control_readonly', 'control_platform']) {
    await admin.query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN
          EXECUTE 'CREATE ROLE ${rol} NOLOGIN';
        END IF;
      END $do$;
    `);
  }
  await admin.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
        EXECUTE 'CREATE ROLE app_login LOGIN NOBYPASSRLS IN ROLE control_app';
      END IF;
    END $do$;
  `);
  // La contraseña va fuera del bloque: `CREATE ROLE ... PASSWORD` dentro de un `DO`
  // con `EXECUTE` corrompe el valor almacenado.
  await admin.query(`ALTER ROLE app_login PASSWORD 'AppL0gin!'`);

  // Base limpia. Se dropea y se recrea: una migración aplicada sobre una base
  // sucia pasa o falla por razones que no tienen que ver con la migración.
  // `WITH (FORCE)` corta las conexiones vivas, que si no bloquean el DROP.
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  console.log(`Base ${DB_NAME} recreada (roles asegurados).`);

  const db = new pg.Client({ connectionString: dsnFor(DB_NAME) });
  await db.connect();

  // ---------------------------------------------------------------------------
  // 2 · Migraciones, en orden. Cada archivo trae su propio BEGIN/COMMIT; si uno
  //     falla, el error tiene que decir CUÁL archivo y en qué línea.
  // ---------------------------------------------------------------------------
  const dir = 'db/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let applied = 0;
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    try {
      await db.query(sql);
      applied += 1;
      console.log(`  OK  ${file}`);
    } catch (e) {
      console.error(`\n  FALLA ${file}`);
      console.error(`  ${e.message}`);
      // `position` viene en caracteres; se traduce a línea para poder mirarla.
      if (e.position) {
        const upto = sql.slice(0, Number(e.position));
        console.error(`  línea ${upto.split('\n').length}`);
      }
      if (e.hint) console.error(`  hint: ${e.hint}`);
      await db.end();
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------------------
  // 3 · Seed del catálogo de sistema, que las suites necesitan.
  // ---------------------------------------------------------------------------
  const seed = 'db/seed/0001_system_catalog.sql';
  try {
    await db.query(readFileSync(seed, 'utf8'));
    console.log(`  OK  ${seed}`);
  } catch (e) {
    console.error(`\n  FALLA ${seed}\n  ${e.message}`);
    await db.end();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 4 · Nada de privilegios acá.
  //
  //     Los roles ya existían cuando corrieron las migraciones, así que cada una
  //     aplicó sus propios `GRANT` — y sus propios `REVOKE`, que es lo que importa.
  //     Un `GRANT ... ON ALL TABLES` en este punto reabriría las excepciones
  //     deliberadas (el caso de `treasury.movements`, sin UPDATE a propósito).
  //
  //     Si el rol no se creó antes y una migración falló en su `GRANT`, eso tiene
  //     que verse: es un problema de la migración o del orden, no algo que un
  //     helper deba tapar.
  // ---------------------------------------------------------------------------

  console.log(`\n${applied} migraciones aplicadas sobre ${DB_NAME}.`);
  console.log(
    `DSN app:       ${dsnFor(DB_NAME).replace(/:[^:@]*@/, ':***@').replace(/\/postgres$/, '/' + DB_NAME)}`
  );
  await db.end();
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  process.exit(1);
});
