import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

/**
 * El plugin conecta `src/i18n/request.ts` con el compilador.
 *
 * Hace falta porque los Server Components piden los mensajes **sin recibir un pedido HTTP**
 * —no hay `req` del que sacarlos—, así que next-intl necesita un punto de entrada que
 * declare de dónde salen. Es la única pieza del sistema de mensajes que no es un import.
 */
const conMensajes = createNextIntlPlugin('./src/i18n/request.ts')

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Los dos paquetes del monorepo se transpilan desde su fuente TypeScript.
   *
   * Sin esto, Next los trataría como dependencias ya compiladas y no habría forma de
   * consumir `@control/tokens` ni `@control/ui` sin publicarlos. Es lo que permite
   * tener una sola fuente de tokens y de componentes para toda la aplicación.
   */
  transpilePackages: ['@control/tokens', '@control/ui'],

  typedRoutes: true,

  eslint: {
    // El lint de este repositorio es propio —tokens, rutas, cobertura de typecheck—
    // y corre como scripts, no a través de Next.
    ignoreDuringBuilds: true,
  },
}

export default conMensajes(config)
