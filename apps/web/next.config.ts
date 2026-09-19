import type { NextConfig } from 'next'

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

export default config
