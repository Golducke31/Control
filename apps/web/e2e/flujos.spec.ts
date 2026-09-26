import { expect, test, type Page } from '@playwright/test'

/**
 * Los flujos críticos, con navegador.
 *
 * Cada uno recorre algo que hasta ahora sólo estaba cubierto por lógica pura: la regla está
 * probada en `packages/contracts`, pero que la **pantalla** la ejerza —que el botón exista,
 * que el ajuste se vea, que la escritura sobreviva a una recarga— no lo probaba nadie. Es
 * donde aparecieron los defectos que la suite de unidad no podía ver.
 *
 * Ninguno de estos tests decide una regla: las reglas viven en `packages/contracts` y ahí
 * están probadas, con sus negativas. Acá se comprueba que la interfaz las muestre.
 */

const SLUG = 'andes'

/**
 * Espera a que React haya tomado un elemento antes de interactuar con él.
 *
 * El HTML llega antes que el JavaScript, y en esa ventana un clic no lo maneja nadie: el
 * `<form>` lo envía el navegador —perdiendo la query string, que es cómo se rompía el 2FA— y
 * un `onClick` simplemente no hace nada. El test falla de forma intermitente y la
 * intermitencia no dice nada del producto.
 *
 * React marca los nodos que hidrata con una propiedad interna (`__reactProps$…`). Es un
 * detalle de implementación, pero es el único observable que distingue «el HTML ya está» de
 * «el elemento ya responde», que es exactamente lo que hay que saber antes de hacer clic.
 */
async function esperarHidratacion(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const nodo = document.querySelector(sel)
      return nodo !== null && Object.keys(nodo).some((clave) => clave.startsWith('__reactProps$'))
    },
    selector,
    // Generoso a propósito: la primera visita a una ruta en `next dev` incluye su
    // compilación, y ese tiempo no es un defecto de la aplicación.
    { timeout: 90_000 },
  )
}

/** Abre una ruta y deja el elemento indicado listo para recibir interacción. */
async function abrirYEsperar(page: Page, ruta: string, selector: string): Promise<void> {
  await page.goto(ruta)
  /*
    El tiempo de espera de la primera visibilidad es el del test, no el de una aserción
    normal. Con `next dev`, la primera visita a una ruta la compila, y tras un build —que
    vacía `.next`— todas las rutas se compilan de nuevo. Con el tiempo de espera normal, la
    suite fallaba por la caché fría y el mensaje hablaba de un elemento que no aparecía: un
    gate que falla por el entorno es un gate que se deja de mirar.
  */
  await expect(page.locator(selector).first()).toBeVisible({ timeout: 90_000 })
  await esperarHidratacion(page, selector)
}

/**
 * El almacén simulado dura lo que dura el proceso, así que una escritura de un test deja el
 * saldo cambiado para el siguiente. Sin reiniciar, un test pasaría o fallaría según el orden
 * en que se corrió antes, que es la peor clase de fragilidad. La ruta que reinicia sólo
 * existe fuera de producción.
 */
test.beforeEach(async ({ request }) => {
  const respuesta = await request.post('/api/dev/reiniciar')
  expect(respuesta.ok(), 'el almacén simulado se reinicia').toBe(true)
})

// ---------------------------------------------------------------------------
// a · Ingreso completo
// ---------------------------------------------------------------------------

test.describe('ingreso', () => {
  // Sin sesión: es lo que se está probando.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('el ingreso completo, con los dos factores, deja entrar', async ({ page }) => {
    // Sin sesión, una ventana de empresa redirige al ingreso.
    await page.goto(`/e/${SLUG}/panel`)
    await expect(page).toHaveURL(/\/ingresar/)

    await abrirYEsperar(page, '/ingresar', 'form')
    await page.getByLabel('Correo').fill('ana@control.app')
    await page.getByLabel('Contraseña').fill('control123')
    await page.getByRole('button', { name: 'Ingresar' }).click()

    // El segundo factor es una pantalla aparte, no un campo más del mismo formulario.
    const codigo = page.getByLabel('Código')
    await expect(codigo).toBeVisible()
    await esperarHidratacion(page, 'form')
    await codigo.fill('123456')
    await page.getByRole('button', { name: 'Verificar' }).click()

    // Ya adentro: la ventana abre con su encabezado.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page).not.toHaveURL(/\/ingresar/)
  })

  test('una clave equivocada no deja entrar y lo dice', async ({ page }) => {
    await abrirYEsperar(page, '/ingresar', 'form')
    await page.getByLabel('Correo').fill('ana@control.app')
    await page.getByLabel('Contraseña').fill('no-es-la-clave')
    await page.getByRole('button', { name: 'Ingresar' }).click()

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/ingresar/)
  })
})

