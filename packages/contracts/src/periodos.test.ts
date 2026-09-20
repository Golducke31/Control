import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admiteAsientos,
  cerrarPeriodo,
  fueReabierto,
  periodosQueContienen,
  reabrirPeriodo,
  resolverPeriodo,
} from './periodos.ts'
import type { Periodo } from './contabilidad.ts'
import { periodos } from './fixtures.ts'

function periodo(parcial: Partial<Periodo> = {}): Periodo {
  return {
    id: 'per_1',
    numero: 9,
    nombre: 'Septiembre 2026',
    ejercicio: 2026,
    desde: '2026-09-01',
    hasta: '2026-09-30',
    estado: 'open',
    cerradoEn: null,
    cerradoPor: null,
    reabiertoEn: null,
    reabiertoPor: null,
    motivoReapertura: null,
    asientosPendientes: 0,
    ...parcial,
  }
}

const FECHA = '2026-09-15'

// ---------------------------------------------------------------------------
// Qué período acepta asientos
// ---------------------------------------------------------------------------

test('un período abierto acepta asientos y uno cerrado no', () => {
  assert.equal(admiteAsientos(periodo({ estado: 'open' })), true)
  assert.equal(admiteAsientos(periodo({ estado: 'closed' })), false)
})

test('`closing` SÍ acepta asientos: es donde entran los ajustes de cierre', () => {
  // El caso que un modelo mental apurado trataría como cerrado. Si `closing` no
  // aceptara, el cierre del mes sería imposible de asentar.
  assert.equal(admiteAsientos(periodo({ estado: 'closing' })), true)
})

test('periodosQueContienen respeta las dos fronteras del rango', () => {
  const septiembre = periodo()
  assert.deepEqual(periodosQueContienen([septiembre], '2026-09-01').length, 1, 'primer día')
  assert.deepEqual(periodosQueContienen([septiembre], '2026-09-30').length, 1, 'último día')
  assert.deepEqual(periodosQueContienen([septiembre], '2026-08-31'), [], 'un día antes')
  assert.deepEqual(periodosQueContienen([septiembre], '2026-10-01'), [], 'un día después')
})

test('resolverPeriodo encuentra el período abierto que contiene la fecha', () => {
  const r = resolverPeriodo([periodo()], FECHA)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.periodo.nombre, 'Septiembre 2026')
})

test('resolverPeriodo acepta imputar en un período en cierre', () => {
  const r = resolverPeriodo([periodo({ estado: 'closing' })], FECHA)
  assert.equal(r.ok, true)
})

test('resolverPeriodo distingue «cerrado» de «fuera de período»', () => {
  const cerrado = resolverPeriodo([periodo({ estado: 'closed', cerradoEn: '2026-10-05T12:00:00.000Z' })], FECHA)
  assert.equal(cerrado.ok, false)
  if (cerrado.ok) return
  assert.equal(cerrado.motivo, 'periodo_cerrado', 'el período existe y está cerrado')
  assert.equal(cerrado.periodo.estado, 'closed', 'y se informa cuál, para poder decirlo')

  const fuera = resolverPeriodo([periodo()], '2026-11-15')
  assert.equal(fuera.ok, false)
  if (fuera.ok) return
  assert.equal(fuera.motivo, 'fuera_de_periodo', 'no hay ningún período que contenga la fecha')
})

test('resolverPeriodo saltea el período cerrado si otro abierto contiene la fecha', () => {
  // Dos períodos solapados —una situación que el motor evita, pero que el
  // resolutor tiene que resolver igual: gana el abierto.
  const r = resolverPeriodo(
    [periodo({ id: 'a', estado: 'closed' }), periodo({ id: 'b', estado: 'open' })],
    FECHA,
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.periodo.id, 'b')
})

test('resolverPeriodo rechaza una fecha que no es ISO', () => {
  // La comparación es de texto: una fecha con hora o en otro formato compararía
  // mal y en silencio, así que se falla fuerte.
  assert.throws(() => resolverPeriodo([periodo()], '2026-09-15T12:00:00.000Z'), /ISO/)
  assert.throws(() => resolverPeriodo([periodo()], '15/09/2026'), /ISO/)
})

// ---------------------------------------------------------------------------
// PUERTA F6 · el cierre de período se ve reflejado
// ---------------------------------------------------------------------------

test('PUERTA F6·3 · después de cerrar, el período deja de aceptar asientos', () => {
  const abierto = periodo()

  // Antes: se imputa sin problema.
  const antes = resolverPeriodo([abierto], FECHA)
  assert.equal(antes.ok, true)

  const cierre = cerrarPeriodo(abierto, { fecha: '2026-10-05T12:00:00.000Z', autor: 'Ana Dueña', asientosPendientes: 0 })
  assert.equal(cierre.ok, true)
  if (!cierre.ok) return

  // Después: el mismo período, la misma fecha, ya no acepta. Esto es «el cierre se
  // ve reflejado»: no hace falta ninguna otra bandera, el estado alcanza.
  const despues = resolverPeriodo([cierre.periodo], FECHA)
  assert.equal(despues.ok, false)
  if (despues.ok) return
  assert.equal(despues.motivo, 'periodo_cerrado')
  assert.equal(despues.periodo.cerradoPor, 'Ana Dueña', 'y queda quién lo cerró')
})

