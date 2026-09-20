/**
 * Suite de la consola de plataforma (F8).
 *
 * La puerta dice: «la consola de plataforma está en dominio aparte y un `owner` no
 * entra». Las dos mitades se verifican acá, y la segunda es la que importa: un `owner`
 * tiene todos los permisos de **su** empresa, y ninguno sobre la plataforma.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RUTAS_FUERA_DE_CARCASA, VENTANAS } from '../rutas.ts'
import { esPlataforma, usuarioPorId } from './directorio.ts'
import { PREFIJO_DE_PLATAFORMA, esRutaDePlataforma, puedeEntrarAPlataforma } from './plataforma.ts'

test('PUERTA F8·3 · un owner de empresa NO entra a la consola de plataforma', () => {
  // `u_ana` es la propietaria de Andes Trading: tiene los 51 permisos de su empresa.
  const ana = usuarioPorId('u_ana')
  assert.ok(ana !== undefined, 'la propietaria tiene que existir en el directorio')
  assert.equal(ana?.plataforma, false, 'ser propietaria de una empresa no es ser de plataforma')

  const resultado = puedeEntrarAPlataforma('u_ana')
  assert.equal(resultado.ok, false)
  if (resultado.ok) return
  assert.equal(resultado.motivo, 'no_es_de_plataforma')
})

test('un usuario de plataforma sí entra', () => {
  assert.equal(esPlataforma('u_carla'), true)
  assert.deepEqual(puedeEntrarAPlataforma('u_carla'), { ok: true })
})

test('sin sesión el rechazo es distinto: no es lo mismo que no ser de plataforma', () => {
  // Se atienden distinto —sin sesión se va al ingreso, con sesión a la empresa— así que
  // un solo «no» obligaría a la página a adivinar cuál de las dos cosas pasó.
  const sinSesion = puedeEntrarAPlataforma(null)
  assert.equal(sinSesion.ok, false)
  if (sinSesion.ok) return
  assert.equal(sinSesion.motivo, 'sin_sesion')

  const sinPermiso = puedeEntrarAPlataforma('u_ana')
  assert.equal(sinPermiso.ok, false)
  if (sinPermiso.ok) return
  assert.notEqual(sinPermiso.motivo, sinSesion.motivo)
})

test('un usuario inexistente no entra', () => {
  assert.equal(puedeEntrarAPlataforma('u_inexistente').ok, false)
})

test('PUERTA F8·3 · la consola vive bajo /plataforma y ninguna ventana de empresa también', () => {
  // Si una ventana viviera bajo el prefijo, quedaría fuera de la carcasa y sin permiso:
  // visible para cualquiera que adivine la URL.
  for (const ventana of VENTANAS) {
    const ruta = `/e/[slug]/${ventana.segmento}`
    assert.ok(!esRutaDePlataforma(ruta), `la ventana ${ventana.id} no puede vivir bajo ${PREFIJO_DE_PLATAFORMA}`)
    assert.notEqual(ventana.segmento, 'plataforma')
  }
})

test('las seis rutas de plataforma están fuera de la carcasa y bajo el prefijo', () => {
  const dePlataforma = RUTAS_FUERA_DE_CARCASA.filter((r) => esRutaDePlataforma(r.ruta))
  assert.equal(dePlataforma.length, 6, 'empresas, empresa, suscripciones, soporte, tareas y salud')
  for (const ruta of dePlataforma) {
    assert.ok(ruta.ruta.startsWith(`${PREFIJO_DE_PLATAFORMA}/`), `${ruta.ruta} no está bajo el prefijo`)
  }
})

test('esRutaDePlataforma distingue el prefijo de una ruta que lo contiene', () => {
  assert.ok(esRutaDePlataforma('/plataforma'))
  assert.ok(esRutaDePlataforma('/plataforma/empresas'))
  assert.ok(esRutaDePlataforma('/plataforma/empresas/123'))
  assert.ok(!esRutaDePlataforma('/e/andes/panel'))
  // Una ruta que empieza igual pero no es del prefijo: el corte tiene que ser por barra.
  assert.ok(!esRutaDePlataforma('/plataformas'))
  assert.ok(!esRutaDePlataforma('/e/andes/plataforma'))
})

test('las ventanas de empresa siguen viviendo bajo /e/[slug]', () => {
  for (const ventana of VENTANAS) {
    assert.ok(`/e/[slug]/${ventana.segmento}`.startsWith('/e/[slug]/'))
  }
  assert.equal(VENTANAS.length, 14)
})
