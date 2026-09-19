/**
 * Suite del mapa de rutas.
 *
 * Es la puerta de la arquitectura de información: verifica que cada ventana esté
 * declarada, que su permiso exista, que ninguna ruta se repita y —lo que más importa—
 * que **cada ventana declarada tenga su archivo de página**. Sin esa última
 * comprobación, agregar una ventana al menú sin crear su ruta produce un enlace que
 * lleva a un 404, y nadie se entera hasta que un usuario hace clic.
 *
 * Trae sus pruebas negativas: el proyecto ya aprendió que un control hay que verlo fallar.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { EMPRESAS, empresaPorSlug } from './empresa.ts'
import {
  FASES,
  GRUPOS,
  PERMISOS_PENDIENTES,
  PERMISOS_SEMBRADOS,
  RUTAS_FUERA_DE_CARCASA,
  TOTAL_DE_RUTAS,
  VENTANAS,
  menuPorGrupo,
  permisosDesconocidos,
  todasLasRutas,
  ventanaPorId,
  ventanasVisibles,
} from './rutas.ts'
import type { Ventana } from './rutas.ts'

const APP = join(import.meta.dirname, 'app')
const CARPETA_DE_EMPRESA = join(APP, 'e', '[slug]')
const DOC_DEL_PLAN = join(import.meta.dirname, '..', '..', '..', 'docs', 'PLAN-FRONTEND-PRODUCCION.md')

test('el mapa declara exactamente catorce ventanas raíz', () => {
  assert.equal(VENTANAS.length, 14)
})

test('los identificadores y los segmentos de URL son únicos', () => {
  const ids = VENTANAS.map((v) => v.id)
  const segmentos = VENTANAS.map((v) => v.segmento)
  assert.equal(new Set(ids).size, ids.length, `ids repetidos: ${ids.join(', ')}`)
  assert.equal(new Set(segmentos).size, segmentos.length, `segmentos repetidos: ${segmentos.join(', ')}`)
})

test('ninguna ruta del mapa se repite', () => {
  const rutas = todasLasRutas().map((r) => r.ruta)
  const repetidas = rutas.filter((ruta, i) => rutas.indexOf(ruta) !== i)
  assert.deepEqual(repetidas, [], `rutas repetidas: ${repetidas.join(', ')}`)
})

test('toda ventana declara título, descripción, icono, grupo y fase válida', () => {
  for (const ventana of VENTANAS) {
    assert.ok(ventana.titulo.trim().length > 0, `${ventana.id}: sin título`)
    // La descripción no es decorativa: es el texto del encabezado y del estado vacío.
    assert.ok(
      ventana.descripcion.trim().length > 40,
      `${ventana.id}: la descripción tiene que explicar para qué sirve la ventana`,
    )
    assert.ok(ventana.icono.length > 0, `${ventana.id}: sin icono`)
    assert.ok(ventana.grupo in GRUPOS, `${ventana.id}: grupo «${ventana.grupo}» desconocido`)
    assert.ok(FASES.includes(ventana.fase), `${ventana.id}: fase «${ventana.fase}» desconocida`)
  }
})

test('toda subruta declara título y una fase válida', () => {
  for (const ventana of VENTANAS) {
    for (const subruta of ventana.subrutas) {
      assert.ok(subruta.titulo.trim().length > 0, `${ventana.id}/${subruta.id}: sin título`)
      assert.ok(FASES.includes(subruta.fase), `${ventana.id}/${subruta.id}: fase inválida`)
    }
  }
})

test('toda ventana declara un permiso, y ese permiso existe en el catálogo', () => {
  assert.deepEqual(permisosDesconocidos(), [])
})

test('el catálogo de permisos refleja lo que la base tiene hoy', () => {
  // 33 permisos en 13 recursos: el espejo de `app.permissions`. Si alguien cambia la
  // base y no esto —o al revés—, el número lo delata.
  assert.equal(PERMISOS_SEMBRADOS.length, 33)
  assert.equal(new Set(PERMISOS_SEMBRADOS).size, 33, 'hay permisos sembrados repetidos')
})

test('los permisos pendientes son los que el RBAC todavía no cubre', () => {
  // Cuatro módulos sin permiso propio: compras, tesorería, contabilidad, fiscal, más
  // tareas. Es el hueco que cierra la migración 0026.
  assert.ok(PERMISOS_PENDIENTES.length > 0, 'si no hay pendientes, la migración 0026 ya corrió y hay que mover esta lista')
  const recursos = new Set(PERMISOS_PENDIENTES.map((p) => p.split('.')[0]))
  assert.deepEqual(
    [...recursos].sort(),
    ['accounting', 'fiscal', 'ops', 'purchasing', 'treasury'],
  )
  // Y ningún permiso puede estar en las dos listas.
  const solapados = PERMISOS_PENDIENTES.filter((p) => (PERMISOS_SEMBRADOS as readonly string[]).includes(p))
  assert.deepEqual(solapados, [], `permisos en ambas listas: ${solapados.join(', ')}`)
})

test('cada ventana declarada tiene su archivo de página', () => {
  const faltantes: string[] = []
  for (const ventana of VENTANAS) {
    const pagina = join(CARPETA_DE_EMPRESA, ventana.segmento, 'page.tsx')
    if (!existsSync(pagina)) faltantes.push(`${ventana.id} → ${ventana.segmento}/page.tsx`)
  }
  assert.deepEqual(
    faltantes,
    [],
    `ventanas declaradas en el menú sin página: ${faltantes.join(', ')}`,
  )
})

test('no hay páginas de ventana que el mapa no declare', () => {
  // La comprobación inversa: una carpeta de ruta sin declaración es una ventana que
  // existe y no está en el menú ni en ninguna guarda.
  const enDisco = readdirSync(CARPETA_DE_EMPRESA, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => entrada.name)
  const declaradas = VENTANAS.map((v) => v.segmento)
  const sobrantes = enDisco.filter((nombre) => !declaradas.includes(nombre))
  assert.deepEqual(sobrantes, [], `carpetas de ventana sin declarar en el mapa: ${sobrantes.join(', ')}`)
})

test('el total de rutas concuerda con el que publica el plan', () => {
  const documento = readFileSync(DOC_DEL_PLAN, 'utf8')
  const encontrado = /\*\*Total: ≈(\d+) rutas\.\*\*/.exec(documento)
  assert.ok(encontrado?.[1], 'no se encontró el total de rutas en el plan de frontend')
  const declarado = Number(encontrado[1])
  // El documento dice «≈», así que se tolera una diferencia chica: lo que no se tolera
  // es que el mapa y el documento se separen.
  assert.ok(
    Math.abs(TOTAL_DE_RUTAS - declarado) <= 5,
    `el mapa tiene ${TOTAL_DE_RUTAS} rutas y el plan declara ≈${declarado}`,
  )
})

