#!/usr/bin/env node
/**
 * =============================================================================
 * Validador de orden de creación de tablas en las migraciones
 * -----------------------------------------------------------------------------
 * QUÉ DETECTA
 *
 * Referencias hacia adelante dentro de un mismo archivo: una clave foránea que
 * apunta a una tabla que ese mismo archivo crea DESPUÉS. PostgreSQL exige que la
 * tabla referenciada ya exista cuando se crea la FK — no admite forward
 * references.
 *
 * POR QUÉ EXISTE
 *
 * Este defecto real estuvo en `0002` desde el inicio y no lo detectó ninguna
 * revisión: `app.memberships` declaraba `REFERENCES app.roles(id)` 28 líneas
 * antes de que `app.roles` se creara. El archivo se lee perfecto; el error sólo
 * aparece al ejecutarlo. Sin un motor real, es invisible.
 *
 * Mira únicamente dentro de cada archivo. Una FK a una tabla creada en una
 * migración anterior es correcta y no se reporta.
 *
 * USO
 *   node tools/check-migration-order.mjs
 * Salida: 0 si no hay referencias hacia adelante, 1 si encuentra alguna.
 * =============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'db/migrations';

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
} catch (e) {
  console.error(`No se pudo leer ${dir}: ${e.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`No hay archivos .sql en ${dir}`);
  process.exit(2);
}

let totalProblems = 0;

for (const file of files) {
  const src = readFileSync(join(dir, file), 'utf8');
  const lines = src.split('\n');

  // Tablas creadas en este archivo: nombre -> línea de la sentencia.
  const created = new Map();
  // Claves foráneas declaradas en este archivo.
  const fks = [];

  lines.forEach((line, idx) => {
    const create = line.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w."]+)/i);
    if (create) {
      created.set(create[1].replace(/"/g, '').toLowerCase(), idx + 1);
    }
    for (const m of line.matchAll(/REFERENCES\s+([\w."]+)\s*\(/gi)) {
      fks.push({ ref: m[1].replace(/"/g, '').toLowerCase(), line: idx + 1 });
    }
  });

  // Sólo interesa cuando AMBAS están en este archivo y la FK viene primero.
  const bad = fks.filter((fk) => {
    const at = created.get(fk.ref);
    return at !== undefined && at > fk.line;
  });

  if (bad.length > 0) {
    totalProblems += bad.length;
    console.error(`\n  ${file}`);
    for (const b of bad) {
      console.error(
        `    L${b.line}: REFERENCES ${b.ref} — pero esa tabla se crea en L${created.get(b.ref)}`
      );
    }
  } else {
    console.log(`  OK  ${file}`);
  }
}

if (totalProblems > 0) {
  console.error(
    `\nReferencias hacia adelante detectadas: ${totalProblems}\n` +
      `Reordená los bloques CREATE TABLE para que la tabla referenciada se cree primero.`
  );
  process.exit(1);
}

console.log('\nSin referencias hacia adelante dentro de un mismo archivo.');
