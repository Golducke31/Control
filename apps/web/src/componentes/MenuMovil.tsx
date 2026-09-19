import { BarraLateral } from './BarraLateral'
import { Icono } from './Iconos'
import type { BloqueDeMenu } from './tipos'

/**
 * Menú para pantallas chicas.
 *
 * Usa `<details>`/`<summary>` en vez de estado de React: el desplegable funciona sin
 * JavaScript, se abre y se cierra con teclado, y no obliga a convertir la carcasa
 * entera en componente de cliente para administrar un booleano. El panel de la
 * empresa sigue siendo un componente de servidor.
 */
export function MenuMovil({ bloques, slug }: { bloques: readonly BloqueDeMenu[]; slug: string }) {
  return (
    <details className="relative lg:hidden">
      <summary
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-[var(--control-radio-sm)] text-sobre-carcasa-sutil hover:bg-carcasa-sutil hover:text-sobre-carcasa focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        aria-label="Abrir el menú de ventanas"
      >
        <Icono nombre="panel" tamano={20} />
      </summary>
      <div className="absolute top-full left-0 z-40 mt-2 max-h-[75vh] w-72 overflow-y-auto rounded-[var(--control-radio)] border border-borde-sutil bg-carcasa shadow-lg">
        {/*
          La etiqueta del landmark es distinta de la de la barra lateral a propósito:
          aunque sólo una de las dos es visible —`display: none` saca a la otra del
          árbol de accesibilidad—, dos regiones con el mismo nombre obligan a quien
          navega por landmarks a adivinar cuál es cuál.
        */}
        <BarraLateral bloques={bloques} slug={slug} etiqueta="Menú de ventanas" />
      </div>
    </details>
  )
}
