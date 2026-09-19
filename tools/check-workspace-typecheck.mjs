/**
 * Aserción de cobertura de typecheck.
 *
 * Comprueba que **todo workspace del monorepo declare cómo se chequea**. Un workspace
 * sin script `typecheck` es código que nadie verifica: se puede escribir cualquier cosa
 * y ningún job del CI va a mirarlo.
 *
 * POR QUÉ EXISTE, HABIENDO UN `tsconfig` RAÍZ
 *
 * El `tsconfig.json` de la raíz existe para que ningún workspace quede sin chequear por
 * olvido, pero no puede cumplir esa función solo: cubre el TypeScript que resuelve para
 * Node, y una aplicación web necesita JSX, tipos del DOM y resolución de empaquetador.
 * Cuando aparece un workspace que el piso no puede cubrir, la salida fácil es
 * exceptuarlo —y ahí es donde el olvido vuelve a ser silencioso—.
 *
 * Esta comprobación invierte la carga: en vez de exceptuar, obliga a declarar. Un
 * workspace nuevo sin `typecheck` rompe el build con un mensaje que dice qué agregar.
 * Es el mismo criterio que `assert_rls_coverage()` en la base y que el lint de literales
 * de diseño: la cobertura se afirma, no se supone.
 *
 * Uso:
 *   node tools/check-workspace-typecheck.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RAIZ = join(import.meta.dirname, '..')

function leerJson(ruta) {
  return JSON.parse(readFileSync(ruta, 'utf8'))
}

const paqueteRaiz = leerJson(join(RAIZ, 'package.json'))
const patrones = paqueteRaiz.workspaces ?? []

if (patrones.length === 0) {
  console.error('::error::El package.json de la raíz no declara workspaces.')
  process.exit(1)
}

/** Expande `apps/*` a los directorios que existen y tienen package.json. */
function expandir(patron) {
  if (!patron.endsWith('/*')) {
    return existsSync(join(RAIZ, patron, 'package.json')) ? [patron] : []
  }
  const base = patron.slice(0, -2)
  let entradas
  try {
    entradas = readdirSync(join(RAIZ, base), { withFileTypes: true })
  } catch {
    return []
  }
  return entradas
    .filter((entrada) => entrada.isDirectory())
    .filter((entrada) => existsSync(join(RAIZ, base, entrada.name, 'package.json')))
    .map((entrada) => `${base}/${entrada.name}`)
}

const workspaces = patrones.flatMap(expandir).sort()

const sinTypecheck = []
const sinTsconfig = []
const resumen = []

for (const workspace of workspaces) {
  const paquete = leerJson(join(RAIZ, workspace, 'package.json'))
  const tieneScript = typeof paquete.scripts?.typecheck === 'string'
  const tieneTsconfig = statSync(join(RAIZ, workspace)).isDirectory()
    ? existsSync(join(RAIZ, workspace, 'tsconfig.json'))
    : false

  if (!tieneScript) sinTypecheck.push(workspace)
  if (!tieneTsconfig) sinTsconfig.push(workspace)

  resumen.push({
    workspace,
    nombre: paquete.name ?? workspace,
    script: tieneScript ? paquete.scripts.typecheck : null,
    tsconfig: tieneTsconfig,
  })
}

console.log('Cobertura de typecheck por workspace:')
for (const fila of resumen) {
  const marca = fila.script === null ? 'FALTA' : 'OK   '
  console.log(`  ${marca} ${fila.nombre.padEnd(18)} ${fila.script ?? '— sin script typecheck'}`)
}

// El script de la raíz tiene que delegar en los workspaces; si no, declarar `typecheck`
// en cada paquete no serviría de nada porque nadie lo invocaría.
const scriptRaiz = paqueteRaiz.scripts?.typecheck ?? ''
if (!scriptRaiz.includes('--workspaces')) {
  console.error('')
  console.error('::error::El script `typecheck` de la raíz no recorre los workspaces.')
  console.error(`  Actual: ${scriptRaiz || '(vacío)'}`)
  console.error('  Tiene que incluir `npm run typecheck --workspaces --if-present`.')
  process.exit(1)
}

if (sinTsconfig.length > 0) {
  console.error('')
  console.error('::error::Workspaces sin tsconfig.json:')
  for (const workspace of sinTsconfig) console.error(`  · ${workspace}`)
  process.exit(1)
}

if (sinTypecheck.length > 0) {
  console.error('')
  console.error('::error::Workspaces sin script `typecheck`. Su código no lo verifica nadie:')
  for (const workspace of sinTypecheck) {
    console.error(`  · ${workspace}`)
    console.error('    agregar en su package.json: "typecheck": "tsc --noEmit"')
  }
  process.exit(1)
}

console.log('')
console.log(`${workspaces.length} workspaces, todos con typecheck y tsconfig.`)
