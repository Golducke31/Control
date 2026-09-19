/**
 * Suite de contraste de los roles.
 *
 * Es la puerta de accesibilidad del sistema de color: recorre los pares que la
 * interfaz realmente usa y exige el nivel que a cada uno le corresponde, en los dos
 * temas.
 *
 * Y trae sus pruebas negativas. Sin ellas, esta suite podría estar midiendo el par
 * equivocado —o ninguno— y seguiría diciendo que todo está bien. Es la lección de
 * los dos jobs del CI que no podían pasar nunca: un control hay que verlo fallar.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contraste } from './contraste.ts'
import { SEMANTICOS } from './escalas.ts'
import type { NombreDeSemantico } from './escalas.ts'
import { ROLES, ROLES_CLARO, ROLES_OSCURO } from './roles.ts'
import type { Rol, Tema } from './roles.ts'
import { PARES, describirViolacion, verificarRoles } from './verificacion.ts'

const TEMAS: readonly Tema[] = ['claro', 'oscuro']

test('los dos temas son conformes en todos los pares declarados', () => {
  for (const tema of TEMAS) {
    const violaciones = verificarRoles(ROLES[tema])
    assert.equal(
      violaciones.length,
      0,
      `tema ${tema}:\n` + violaciones.map((v) => '  · ' + describirViolacion(v)).join('\n'),
    )
  }
})

test('los pares declarados son suficientes para cubrir los roles', () => {
  // Cada rol de color tiene que aparecer en al menos un par verificado, o su
  // contraste no está medido por nadie. Los de sólo fondo y los de borde decorativo
  // se exceptúan a propósito y están listados acá.
  const exentos = new Set<Rol>([
    'fondo-sutil',
    'fondo-invertido',
    'fondo-accion',
    'borde-sutil',
    'borde-accion',
    'texto-deshabilitado',
  ])
  const usados = new Set<Rol>()
  for (const par of PARES) {
    usados.add(par.frente)
    usados.add(par.fondo)
  }
  const sinVerificar = (Object.keys(ROLES_CLARO) as Rol[]).filter(
    (rol) => !usados.has(rol) && !exentos.has(rol),
  )
  assert.deepEqual(sinVerificar, [], 'hay roles cuyo contraste no mide ningún par')
})

test('los dos temas definen exactamente los mismos roles', () => {
  // Un rol definido en un tema y olvidado en el otro no falla en ningún lado:
  // simplemente la variable CSS no existe y el navegador pinta lo que puede.
  assert.deepEqual(Object.keys(ROLES_CLARO).sort(), Object.keys(ROLES_OSCURO).sort())
})

test('cada semántico aporta sus tres roles en los dos temas', () => {
  for (const tema of TEMAS) {
    for (const nombre of Object.keys(SEMANTICOS) as NombreDeSemantico[]) {
      for (const sufijo of ['', '-suave', '-tinta'] as const) {
        const rol = `estado-${nombre}${sufijo}` as Rol
        assert.ok(ROLES[tema][rol], `falta el rol ${rol} en el tema ${tema}`)
      }
    }
  }
})

test('no hay pares repetidos ni descripciones ambiguas', () => {
  const vistos = new Set<string>()
  for (const par of PARES) {
    const clave = `${par.frente}|${par.fondo}`
    assert.ok(!vistos.has(clave), `el par ${clave} está declarado dos veces`)
    vistos.add(clave)
    assert.ok(par.descripcion.trim().length > 0, 'todo par necesita descripción')
  }
})

test('el verificador falla ante un par que no cumple', () => {
  // Prueba negativa básica: se rompe el par más visible del sistema y el
  // verificador tiene que verlo.
  const roto = { ...ROLES_CLARO, 'texto-sobre-accion': '#FFFFFF' }
  const violaciones = verificarRoles(roto)
  assert.ok(violaciones.length > 0, 'blanco sobre el naranja en cuerpo tiene que fallar')
  assert.ok(
    violaciones.some((v) => v.descripcion === 'tinta del botón primario'),
    `la violación tiene que señalar el botón, y señaló: ${violaciones.map((v) => v.descripcion).join(', ')}`,
  )
})

test('el verificador falla ante un tema entero mal elegido', () => {
  // Prueba negativa de fondo: una paleta que «se ve bien» pero no mide. Es el caso
  // real que motivó la suite — las paletas de inquilino del prototipo.
  const paletasQueFallan = [
    { nombre: 'verde sobre blanco', tinta: '#10B981' },
    { nombre: 'rosa sobre blanco', tinta: '#E879A6' },
    { nombre: 'ámbar sobre blanco', tinta: '#F5B22E' },
  ]
  for (const { nombre, tinta } of paletasQueFallan) {
    const roto = { ...ROLES_CLARO, 'texto-principal': tinta }
    const violaciones = verificarRoles(roto)
    assert.ok(
      violaciones.length > 0,
      `${nombre}: el verificador debería rechazarlo, y el contraste real es ${contraste(tinta, '#FFFFFF').toFixed(2)}:1`,
    )
  }
})

test('el verificador no reporta de más: un tema conforme da lista vacía', () => {
  // La contracara de las pruebas negativas. Si el verificador marcara todo, las
  // anteriores pasarían igual y no probarían nada.
  assert.deepEqual(verificarRoles(ROLES_CLARO), [])
  assert.deepEqual(verificarRoles(ROLES_OSCURO), [])
})

test('un par que referencia un rol inexistente falla en vez de pasar de largo', () => {
  assert.throws(
    () => verificarRoles(ROLES_CLARO, [
      { descripcion: 'rol que no existe', frente: 'texto-principal' as Rol, fondo: 'fondo-inventado' as Rol, exigido: 'AA' },
    ]),
    /rol inexistente/,
  )
})
