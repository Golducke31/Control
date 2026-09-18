#!/usr/bin/env node
/**
 * =============================================================================
 * Validador estructural del SQL embebido en tests/isolation/run.mjs
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Extrae cada template literal del archivo y, para los que contienen SQL,
 * verifica tres cosas que `node --check` no puede ver porque para el parser de
 * JavaScript son sólo texto:
 *
 *   1. Paréntesis balanceados.
 *   2. Cantidad PAR de comillas simples (un apóstrofo suelto rompe el bloque).
 *   3. Cada BEGIN tiene su COMMIT o su ROLLBACK.
 *
 * POR QUÉ EXISTE
 *
 * No hay PostgreSQL en este entorno, así que la suite no se puede ejecutar. Sin
 * un motor, la única red de seguridad sobre el SQL es estructural. Esto no
 * reemplaza la ejecución real: no detecta un nombre de columna mal escrito ni un
 * tipo incompatible. Detecta el error de tipeo que rompería la corrida entera
 * antes de llegar a la primera aserción — que es justamente el modo de falla que
 * más caro sale cuando no se puede probar.
 *
 * USO
 *   node tools/check-suite-sql.mjs [ruta-al-archivo]
 * Salida: 0 si todo está balanceado, 1 si encontró un desbalance.
 * =============================================================================
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'tests/isolation/run.mjs';

let src;
try {
  src = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`No se pudo leer ${file}: ${e.message}`);
  process.exit(2);
}

const re = /`([^`]*)`/gs;
let m;
let checked = 0;
let problems = 0;

while ((m = re.exec(src))) {
  const body = m[1];
  if (!/\b(BEGIN|SELECT|INSERT|DELETE|UPDATE|WITH)\b/i.test(body)) continue;

  checked += 1;
  const line = src.slice(0, m.index).split('\n').length;

  const openParens = (body.match(/\(/g) || []).length;
  const closeParens = (body.match(/\)/g) || []).length;
  const parens = openParens - closeParens;

  // Se cuentan las comillas simples. Los pares son delimitadores; un número
  // impar significa que una quedó sin cerrar y el bloque entero se corre.
  const quotes = (body.match(/'/g) || []).length;

  const begins = (body.match(/^\s*BEGIN;/gim) || []).length;
  const commits = (body.match(/^\s*COMMIT;/gim) || []).length;
  const rollbacks = (body.match(/^\s*ROLLBACK;/gim) || []).length;

  const bad = [];
  if (parens !== 0) bad.push(`paréntesis desbalanceados (${parens > 0 ? '+' : ''}${parens})`);
  if (quotes % 2 !== 0) bad.push(`comillas simples impares (${quotes})`);
  if (begins !== commits + rollbacks) {
    bad.push(`BEGIN=${begins} pero COMMIT+ROLLBACK=${commits + rollbacks}`);
  }

  if (bad.length > 0) {
    problems += 1;
    console.error(`  \u2717 bloque en línea ${line}: ${bad.join('; ')}`);
  } else {
    console.log(
      `  \u2713 bloque en línea ${line}: paréntesis OK, ${quotes} comillas, ` +
        `${begins} BEGIN / ${commits + rollbacks} cierre`
    );
  }
}

console.log(
  `\nBloques SQL revisados: ${checked} · con problemas: ${problems}`
);

if (checked === 0) {
  console.error('\nNo se encontró ningún bloque SQL. ¿Cambió el formato del archivo?');
  process.exit(1);
}

process.exit(problems > 0 ? 1 : 0);