test('los grupos del menú salen en el orden declarado y sin bloques vacíos', () => {
  const bloques = menuPorGrupo([...VENTANAS])
  assert.deepEqual(
    bloques.map((b) => b.grupo),
    ['operacion', 'inventario', 'compras', 'finanzas', 'logistica', 'gobierno'],
  )
  for (const bloque of bloques) {
    assert.ok(bloque.ventanas.length > 0, `el bloque ${bloque.grupo} quedó vacío`)
  }
  // Y ninguna ventana se pierde en el camino.
  const enBloques = bloques.flatMap((b) => b.ventanas.map((v) => v.id))
  assert.deepEqual([...enBloques].sort(), VENTANAS.map((v) => v.id).sort())
})

test('el menú se filtra por permisos', () => {
  // Un encargado de depósito no ve facturación ni contabilidad.
  const visibles = ventanasVisibles(
    ['inventory.read', 'catalog.read'],
    {},
  ).map((v) => v.id)
  assert.ok(visibles.includes('stock'), 'debería ver Stock')
  assert.ok(visibles.includes('catalogo'), 'debería ver Catálogo')
  assert.ok(!visibles.includes('facturacion'), 'no debería ver Facturación')
  assert.ok(!visibles.includes('contabilidad'), 'no debería ver Contabilidad')
  // Y el panel no requiere permiso: cualquiera con sesión lo ve.
  assert.ok(visibles.includes('panel'))
})

