/**
 * =============================================================================
 * Control · Evaluación de la cadencia de jobs
 * -----------------------------------------------------------------------------
 * `scheduleIntervalMs` tenía que existir para que el scheduler decidiera sin un
 * timer en memoria. Acá se prueba sola, sin base: es la única parte del
 * scheduler que es función pura, y por eso es la que se puede probar de verdad.
 *
 * El backend de tests es `node:test`, el runner nativo de Node. La razón es la
 * misma por la que el scheduler no usa un parser de cron: cada dependencia
 * nueva hay que mantenerla, y esto no la necesita. `node --test` se instala con
 * el runtime.
 *
 * Los casos que importan no son los felices —esos se ven a simple vista— sino
 * los bordes: una expresión que parece válida y no lo es, o una forma de cron
 * que el proyecto podría llegar a usar y hoy falla en silencio.
 * =============================================================================
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scheduleIntervalMs } from './scheduler.js';

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

test('cada N minutos se convierte a milisegundos', () => {
  assert.equal(scheduleIntervalMs('*/15 * * * *'), 15 * MINUTO);
  assert.equal(scheduleIntervalMs('*/30 * * * *'), 30 * MINUTO);
  assert.equal(scheduleIntervalMs('*/1 * * * *'), MINUTO);
});

test('una hora fija con día comodín es diaria', () => {
  assert.equal(scheduleIntervalMs('0 3 * * *'), DIA);
  assert.equal(scheduleIntervalMs('30 4 * * *'), DIA);
  assert.equal(scheduleIntervalMs('59 23 * * *'), DIA);
});

test('el día 1 del mes es mensual', () => {
  assert.equal(scheduleIntervalMs('0 5 1 * *'), 30 * DIA);
  assert.equal(scheduleIntervalMs('15 6 1 * *'), 30 * DIA);
});

test('el intervalo mensual es mayor que el diario', () => {
  // Es la propiedad que hace que el orden de los `if` importe: si la rama
  // mensual se evaluara antes que la diaria, "0 5 1 * *" daría un día.
  assert.ok(scheduleIntervalMs('0 5 1 * *') > scheduleIntervalMs('0 5 * * *'));
});

test('una expresión de cuatro campos falla', () => {
  assert.throws(() => scheduleIntervalMs('0 3 * *'), /no soportada/);
});

test('una expresión de seis campos falla', () => {
  assert.throws(() => scheduleIntervalMs('0 0 3 * * *'), /no soportada/);
});

test('una cadencia con restricción de calendario falla en vez de aproximarse', () => {
  // Este es el caso que el test anterior destapó y que la implementación
  // original no cubría: `dow` (día de semana) y `mes` se ignoraban por completo.
  // "0 3 * * MON" habría devuelto un día — y el job correría todos los días en
  // vez de sólo los lunes.
  assert.throws(() => scheduleIntervalMs('0 3 * * MON'), /no soportada/);
  assert.throws(() => scheduleIntervalMs('0 3 * * 1'), /no soportada/);
  assert.throws(() => scheduleIntervalMs('0 3 * 6 *'), /no soportada/);
  assert.throws(() => scheduleIntervalMs('*/15 * * * MON'), /no soportada/);
  assert.throws(() => scheduleIntervalMs('0 3 1 3 *'), /no soportada/);
});

test('la restricción de calendario se detecta antes que la forma de intervalo', () => {
  // El orden importa: si la rama de "cada N minutos" se evaluara primero,
  // "*/15 * * * MON" devolvería 15 minutos sin error. El rechazo tiene que
  // ocurrir antes de llegar a las ramas de interpretación.
  assert.throws(() => scheduleIntervalMs('*/15 * * * SAT'), /no soportada/);
});

test('el mensaje de error del campo de calendario explica el motivo', () => {
  // Un error que no dice por qué no se acepta obliga a leer el código fuente.
  try {
    scheduleIntervalMs('0 3 * * MON');
    assert.fail('debía lanzar');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /mes y día-de-semana/);
    assert.match(msg, /intervalo/);
  }
});

test('el mensaje de error por cantidad de campos dice cuántos se esperan', () => {
  try {
    scheduleIntervalMs('@daily');
    assert.fail('debía lanzar');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /5 campos/);
  }
});

test('el mensaje de error por forma desconocida lista las formas válidas', () => {
  // Una expresión de 5 campos que no matchea ninguna forma soportada: cae en el
  // último throw, no en el de cantidad de campos.
  try {
    scheduleIntervalMs('0,30 * * * *');
    assert.fail('debía lanzar');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, /\*\/N \* \* \* \*/);
    assert.match(msg, /M H \* \* \*/);
  }
});

test('los espacios de más no rompen la expresión', () => {
  assert.equal(scheduleIntervalMs('  0   3  *  *  *  '), DIA);
});
