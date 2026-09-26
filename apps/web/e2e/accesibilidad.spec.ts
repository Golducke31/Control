import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

import { VENTANAS } from '../src/rutas.ts'

/**
 * Accesibilidad real, con el navegador y los estilos calculados.
 *
 * El gate estático (`tools/check-accesibilidad.mjs`) cubre las reglas de **forma** —un `alt`
 * que falta, un `href` vacío, un `tabIndex` positivo— leyendo el código. Lo que no puede ver,
 * y es lo que este archivo cubre, es todo lo que depende del render: el **contraste** de un
 * color contra el fondo que realmente le tocó, el **nombre accesible** que el navegador
 * calcula, y el **orden de foco** de la página tal como quedó armada.
 *
 * Es el criterio 3 de §8.3, que hasta ahora estaba a medias.
 */

/** El nivel que el plan exige: AA. Se incluyen las reglas de la 2.1 además de las de la 2.0. */
const ETIQUETAS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const SLUG = 'andes'

/** Las páginas que se visitan sin sesión. No son ventanas, pero son pantallas del producto. */
const PUBLICAS = [
  { nombre: 'Ingreso', ruta: '/ingresar' },
  { nombre: 'Tracking público', ruta: '/t/TRK-9F2K7A01' },
  { nombre: 'Panel del conductor', ruta: '/chofer' },
]

/**
 * Navega y espera a que la ventana esté armada.
 *
 * **No se usa `networkidle`**: la torre de control abre una conexión SSE que queda viva, así
 * que la red nunca se queda quieta y la espera expiraría siempre. El encabezado de ventana es
 * la señal correcta — es lo primero que hay dentro del área de trabajo y está en el HTML que
 * el servidor manda, así que cuando aparece la página ya se puede analizar.
 */
async function abrirYEsperar(page: import('@playwright/test').Page, ruta: string): Promise<void> {
  await page.goto(ruta, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

/** El resultado tal como lo devuelve axe. Se deriva de su firma para no duplicar su forma. */
type Analisis = Awaited<ReturnType<AxeBuilder['analyze']>>

/**
 * Un selector de axe puede no ser un string: en shadow DOM o en marcos con nombre, el
 * destino es un objeto. Se imprime en su forma legible en vez de asumir que es texto.
 */
function selector(destino: readonly unknown[]): string {
  return destino.map((parte) => (typeof parte === 'string' ? parte : JSON.stringify(parte))).join(' ')
}

/** Un informe legible: `toEqual([])` sobre las violaciones no dice qué arreglar. */
function informe(violaciones: Analisis['violations']): string {
  if (violaciones.length === 0) return 'sin violaciones'
  const lineas = violaciones.map((v) => {
    const nodos = v.nodes.slice(0, 3).map((n) => `      ${selector(n.target)}`)
    const resto = v.nodes.length > 3 ? [`      …y ${v.nodes.length - 3} más`] : []
    return `  · [${v.impact ?? 'sin impacto'}] ${v.id} — ${v.help}\n${[...nodos, ...resto].join('\n')}`
  })
  return `\n${lineas.join('\n')}`
}

async function analizar(page: import('@playwright/test').Page): Promise<Analisis> {
  return new AxeBuilder({ page }).withTags(ETIQUETAS).analyze()
}

for (const ventana of VENTANAS) {
  test(`${ventana.titulo} cumple AA`, async ({ page }) => {
    await abrirYEsperar(page, `/e/${SLUG}/${ventana.segmento}`)
    const resultado = await analizar(page)
    expect(resultado.violations, informe(resultado.violations)).toEqual([])
  })
}

for (const publica of PUBLICAS) {
  test(`${publica.nombre} cumple AA`, async ({ page }) => {
    await abrirYEsperar(page, publica.ruta)
    const resultado = await analizar(page)
    expect(resultado.violations, informe(resultado.violations)).toEqual([])
  })
}
