#!/usr/bin/env node
/**
 * =============================================================================
 * Validador de tablas particionadas
 * -----------------------------------------------------------------------------
 * QUÉ DETECTA
 *
 * Toda tabla `PARTITION BY RANGE (...)` que declare `PRIMARY KEY` o `UNIQUE` sin
 * incluir la clave de particionamiento.
 *
 * PostgreSQL no lo permite: el índice único se construye por partición, así que
 * sin la clave de partición no puede garantizar unicidad global. El error es
 * «las restricciones unique en tablas particionadas deben incluir todas las
 * columnas de particionamiento».
 *
 * POR QUÉ EXISTE
 *
 * `logistics.position_pings` (0005) usa correctamente `PRIMARY KEY (id,
 * recorded_at)`. `audit.events` (0007) declaraba `id bigserial PRIMARY KEY` a
 * secas. La misma regla, aplicada en un archivo y omitida en otro, once
 * migraciones después. Sin ejecutar, es indetectable: el SQL se lee perfecto.
 *
 * POR QUÉ NO USA UN REGEX DE UNA SOLA PIEZA
 *
 * La primera versión buscaba `CREATE TABLE ... \(([\s\S]*?)\n\)\s*PARTITION BY`
 * con captura no-greedy. Ese `[\s\S]*?` no respeta paréntesis: si una tabla
 * intermedia tenía su propio `PARTITION BY`, o si el `\n)` del cierre aparecía
 * dentro de un CHECK, la captura cruzaba el límite de la tabla y le atribuía
 * las restricciones de OTRA tabla. El resultado eran violaciones inventadas
 * («PRIMARY KEY (inline) (create)»: el regex leía la palabra CREATE como si
 * fuera una columna).
 *
 * La versión actual hace lo correcto: recorre el archivo carácter a carácter
 * contando paréntesis, de modo que delimita CADA cuerpo de tabla con exactitud.
 * Es más código y no depende de cómo esté formateado el SQL.
 *
 * USO
 *   node tools/check-partitioned-tables.mjs [directorio]
 * Salida: 0 si todas cumplen, 1 si alguna viola la regla.
 * =============================================================================
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'db/migrations';
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/**
 * Quita comentarios `--` de línea y bloques `/* *\/`, preservando la longitud
 * relativa por saltos de línea (no hace falta preservar columnas acá, pero sí
 * que un `--` dentro de un literal no se confunda con un comentario).
 * También neutraliza los literales de texto entre comillas simples.
 */
function sanitize(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Comentario de línea
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Comentario de bloque
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Literal de texto entre comillas simples (con '' como escape)
    if (c === "'") {
      out += ' ';
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i++;
          break;
        }
        // Preservar el salto de línea para no desalinear el conteo de líneas
        if (src[i] === '\n') out += '\n';
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Devuelve el índice del `)` que cierra el `(` en `openIdx`. */
function matchParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

let problems = 0;
let partitioned = 0;

for (const file of files) {
  const raw = readFileSync(join(dir, file), 'utf8');
  const src = sanitize(raw);

  const head = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(/gi;

  for (const m of src.matchAll(head)) {
    const fq = m[1];
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx === -1) continue;

    const body = src.slice(openIdx + 1, closeIdx);

    // Sólo interesan las particionadas.
    const tail = src.slice(closeIdx + 1, closeIdx + 200);
    const pm = tail.match(/^\s*PARTITION\s+BY\s+RANGE\s*\(\s*"?([\w]+)"?\s*\)/i);
    if (!pm) continue;

    partitioned += 1;
    const partitionKey = pm[1].toLowerCase();

    // ---- Restricciones declaradas como cláusula de tabla ----------------
    // Se recorren los niveles de profundidad 0 del cuerpo para no capturar
    // PRIMARY KEY / UNIQUE anidadas dentro de un CHECK o de una expresión.
    const keys = [];
    let depth = 0;
    let stmtStart = 0;
    const clauses = [];
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if ((ch === ',' && depth === 0) || i === body.length) {
        clauses.push(body.slice(stmtStart, i));
        stmtStart = i + 1;
      }
    }

    for (const clauseRaw of clauses) {
      const clause = clauseRaw.trim();
      if (!clause) continue;

      const pk = clause.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i);
      if (pk) {
        keys.push({ kind: 'PRIMARY KEY', cols: pk[1] });
        continue;
      }
      const uq = clause.match(/^UNIQUE\s*\(([^)]*)\)/i);
      if (uq) {
        keys.push({ kind: 'UNIQUE', cols: uq[1] });
        continue;
      }
      // PRIMARY KEY inline al final de la definición de una columna.
      const inline = clause.match(/^"?(\w+)"?\s+[\s\S]*?\bPRIMARY\s+KEY\b/i);
      if (inline) {
        keys.push({ kind: 'PRIMARY KEY (inline)', cols: inline[1] });
      }
    }

    if (keys.length === 0) {
      console.log(
        `  · ${fq}: particionada por ${partitionKey}, sin PK/UNIQUE (no aplica la regla)`
      );
      continue;
    }

    for (const k of keys) {
      const cols = k.cols
        .split(',')
        .map((c) => c.trim().toLowerCase().replace(/"/g, ''))
        .filter(Boolean);

      if (!cols.includes(partitionKey)) {
        problems += 1;
        console.error(
          `  ${file} · ${fq}: ${k.kind} (${cols.join(', ')}) NO incluye la clave de ` +
            `particionamiento «${partitionKey}»`
        );
      } else {
        console.log(
          `  OK  ${fq}: ${k.kind} (${cols.join(', ')}) incluye «${partitionKey}»`
        );
      }
    }
  }
}

if (problems > 0) {
  console.error(
    `\nViolaciones: ${problems}\n` +
      'Agregá la clave de particionamiento a la PRIMARY KEY / UNIQUE.'
  );
  process.exit(1);
}

console.log(
  `\nTablas particionadas revisadas: ${partitioned}. Todas cumplen la regla.`
);
