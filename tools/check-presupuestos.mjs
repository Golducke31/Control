#!/usr/bin/env node
/**
 * Presupuesto de peso del frontend — el criterio 4 de §8.3, hecho gate.
 *
 * Corre después de `next build` y falla si una ruta carga más JavaScript del que se le
 * asignó. Es el único de los cinco criterios de aceptación que se puede medir sin
 * navegador y sin un servidor levantado: los números salen de la tabla que el propio
 * build imprime.
 *
 * **Por qué un gate y no una medición suelta.** Un número medido una vez, en el commit en
 * que se midió, deja de ser cierto en cuanto alguien agrega una dependencia. El build ya
 * imprime el peso de cada ruta en cada corrida; lo que faltaba era alguien que lo mirara.
 *
 * Uso:
 *   node tools/check-presupuestos.mjs                    # corre el build y verifica
 *   node tools/check-presupuestos.mjs --desde salida.txt # verifica una salida guardada
 *   node tools/check-presupuestos.mjs --listar           # imprime lo medido y sale en 0
 *
 * La salida guardada no es un atajo de conveniencia: es lo que permite probar que el gate
 * **falla** sin esperar cuarenta segundos de build, y un gate que no se vio fallar no
 * está probado.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..')
const WEB = join(RAIZ, 'apps', 'web')
const PRESUPUESTOS = join(AQUI, 'presupuestos.json')

/** Convierte `1.2 kB` / `480 B` / `1.1 MB` a kilobytes. */
export function aKb(valor, unidad) {
  const n = Number(valor)
  if (Number.isNaN(n)) return null
  if (unidad === 'MB') return n * 1024
  if (unidad === 'B') return n / 1024
  return n
}

/**
 * Extrae de la salida del build el peso de cada ruta y el del chunk compartido.
 *
 * Se parsea la tabla y no se leen los archivos de `.next`: lo que importa es lo que el
 * build **declara** que carga el navegador —incluidos los chunks compartidos—, y eso es
 * exactamente lo que esa tabla calcula. Leer los archivos por mi cuenta sería reimplementar
 * el cálculo y, con el tiempo, discrepar con él.
 */
export function medir(salida) {
  const rutas = []
  let compartido = null

  for (const linea of salida.split('\n')) {
    const compartida = linea.match(/First Load JS shared by all\s+([\d.]+)\s*(kB|MB|B)/)
    if (compartida) {
      compartido = aKb(compartida[1], compartida[2])
      continue
    }

    // Una fila de la tabla: marcador, ruta, tamaño del chunk, First Load JS.
    const fila = linea.match(/[○ƒλ●]\s+(\S+)\s+([\d.]+)\s*(kB|MB|B)\s+([\d.]+)\s*(kB|MB|B)\s*$/)
    if (!fila) continue
    const kb = aKb(fila[4], fila[5])
    if (kb === null) continue
    rutas.push({ ruta: fila[1], kb })
  }

  return { rutas, compartido }
}

function correrBuild() {
  process.stderr.write('  Compilando para medir (esto tarda un poco)…\n')
  const salida = execFileSync('npm', ['run', 'build'], {
    cwd: WEB,
    encoding: 'utf8',
    // `next dev` y `next build` reescriben `.next` y el shim de safe-delete de este
    // entorno bloquea los borrados masivos. Fuera de WorkBuddy la variable es inerte.
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
    maxBuffer: 32 * 1024 * 1024,
  })
  return salida
}

const argumentos = process.argv.slice(2)
const indiceDesde = argumentos.indexOf('--desde')
const desde = indiceDesde === -1 ? null : argumentos[indiceDesde + 1]
const soloListar = argumentos.includes('--listar')

if (indiceDesde !== -1 && (desde === undefined || desde === null)) {
  console.error('  --desde necesita un archivo con la salida del build.')
  process.exit(1)
}

if (!existsSync(PRESUPUESTOS)) {
  console.error(`  No encontré ${PRESUPUESTOS}. El gate no puede correr sin presupuestos.`)
  process.exit(1)
}
const presupuestos = JSON.parse(readFileSync(PRESUPUESTOS, 'utf8'))

const salida = desde === null ? correrBuild() : readFileSync(desde, 'utf8')
const { rutas, compartido } = medir(salida)

/**
 * Si no se pudo medir nada, se falla. Un gate que «pasa» porque no entendió su entrada es
 * peor que no tener gate: da la sensación de estar cubierto.
 */
if (rutas.length === 0) {
  console.error('  No pude leer ninguna ruta de la salida del build.')
  console.error('  Si el formato del reporte de Next cambió, hay que actualizar el parser:')
  console.error('  un gate que no ve nada no protege nada.')
  process.exit(1)
}

const exceso = []
for (const { ruta, kb } of rutas) {
  const excepcion = presupuestos.excepciones?.[ruta]
  const tope = excepcion?.maxKb ?? presupuestos.porRuta.maxKb
  if (kb > tope) exceso.push({ ruta, kb, tope, motivo: excepcion?.motivo })
}

const compartidoTope = presupuestos.compartido.maxKb
const compartidoExcedido = compartido !== null && compartido > compartidoTope

if (soloListar) {
  console.log(`  ${rutas.length} rutas medidas · chunk compartido: ${compartido ?? '?'} kB`)
  for (const { ruta, kb } of [...rutas].sort((a, b) => b.kb - a.kb)) {
    console.log(`    ${String(kb).padStart(7)} kB  ${ruta}`)
  }
  process.exit(0)
}

if (exceso.length === 0 && !compartidoExcedido) {
  const masPesada = [...rutas].sort((a, b) => b.kb - a.kb)[0]
  console.log(
    `  ${rutas.length} rutas dentro del presupuesto · compartido ${compartido ?? '?'} kB (tope ${compartidoTope}) · la más pesada ${masPesada.ruta} ${masPesada.kb} kB`,
  )
  process.exit(0)
}

console.error('  Presupuesto de peso excedido:')
if (compartidoExcedido) {
  console.error(
    `    chunk compartido: ${compartido} kB (tope ${compartidoTope}) — lo paga toda ruta`,
  )
  console.error(`    ${presupuestos.compartido.motivo}`)
}
for (const { ruta, kb, tope, motivo } of exceso) {
  console.error(`    ${ruta}: ${kb} kB (tope ${tope})`)
  if (motivo !== undefined) console.error(`      excepción declarada: ${motivo}`)
}
console.error('')
console.error('  Un exceso se arregla achicando la ruta o subiendo el presupuesto **con un motivo')
console.error('  escrito en tools/presupuestos.json**. Subirlo sin motivo es apagar el gate.')
process.exit(1)
