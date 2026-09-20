#!/usr/bin/env node
/**
 * =============================================================================
 * Lint de textos: ninguna cadena de interfaz escrita en un componente
 * -----------------------------------------------------------------------------
 * QUÉ HACE
 *
 * Recorre los componentes (`apps/web/src/**\/*.tsx`) con el parser de TypeScript
 * —el mismo que usa el compilador, no una expresión regular— y busca dos cosas:
 *
 *   1. **Texto entre etiquetas** (`<p>No hay envíos</p>`).
 *   2. **Literales en atributos visibles** (`placeholder`, `title`, `aria-label`,
 *      `alt`).
 *
 * Los dos son interfaz escrita en el componente: no se pueden traducir, no se
 * pueden revisar en un solo lugar, y no hay forma de saber si falta una.
 *
 * POR QUÉ CON EL PARSER Y NO CON REGEX
 *
 * Un regex sobre TSX confunde el texto de un atributo con el de una etiqueta, se
 * pierde los literales dentro de llaves y marca los `className` como si fueran
 * prosa. El parser distingue un nodo `JsxText` de un `JsxAttribute` sin ambigüedad,
 * y no hay que mantener una lista de excepciones que se desactualiza.
 *
 * POR QUÉ HAY UNA LÍNEA BASE
 *
 * La migración a `next-intl` es grande —hay diez ventanas cableadas antes de F8— y
 * hacerla de una sola vez obligaría a un commit que nadie puede revisar. La línea
 * base (`tools/textos-pendientes.json`) registra **cuántos** textos tiene hoy cada
 * archivo, y la regla es un trinquete:
 *
 *   · Un archivo que no está en la línea base y tiene textos → **FALLA**.
 *   · Un archivo que tiene más textos que su línea base → **FALLA**.
 *   · Un archivo que tiene menos → se informa, para que la línea base baje.
 *
 * No es una lista de excepciones: no se puede agregar un archivo nuevo a mano sin
 * que el lint lo note, y el número sólo puede bajar. Es la diferencia entre «deuda
 * visible y decreciente» y «regla que se dejó de cumplir».
 *
 * LO QUE NO DETECTA (y conviene saberlo)
 *
 * Un literal dentro de una expresión de llaves —`{cond ? 'texto' : null}`— no se
 * marca: distinguirlo de un identificador técnico necesita tipos, no sintaxis. La
 * línea base cubre esos casos por archivo, y el número no puede crecer.
 *
 * USO
 *   node tools/check-textos.mjs              # verifica
 *   node tools/check-textos.mjs --generar    # reescribe la línea base
 * Salida: 0 si está dentro del trinquete, 1 si creció, 2 si no pudo leer.
 * =============================================================================
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const RAIZ = 'apps/web/src';
const LINEA_BASE = 'tools/textos-pendientes.json';

/** Atributos cuyo valor es texto que ve una persona. */
const ATRIBUTOS_VISIBLES = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label']);

/** Recorre un directorio y devuelve los `.tsx`. */
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

/**
 * Normaliza el separador de rutas a `/`.
 *
 * Sin esto la línea base se escribe con `\` en Windows y con `/` en Linux, y el mismo
 * repositorio produce dos líneas base distintas: el CI vería **todos** los archivos como
 * nuevos y el lint fallaría por un motivo que no tiene nada que ver con los textos.
 */
function normalizar(ruta) {
  return ruta.split('\\').join('/');
}

/** ¿El texto tiene letras suficientes como para ser prosa y no puntuación? */
function esProsa(texto) {
  const limpio = texto.trim();
  if (limpio.length < 3) return false;
  return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3}/.test(limpio);
}

