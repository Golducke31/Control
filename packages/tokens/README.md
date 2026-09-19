# @control/tokens

Fuente única del sistema de diseño de Control. Los componentes no escriben colores:
leen roles.

## Cómo cambiar un color

1. Editar el ancla en `src/escalas.ts`. Es lo único que se escribe a mano: las tres
   escalas de doce pasos, los tonos de lienzo y las tintas se derivan.
2. Regenerar: `npm run generate --workspace @control/tokens`
3. Verificar: `npm test --workspace @control/tokens`

La suite recalcula el contraste de los 33 pares que la interfaz usa, en los dos temas,
y falla si alguno baja de su mínimo. También falla si los artefactos generados no
coinciden con la fuente —que es lo que impide que alguien cambie un ancla, no regenere,
y la aplicación siga pintando la paleta vieja mientras la suite verifica la nueva—.

## Los tres artefactos se commitean

`generated/` no está en `.gitignore`. No es una comodidad: es lo que evita que compilar
dependa de que alguien se acuerde de generar antes. Como están commiteados, la puerta
que impide que se desincronicen es `npm run check`.

## Las tres formas de consumirlo

| Quién | Cómo |
|---|---|
| La aplicación | `import '@control/tokens/tokens.css'` y usar `var(--control-…)` |
| Los gráficos | `import { ROLES, SERIES } from '@control/tokens'` — necesitan el color como valor, no como referencia |
| Las herramientas | `generated/tokens.json` |

## Por qué Node ejecuta este paquete sin compilarlo

`tsconfig.json` activa `erasableSyntaxOnly`, `verbatimModuleSyntax` y
`allowImportingTsExtensions`. Node 22 ejecuta TypeScript borrando los tipos, y esas tres
opciones hacen que el compilador exija exactamente la sintaxis que el borrado puede
manejar: sin `enum`, sin `namespace`, con `import type` en los imports de sólo tipos y
con extensión `.ts` en los relativos. El efecto neto es que **si compila, se ejecuta**:
no hay un paso de build entre el código y su verificación.

## Lo que la suite protege

- Los 36 valores publicados en `docs/PLAN-FRONTEND-PRODUCCION.md` §3.2, para que el
  documento y el código no se separen.
- Que el paso del ancla salga exacto y no interpolado: `scarlet-900` es `#261A66`.
- Que la luminosidad de cada escala sea monótona —un paso claro en medio de los oscuros
  rompería la correspondencia entre número y peso visual—.
- Que los dos temas definan los mismos roles, y que cada rol tenga su contraste medido.
- Y que el verificador **pueda fallar**: hay pruebas que rompen el sistema a propósito
  y exigen que lo detecte. Un control que no puede fallar no protege nada.