test('el menú respeta las banderas de funcionalidad', () => {
  const conLogistica = ventanasVisibles(['logistics.read'], { 'logistics.enabled': true })
  const sinLogistica = ventanasVisibles(['logistics.read'], { 'logistics.enabled': false })
  assert.ok(conLogistica.some((v) => v.id === 'logistica'))
  assert.ok(
    !sinLogistica.some((v) => v.id === 'logistica'),
    'con la bandera apagada la ventana no puede aparecer, aunque el permiso esté',
  )
  // Y con la bandera ausente tampoco: no hay que declararla en falso para que funcione.
  assert.ok(!ventanasVisibles(['logistics.read'], {}).some((v) => v.id === 'logistica'))
})

test('las empresas de demostración son coherentes con el mapa', () => {
  for (const empresa of EMPRESAS) {
    const visibles = ventanasVisibles(empresa.permisos, empresa.funcionalidades)
    assert.ok(visibles.length > 0, `${empresa.slug} no vería ninguna ventana`)
    // Ninguna empresa puede ver una ventana cuyo permiso no tenga.
    for (const ventana of visibles) {
      if (ventana.permiso !== null) {
        assert.ok(
          empresa.permisos.includes(ventana.permiso),
          `${empresa.slug} ve ${ventana.id} sin tener ${ventana.permiso}`,
        )
      }
    }
  }

  // El propietario ve las catorce: es la demostración de que el mapa está completo.
  const andes = empresaPorSlug('andes')
  assert.ok(andes)
  assert.equal(ventanasVisibles(andes.permisos, andes.funcionalidades).length, 14)

  // Y la empresa sin logística no la ve, aunque tenga el permiso.
  const nordico = empresaPorSlug('nordico')
  assert.ok(nordico)
  assert.ok(
    !ventanasVisibles(nordico.permisos, nordico.funcionalidades).some((v) => v.id === 'logistica'),
  )
})

test('ventanaPorId devuelve la ventana y falla ante un id inexistente', () => {
  assert.equal(ventanaPorId('stock').segmento, 'stock')
  assert.throws(() => ventanaPorId('inventario'), /No existe la ventana/)
})

// ===========================================================================
// Pruebas negativas: el verificador tiene que poder fallar.
// ===========================================================================

test('el verificador de permisos detecta un permiso que no existe', () => {
  const conPermisoInventado: Ventana = {
    ...(VENTANAS[0] as Ventana),
    id: 'inventada',
    permiso: 'inventario.read' as never,
  }
  const desconocidos = permisosDesconocidos([conPermisoInventado])
  assert.deepEqual(desconocidos, ['inventario.read'])
})

test('el verificador de permisos no reporta de más', () => {
  // La contracara: si marcara todo, la prueba anterior pasaría igual y no probaría nada.
  assert.deepEqual(permisosDesconocidos(VENTANAS), [])
})

test('la comprobación de páginas detecta una ventana sin archivo', () => {
  const inventada: Ventana = {
    ...(VENTANAS[0] as Ventana),
    id: 'sin-pagina',
    segmento: 'no-existe-esta-carpeta',
  }
  const faltantes = [inventada].filter(
    (v) => !existsSync(join(CARPETA_DE_EMPRESA, v.segmento, 'page.tsx')),
  )
  assert.equal(faltantes.length, 1, 'una ventana sin página tiene que detectarse')
})

test('las rutas fuera de la carcasa no tienen permiso ni ventana', () => {
  // No están en el menú, así que no pueden depender de un permiso de empresa: el
  // tracking público se autentica con un token y la consola de plataforma con un rol
  // que un owner de empresa nunca tiene.
  const rutas = todasLasRutas().filter((r) => r.ventana === undefined)
  assert.equal(rutas.length, RUTAS_FUERA_DE_CARCASA.length)
  for (const ruta of rutas) {
    assert.ok(ruta.ruta.startsWith('/'), `${ruta.ruta} tiene que ser absoluta`)
  }
})