// ---------------------------------------------------------------------------
// b · Recuento: la regla de la puerta de F5, en pantalla
// ---------------------------------------------------------------------------

test('el recuento mueve el saldo y deja su fila en el libro mayor', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/stock/recuento`, 'input[type="number"]')
  const fila = page.locator('tr', { hasText: 'LIC-AN-001' }).first()
  await expect(fila).toBeVisible()

  /** La columna «Sistema»: SKU, Producto, Depósito, **Sistema**. */
  const sistema = fila.locator('td').nth(3)
  await expect(sistema).toHaveText('100')

  // Contar 95 donde el sistema dice 100: un ajuste negativo de 5.
  await fila.getByLabel(/Cantidad contada/).fill('95')
  await fila.getByRole('button', { name: 'Aplicar' }).click()
  await expect(fila).toContainText('adjustment_neg -5 → saldo 95')

  // Las dos mitades de la regla, y la segunda es la que antes no se cumplía: el saldo
  // tiene que quedar movido **después de recargar**, no sólo en la respuesta.
  await page.reload()
  await expect(page.locator('tr', { hasText: 'LIC-AN-001' }).first().locator('td').nth(3)).toHaveText('95')

  // Y el libro mayor tiene el movimiento, con el motivo que escribe la función pura.
  await page.goto(`/e/${SLUG}/stock/movimientos?texto=Recuento`)
  await expect(page.getByText('Recuento: sistema 100, contado 95')).toBeVisible()
  await expect(page.getByText('Ajuste negativo')).toBeVisible()
})

test('contar por debajo de lo reservado se rechaza y no mueve nada', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/stock/recuento`, 'input[type="number"]')
  const fila = page.locator('tr', { hasText: 'LIC-AN-001' }).first()

  // El nivel tiene 8 reservadas: contar 3 no es un ajuste, es un imposible.
  await fila.getByLabel(/Cantidad contada/).fill('3')
  await expect(fila).toContainText('por debajo de lo reservado')
  await expect(fila.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
})

// ---------------------------------------------------------------------------
// c · Transferencia: el bloqueo optimista
// ---------------------------------------------------------------------------

test('la transferencia con edición concurrente avisa y no pisa', async ({ page }) => {
  // TRN-0013 está en borrador: ofrece despachar.
  await abrirYEsperar(page, `/e/${SLUG}/stock/transferencias/tr_003`, 'section')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('TRN-0013')

  await page.getByRole('button', { name: 'Despachar' }).click()
  await expect(page.getByText('Despachar: hecho.')).toBeVisible()

  // La versión en pantalla quedó vieja **a propósito**, así que el mecanismo se ve en una
  // sola pestaña: la acción siguiente se escribe contra una versión que ya no es la vigente.
  await page.getByRole('button', { name: 'Recibir' }).click()
  await expect(page.getByText('Alguien más modificó esta transferencia')).toBeVisible()
  await expect(page.getByText('No se pisó nada')).toBeVisible()

  // El estado no se movió: sigue despachada, que es lo que la primera acción dejó.
  await expect(page.getByText('despachada')).toBeVisible()
})

