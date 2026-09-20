#!/usr/bin/env node
/**
 * =============================================================================
 * Validador de cobertura de permisos
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Cruza, en los DOS sentidos, los permisos que declara el mapa de rutas del
 * frontend (`apps/web/src/rutas.ts`) contra el catálogo SQL de la base
 * (`INSERT INTO app.permissions` en `db/`).
 *
 *   1. Todo permiso declarado en `rutas.ts` existe en el SQL.
 *   2. Todo permiso del SQL está declarado en `rutas.ts` — el espejo no puede
 *      quedar viejo en silencio.
 *   3. Todo permiso que referencia una ventana del mapa está en el catálogo.
 *      Es la puerta de F6: «toda ventana del mapa tiene su permiso».
 *   4. Cada fila del SQL respeta `resource.action`.
 *   5. No hay códigos repetidos ni en el SQL ni en el frontend.
 *
 * POR QUÉ EXISTE
 *
 * Cuatro de las catorce ventanas no tenían permiso que las cubriera: compras,
 * tesorería, contabilidad y fiscal se veían en el menú para cualquiera y se
 * abrían por URL, porque la comprobación de permiso nunca podía pasar a
 * verdadero. El mapa de rutas lo declaraba y la base no lo tenía, y nada lo
 * cruzaba: los tests del frontend miraban sólo el frontend y las migraciones sólo
 * la base.
 *
 * POR QUÉ NO ALCANZA CON LA ASERCIÓN SQL
 *
 * `app.assert_permissions_covered()` corre dentro de PostgreSQL, después del seed.
 * Este validador corre en `npm run verify`, sin base de datos, y cubre el otro
 * borde: que el mapa de rutas —que vive en TypeScript— y el catálogo no se separen.
 * Los dos son necesarios y ninguno reemplaza al otro.
 *
 * POR QUÉ FALLA RUIDOSAMENTE SI NO ENCUENTRA LOS ARREGLOS
 *
 * Es la lección de `check-suite-sql.mjs`: un validador que mira una ruta escrita a
 * mano siguió reportando verde mientras cientos de bloques quedaban sin revisar.
 * Si este script no encuentra `PERMISOS_SEMBRADOS` o no encuentra el `INSERT`, NO
 * puede concluir «todo bien»: tiene que salir en rojo. Un gate que no puede fallar
 * no protege.
 *
 * USO
 *   node tools/check-permissions.mjs
 * Salida: 0 si el mapa y el catálogo coinciden, 1 si divergen, 2 si no pudo leer
 *         lo que tenía que leer.
 * =============================================================================
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RUTAS = 'apps/web/src/rutas.ts';
const DIR_DB = 'db';

/** Los 16 recursos que el mapa de rutas necesita que la base cubra. */
const RECURSOS_ESPERADOS = [
  'accounting',
  'audit',
  'billing',
  'catalog',
  'customers',
  'fiscal',
  'inventory',
  'logistics',
  'ops',
  'payments',
  'purchasing',
  'reports',
  'sales',
  'team',
  'tenant',
  'treasury',
];

const problemas = [];
const fallar = (mensaje) => problemas.push(mensaje);

// -----------------------------------------------------------------------------
// 1 · Los permisos declarados en el frontend
// -----------------------------------------------------------------------------
let fuenteRutas;
try {
  fuenteRutas = readFileSync(RUTAS, 'utf8');
} catch (e) {
  console.error(`No se pudo leer ${RUTAS}: ${e.message}`);
  process.exit(2);
}

/**
 * Extrae un arreglo de strings declarado como `export const NOMBRE = [...] as const`.
 * Devuelve `null` si no lo encuentra, para que quien llama pueda distinguir
 * «arreglo vacío» de «no lo encontré».
 */
function extraerArreglo(fuente, nombre) {
  const re = new RegExp(`export const ${nombre}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`);
  const coincidencia = fuente.match(re);
  if (coincidencia === null) return null;
  const cuerpo = coincidencia[1] ?? '';
  return [...cuerpo.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const sembrados = extraerArreglo(fuenteRutas, 'PERMISOS_SEMBRADOS');
const pendientes = extraerArreglo(fuenteRutas, 'PERMISOS_PENDIENTES');

if (sembrados === null) {
  console.error(`No se encontró PERMISOS_SEMBRADOS en ${RUTAS}. No se puede validar nada.`);
  process.exit(2);
}
if (pendientes === null) {
  console.error(`No se encontró PERMISOS_PENDIENTES en ${RUTAS}. No se puede validar nada.`);
  process.exit(2);
}

const declarados = [...sembrados, ...pendientes];

// Permisos que el mapa referencia en cada ventana.
const referenciados = [...fuenteRutas.matchAll(/permiso:\s*'([^']+)'/g)].map((m) => m[1]);

// -----------------------------------------------------------------------------
// 2 · El catálogo SQL
// -----------------------------------------------------------------------------
function archivosSql(dir) {
  const salida = [];
  let entradas;
  try {
    entradas = readdirSync(dir);
  } catch {
    return salida;
  }
  for (const entrada of entradas) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivosSql(ruta));
    else if (entrada.endsWith('.sql')) salida.push(ruta);
  }
  return salida;
}

