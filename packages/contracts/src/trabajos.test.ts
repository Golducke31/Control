import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  corridaCoherente,
  duracionDeCorrida,
  estadoDeTrabajo,
  materializarTrabajo,
  ordenarTrabajos,
  trabajosQuePreocupan,
} from './trabajos.ts'
import type { Corrida, EscenarioDeTrabajo, Trabajo } from './trabajos.ts'
import { trabajos } from './fixtures.ts'

const AHORA = Date.parse('2026-09-20T14:00:00.000Z')
const HORA = 3600_000
const DIA = 24 * HORA

function trabajo(parcial: Partial<Trabajo> = {}): Trabajo {
  return {
    codigo: 'prueba.job',
    descripcion: 'Un job de prueba',
    cadenciaMs: DIA,
    toleranciaMs: 2 * HORA,
    critico: false,
    activo: true,
    ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - HORA).toISOString() }),
    ...parcial,
  }
}

function corrida(parcial: Partial<Corrida> = {}): Corrida {
  return {
    iniciadaEn: new Date(AHORA - HORA).toISOString(),
    terminadaEn: new Date(AHORA - HORA + 60_000).toISOString(),
    estado: 'succeeded',
    host: 'worker-1',
    error: null,
    ...parcial,
  }
}

// ---------------------------------------------------------------------------
// El estado derivado
// ---------------------------------------------------------------------------

test('un job que corrió hace poco está al día', () => {
  assert.equal(estadoDeTrabajo(trabajo(), AHORA), 'al_dia')
})

test('un job inactivo se informa como inactivo, sin importar cuándo corrió', () => {
  assert.equal(estadoDeTrabajo(trabajo({ activo: false }), AHORA), 'inactivo')
})

test('un job que nunca corrió se distingue de uno atrasado', () => {
  // Es la distinción que da sentido a la ventana: un job que dejó de correr no deja
  // error, y sin esta separación se vería igual que uno que nunca se configuró.
  assert.equal(estadoDeTrabajo(trabajo({ ultimaCorrida: null }), AHORA), 'sin_correr')
})

test('una corrida viva manda sobre todo lo demás', () => {
  const corriendo = trabajo({
    ultimaCorrida: corrida({ estado: 'running', terminadaEn: null, iniciadaEn: new Date(AHORA - 3 * DIA).toISOString() }),
  })
  assert.equal(estadoDeTrabajo(corriendo, AHORA), 'corriendo', 'aunque lleve tres días, está corriendo')
})

test('una última corrida fallida se informa como fallando, no como atrasado', () => {
  const fallado = trabajo({
    ultimaCorrida: corrida({ estado: 'failed', error: 'timeout', iniciadaEn: new Date(AHORA - 3 * DIA).toISOString() }),
  })
  assert.equal(estadoDeTrabajo(fallado, AHORA), 'fallando')
})

test('el atraso se mide desde que la corrida EMPEZÓ, no desde que terminó', () => {
  // Un job que terminó hace un rato pero no volvió a arrancar está atrasado igual: lo que
  // se vigila es la cadencia de arranques.
  const empezóHaceMucho = trabajo({
    ultimaCorrida: corrida({
      iniciadaEn: new Date(AHORA - (DIA + 3 * HORA)).toISOString(),
      terminadaEn: new Date(AHORA - (DIA + 3 * HORA) + 10 * 60_000).toISOString(),
    }),
  })
  assert.equal(estadoDeTrabajo(empezóHaceMucho, AHORA), 'atrasado')
})

test('la frontera del atraso es la cadencia más la tolerancia', () => {
  const justo = trabajo({
    cadenciaMs: DIA,
    toleranciaMs: 2 * HORA,
    ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - (DIA + 2 * HORA)).toISOString() }),
  })
  assert.equal(estadoDeTrabajo(justo, AHORA), 'al_dia', 'exactamente en el límite todavía no está atrasado')

  const pasado = trabajo({
    cadenciaMs: DIA,
    toleranciaMs: 2 * HORA,
    ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - (DIA + 2 * HORA + 1)).toISOString() }),
  })
  assert.equal(estadoDeTrabajo(pasado, AHORA), 'atrasado', 'un milisegundo más allá, sí')
})

test('un job con tolerancia cero se atrasa apenas pasa su cadencia', () => {
  const sinTolerancia = trabajo({
    toleranciaMs: 0,
    ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - DIA - 1).toISOString() }),
  })
  assert.equal(estadoDeTrabajo(sinTolerancia, AHORA), 'atrasado')
})

// ---------------------------------------------------------------------------
// La coherencia del motor
// ---------------------------------------------------------------------------

test('una corrida viva no tiene hora de fin (espeja job_runs_finished_consistency)', () => {
  assert.equal(corridaCoherente(corrida({ estado: 'running', terminadaEn: null })), true)
  assert.equal(corridaCoherente(corrida({ estado: 'succeeded', terminadaEn: null })), false)
  assert.equal(
    corridaCoherente(corrida({ estado: 'running', terminadaEn: new Date(AHORA).toISOString() })),
    false,
    'decir que corre y tener hora de fin haría informar una duración de algo vivo',
  )
})

