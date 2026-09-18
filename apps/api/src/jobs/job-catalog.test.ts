/**
 * =============================================================================
 * Control · Coherencia del catálogo de jobs
 * -----------------------------------------------------------------------------
 * QUÉ PRUEBA
 *
 * La relación entre tres cosas que declaran lo mismo desde lugares distintos:
 *
 *   · `ops.jobs` (en la base) — el ledger de ejecuciones y la cadencia esperada.
 *   · `JOB_DEFINITIONS` (en código) — qué sabe hacer el worker.
 *   · `JOB_SCHEDULE` (en código) — cada cuánto se lo programa.
 *
 * POR QUÉ ESTA PRUEBA EXISTE
 *
 * El defecto que busca no falla: se ve como éxito. Un job registrado en
 * `ops.jobs` sin definición en el catálogo hace que el scheduler lo saltee con un
 * warning en el log, y `ops.v_job_health` lo muestre atrasado o lo ignore —pero
 * nadie generó nunca un asiento, nadie detectó nunca una brecha. El sistema
 * reporta "todo en orden" y no hizo nada. Es la misma clase de falla que
 * `assertPlatformMode()` existe para atrapar, un nivel más arriba.
 *
 * Lo que sí se puede probar acá, sin base de datos, es la coherencia interna: que
 * las dos estructuras de código no se desincronicen entre sí, y que un job nuevo
 * no entre sin cadencia. La correspondencia con `ops.jobs` se verifica en
 * `tests/accounting/run.mjs`, que sí tiene la base.
 *
 * El runner de tests es `node:test`, el nativo. La razón es la misma que en
 * `scheduler.test.ts`: cada dependencia hay que mantenerla, y esto no la necesita.
 * =============================================================================
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JOB_DEFINITIONS, JOB_SCHEDULE } from './job-runner.js';
import { scheduleIntervalMs } from './scheduler.js';

const codes = JOB_DEFINITIONS.map((d) => d.code);

test('el catálogo de jobs no tiene códigos repetidos', () => {
  // Dos definiciones con el mismo `code` competirían por la misma fila del
  // ledger: `begin_job_run()` falla si el job no está registrado, y con dos
  // definiciones el runner no sabría cuál ejecutar. El duplicado es un error de
  // programación que el índice único de la base no puede ver.
  assert.equal(new Set(codes).size, codes.length, `códigos repetidos: ${codes.join(', ')}`);
});

test('todo job del catálogo tiene una cadencia declarada', () => {
  // Sin entrada en `JOB_SCHEDULE`, el scheduler emite un warning y NO programa el
  // job. El job queda registrado, tiene implementación, y nunca corre. El warning
  // en un barrido programado no lo lee nadie.
  for (const code of codes) {
    assert.ok(
      JOB_SCHEDULE[code] !== undefined,
      `"${code}" no tiene entrada en JOB_SCHEDULE: el scheduler lo saltearía con un warning`
    );
  }
});

test('toda cadencia declarada corresponde a un job del catálogo', () => {
  // La dirección inversa: una entrada en `JOB_SCHEDULE` sin definición es un job
  // que se esperaba y no se implementó. Es el caso exacto de
  // `accounting.posting_check` antes de este cambio: registrado en `ops.jobs`,
  // agendado en la mente de quien escribió la migración, y sin código.
  for (const code of Object.keys(JOB_SCHEDULE)) {
    assert.ok(
      codes.includes(code),
      `JOB_SCHEDULE declara "${code}" pero JOB_DEFINITIONS no lo implementa`
    );
  }
});

test('toda cadencia del catálogo es una expresión que el scheduler entiende', () => {
  // El proyecto no usa un parser de cron completo: acepta formas concretas y
  // rechaza el resto para no aproximar en silencio. Una cadencia nueva que caiga
  // fuera de esas formas tiene que fallar acá, en el test, y no en producción a
  // la hora en que el job debería haber corrido.
  for (const [code, expr] of Object.entries(JOB_SCHEDULE)) {
    assert.doesNotThrow(
      () => scheduleIntervalMs(expr),
      `"${code}" tiene la cadencia "${expr}", que el scheduler no sabe interpretar`
    );
  }
});

test('los jobs transversales activan el modo plataforma', () => {
  // Un job transversal que corre sin `app.platform_admin = 'on'` lee cero filas
  // por RLS, reporta éxito y no hace nada. Es el modo de falla más traicionero del
  // sistema y no se puede detectar en runtime sin la base: lo que sí se puede
  // verificar estáticamente es que la llamada esté en el código, que es la
  // condición necesaria para que el modo se aplique.
  //
  // Se inspecciona el texto de las funciones en vez de ejecutarlas: las que
  // necesitan base no se pueden invocar sin una conexión, y montar una para esto
  // probaría la base y no el código.
  const transversal = [
    'certificate.expiry',
    'stock.reconciliation',
    'accounting.reconciliation',
    'accounting.posting_check',
    'outbox.reaper',
  ];

  for (const code of transversal) {
    const def = JOB_DEFINITIONS.find((d) => d.code === code);
    assert.ok(def !== undefined, `"${code}" no está en el catálogo`);
    assert.match(
      def.run.toString(),
      /set_tenant_context\(NULL, NULL, true\)/,
      `"${code}" es transversal y no activa el modo plataforma: ` +
        `leería cero filas por RLS y reportaría éxito sin hacer nada`
    );
  }
});

test('el job de verificación de asientos no genera los asientos que falta', () => {
  // La decisión 3 del ADR 0002: un asiento se genera en la MISMA transacción que
  // el hecho. Un job que los creara después tendría una fecha contable distinta a
  // la del hecho, y silenciaría el síntoma que hay que investigar. Si alguien
  // "arregla" el job agregando la generación, esta prueba lo tiene que frenar.
  const def = JOB_DEFINITIONS.find((d) => d.code === 'accounting.posting_check');
  assert.ok(def !== undefined, 'accounting.posting_check no está en el catálogo');

  const source = def.run.toString();
  assert.doesNotMatch(
    source,
    /post_entry_for_source|post_entry\(/,
    'el job de verificación está generando asientos: eso silencia la brecha en vez de reportarla'
  );
});

test('el job de verificación compara contra un universo no vacío', () => {
  // El control de cordura: sin el conteo de hechos esperados, un resultado con
  // cero brechas es ambiguo —puede ser "todo asentado" o "el RLS no me dejó ver
  // nada"—. La prueba exige que el job consulte cuántos hechos hay, que es lo que
  // permite distinguir los dos casos.
  const def = JOB_DEFINITIONS.find((d) => d.code === 'accounting.posting_check');
  assert.ok(def !== undefined, 'accounting.posting_check no está en el catálogo');

  const source = def.run.toString();
  assert.match(
    source,
    /billing\.invoices/,
    'el job no cuenta las facturas: no puede distinguir "todo asentado" de "no vi nada"'
  );
  assert.match(
    source,
    /app\.stock_movements/,
    'el job no cuenta los movimientos de stock: el control de cordura está incompleto'
  );
});

test('la reconciliación contable corre después de la de stock y antes de la verificación', () => {
  // El orden de los jobs nocturnos es una decisión, no una coincidencia: si un
  // asiento falta, los saldos divergen POR ESO, y conviene leer el reporte de
  // divergencias como consecuencia del de hechos sin asiento y no como causa.
  // Al revés, el operador investiga la proyección cuando el problema está en la
  // generación —el trabajo se duplica y el diagnóstico se equivoca.
  //
  // Se compara la hora de cada uno en vez de fijar los literales: lo que importa
  // es la relación, no que valga 04:45.
  const horaDe = (code: string): number => {
    const expr = JOB_SCHEDULE[code];
    assert.ok(expr !== undefined, `"${code}" no tiene cadencia`);
    const partes = expr.split(/\s+/);
    const min = Number(partes[0]);
    const h = Number(partes[1]);
    assert.ok(
      Number.isFinite(min) && Number.isFinite(h),
      `"${code}" tiene la cadencia "${expr}", que no es del tipo "M H * * *"`
    );
    return h * 60 + min;
  };

  const stock = horaDe('stock.reconciliation');
  const contable = horaDe('accounting.reconciliation');
  const posting = horaDe('accounting.posting_check');

  assert.ok(
    stock < contable,
    `la reconciliación contable (${contable}) debe correr después de la de stock (${stock}): ` +
      'la de stock captura los movimientos del día que la contable va a valuar'
  );
  assert.ok(
    contable < posting,
    `la verificación de asientos (${posting}) debe correr después de la reconciliación ` +
      `contable (${contable}): un asiento faltante explica una divergencia de saldos, ` +
      'no al revés'
  );
});

test('la reconciliación contable tampoco autocorrige los saldos', () => {
  // Mismo criterio que stock.reconciliation: la divergencia es un síntoma y
  // desde el job no se sabe cuál de las dos vistas está mal. Si el bug fue en la
  // escritura del libro, corregir el saldo propaga el error y destruye la
  // evidencia. Un `UPDATE accounting.account_balances` acá sería el defecto.
  const def = JOB_DEFINITIONS.find((d) => d.code === 'accounting.reconciliation');
  assert.ok(def !== undefined, 'accounting.reconciliation no está en el catálogo');

  const source = def.run.toString();
  assert.doesNotMatch(
    source,
    /UPDATE\s+accounting\.account_balances|INSERT\s+INTO\s+accounting\.account_balances/i,
    'el job está escribiendo los saldos: eso destruye la evidencia de dónde está el error'
  );
});
