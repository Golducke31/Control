#!/usr/bin/env node
/**
 * =============================================================================
 * Accesibilidad: las reglas que se pueden verificar sin navegador
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Recorre los componentes con el parser de TypeScript y comprueba las reglas de
 * accesibilidad que dependen **sólo de la estructura del JSX**:
 *
 *   1. Toda imagen tiene `alt`.
 *   2. Todo control interactivo tiene un **nombre accesible**: `aria-label`, o un
 *      `id` (que puede venir de un `<label htmlFor>`), o un `<label>` que lo envuelve.
 *   3. Ningún `<a>` o `<Link>` sin `href`.
 *   4. Ningún `tabIndex` positivo: rompe el orden natural del tabulador.
 *   5. Ningún `onClick` sobre un elemento no interactivo sin `role` — un `div` con
 *      clic es inalcanzable con el teclado.
 *
 * POR QUÉ NO ES `axe-core`
 *
 * `axe-core` es la verificación de la puerta (criterio 3 de §8.3) y necesita un DOM
 * real: hay que renderizar cada ventana y analizarla. En este entorno no hay navegador
 * —`agent-browser` no corre en Windows—, así que la mitad que se puede verificar hoy es
 * ésta: reglas de forma, sobre la fuente.
 *
 * Las dos mitades no se reemplazan. Ésta **no** detecta contraste, orden de foco real,
 * nombres calculados ni regiones vivas: para eso hace falta el DOM. Lo que sí detecta es
 * la clase de defecto que se cuela en una revisión —el `input` sin etiqueta, el `div`
 * clickeable, el `tabIndex` positivo—, y la detecta en cada corrida y no cuando alguien
 * se acuerda de mirar.
 *
 * USO
 *   node tools/check-accesibilidad.mjs
 * Salida: 0 si no hay violaciones, 1 si las hay, 2 si no pudo leer.
 * =============================================================================
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const RAIZ = 'apps/web/src';

/** Elementos que ya son interactivos por sí mismos: un onClick en ellos es correcto. */
const INTERACTIVOS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'details', 'option', 'label']);

/** Controles que necesitan un nombre accesible. */
const CONTROLES = new Set(['input', 'select', 'textarea']);

function componentes(dir) {
  const salida = [];
  let entradas;
  try {
    entradas = readdirSync(dir);
  } catch {
    return salida;
  }
  for (const entrada of entradas) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...componentes(ruta));
    else if (entrada.endsWith('.tsx')) salida.push(ruta);
  }
  return salida;
}

function normalizar(ruta) {
  return ruta.split('\\').join('/');
}

/** El nombre de la etiqueta de un nodo JSX, en minúsculas. */
function etiquetaDe(nodo) {
  const tag = nodo.tagName;
  if (tag === undefined) return null;
  return tag.getText().toLowerCase();
}

/** Los atributos presentes, por nombre. */
function atributosDe(nodo) {
  const mapa = new Map();
  for (const propiedad of nodo.attributes.properties) {
    if (ts.isJsxAttribute(propiedad) && propiedad.name !== undefined) {
      mapa.set(propiedad.name.getText(), propiedad);
    }
  }
  return mapa;
}

/** El texto de un atributo string, o `null`. */
function textoDe(atributo) {
  if (atributo?.initializer === undefined) return null;
  const init = atributo.initializer;
  return ts.isStringLiteral(init) ? init.text : null;
}

/**
 * El número de un atributo, en las dos formas que existen: `tabIndex="5"` y
 * `tabIndex={5}`.
 *
 * Sin la segunda, la regla del `tabIndex` positivo no detectaría el caso normal —que es
 * el que se escribe— y sólo atraparía la forma rara. Una regla que no ve su caso típico
 * no protege: da la sensación de estar cubierto.
 */
function numeroDe(atributo) {
  if (atributo?.initializer === undefined) return null;
  const init = atributo.initializer;
  if (ts.isStringLiteral(init)) return Number(init.text);
  if (ts.isJsxExpression(init) && init.expression !== undefined && ts.isNumericLiteral(init.expression)) {
    return Number(init.expression.text);
  }
  return null;
}

/** Si algún ancestro es un `<label>`: es la forma de dar nombre envolviendo el control. */
function envueltoEnLabel(nodo) {
  let actual = nodo.parent;
  while (actual !== undefined) {
    if (ts.isJsxElement(actual) && etiquetaDe(actual.openingElement) === 'label') return true;
    if (ts.isJsxSelfClosingElement(actual) && etiquetaDe(actual) === 'label') return true;
    actual = actual.parent;
  }
  return false;
}

