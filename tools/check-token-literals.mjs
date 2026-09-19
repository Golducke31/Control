/**
 * Lint de literales de diseño.
 *
 * Falla si aparece un color, una familia tipográfica o un tamaño escrito a mano en el
 * código de la aplicación o de los componentes. Todo eso tiene que pasar por
 * `@control/tokens`.
 *
 * POR QUÉ EXISTE
 *
 * Un sistema de diseño no se degrada de golpe: se degrada cuando alguien, apurado,
 * escribe `#EF5F18` en un componente porque «es el naranja de la marca». En ese momento
 * hay dos definiciones del naranja de la marca, y la segunda no está verificada contra
 * nada. A partir de ahí el sistema tiene dos velocidades y ya no se puede confiar en
 * que la suite de contraste esté midiendo lo que se ve.
 *
 * Es el mismo criterio que el `assert_rls_coverage()` de la base: una tabla nueva sin
 * política rompe el build. Acá, un color nuevo sin token rompe el build.
 *
 * Uso:
 *   node tools/check-token-literals.mjs
 *
 * Para permitir una excepción justificada, la línea lleva `token-lint: permitido` y el
 * motivo. Las excepciones quedan a la vista en el código, que es lo que se busca.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const RAIZ = join(import.meta.dirname, '..')

/** Dónde se busca. El paquete de tokens queda afuera: ahí los colores SON el contenido. */
const OBJETIVOS = ['apps/web/src', 'packages/ui/src']

const EXTENSIONES = new Set(['.ts', '.tsx', '.css'])

const REGLAS = [
  {
    id: 'color-hex',
    descripcion: 'color hexadecimal escrito a mano',
    patron: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
    sugerencia: 'usar una clase de Tailwind mapeada a un token, o `var(--control-…)`',
  },
  {
    id: 'color-funcional',
    descripcion: 'color funcional escrito a mano',
    patron: /\b(?:rgba?|hsla?|oklch|lab|lch|color-mix)\s*\(/g,
    sugerencia: 'usar un rol de `@control/tokens`; si hace falta una mezcla, agregar el rol y verificarlo',
  },
  {
    id: 'familia-tipografica',
    descripcion: 'familia tipográfica escrita a mano',
    patron: /fontFamily\s*:\s*['"]/g,
    sugerencia: 'usar `font-titulos` o `font-cuerpo` de Tailwind, o `var(--control-fuente-…)`',
  },
  {
    id: 'tamano-de-texto',
    descripcion: 'tamaño de texto en píxeles escrito a mano',
    patron: /fontSize\s*:\s*['"]?\d+px/g,
    sugerencia: 'usar un paso de la escala tipográfica (`text-xs`…`text-4xl`)',
  },
]

/**
 * Quita los comentarios conservando las cadenas y las líneas.
 *
 * Hay que conservar las cadenas porque los colores viven adentro de ellas, y conservar
 * las líneas para poder informar en qué línea está el problema. Un `//` dentro de una
 * cadena —una URL, por ejemplo— no es un comentario, y por eso esto es un recorrido y
 * no una expresión regular.
 */
function sinComentarios(fuente) {
  let salida = ''
  let estado = 'codigo'
  let comilla = ''
  let i = 0

  while (i < fuente.length) {
    const c = fuente[i]
    const siguiente = fuente[i + 1]

    if (estado === 'codigo') {
      if (c === '/' && siguiente === '/') {
        estado = 'linea'
        i += 2
        continue
      }
      if (c === '/' && siguiente === '*') {
        estado = 'bloque'
        i += 2
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        estado = 'cadena'
        comilla = c
        salida += c
        i++
        continue
      }
      salida += c
      i++
      continue
    }

    if (estado === 'linea') {
      if (c === '\n') {
        estado = 'codigo'
        salida += c
      }
      i++
      continue
    }

    if (estado === 'bloque') {
      if (c === '*' && siguiente === '/') {
        estado = 'codigo'
        i += 2
        continue
      }
      if (c === '\n') salida += c
      i++
      continue
    }

    // Dentro de una cadena: se conserva todo, y el escape se saltea entero.
    if (c === '\\') {
      salida += c + (siguiente ?? '')
      i += 2
      continue
    }
    salida += c
    if (c === comilla) estado = 'codigo'
    i++
  }

  return salida
}

function archivosDe(directorio) {
  const encontrados = []
  let entradas
  try {
    entradas = readdirSync(directorio, { withFileTypes: true })
  } catch {
    return encontrados
  }
  for (const entrada of entradas) {
    const ruta = join(directorio, entrada.name)
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules' || entrada.name === '.next') continue
      encontrados.push(...archivosDe(ruta))
      continue
    }
    if (EXTENSIONES.has(extname(entrada.name))) encontrados.push(ruta)
  }
  return encontrados
}

const hallazgos = []
let revisados = 0

for (const objetivo of OBJETIVOS) {
  const base = join(RAIZ, objetivo)
  try {
    if (!statSync(base).isDirectory()) continue
  } catch {
    continue
  }

  for (const archivo of archivosDe(base)) {
    revisados++
    const fuente = sinComentarios(readFileSync(archivo, 'utf8'))
    const lineas = fuente.split('\n')

    lineas.forEach((linea, indice) => {
      if (linea.includes('token-lint: permitido')) return
      for (const regla of REGLAS) {
        regla.patron.lastIndex = 0
        const coincidencia = regla.patron.exec(linea)
        if (coincidencia === null) continue
        hallazgos.push({
          archivo: relative(RAIZ, archivo),
          linea: indice + 1,
          columna: coincidencia.index + 1,
          texto: coincidencia[0],
          regla,
        })
      }
    })
  }
}

if (hallazgos.length > 0) {
  console.error('Literales de diseño fuera del paquete de tokens:\n')
  for (const h of hallazgos) {
    console.error(`  ${h.archivo}:${h.linea}:${h.columna}`)
    console.error(`    ${h.regla.descripcion}: ${h.texto}`)
    console.error(`    ${h.regla.sugerencia}\n`)
  }
  console.error(`${hallazgos.length} hallazgo(s) en ${revisados} archivos revisados.`)
  console.error('Todo color, familia y tamaño tiene que venir de `@control/tokens`.')
  process.exit(1)
}

console.log(`Literales de diseño: sin hallazgos en ${revisados} archivos revisados.`)
