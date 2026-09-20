import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENUMS } from './enums.ts'
import type { z } from 'zod'

const aqui = dirname(fileURLToPath(import.meta.url))
// Desde packages/contracts/src subimos tres niveles a la raíz del repo.
const migraciones = join(aqui, '../../../db/migrations')

/** Extrae los `CREATE TYPE ... AS ENUM` de las migraciones exactamente como están en el motor. */
function extraerEnumsPg(): Map<string, string[]> {
  const archivos = readdirSync(migraciones)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const re = /CREATE TYPE\s+([a-z_]+)\.([a-z_]+)\s+AS\s+ENUM\s*\(([\s\S]*?)\);/gi
  const salida = new Map<string, string[]>()
  for (const archivo of archivos) {
    const texto = readFileSync(join(migraciones, archivo), 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(texto)) !== null) {
      const nombre = `${m[1]}.${m[2]}`
      const cuerpo = m[3] ?? ''
      const valores = [...cuerpo.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
      salida.set(nombre, valores)
    }
  }
  return salida
}

function opciones(esquema: unknown): readonly string[] {
  return (esquema as z.ZodEnum<[string, ...string[]]>).options
}

test('los enums del contrato espejan exactamente los de pg_enum', () => {
  const pg = extraerEnumsPg()

  // 1. Todo enum del motor tiene su contraparte en el contrato, con los mismos valores.
  for (const [nombre, valores] of pg) {
    const esquema = ENUMS[nombre as keyof typeof ENUMS]
    assert.ok(esquema !== undefined, `falta el enum del contrato para ${nombre} (pg_enum lo tiene)`)
    const contrato = [...opciones(esquema)].sort()
    const motor = [...valores].sort()
    assert.deepEqual(
      contrato,
      motor,
      `valores distintos en ${nombre}: contrato=${contrato.join(',')} motor=${motor.join(',')}`,
    )
  }

  // 2. El contrato no inventa enums que el motor no tenga.
  for (const nombre of Object.keys(ENUMS)) {
    assert.ok(
      pg.has(nombre),
      `el contrato define ${nombre} que NO existe en pg_enum`,
    )
  }
})

test('la cantidad de enums y valores coincide con lo publicado en el plan', () => {
  const pg = extraerEnumsPg()
  assert.equal(pg.size, 19, 'el plan declara 19 enums de pg')
  const total = [...pg.values()].reduce((a, v) => a + v.length, 0)
  assert.equal(total, 96, 'el plan declara 96 valores de enum en total')
})

test('un valor ausente en el contrato rompe la sincronía (negativo)', () => {
  // Si el motor tuviera un valor extra, la comparación de arriba fallaría. Lo
  // comprobamos de forma directa: forzar un contrato incompleto no pasa.
  const contratoIncompleto = new Set(['active', 'suspended']) // le falta trial, churned
  const pg = extraerEnumsPg().get('app.tenant_status')!
  const coinciden = [...pg].sort().join(',') === [...contratoIncompleto].sort().join(',')
  assert.equal(coinciden, false, 'un contrato incompleto no debe coincidir con pg_enum')
})