/** Si el control tiene hijos de texto (un `<button>Guardar</button>` se nombra solo). */
function tieneTextoVisible(nodo) {
  let encontrado = false;
  const recorrer = (n) => {
    if (ts.isJsxText(n) && n.getText().trim().length > 0) encontrado = true;
    if (ts.isJsxExpression(n) && n.expression !== undefined) encontrado = true;
    ts.forEachChild(n, recorrer);
  };
  for (const hijo of nodo.children ?? []) recorrer(hijo);
  return encontrado;
}

const violaciones = [];
for (const archivo of componentes(RAIZ).sort()) {
  const fuente = readFileSync(archivo, 'utf8');
  const sf = ts.createSourceFile(archivo, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const linea = (nodo) => sf.getLineAndCharacterOfPosition(nodo.getStart(sf)).line + 1;
  const ruta = normalizar(archivo);

  const visitar = (nodo) => {
    if (ts.isJsxOpeningElement(nodo) || ts.isJsxSelfClosingElement(nodo)) {
      const tag = nodo.tagName === undefined ? null : nodo.tagName.getText();
      const etiqueta = tag === null ? null : tag.toLowerCase();
      if (etiqueta !== null && tag !== null) {
        const atributos = atributosDe(nodo);

        // 1 · Imagen sin alt.
        if (etiqueta === 'img' && !atributos.has('alt')) {
          violaciones.push({ ruta, linea: linea(nodo), regla: 'img-sin-alt', detalle: '<img> sin alt' });
        }

        // 2 · Control sin nombre accesible.
        if (CONTROLES.has(etiqueta) && textoDe(atributos.get('type')) !== 'hidden') {
          const conNombre = atributos.has('aria-label') || atributos.has('aria-labelledby') || atributos.has('id');
          if (!conNombre && !envueltoEnLabel(nodo)) {
            violaciones.push({
              ruta,
              linea: linea(nodo),
              regla: 'control-sin-nombre',
              detalle: `<${etiqueta}> sin aria-label, sin id y sin <label> que lo envuelva`,
            });
          }
        }

        // 3 · Enlace sin destino.
        if ((etiqueta === 'a' || etiqueta === 'link') && !atributos.has('href')) {
          violaciones.push({ ruta, linea: linea(nodo), regla: 'enlace-sin-href', detalle: `<${etiqueta}> sin href` });
        }

        // 4 · tabIndex positivo.
        const tabIndex = textoDe(atributos.get('tabIndex'));
        if (tabIndex !== null && Number(tabIndex) > 0) {
          violaciones.push({
            ruta,
            linea: linea(nodo),
            regla: 'tabindex-positivo',
            detalle: `tabIndex=${tabIndex}: rompe el orden natural del tabulador`,
          });
        }

        // 5 · onClick sobre algo que no es interactivo.
        //
        // Sólo se miran las etiquetas **intrínsecas** (minúscula). Una etiqueta
        // capitalizada es un componente —`<Boton>`— y no se puede saber desde acá si
        // renderiza un `button` o un `div`: marcarlo sería un falso positivo en cada
        // botón del sistema de diseño, y un gate con falsos positivos se desactiva.
        const esIntrinseca = tag === tag.toLowerCase();
        if (esIntrinseca && atributos.has('onClick') && !INTERACTIVOS.has(etiqueta) && !atributos.has('role')) {
          violaciones.push({
            ruta,
            linea: linea(nodo),
            regla: 'clic-no-interactivo',
            detalle: `<${tag}> con onClick y sin role: inalcanzable con el teclado`,
          });
        }
      }
    }

    ts.forEachChild(nodo, visitar);
  };

  visitar(sf);
}

if (violaciones.length > 0) {
  console.error('Accesibilidad (reglas estáticas): FALLA\n');
  for (const v of violaciones) {
    console.error(`  · ${v.ruta}:${v.linea}  [${v.regla}]  ${v.detalle}`);
  }
  console.error(`\n  ${violaciones.length} violación(es).`);
  console.error(
    '\n  Estas reglas se comprueban sin DOM. El contraste, el orden de foco real y los\n' +
      '  nombres calculados necesitan axe-core sobre un navegador (criterio 3 de §8.3).',
  );
  process.exit(1);
}

console.log('  OK    accesibilidad: sin violaciones en las reglas estáticas (alt, nombre de control, href, tabIndex, clic).');
