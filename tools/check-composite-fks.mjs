#!/usr/bin/env node
/**
 * =============================================================================
 * Validador de claves foráneas compuestas
 * -----------------------------------------------------------------------------
 * QUÉ DETECTA
 *
 * Dos defectos del mismo tipo, ambos invisibles leyendo un archivo por separado:
 *
 *   1. Una FK compuesta `(tenant_id, x) REFERENCES t(tenant_id, id)` donde `t`
 *      NO declara `UNIQUE (tenant_id, id)`. PostgreSQL exige que las columnas
 *      referidas tengan una restricción única que las cubra exactamente.
 *
 *   2. Una tabla con `tenant_id` referenciada por una FK SIMPLE `REFERENCES
 *      t(id)`. Es peor que el anterior: no falla, funciona, y permite que una
 *      fila de la empresa A apunte a un recurso de la empresa B. Rompe el
 *      aislamiento sin ningún síntoma.
 *
 * POR QUÉ EXISTE
 *
 * El defecto 1 estaba en `logistics.vehicles`: era la única de 13 tablas
 * referenciadas por FK compuesta que no declaraba la restricción única. Se
 * descubrió al ejecutar `0005` contra un motor real, tras dos migraciones
 * anteriores que también fallaban. Sin base, es indetectable.
 *
 * El defecto 2 no se puede detectar ejecutando: hay que buscarlo a propósito.
 *
 * USO
 *   node tools/check-composite-fks.mjs
 * Salida: 0 si todo está bien, 1 si encuentra alguno de los dos defectos.
 * =============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'db/migrations';

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/** Acumula el texto de todas las migraciones, en orden. */
const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n\n');

// -----------------------------------------------------------------------------
// 1 · Recolectar tablas, su tenant_id y sus restricciones únicas
// -----------------------------------------------------------------------------
// Cada CREATE TABLE ... ( ... ); se analiza por separado.
const tables = new Map(); // fq -> { hasTenantId, uniques: [[cols]], file }

const createRe = /CREATE\s+TABLE\s+([\w.]+)\s*\(([\s\S]*?)\n\)\s*;/gi;
for (const m of all.matchAll(createRe)) {
  const fq = m[1].toLowerCase();
  const body = m[2];

  const hasTenantId = /^\s*tenant_id\s+/im.test(body);

  // UNIQUE (a, b) y CONSTRAINT x UNIQUE (a, b)
  const uniques = [];
  for (const u of body.matchAll(/UNIQUE\s*\(([^)]*)\)/gi)) {
    uniques.push(
      u[1]
        .split(',')
        .map((c) => c.trim().toLowerCase().replace(/"/g, ''))
        .filter(Boolean)
    );
  }
  // PRIMARY KEY (a, b)
  for (const p of body.matchAll(/PRIMARY\s+KEY\s*\(([^)]*)\)/gi)) {
    uniques.push(
      p[1]
        .split(',')
        .map((c) => c.trim().toLowerCase().replace(/"/g, ''))
        .filter(Boolean)
    );
  }

  tables.set(fq, { hasTenantId, uniques });
}

const covers = (fq, cols) => {
  const t = tables.get(fq);
  if (!t) return true; // Tabla externa a las migraciones: no opinamos.
  const want = cols.map((c) => c.toLowerCase()).sort().join(',');
  return t.uniques.some((u) => [...u].sort().join(',') === want);
};

// -----------------------------------------------------------------------------
// 2 · Defecto 1: FK compuesta sin UNIQUE (tenant_id, id) en el destino
// -----------------------------------------------------------------------------
let problems = 0;

const compositeRe =
  /REFERENCES\s+([\w.]+)\s*\(\s*tenant_id\s*,\s*id\s*\)/gi;

for (const m of all.matchAll(compositeRe)) {
  const target = m[1].toLowerCase();
  if (!covers(target, ['tenant_id', 'id'])) {
    problems += 1;
    console.error(
      `  FALTA UNIQUE: ${target} es referida por (tenant_id, id) pero no declara UNIQUE (tenant_id, id)`
    );
  }
}

// -----------------------------------------------------------------------------
// 3 · Defecto 2: FK simple a una tabla que tiene tenant_id
//
// Una FK simple a una tabla con tenant_id permite cruzar empresas. Se excluyen
// app.tenants y app.users: la primera es el inquilino mismo, la segunda es
// identidad global sin tenant_id.
// -----------------------------------------------------------------------------
const GLOBAL_TABLES = new Set(['app.tenants', 'app.users', 'app.permissions', 'app.roles']);

const simpleRe = /REFERENCES\s+([\w.]+)\s*\(\s*id\s*\)/gi;

for (const m of all.matchAll(simpleRe)) {
  const target = m[1].toLowerCase();
  if (GLOBAL_TABLES.has(target)) continue;

  const t = tables.get(target);
  if (t && t.hasTenantId) {
    problems += 1;
    console.error(
      `  FK SIMPLE a tabla con tenant_id: ${target}(id) — debe ser (tenant_id, id) REFERENCES ${target}(tenant_id, id)`
    );
  }
}

// -----------------------------------------------------------------------------
// 4 · Tablas con tenant_id que nunca declaran UNIQUE (tenant_id, id)
//
// No es obligatorio para todas (sólo para las referenciadas), pero avisa de
// cuáles NO podrían ser referidas de forma compuesta si alguien lo intentara.
// -----------------------------------------------------------------------------
const notReferenceable = [...tables.entries()]
  .filter(([, t]) => t.hasTenantId && !covers(null, []) && !t.uniques.some(
    (u) => [...u].sort().join(',') === 'id,tenant_id'
  ))
  .map(([fq]) => fq);

if (problems > 0) {
  console.error(`\nDefectos de claves foráneas: ${problems}`);
  process.exit(1);
}

console.log(`Tablas analizadas: ${tables.size}`);
console.log(`Referencias compuestas (tenant_id, id): ${[...all.matchAll(compositeRe)].length}`);
console.log('Sin defectos de claves foráneas.');

if (notReferenceable.length > 0) {
  console.log(
    `\nNota: ${notReferenceable.length} tabla(s) con tenant_id sin UNIQUE (tenant_id, id).\n` +
      'No es un error, pero no podrían ser referidas con FK compuesta:\n  ' +
      notReferenceable.join('\n  ')
  );
}
