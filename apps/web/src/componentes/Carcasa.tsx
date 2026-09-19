import Link from 'next/link'
import type { ReactNode } from 'react'

import { BarraLateral } from './BarraLateral'
import { Icono } from './Iconos'
import { MenuMovil } from './MenuMovil'
import { SelectorDeEmpresa } from './SelectorDeEmpresa'
import type { BloqueDeMenu } from './tipos'
import { menuPorGrupo, ventanasVisibles } from '@/rutas'
import { ProveedorSesion, type ContextoEmpresa } from '@/sesion'

/**
 * La carcasa de la empresa.
 *
 * Es un componente de **servidor**, y el menú se filtra acá: los permisos y las banderas
 * de funcionalidad del usuario se resuelven en el servidor antes de renderizar, así que
 * una ventana que el usuario no puede ver nunca llega al navegador. Es la regla A2 —el
 * menú se genera desde los permisos, no desde condiciones dispersas en los componentes—.
 *
 * Lo que recibe es un `ContextoEmpresa`: la empresa, los permisos **de este usuario** en
 * ella, sus empresas (para el selector) y si viene impersonando. El cliente no participa
 * de ninguna de esas decisiones.
 *
 * La carcasa es violeta del **sistema**, nunca del inquilino: si el cliente pintara la
 * carcasa, el contraste del texto de navegación dependería de un color que elige
 * libremente, que es el defecto que el sistema existe para evitar.
 */
export function Carcasa({ contexto, children }: { contexto: ContextoEmpresa; children: ReactNode }) {
  const empresa = contexto.empresa
  const visibles = ventanasVisibles(contexto.permisos, contexto.funcionalidades)
  const bloques: BloqueDeMenu[] = menuPorGrupo(visibles)

  return (
    <ProveedorSesion contexto={contexto}>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-[var(--control-alto-encabezado)] shrink-0 items-center gap-2 border-b border-borde-sutil bg-carcasa px-3 sm:px-4">
          <MenuMovil bloques={bloques} slug={empresa.slug} />

          <Link
            href={`/e/${empresa.slug}/panel`}
            className="mr-1 flex items-center gap-2 rounded-[var(--control-radio-sm)] px-1.5 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
          >
            <Marca />
            <span className="hidden font-titulos text-sm font-semibold tracking-tight text-sobre-carcasa sm:block">
              Control
            </span>
          </Link>

          <span aria-hidden="true" className="hidden h-5 w-px bg-borde-sutil sm:block" />

          <SelectorDeEmpresa empresas={contexto.empresas} actual={empresa} />

          <div className="ml-auto flex items-center gap-2">
            {/*
              La ventana de tareas programadas es la que avisa que algo dejó de correr.
              El contador es decorativo en F1: los datos llegan en F8.
            */}
            <Link
              href={`/e/${empresa.slug}/tareas`}
              className="hidden size-9 items-center justify-center rounded-[var(--control-radio-sm)] text-sobre-carcasa-sutil hover:bg-carcasa-sutil hover:text-sobre-carcasa focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco sm:flex"
              aria-label="Tareas programadas"
            >
              <Icono nombre="tareas" tamano={18} />
            </Link>
            <span className="hidden h-5 w-px bg-borde-sutil sm:block" />
            <span className="flex items-center gap-2 rounded-[var(--control-radio-sm)] px-1.5 py-1">
              <span
                aria-hidden="true"
                className="flex size-7 items-center justify-center rounded-full bg-carcasa-sutil text-xs font-medium text-sobre-carcasa"
              >
                {contexto.usuario.iniciales}
              </span>
              <span className="hidden text-sm text-sobre-carcasa md:block">{contexto.usuario.nombre}</span>
            </span>
            <form action="/api/auth/salir" method="post" className="ml-1">
              <button
                type="submit"
                aria-label="Cerrar sesión"
                className="rounded-[var(--control-radio-sm)] px-2 py-1 text-sm text-sobre-carcasa-sutil hover:bg-carcasa-sutil hover:text-sobre-carcasa focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
              >
                Salir
              </button>
            </form>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[var(--control-ancho-carcasa)] shrink-0 border-r border-borde-sutil bg-carcasa lg:block">
            <div className="sticky top-[var(--control-alto-encabezado)]">
              <BarraLateral bloques={bloques} slug={empresa.slug} etiqueta="Navegación principal" />
            </div>
          </aside>

          <main className="min-w-0 flex-1 bg-lienzo">
            <div className="mx-auto w-full max-w-[var(--control-ancho-max-contenido)] px-4 py-6 sm:px-6">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ProveedorSesion>
  )
}

/**
 * La marca de la plataforma.
 *
 * Es un trazo propio y no el logotipo de un inquilino: la carcasa pertenece a Control.
 * El logotipo de la empresa aparece en su ficha y en sus documentos.
 */
function Marca() {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 items-center justify-center rounded-[var(--control-radio-sm)] bg-accion"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 6.5 12 3l7 3.5v5L12 15l-7-3.5v-5Z"
          stroke="var(--control-texto-sobre-accion)"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
        <path
          d="M5 12.5 12 16l7-3.5"
          stroke="var(--control-texto-sobre-accion)"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
