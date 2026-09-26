import { defineConfig, devices } from '@playwright/test'

/**
 * Configuración de Playwright para Control.
 *
 * Corre contra el servidor de desarrollo —no contra `next start`— porque el objetivo es
 * verificar la aplicación tal como la usa una persona: con la hidratación real, el foco
 * real y los estilos calculados. Un `next start` mediría el bundle de producción, que es
 * otra cosa y se mide en el gate de presupuestos.
 *
 * **Secuencial y con un solo worker, a propósito.** El servidor de desarrollo compila cada
 * ruta la primera vez que se pide, y esa compilación tarda segundos. Con workers en paralelo
 * las compilaciones compiten y los tests fallan por tiempo de espera, no por un defecto —
 * un gate que falla por el entorno deja de mirarse.
 */

const BASE = process.env.CONTROL_BASE_URL ?? 'http://localhost:3000'

/**
 * El host local queda fuera del proxy del entorno, y esto no es cosmético.
 *
 * Este entorno define `HTTP_PROXY`/`HTTPS_PROXY` apuntando a un proxy local que responde
 * **404** para las rutas de `localhost`. Playwright respeta esas variables en su propio
 * cliente HTTP —el que usa para sondear si el servidor ya está levantado—, así que el
 * sondeo fallaba, Playwright intentaba arrancar un servidor nuevo sobre un puerto ya
 * ocupado, y el arranque terminaba en un «Timed out waiting … from config.webServer» que
 * no decía nada del proxy. Se excluye el host local antes de que Playwright sondee nada.
 */
const SIN_PROXY = ['localhost', '127.0.0.1', '::1']
process.env.NO_PROXY = [
  ...new Set([...(process.env.NO_PROXY ?? '').split(',').filter(Boolean), ...SIN_PROXY]),
].join(',')
process.env.no_proxy = process.env.NO_PROXY

/**
 * El shim de safe-delete de este entorno bloquea el borrado masivo de `test-results/`, que
 * Playwright vacía al empezar. La variable **no se puede desactivar desde acá**: el shim la
 * evalúa al cargarse, antes de que este archivo se lea. Va en el comando, en los scripts
 * `test:*` del paquete, con `cross-env` para que funcione igual en cmd, bash y PowerShell.
 * Fuera de WorkBuddy la variable es inerte: no existe el shim que la lee.
 */

/** Dónde queda la sesión de la propietaria, para que la reusen todos los proyectos. */
const SESION = 'e2e/.estado/sesion.json'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: [['list']],
  // Generoso: la primera visita a cada ruta incluye la compilación on-demand del servidor.
  timeout: 120_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'preparacion',
      testMatch: /preparacion\.setup\.ts/,
    },
    {
      name: 'accesibilidad',
      testMatch: /accesibilidad\.spec\.ts/,
      dependencies: ['preparacion'],
      use: { ...devices['Desktop Chrome'], storageState: SESION },
    },
    {
      name: 'flujos',
      testMatch: /flujos\.spec\.ts/,
      dependencies: ['preparacion'],
      use: { ...devices['Desktop Chrome'], storageState: SESION },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: BASE,
    // Si ya hay un servidor levantado se reutiliza; en CI se levanta uno propio.
    reuseExistingServer: process.env.CI === undefined,
    timeout: Number(process.env.CONTROL_WEBSERVER_TIMEOUT ?? 240_000),
    // `next dev` reescribe `.next` y el shim de safe-delete de este entorno lo bloquea.
    env: { CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
  },
})
