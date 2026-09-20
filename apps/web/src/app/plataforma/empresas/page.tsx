import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { EMPRESAS } from '@/empresa'
import { sesionActual } from '@/sesion'
import { puedeEntrarAPlataforma } from '@/sesion/plataforma'

export const metadata: Metadata = {
  title: 'Empresas · Plataforma',
  // La consola de plataforma no se indexa.
  robots: { index: false, follow: false },
}

/**
 * Consola de plataforma · Empresas (F8).
 *
 * Vive **fuera de la carcasa**: sin menú de empresa, sin selector de empresa, sin
 * permisos de inquilino. Es otro producto dentro del mismo despliegue, y por eso está
 * bajo su propio prefijo y con su propia guarda.
 *
 * **Un `owner` de empresa no entra.** Tiene los 51 permisos de su empresa y ninguno
 * sobre la plataforma: son dos niveles de acceso distintos, y confundirlos es la forma
 * más directa de que un cliente vea los datos de otro. La guarda no se apoya en un
 * permiso —`owner` tiene todos— sino en la identidad de plataforma.
 *
 * Los dos rechazos se atienden distinto: sin sesión se va al ingreso, con sesión pero
 * sin ser de plataforma se va a las empresas propias. Por eso la regla los separa.
 */
export default async function Pagina() {
  const sesion = await sesionActual()
  if (sesion === null) redirect('/ingresar')

  const acceso = puedeEntrarAPlataforma(sesion.sub)
  if (!acceso.ok) {
    // `sin_sesion` ya se resolvió arriba; acá sólo queda el caso de un usuario de
    // empresa que intenta entrar por URL.
    redirect('/empresas')
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-terciario">Consola de plataforma</p>
        <h1 className="text-xl font-semibold text-principal">Empresas</h1>
        <p className="text-sm text-secundario">
          Las empresas de la plataforma. Esta consola no comparte sesión ni permisos con la carcasa de una empresa.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {EMPRESAS.map((empresa) => (
          <li
            key={empresa.slug}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-4"
          >
            <div>
              <p className="text-sm text-principal">{empresa.nombre}</p>
              <p className="font-mono text-xs text-terciario">{empresa.slug}</p>
            </div>
            <Link
              href={`/plataforma/empresas/${empresa.slug}`}
              className="rounded-[var(--control-radio-sm)] px-3 py-1.5 text-sm text-accion hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
            >
              Ver detalle
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-xs text-terciario">
        Si estás viendo esta pantalla, tu usuario pertenece a la plataforma. Un propietario de empresa que escriba esta
        URL es redirigido a sus propias empresas.
      </p>
    </main>
  )
}