test('la duración es null mientras la corrida está viva', () => {
  assert.equal(duracionDeCorrida(corrida({ estado: 'running', terminadaEn: null })), null)
  assert.equal(duracionDeCorrida(corrida()), 60_000)
})

// ---------------------------------------------------------------------------
// El tablero
// ---------------------------------------------------------------------------

test('trabajosQuePreocupan deja afuera lo que está al día, corriendo o inactivo', () => {
  const lista = [
    trabajo({ codigo: 'a', ultimaCorrida: corrida({ estado: 'failed' }) }),
    trabajo({ codigo: 'b', ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - 5 * DIA).toISOString() }) }),
    trabajo({ codigo: 'c', ultimaCorrida: null }),
    trabajo({ codigo: 'd' }),
    trabajo({ codigo: 'e', activo: false }),
  ]
  assert.deepEqual(
    trabajosQuePreocupan(lista, AHORA).map((t) => t.codigo),
    ['a', 'b', 'c'],
  )
})

test('el tablero ordena por estado y después por criticidad', () => {
  const lista = [
    trabajo({ codigo: 'al-dia-critico', critico: true }),
    trabajo({ codigo: 'fallando', ultimaCorrida: corrida({ estado: 'failed' }) }),
    trabajo({ codigo: 'atrasado', ultimaCorrida: corrida({ iniciadaEn: new Date(AHORA - 5 * DIA).toISOString() }) }),
    trabajo({ codigo: 'nunca', ultimaCorrida: null }),
  ]
  assert.deepEqual(
    ordenarTrabajos(lista, AHORA).map((t) => t.codigo),
    ['fallando', 'atrasado', 'nunca', 'al-dia-critico'],
  )
})

test('a igual estado, lo crítico va primero', () => {
  const lista = [
    trabajo({ codigo: 'no-critico' }),
    trabajo({ codigo: 'critico', critico: true }),
  ]
  assert.deepEqual(
    ordenarTrabajos(lista, AHORA).map((t) => t.codigo),
    ['critico', 'no-critico'],
  )
})

// ---------------------------------------------------------------------------
// El mundo simulado
// ---------------------------------------------------------------------------

test('materializarTrabajo arma fechas absolutas desde el desfase', () => {
  const escenario: EscenarioDeTrabajo = {
    codigo: 'x',
    descripcion: 'X',
    cadenciaMs: DIA,
    toleranciaMs: HORA,
    critico: true,
    activo: true,
    ultimaCorridaHaceMs: 2 * HORA,
    duracionMs: 30_000,
    estadoDeLaUltimaCorrida: 'succeeded',
    host: 'worker-1',
    error: null,
  }
  const materializado = materializarTrabajo(escenario, AHORA)
  assert.equal(materializado.ultimaCorrida?.iniciadaEn, new Date(AHORA - 2 * HORA).toISOString())
  assert.equal(materializado.ultimaCorrida?.terminadaEn, new Date(AHORA - 2 * HORA + 30_000).toISOString())
  assert.equal(estadoDeTrabajo(materializado, AHORA), 'al_dia')
})

test('materializarTrabajo respeta la coherencia de una corrida viva', () => {
  const escenario: EscenarioDeTrabajo = {
    codigo: 'x',
    descripcion: 'X',
    cadenciaMs: DIA,
    toleranciaMs: HORA,
    critico: false,
    activo: true,
    ultimaCorridaHaceMs: 5 * 60_000,
    duracionMs: null,
    estadoDeLaUltimaCorrida: 'running',
    host: 'worker-2',
    error: null,
  }
  const materializado = materializarTrabajo(escenario, AHORA)
  assert.equal(materializado.ultimaCorrida?.terminadaEn, null)
  assert.equal(corridaCoherente(materializado.ultimaCorrida!), true)
  assert.equal(estadoDeTrabajo(materializado, AHORA), 'corriendo')
})

test('los escenarios simulados cubren los estados que la ventana tiene que mostrar', () => {
  const materializados = trabajos.map((escenario) => materializarTrabajo(escenario, AHORA))
  const estados = new Set(materializados.map((t) => estadoDeTrabajo(t, AHORA)))

  // Sin esta cobertura, la ventana mostraría siempre el mismo estado y no se vería si el
  // cálculo funciona.
  assert.ok(estados.has('al_dia'), 'hace falta uno al día')
  assert.ok(estados.has('atrasado'), 'y uno atrasado: es el caso que la ventana existe para mostrar')
  assert.ok(estados.has('fallando'), 'y uno que falló')
  assert.ok(estados.has('sin_correr'), 'y uno que nunca corrió')

  for (const materializado of materializados) {
    if (materializado.ultimaCorrida !== null) {
      assert.equal(corridaCoherente(materializado.ultimaCorrida), true, `${materializado.codigo} es incoherente`)
    }
  }
})

test('los cuatro jobs sembrados por el motor están en los escenarios', () => {
  const codigos = trabajos.map((t) => t.codigo)
  for (const esperado of ['partition.maintenance', 'partition.retention', 'certificate.expiry', 'stock.reconciliation']) {
    assert.ok(codigos.includes(esperado), `falta el job ${esperado}, que el motor siembra`)
  }
})
