import type mensajes from '../messages/es.json'

/**
 * Los mensajes, tipados.
 *
 * Sin esto, `t('comun.limpiar')` con un error de tipeo compila y devuelve la **clave** en
 * pantalla —`comun.limpiarr`— en vez de fallar. Con esto, una clave que no existe es un
 * error de typecheck, y el autocompletado propone las que sí.
 *
 * Es la diferencia entre una migración que se puede verificar y una que hay que mirar a
 * ojo: `npm run typecheck` cubre las 199 claves sin abrir un navegador.
 */
declare module 'next-intl' {
  interface AppConfig {
    Messages: typeof mensajes
  }
}
