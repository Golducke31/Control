/**
 * PostCSS: sólo Tailwind.
 *
 * Tailwind v4 se configura desde el CSS (`@import 'tailwindcss'` y `@theme`), así que
 * no hay un `tailwind.config.js`. Es justo lo que conviene acá: el tema se define
 * mapeando las variables de `@control/tokens`, y así los tokens siguen siendo la
 * única fuente y no hay un archivo de configuración que pueda divergir de ellos.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