const filas = [];
for (const archivo of archivosSql(DIR_DB)) {
  const sql = readFileSync(archivo, 'utf8');
  const bloques = sql.match(/INSERT INTO app\.permissions[\s\S]*?;/g) ?? [];
  for (const bloque of bloques) {
    // Cada fila del VALUES: ('code', 'resource', 'action', 'descripción')
    for (const m of bloque.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      filas.push({ archivo, code: m[1], resource: m[2], action: m[3] });
    }
  }
}

if (filas.length === 0) {
  console.error(
    `No se encontró ningún «INSERT INTO app.permissions» bajo ${DIR_DB}. ` +
      'El catálogo no está donde este validador lo busca: revisar antes de dar por buena la cobertura.',
  );
  process.exit(2);
}

const enSql = new Map();
for (const fila of filas) {
  if (enSql.has(fila.code)) {
    fallar(`permiso repetido en el SQL: ${fila.code} (${enSql.get(fila.code).archivo} y ${fila.archivo})`);
  }
  enSql.set(fila.code, fila);
}

// -----------------------------------------------------------------------------
// 3 · Los cruces
// -----------------------------------------------------------------------------
const faltanEnSql = declarados.filter((p) => !enSql.has(p));
if (faltanEnSql.length > 0) {
  fallar(
    `declarados en ${RUTAS} y ausentes del catálogo SQL: ${faltanEnSql.join(', ')}. ` +
      'Si el permiso es nuevo, sembrarlo en db/seed/0001_system_catalog.sql.',
  );
}

const declaradosSet = new Set(declarados);
const sobranEnSql = [...enSql.keys()].filter((p) => !declaradosSet.has(p));
if (sobranEnSql.length > 0) {
  fallar(
    `en el catálogo SQL y ausentes de ${RUTAS}: ${sobranEnSql.join(', ')}. ` +
      'El espejo del frontend quedó viejo: mover los códigos a PERMISOS_SEMBRADOS.',
  );
}

const repetidosFrontend = declarados.filter((p, i) => declarados.indexOf(p) !== i);
if (repetidosFrontend.length > 0) {
  fallar(`permisos declarados dos veces en el frontend: ${[...new Set(repetidosFrontend)].join(', ')}`);
}

const enAmbasListas = pendientes.filter((p) => sembrados.includes(p));
if (enAmbasListas.length > 0) {
  fallar(`permisos en PERMISOS_SEMBRADOS y en PERMISOS_PENDIENTES a la vez: ${enAmbasListas.join(', ')}`);
}

// 4 · Cada permiso que referencia una ventana existe en el catálogo.
const referenciadosSinCatalogo = [...new Set(referenciados)].filter((p) => !enSql.has(p));
if (referenciadosSinCatalogo.length > 0) {
  fallar(
    `ventanas que exigen un permiso inexistente: ${referenciadosSinCatalogo.join(', ')}. ` +
      'Una ventana sin permiso se ve en el menú para cualquiera y se abre por URL.',
  );
}

// 5 · resource.action.
for (const fila of filas) {
  const [resource, action] = fila.code.split('.');
  if (resource !== fila.resource || action !== fila.action) {
    fallar(
      `${fila.archivo}: ${fila.code} declara resource='${fila.resource}' y action='${fila.action}', ` +
        `pero el código dice '${resource}.${action}'.`,
    );
  }
}

// 6 · Los 16 recursos del mapa están cubiertos.
const recursosEnSql = new Set([...enSql.values()].map((f) => f.resource));
const recursosFaltantes = RECURSOS_ESPERADOS.filter((r) => !recursosEnSql.has(r));
if (recursosFaltantes.length > 0) {
  fallar(`recursos sin ningún permiso en el catálogo: ${recursosFaltantes.join(', ')}`);
}

// -----------------------------------------------------------------------------
// Resultado
// -----------------------------------------------------------------------------
if (problemas.length > 0) {
  console.error('Cobertura de permisos: FALLA\n');
  for (const problema of problemas) console.error(`  · ${problema}`);
  console.error(`\n  ${problemas.length} problema(s).`);
  process.exit(1);
}

console.log(
  `  OK    permisos: ${filas.length} en el catálogo SQL, ${sembrados.length} sembrados y ` +
    `${pendientes.length} pendientes en el mapa, ${RECURSOS_ESPERADOS.length} recursos cubiertos.`,
);
