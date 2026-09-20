#!/usr/bin/env node
/**
 * =============================================================================
 * Fronteras cliente/servidor
 * -----------------------------------------------------------------------------
 * QUÉ DETECTA
 *
 * Un Server Component (`page.tsx`, `layout.tsx`, `route.ts` sin `'use client'`) que
 * importe **valores** de un módulo `'use client'` y los use como funciones en vez de
 * renderizarlos como componentes.
 *
 * POR QUÉ EXISTE
 *
 * Un módulo con `'use client'` exporta **referencias de cliente**, no funciones: desde el
 * servidor, `import { temaInicial } from './ConfiguracionCliente'` y `temaInicial(slug)`
 * compila, pasa el typecheck, pasa los tests, pasa `next build` — y falla en runtime con
 *
 *   Attempted to call temaInicial() from the server but temaInicial is on the client.
 *
 * Pasó de verdad en F8: la ventana de Configuración respondía 500 y ninguna de las
 * verificaciones del repositorio lo veía. Lo encontró un smoke test de las catorce rutas.
 * Un defecto que sólo aparece cuando alguien pide la ruta no puede depender de que
 * alguien se acuerde de pedirla: la regla es de forma, y una regla de forma se verifica
 * sobre la fuente.
 *
 * QUÉ CONSIDERA VÁLIDO
 *
 *   · Importar un **componente** y usarlo como JSX (`<VentanaCliente … />`).
 *   · Importar **tipos** (`import type { … }`).
 *   · Cualquier import desde un módulo que no sea `'use client'`.
 *
 * Todo lo demás —importar una función de un módulo cliente y llamarla— es una violación.
 *
 * USO
 *   node tools/check-fronteras.mjs
 * Salida: 0 si no hay violaciones, 1 si las hay, 2 si no pudo leer.
 * =============================================================================
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const RAIZ = 'apps/web/src';

function archivos(dir, filtro) {
  const salida = [];
  let entradas;
  try {
    entradas = readdirSync(dir);
  } catch {
    return salida;
  }
  for (const entrada of entradas) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta, filtro));
    else if (filtro(entrada)) salida.push(ruta);
  }
  return salida;
}

const normalizar = (ruta) => ruta.split('\\').join('/');

/** Los módulos que se declaran cliente, para no releerlos en cada import. */
const esModuloCliente = new Map();
function tieneUseClient(ruta) {
  if (esModuloCliente.has(ruta)) return esModuloCliente.get(ruta);
  let es = false;
  try {
    const fuente = readFileSync(ruta, 'utf8');
    es = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/m.test(fuente);
  } catch {
    es = false;
  }
  esModuloCliente.set(ruta, es);
  return es;
}

/** Resuelve un especificador relativo a un archivo real, probando las extensiones del repo. */
function resolverModulo(desde, especificador) {
  if (!especificador.startsWith('.')) return null;
  const base = resolve(dirname(desde), especificador);
  for (const candidato of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try {
      if (statSync(candidato).isFile()) return candidato;
    } catch {
      /* sigue */
    }
  }
  return null;
}

const violaciones = [];

for (const archivo of archivos(RAIZ, (n) => n === 'page.tsx' || n === 'layout.tsx' || n === 'route.ts')) {
  if (tieneUseClient(archivo)) continue;

  const fuente = readFileSync(archivo, 'utf8');
  const sf = ts.createSourceFile(archivo, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ruta = normalizar(archivo);
  const linea = (nodo) => sf.getLineAndCharacterOfPosition(nodo.getStart(sf)).line + 1;

  for (const sentencia of sf.statements) {
    if (!ts.isImportDeclaration(sentencia) || sentencia.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(sentencia.moduleSpecifier)) continue;

    const destino = resolverModulo(archivo, sentencia.moduleSpecifier.text);
    if (destino === null || !tieneUseClient(destino)) continue;

    // Un `import type` no trae valores: no puede violar la frontera.
    const clausula = sentencia.importClause;
    if (clausula?.isTypeOnly === true) continue;

    const vinculaciones = clausula?.namedBindings;
    if (vinculaciones === undefined || !ts.isNamedImports(vinculaciones)) continue;

    for (const elemento of vinculaciones.elements) {
      if (elemento.isTypeOnly) continue;
      const nombre = elemento.name.getText();

      // Válido si se usa como componente: `<Nombre`, o `Nombre` en un `<Nombre …>`.
      const usadoComoJsx = new RegExp(`<${nombre}[\\s/>]`).test(fuente);
      if (usadoComoJsx) continue;

      violaciones.push({
        ruta,
        linea: linea(sentencia),
        detalle: `importa «${nombre}» de un módulo 'use client' (${normalizar(destino)}) y no lo usa como componente`,
      });
    }
  }
}

if (violaciones.length > 0) {
  console.error('Fronteras cliente/servidor: FALLA\n');
  for (const v of violaciones) console.error(`  · ${v.ruta}:${v.linea}  ${v.detalle}`);
  console.error(
    '\n  Un módulo con \'use client\' exporta referencias de cliente: desde el servidor no se\n' +
      '  pueden llamar, y el fallo aparece recién al pedir la ruta. Movés el valor a un módulo\n' +
      '  compartido (sin \'use client\') y lo importás desde los dos lados.',
  );
  process.exit(1);
}

console.log('  OK    fronteras: ningún Server Component llama a un valor de un módulo cliente.');