/** Los textos visibles de un archivo, con su línea. */
function textosDe(archivo) {
  const fuente = readFileSync(archivo, 'utf8');
  const sf = ts.createSourceFile(archivo, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const encontrados = [];

  function visitar(nodo) {
    // 1 · Texto entre etiquetas.
    if (ts.isJsxText(nodo) && esProsa(nodo.getText(sf))) {
      encontrados.push({ linea: lineaDe(sf, nodo), texto: nodo.getText(sf).trim().slice(0, 60) });
    }

    // 2 · Literales en atributos visibles.
    if (ts.isJsxAttribute(nodo) && nodo.name !== undefined) {
      const nombre = nodo.name.getText(sf);
      if (ATRIBUTOS_VISIBLES.has(nombre) && nodo.initializer !== undefined) {
        const valor = nodo.initializer;
        if (ts.isStringLiteral(valor) && esProsa(valor.text)) {
          encontrados.push({ linea: lineaDe(sf, nodo), texto: valor.text.slice(0, 60) });
        }
      }
    }

    ts.forEachChild(nodo, visitar);
  }

  visitar(sf);
  return encontrados;
}

function lineaDe(sf, nodo) {
  return sf.getLineAndCharacterOfPosition(nodo.getStart(sf)).line + 1;
}

// -----------------------------------------------------------------------------
// Ejecución
// -----------------------------------------------------------------------------

const archivos = componentes(RAIZ).sort();
if (archivos.length === 0) {
  console.error(`No se encontró ningún componente bajo ${RAIZ}. No se puede validar nada.`);
  process.exit(2);
}

const conteo = {};
const detalles = {};
for (const archivo of archivos) {
  const textos = textosDe(archivo);
  if (textos.length > 0) {
    const clave = normalizar(archivo);
    conteo[clave] = textos.length;
    detalles[clave] = textos;
  }
}

if (process.argv.includes('--generar')) {
  // El trinquete de verdad está acá: `--generar` acepta archivos nuevos —un componente
  // nuevo necesita textos hasta que exista el archivo de mensajes— pero **se niega a
  // subir** el número de un archivo que ya estaba. Si lo aceptara, regenerar sería la
  // forma de tapar una regresión, y el trinquete no serviría para nada.
  let previa = {};
  try {
    previa = JSON.parse(readFileSync(LINEA_BASE, 'utf8'));
  } catch {
    previa = {};
  }

  const crecidas = Object.entries(conteo)
    .filter(([archivo, cantidad]) => previa[archivo] !== undefined && cantidad > previa[archivo])
    .map(([archivo, cantidad]) => ({ archivo, cantidad, previa: previa[archivo] }));

  if (crecidas.length > 0 && !process.argv.includes('--forzar')) {
    console.error('La línea base no puede crecer: FALLA\n');
    for (const caso of crecidas) {
      console.error(`  · ${caso.archivo}: ${caso.previa} → ${caso.cantidad} textos.`);
    }
    console.error(
      '\n  Un archivo que ya estaba en la línea base no puede sumar textos de interfaz.\n' +
        '  Movelos al archivo de mensajes, o si es una decisión consciente: --generar --forzar',
    );
    process.exit(1);
  }

  writeFileSync(LINEA_BASE, `${JSON.stringify(conteo, null, 2)}\n`);
  const total = Object.values(conteo).reduce((s, n) => s + n, 0);
  const nuevos = Object.keys(conteo).filter((a) => previa[a] === undefined).length;
  console.log(
    `  Línea base escrita en ${LINEA_BASE}: ${Object.keys(conteo).length} archivos (${nuevos} nuevos), ${total} textos.`,
  );
  process.exit(0);
}

let lineaBase;
try {
  lineaBase = JSON.parse(readFileSync(LINEA_BASE, 'utf8'));
} catch (e) {
  console.error(`No se pudo leer ${LINEA_BASE}: ${e.message}`);
  console.error('Generala con: node tools/check-textos.mjs --generar');
  process.exit(2);
}

const nuevos = [];
const crecieron = [];
const bajaron = [];

for (const [archivo, cantidad] of Object.entries(conteo)) {
  const permitido = lineaBase[archivo];
  if (permitido === undefined) {
    nuevos.push({ archivo, cantidad, textos: detalles[archivo] ?? [] });
  } else if (cantidad > permitido) {
    crecieron.push({ archivo, cantidad, permitido });
  } else if (cantidad < permitido) {
    bajaron.push({ archivo, cantidad, permitido });
  }
}

if (nuevos.length > 0 || crecieron.length > 0) {
  console.error('Textos de interfaz escritos en componentes: FALLA\n');

  for (const caso of nuevos) {
    console.error(`  · ${caso.archivo} tiene ${caso.cantidad} texto(s) y no está en la línea base:`);
    for (const t of caso.textos.slice(0, 5)) console.error(`      línea ${t.linea}: «${t.texto}»`);
  }
  for (const caso of crecieron) {
    console.error(
      `  · ${caso.archivo}: ${caso.cantidad} textos, y la línea base permite ${caso.permitido}.`,
    );
  }

  console.error(
    '\n  Los textos de interfaz van a los archivos de mensajes, no al componente.\n' +
      '  Si es deuda que ya existía, la línea base se regenera con: node tools/check-textos.mjs --generar',
  );
  process.exit(1);
}

const totalPendiente = Object.values(lineaBase).reduce((s, n) => s + n, 0);
console.log(
  `  OK    textos: ${Object.keys(lineaBase).length} archivos en la línea base con ${totalPendiente} textos pendientes de migrar; ninguno nuevo.`,
);

if (bajaron.length > 0) {
  console.log(`  ↓     ${bajaron.length} archivo(s) mejoraron. Regenerá la línea base para dejarlo escrito:`);
  for (const caso of bajaron.slice(0, 5)) {
    console.log(`      ${caso.archivo}: ${caso.permitido} → ${caso.cantidad}`);
  }
}
