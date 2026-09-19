/**
 * API pública del módulo de sesión.
 *
 * Lo que la carcasa, las páginas y los manejadores de ruta necesitan. Lo interno
 * (firma, directorio) queda fuera de acá a propósito.
 */

export type { ContextoEmpresa, Membresia, Sesion, Usuario } from './tipos.ts'
export { SESSION_COOKIE } from './firma.ts'
export { emitirDesafio2FA, emitirSesion, leerSesion, resolverContexto, verificarDesafio2FA } from './servidor.ts'
export type { ResultadoContexto } from './servidor.ts'
export { claveDeConsulta, debeDescartarCache, slugDeRuta } from './cache.ts'
export type { Clave } from './cache.ts'
export { ProveedorSesion } from './ProveedorSesion'
export { BandaImpersonacion } from './BandaImpersonacion'
export { borrarCookieSesion, establecerCookieSesion, sesionActual } from './cookie.ts'
export {
  aceptarInvitacion,
  empresaPorDefecto,
  empresasDelUsuario,
  esPlataforma,
  establecerContrasena,
  generarTokenRecuperacion,
  invitacionPorToken,
  membresia,
  primerMiembro,
  usuarioPorCorreo,
  usuarioPorGoogle,
  usuarioPorId,
  usuarioPorTokenRecuperacion,
  validarCredenciales,
} from './directorio.ts'
