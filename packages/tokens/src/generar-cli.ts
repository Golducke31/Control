/**
 * Ejecutable del generador de tokens.
 *
 * Separado de `generar.ts` a propósito: la biblioteca no puede tener efectos al
 * importarse, o cada vez que alguien pida un color se reescribirían tres archivos.
 *
 *     node src/generar-cli.ts           # regenera los artefactos
 *     node src/generar-cli.ts --check   # falla si no coinciden con la fuente
 */

import { artefactosDesincronizados, generar } from './generar.ts'

const enModoCheck = process.argv.includes('--check')

if (enModoCheck) {
  const desincronizados = artefactosDesincronizados()

  if (desincronizados.length > 0) {
    console.error('Los artefactos generados no coinciden con la fuente:')
    for (const archivo of desincronizados) console.error(`  · ${archivo}`)
    console.error('')
    console.error('Ejecutar: npm run generate --workspace @control/tokens')
    process.exit(1)
  }

  console.log('Tokens sincronizados con su fuente.')
} else {
  for (const archivo of generar()) console.log(`  escrito ${archivo}`)
  console.log('Tokens generados.')
}
