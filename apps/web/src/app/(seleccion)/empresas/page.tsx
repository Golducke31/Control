import Link from 'next/link'
import { redirect } from 'next/navigation'

import { EMPRESAS } from '@/empresa'
import { empresasDelUsuario, esPlataforma, sesionActual } from '@/sesion'

/**
 * Selector de empresa.
 *
 * Para un usuario normal, lista las empresas de las que es miembro. Para un usuario de
 * plataforma sin membresías, es el punto de entrada a la impersonación: elige una empresa y
 * actúa como su primer miembro. El cambio de empresa es navegación, no mutación: la cookie no
 * guarda la empresa, la resuelve el `slug`.
 */
export default async function PaginaEmpresas() {
  const sesion = await sesionActual()
  if (sesion === null) redirect('/ingresar')

  const empresas = empresasDelUsuario(sesion.sub)
  const plataforma = esPlataforma(sesion.sub)

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <div className="w-full max-w-md rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 shadow-sm">
        <h1 className="font-titulos text-xl font-semibold text-principal">Elegí una empresa</h1>
        <p className="mt-1 text-sm text-secundario">Entrá a la cuenta que quieras gestionar.</p>

        {empresas.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-2">
            {empresas.map((empresa) => (
              <li key={empresa.slug}>
                <Link
                  href={`/e/${empresa.slug}/panel`}
                  className="flex items-center gap-3 rounded-[var(--control-radio-sm)] border border-borde-sutil px-3 py-2.5 hover:bg-carcasa-sutil focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-[var(--control-radio-sm)] bg-accion text-sm font-semibold text-sobre-accion"
                  >
                    {empresa.iniciales}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-principal">{empresa.nombre}</span>
                    <span className="block truncate text-xs text-secundario">{empresa.descripcion}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-secundario">
            No tenés empresas propias. Como usuario de plataforma, podés impersonar una para operar en ella.
          </p>
        )}

        {plataforma && (
          <form action="/api/auth/impersonar" method="post" className="mt-6 border-t border-borde-sutil pt-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
              Impersonar empresa
              <select
                name="slug"
                defaultValue={EMPRESAS[0]?.slug}
                className="rounded-[var(--control-radio-sm)] border border-borde-control bg-lienzo px-3 py-2 text-principal outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
              >
                {EMPRESAS.map((empresa) => (
                  <option key={empresa.slug} value={empresa.slug}>
                    {empresa.nombre}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="mt-3 w-full rounded-[var(--control-radio-sm)] bg-peligro-solido px-4 py-2 font-medium text-sobre-peligro hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            >
              Entrar en modo impersonación
            </button>
          </form>
        )}

        <form action="/api/auth/salir" method="post" className="mt-6">
          <button
            type="submit"
            className="text-sm text-secundario underline hover:text-principal"
          >
            Cerrar sesión
          </button>
        </form>
      </div>
    </main>
  )
}
