#!/usr/bin/env node
/**
 * =============================================================================
 * Validador estructural del SQL embebido en las suites de `tests/`
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Descubre todas las suites `tests/<area>/run.mjs`, extrae cada template literal
 * y, para los que contienen SQL, verifica cuatro cosas que `node --check` no
 * puede ver porque para el parser de JavaScript son sólo texto:
 *
 *   1. Paréntesis balanceados.
 *   2. Cantidad PAR de comillas simples (un apóstrofo suelto rompe el bloque).
 *   3. Cada BEGIN tiene su COMMIT o su ROLLBACK.
 *   4. Ningún comentario SQL `--` contiene un backtick.
 *
 * POR QUÉ LA CUARTA
 *
 * Un backtick dentro de un comentario `--` que a su vez vive dentro de un
 * template literal CIERRA el template. El SQL que sigue queda fuera de la
 * cadena y, según lo que venga, el archivo puede seguir siendo JavaScript
 * válido — sólo que ejecutando otra cosa. Ya pasó CUATRO veces durante la fase
 * E4, y en tres de esos casos `node --check` pasó sin chistar: el daño era
 * silencioso. La línea que lo delata es cómoda de escribir y letal de leer, así
 * que la red tiene que ser mecánica.
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
 * Detecta backticks dentro de comentarios SQL `--` que viven dentro de un
 * template literal.
 *
 * POR QUÉ NO SE HACE CON EL TEMPLATE YA EXTRAÍDO
 *
 * El propio extractor (`/`([^`]*)`/gs`) es la víctima del defecto: si un
 * backtick cierra el template antes de tiempo, `body` ya viene truncado y el
 * comentario dañino queda afuera. Para encontrar el problema hay que mirar el
 * archivo crudo, no el resultado de una extracción que el problema ya corrompió.
 *
 * CÓMO LO ENCUENTRA SIN PARSEAR
 *
 * Se recorre el archivo crudo línea por línea llevando la cuenta de en qué
 * template estamos (los backticks de apertura/cierre alternan, y ninguno se
 * escapa en este código). Dentro de un template, una línea se considera un
 * comentario SQL si su primer carácter no blanco es `--`. Si además contiene un
 * backtick, esa línea es la que cierra el template: se reporta con su número.
 *
 * Sólo se revisan las líneas que ABREN el comentario. Un backtick comentado a
 * mitad de una línea (después de SQL real) sigue siendo peligroso, pero no
 * aparece nunca en este proyecto y perseguirlo exigiría parsear SQL de verdad.
 */
function checkBackticksInSqlComments(file, src) {
  const problemas = [];
  let dentroDeTemplate = false;

  const lineas = src.split('\n');
  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];
    const backticks = (linea.match(/`/g) || []).length;

    // Sólo importa si estamos dentro de un template en el momento de abrir la
    // línea. Una línea con un número impar de backticks invierte el estado.
    const abriaDentro = dentroDeTemplate;

    if (abriaDentro && /^\s*--/.test(linea) && backticks > 0) {
      problemas.push(i + 1);
    }

    if (backticks % 2 === 1) dentroDeTemplate = !dentroDeTemplate;
  }

  if (problemas.length > 0) {
    for (const linea of problemas) {
      console.error(
        `  \u2717 ${file} · línea ${linea}: comentario SQL con backtick dentro de un template ` +
          `(el backtick cierra la cadena y el SQL queda fuera)`
      );
    }
  }
  return problemas.length;
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

  // Va primero y sobre el archivo crudo: si hay un backtick suelto, la
  // extracción de templates de abajo ya está corrupta y sus resultados no valen.
  let problems = checkBackticksInSqlComments(file, src);

  const re = /`([^`]*)`/gs;
  let m;
  let checked = 0;

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
