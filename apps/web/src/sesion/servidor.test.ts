import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emitirToken } from './firma.ts'
import { emitirSesion, leerSesion, resolverContexto } from './servidor.ts'

/**
 * Resolución de sesión. La prueba negativa es la que importa: una cookie manipulada, expirada
 * o de un no-miembro nunca abre la aplicación ni revela que la empresa existe.
 */

test('leerSesion devuelve null sin cookie', () => {
  assert.equal(leerSesion(undefined), null)
})

test('leerSesion devuelve null ante una firma inválida', () => {
  assert.equal(leerSesion('cualquier-cosa.sin-firma'), null)
})

test('leerSesion devuelve null si la sesión expiró', () => {
  const expirada = emitirToken(JSON.stringify({ sub: 'u_ana', iat: 1, exp: 2 }))
  assert.equal(leerSesion(expirada), null)
})

test('leerSesion abre una sesión válida', () => {
  const sesion = leerSesion(emitirSesion('u_ana'))
  assert.ok(sesion !== null)
  assert.equal(sesion.sub, 'u_ana')
  assert.equal(sesion.imp, undefined)
})

test('una empresa que no es del usuario da sin-membresia (no 404 con datos)', () => {
  // beto no es miembro de andes: resolverContexto tiene que rechazar, no inventar contexto.
  const sesion = leerSesion(emitirSesion('u_beto'))!
  const resultado = resolverContexto(sesion, 'andes')
  assert.equal(resultado.ok, false)
  if (resultado.ok) return
  assert.equal(resultado.motivo, 'sin-membresia')
})

test('el propietario ve todos los permisos habilitados de su empresa', () => {
  const sesion = leerSesion(emitirSesion('u_ana'))!
  const resultado = resolverContexto(sesion, 'pampa')
  assert.equal(resultado.ok, true)
  if (!resultado.ok) return
  const { contexto } = resultado
  assert.ok(contexto.permisos.includes('sales.read'))
  assert.ok(contexto.permisos.includes('logistics.read'))
  assert.equal(contexto.empresas.length, 3) // andes, pampa, nordico
  assert.equal(contexto.impersonacion, null)
})

test('un encargado de depósito ve sólo sus permisos', () => {
  const sesion = leerSesion(emitirSesion('u_beto'))!
  const resultado = resolverContexto(sesion, 'pampa')
  assert.equal(resultado.ok, true)
  if (!resultado.ok) return
  const { contexto } = resultado
  assert.ok(contexto.permisos.includes('inventory.read'))
  assert.ok(!contexto.permisos.includes('sales.read'))
  assert.ok(!contexto.permisos.includes('billing.read'))
})

test('la impersonación resuelve al objetivo, no al usuario real', () => {
  // Carla (plataforma) impersona a Ana en andes.
  const sesion = leerSesion(emitirSesion('u_carla', 'u_ana'))!
  assert.equal(sesion.imp, 'u_ana')
  const resultado = resolverContexto(sesion, 'andes')
  assert.equal(resultado.ok, true)
  if (!resultado.ok) return
  const { contexto } = resultado
  assert.equal(contexto.usuario.nombre, 'Ana Ortega')
  assert.ok(contexto.impersonacion !== null)
  assert.equal(contexto.impersonacion?.por, 'Carla Núñez')
})

test('los permisos efectivos respetan lo que la empresa habilita', () => {
  // Si la empresa deshabilitara un permiso, el filtro lo quita aunque el usuario lo tenga.
  const sesion = leerSesion(emitirSesion('u_ana'))!
  const resultado = resolverContexto(sesion, 'nordico')
  assert.equal(resultado.ok, true)
  if (!resultado.ok) return
  const { contexto } = resultado
  assert.ok(contexto.permisos.includes('logistics.read')) // el permiso lo tiene
  assert.equal(contexto.funcionalidades['logistics.enabled'], false) // pero la bandera lo oculta en el menú
})