test('el cierre mantiene la coherencia del motor: closed y cerradoEn van juntos', () => {
  // Espeja `periods_closed_coherent`.
  const cierre = cerrarPeriodo(periodo(), { fecha: '2026-10-05T12:00:00.000Z', autor: 'Ana', asientosPendientes: 0 })
  assert.equal(cierre.ok, true)
  if (!cierre.ok) return
  assert.equal(cierre.periodo.estado === 'closed', cierre.periodo.cerradoEn !== null)
  assert.equal(cierre.periodo.cerradoEn, '2026-10-05T12:00:00.000Z')
})

test('no se cierra un período con asientos en borrador', () => {
  const r = cerrarPeriodo(periodo({ asientosPendientes: 3 }), {
    fecha: '2026-10-05T12:00:00.000Z',
    autor: 'Ana',
    asientosPendientes: 3,
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'asientos_pendientes')
  assert.equal(r.cantidad, 3, 'se informa cuántos, para poder listarlos')
})

test('cerrar un período ya cerrado se rechaza', () => {
  const r = cerrarPeriodo(periodo({ estado: 'closed', cerradoEn: '2026-10-05T12:00:00.000Z' }), {
    fecha: '2026-10-06T12:00:00.000Z',
    autor: 'Ana',
    asientosPendientes: 0,
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'ya_cerrado')
})

test('un período en cierre también se puede cerrar', () => {
  const r = cerrarPeriodo(periodo({ estado: 'closing' }), {
    fecha: '2026-10-05T12:00:00.000Z',
    autor: 'Ana',
    asientosPendientes: 0,
  })
  assert.equal(r.ok, true, 'closing es un paso previo de closed, no un estado terminal')
})

// ---------------------------------------------------------------------------
// Reapertura
// ---------------------------------------------------------------------------

test('una reapertura sin motivo se rechaza (espeja periods_reopen_coherent)', () => {
  const cerrado = periodo({ estado: 'closed', cerradoEn: '2026-10-05T12:00:00.000Z', cerradoPor: 'Ana' })
  for (const motivo of ['', '   ']) {
    const r = reabrirPeriodo(cerrado, { fecha: '2026-10-20T12:00:00.000Z', autor: 'Ana', motivo })
    assert.equal(r.ok, false)
    if (r.ok) continue
    assert.equal(r.motivo, 'motivo_requerido')
  }
})

test('no se reabre un período que no está cerrado', () => {
  const r = reabrirPeriodo(periodo({ estado: 'open' }), {
    fecha: '2026-10-20T12:00:00.000Z',
    autor: 'Ana',
    motivo: 'corrección',
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.motivo, 'no_esta_cerrado')
})

test('reabrir devuelve el período a open y deja el rastro de la reapertura', () => {
  const cerrado = periodo({ estado: 'closed', cerradoEn: '2026-10-05T12:00:00.000Z', cerradoPor: 'Ana' })
  const r = reabrirPeriodo(cerrado, {
    fecha: '2026-10-20T12:00:00.000Z',
    autor: 'Beto',
    motivo: 'Faltó imputar la factura de flete',
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.periodo.estado, 'open')
  assert.equal(r.periodo.cerradoEn, null, 'el cierre anterior se limpia: no puede quedar un cierre colgado')
  assert.equal(r.periodo.cerradoPor, null)
  assert.equal(r.periodo.reabiertoPor, 'Beto')
  assert.equal(r.periodo.motivoReapertura, 'Faltó imputar la factura de flete')
  assert.equal(fueReabierto(r.periodo), true)

  // Y vuelve a aceptar asientos: el ciclo cierra.
  assert.equal(resolverPeriodo([r.periodo], FECHA).ok, true)
})

// ---------------------------------------------------------------------------
// Los datos simulados
// ---------------------------------------------------------------------------

test('los períodos simulados muestran el cierre y la reapertura', () => {
  const cerrados = periodos.filter((p) => p.estado === 'closed')
  const abiertos = periodos.filter((p) => p.estado === 'open')
  assert.ok(cerrados.length > 0, 'hace falta al menos un período cerrado, para ver el estado')
  assert.ok(abiertos.length > 0, 'y al menos uno abierto, para poder imputar')
  assert.ok(periodos.some(fueReabierto), 'y uno reabierto, para ver el rastro con motivo y autor')

  for (const p of periodos) {
    assert.equal(
      p.estado === 'closed',
      p.cerradoEn !== null,
      `${p.nombre}: closed y cerradoEn tienen que ir juntos`,
    )
    if (p.reabiertoEn !== null) {
      assert.ok(p.motivoReapertura !== null && p.reabiertoPor !== null, `${p.nombre}: reapertura sin motivo ni autor`)
    }
  }
})