test('sincronizar la versión deja continuar', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/stock/transferencias/tr_003`, 'section')
  await page.getByRole('button', { name: 'Despachar' }).click()
  await expect(page.getByText('Despachar: hecho.')).toBeVisible()

  // El botón sólo se habilita cuando hay algo que sincronizar.
  const sincronizar = page.getByRole('button', { name: 'Sincronizar versión' })
  await expect(sincronizar).toBeEnabled()
  await sincronizar.click()
  await expect(page.getByText('versión en pantalla:').locator('..')).toContainText('al día')

  // Y ahora sí: con la versión vigente, recibir funciona.
  await page.getByRole('button', { name: 'Recibir' }).click()
  await expect(page.getByText('Recibir: hecho.')).toBeVisible()
})

// ---------------------------------------------------------------------------
// d · Cierre de período
// ---------------------------------------------------------------------------

test('un período con asientos en borrador no se puede cerrar, y lo explica', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/contabilidad/periodos`, 'section')

  // Septiembre tiene dos asientos en borrador: el botón anticipa el rechazo en vez de
  // ofrecer una operación que va a fallar.
  const septiembre = page.locator('section').filter({ hasText: 'Septiembre 2026' })
  await expect(septiembre).toContainText('2 asiento(s) en borrador')
  const cerrarSeptiembre = septiembre.getByRole('button', { name: 'No se puede cerrar' })
  await expect(cerrarSeptiembre).toBeDisabled()

  // Octubre no tiene pendientes: ahí el cierre está disponible.
  const octubre = page.locator('section').filter({ hasText: 'Octubre 2026' })
  await expect(octubre.getByRole('button', { name: 'Cerrar período' })).toBeEnabled()
})

test('cerrar un período lo deja cerrado, y reabrirlo exige motivo', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/contabilidad/periodos`, 'section')

  const octubre = page.locator('section').filter({ hasText: 'Octubre 2026' })
  await octubre.getByRole('button', { name: 'Cerrar período' }).click()
  // Cerrado se nota en que la acción cambia: ya no ofrece cerrar, ofrece reabrir.
  await expect(octubre.getByRole('button', { name: 'Cerrar período' })).toHaveCount(0)
  const reabrir = octubre.getByRole('button', { name: 'Reabrir' })
  await expect(reabrir).toBeVisible()
  // Y reabrir sin motivo no se puede: el motor lo exige (`periods_reopen_coherent`).
  await expect(reabrir).toBeDisabled()

  await octubre.getByLabel('Motivo para reabrir Octubre 2026').fill('Faltó imputar la factura de flete')
  await expect(reabrir).toBeEnabled()
})

// ---------------------------------------------------------------------------
// e · El tema, sin recargar
// ---------------------------------------------------------------------------

test('cambiar de plantilla aplica el tema sin recargar', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/configuracion`, 'table')

  // Una marca en el objeto `window`: si la página se recargara, desaparecería.
  await page.evaluate(() => {
    ;(window as unknown as { __sinRecargar?: string }).__sinRecargar = 'vivo'
  })

  // Retail Glass es la que abre: radio 20, densidad cómoda.
  await expect(page.getByText('20 px')).toBeVisible()

  await page.getByRole('button', { name: 'Logistics Glass' }).click()

  // La plantilla cambió —radio 14, densidad compacta— y la página sigue siendo la misma.
  await expect(page.getByText('14 px')).toBeVisible()
  await expect(page.getByText('compacta')).toBeVisible()
  const marca = await page.evaluate(
    () => (window as unknown as { __sinRecargar?: string }).__sinRecargar ?? null,
  )
  expect(marca, 'la página no se recargó: la marca sobrevivió').toBe('vivo')
})

