#!/usr/bin/env node
/**
 * =============================================================================
 * Validador estructural del SQL embebido en las suites de `tests/`
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Descubre todas las suites `tests/<area>/run.mjs`, extrae cada template literal
 * y, para los que contienen SQL, verifica tres cosas que `node --check` no puede
 * ver porque para el parser de JavaScript son sólo texto:
 *
 *   1. Paréntesis balanceados.
 *   2. Cantidad PAR de comillas simples (un apóstrofo suelto rompe el bloque).
 *   3. Cada BEGIN tiene su COMMIT o su ROLLBACK.
 *
 * POR QUÉ DESCUBRE EN VEZ DE TENER UNA LISTA
 *
 * Antes miraba sólo `tests/isolation/run.mjs` — una ruta escrita a mano. Al
 * agregar la suite contable y la de compras, este validador siguió reportando
 * verde sobre un archivo, mientras cientos de bloques SQL nuevos quedaban sin
 * revisar. Es el mismo defecto que el proyecto ya prohíbe en la cobertura de RLS:
 * una lista manual se desactualiza en silencio y deja de proteger.
 *
 * POR QUÉ EXISTE
 *
 * No siempre hay PostgreSQL disponible (en el entorno de trabajo de Windows no
 * lo hay). Sin un motor, la única red de seguridad sobre el SQL es estructural.
 * Esto no reemplaza la ejecución real: no detecta un nombre de columna mal
 * escrito ni un tipo incompatible. Detecta el error de tipeo que rompería la
 * corrida entera antes de llegar a la primera aserción — que es justamente el
 * modo de falla que más caro sale cuando no se puede probar.
 *
 * USO
 *   node tools/check-suite-sql.mjs              # descubre todas las suites
 *   node tools/check-suite-sql.mjs <ruta>       # una sola (modo focalizado)
 * Salida: 0 si todo está balanceado, 1 si encontró un desbalance.
 * =============================================================================
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Descubre `tests/<area>/run.mjs`. Si se pasa una ruta, se usa esa sola. */
function discoverFiles() {
  const explicit = process.argv[2];
  if (explicit) return [explicit];

  const raiz = 'tests';
  if (!existsSync(raiz)) {
    console.error(`No existe el directorio ${raiz}.`);
    process.exit(2);
  }

  const encontrados = [];
  for (const entrada of readdirSync(raiz)) {
    const dir = join(raiz, entrada);
    if (!statSync(dir).isDirectory()) continue;
    const candidato = join(dir, 'run.mjs');
    if (existsSync(candidato)) encontrados.push(posix.join(...candidato.split(/[\\/]/)));
  }

  if (encontrados.length === 0) {
    console.error(
      '\nNo se descubrió ninguna suite (`tests/<area>/run.mjs`).\n' +
        'Si la convención de nombres cambió, este validador dejó de proteger en\n' +
        'silencio: hay que actualizarlo, no ignorarlo.'
    );
    process.exit(2);
  }

  return encontrados.sort();
}

/**
 * Revisa un archivo y devuelve { checked, problems }. Los problemas se imprimen
 * con el nombre del archivo adelante: con varias suites, un mensaje anónimo
 * obliga a buscar el bloque a mano.
 */
function checkFile(file, { verbose }) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`No se pudo leer ${file}: ${e.message}`);
    return { checked: 0, problems: 1 };
  }

  if (verbose) console.log(`\n── ${file}`);

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
      console.error(`  \u2717 ${file} · bloque en línea ${line}: ${bad.join('; ')}`);
    } else if (verbose) {
      console.log(
        `  \u2713 bloque en línea ${line}: paréntesis OK, ${quotes} comillas, ` +
          `${begins} BEGIN / ${commits + rollbacks} cierre`
      );
    }
  }

  return { checked, problems };
}

const verbose = process.argv.includes('--verbose');
const files = discoverFiles();

console.log('=== Validación estructural del SQL en las suites ===');
if (!verbose) {
  console.log(`Suites: ${files.length} (${files.join(', ')})`);
}

let totalChecked = 0;
let totalProblems = 0;

for (const file of files) {
  const { checked, problems } = checkFile(file, { verbose });
  totalChecked += checked;
  totalProblems += problems;
}

console.log(
  `\nBloques SQL revisados: ${totalChecked} · con problemas: ${totalProblems}`
);

// Cero bloques en TODAS las suites significa que el descubrimiento o el formato
// de los template literals cambió. Es un fallo, no un éxito vacío.
if (totalChecked === 0) {
  console.error(
    '\nNo se encontró ningún bloque SQL en ninguna suite. ' +
      '¿Cambió el formato de los archivos?'
  );
  process.exit(1);
}

process.exit(totalProblems > 0 ? 1 : 0);
