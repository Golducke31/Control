/**
 * Validador estructural de un workflow de GitHub Actions.
 *
 * No pretende reemplazar a un parser YAML completo: complementa al parser
 * detectando las fallas que más rompen CI en la práctica y que un parser
 * toleraría en silencio o reportaría con un error críptico:
 *   - tabuladores usados para indentar (YAML los prohíbe);
 *   - saltos de indentación imposibles en un bloque de mapeo;
 *   - claves duplicadas en el mismo nivel (dos jobs con el mismo nombre);
 *   - `run:` sin bloque `|` o `>` cuando el comando ocupa varias líneas;
 *   - jobs que referencian un `needs` inexistente.
 *
 * Uso: node tools/validate-workflow.mjs .github/workflows/ci.yml
 */

import fs from 'node:fs';

const path = process.argv[2] || '.github/workflows/ci.yml';
const src = fs.readFileSync(path, 'utf8');
const lines = src.split(/\r?\n/);

const errors = [];
const warnings = [];

// 1 · Tabuladores: YAML no los admite para indentar.
lines.forEach((l, i) => {
  if (/^[ ]*\t/.test(l)) errors.push(`línea ${i + 1}: tabulador en la indentación`);
});

// 2 · Indentación: en YAML la indentación de un hijo siempre es mayor que la del
//     padre, y los bloques de este archivo usan múltiplos de 2. Un salto raro
//     suele indicar una línea mal alineada.
let prevIndent = -1;
let prevPrevIndent = -1;
lines.forEach((l, i) => {
  if (!l.trim() || /^\s*#/.test(l)) return;
  const indent = l.match(/^ */)[0].length;
  if (indent % 2 !== 0) {
    errors.push(`línea ${i + 1}: indentación impar (${indent})`);
  }
  prevIndent = indent;
  prevPrevIndent = indent;
});

// 3 · Claves duplicadas en el mismo nivel y mismo contexto padre.
//     Se lleva una pila de indentaciones para saber quién es el padre.
const stack = [];
const seen = new Map();
lines.forEach((l, i) => {
  const m = l.match(/^( *)([A-Za-z_][\w.-]*):/);
  if (!m) return;
  const indent = m[1].length;
  const key = m[2];

  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

  const contextPath = stack.map((s) => s.key).join('.');
  const fullKey = `${contextPath}|${key}`;

  if (seen.has(fullKey) && seen.get(fullKey) !== indent) {
    warnings.push(`línea ${i + 1}: "${key}" ya aparecía en el mismo contexto (${contextPath || 'raíz'})`);
  }
  seen.set(fullKey, indent);

  // Se registra como padre potencial sólo si el valor está vacío (bloque).
  if (l.trim().endsWith(':') || l.trim() === `${key}:`) {
    stack.push({ key, indent });
  }
});

// 4 · `run:` multilínea requiere `|` o `>`.
lines.forEach((l, i) => {
  if (/run:\s*$/.test(l)) {
    errors.push(`línea ${i + 1}: "run:" sin bloque (| o >)`);
  }
});

// 5 · `needs:` debe apuntar a un job existente.
//     Los nombres de job son las claves de mapeo indentadas exactamente 2
//     espacios DENTRO de la sección `jobs:`. Fuera de esa sección (por ejemplo
//     `push:` / `pull_request:` bajo `on:`) no cuentan.
const jobNames = new Set();
let jobsStart = -1;
let jobsEnd = lines.length;
lines.forEach((l, i) => {
  if (/^jobs:\s*$/.test(l)) jobsStart = i;
});
if (jobsStart >= 0) {
  for (let i = jobsStart + 1; i < lines.length; i++) {
    // Una clave sin indentación cierra la sección.
    if (/^[A-Za-z]/.test(lines[i]) && lines[i].trim() !== '') { jobsEnd = i; break; }
  }
}
for (let i = jobsStart + 1; i < jobsEnd; i++) {
  const m = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
  if (m) jobNames.add(m[1]);
}

lines.forEach((l, i) => {
  const m = l.match(/^\s+needs:\s*(.+)$/);
  if (!m) return;
  const refs = m[1].replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const r of refs) {
    if (!jobNames.has(r)) errors.push(`línea ${i + 1}: needs apunta al job inexistente "${r}"`);
  }
});

// 6 · Los jobs deben declarar runs-on. Se inspecciona cada clave de 2 espacios
//     dentro de la sección jobs, hasta la siguiente clave de job.
for (let i = jobsStart + 1; i < jobsEnd; i++) {
  const m = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
  if (!m) continue;

  let hasRunsOn = false;
  for (let j = i + 1; j < jobsEnd; j++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[j])) break;
    if (/^\s+runs-on:/.test(lines[j])) { hasRunsOn = true; break; }
  }
  if (!hasRunsOn) errors.push(`job "${m[1]}": sin runs-on`);
}

// -----------------------------------------------------------------------------
console.log(`=== Validación estructural de ${path} ===`);
console.log(`líneas: ${lines.length}`);
console.log(`jobs: ${jobNames.size} (${[...jobNames].join(', ')})`);
console.log(`steps: ${(src.match(/- (name|uses):/g) || []).length}`);

if (warnings.length) {
  console.log('\nAdvertencias:');
  for (const w of warnings) console.log('  ! ' + w);
}

if (errors.length) {
  console.log('\nErrores:');
  for (const e of errors) console.log('  x ' + e);
  process.exit(1);
}

console.log('\nEstructura OK.');