test('la tabla de paletas muestra la tinta derivada, con su contraste medido', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/configuracion`, 'table')

  // Nórdico es el caso que el prototipo rompía: con tinta blanca fija daba 2,72:1. La
  // corrección no fue oscurecer el primario —es del inquilino— sino derivar la tinta.
  const nordico = page.locator('tr').filter({ hasText: 'Nórdico Retail' })
  await expect(nordico).toBeVisible()
  await expect(nordico, 'con blanco no llega a AA').not.toContainText('#FFFFFF')

  const relacion = await nordico.locator('td').nth(3).innerText()
  const valor = Number(relacion.replace(':1', '').replace(',', '.'))
  expect(valor, `la tinta derivada tiene que pasar AA, y mide ${relacion}`).toBeGreaterThanOrEqual(4.5)
  await expect(nordico.getByText('cumple')).toBeVisible()
})

test('elegir otra paleta cambia el tema sin recargar', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/configuracion`, 'table')

  await page.evaluate(() => {
    ;(window as unknown as { __sinRecargar?: string }).__sinRecargar = 'vivo'
  })

  await page.getByRole('button', { name: 'Pampa Logística' }).click()

  // La fila elegida se marca y la vista previa cambia de color.
  await expect(page.locator('tr').filter({ hasText: 'Pampa Logística' })).toHaveClass(/bg-sutil/)
  const marca = await page.evaluate(
    () => (window as unknown as { __sinRecargar?: string }).__sinRecargar ?? null,
  )
  expect(marca, 'cambiar de paleta no recarga: la marca sobrevivió').toBe('vivo')
})

// ---------------------------------------------------------------------------
// f · A12: recargar restaura la vista
// ---------------------------------------------------------------------------

test('recargar restaura filtro, página y orden', async ({ page }) => {
  await abrirYEsperar(page, `/e/${SLUG}/stock/movimientos`, 'input[type="search"]')

  await page.getByLabel('Buscar movimientos').fill('Traslado')
  await expect(page).toHaveURL(/texto=Traslado/)

  // Ordenar por fecha: la primera pulsación deja ascendente.
  await page.getByRole('button', { name: /Fecha/ }).click()
  await expect(page).toHaveURL(/orden=fecha(:|%3A)asc/)

  const antes = await page.locator('tbody tr').allInnerTexts()
  expect(antes.length, 'el filtro deja filas').toBeGreaterThan(0)
  expect(antes.every((f) => f.includes('Traslado')), 'todas las filas cumplen el filtro').toBe(true)

  await page.reload()

  // Lo que A12 promete: la vista vuelve tal cual, no sólo el campo con el texto.
  await expect(page.getByLabel('Buscar movimientos')).toHaveValue('Traslado')
  await expect(page).toHaveURL(/orden=fecha(:|%3A)asc/)
  expect(await page.locator('tbody tr').allInnerTexts()).toEqual(antes)
})

test('el filtro de la URL se aplica ya en la primera pintura', async ({ page }) => {
  // Sin pasar por la interfaz: la URL es el estado (A12), así que un enlace compartido
  // tiene que abrir la vista filtrada directamente.
  await page.goto(`/e/${SLUG}/stock/movimientos?texto=Traslado&orden=fecha:desc`)

  await expect(page.getByLabel('Buscar movimientos')).toHaveValue('Traslado')
  const filas = page.locator('tbody tr')
  await expect(filas.first()).toBeVisible()
  const textos = await filas.allInnerTexts()
  expect(textos.every((f) => f.includes('Traslado'))).toBe(true)

  // Y el orden pedido: la fecha más reciente primero.
  const fechas = await page.locator('tbody tr td:first-child').allInnerTexts()
  expect(fechas[0]).toBe('18 sept 2026')
})

// ---------------------------------------------------------------------------
// g · Rutas fuera de la carcasa
// ---------------------------------------------------------------------------

test('el tracking público no expone datos del cliente', async ({ page }) => {
  await page.goto('/t/TRK-9F2K7A01')
  const cuerpo = await page.locator('body').innerText()

  // La proyección pública es una lista blanca: estos campos no están.
  for (const prohibido of ['Distribuidora', 'Transportes', 'patente', 'token']) {
    expect(cuerpo.toLowerCase(), `«${prohibido}» no debería publicarse`).not.toContain(
      prohibido.toLowerCase(),
    )
  }
})

test('un token inexistente da 404, no una pantalla con 200', async ({ page }) => {
  const respuesta = await page.goto('/t/NO-EXISTE')
  expect(respuesta?.status(), 'un recurso que no existe no puede responder 200').toBe(404)
})
