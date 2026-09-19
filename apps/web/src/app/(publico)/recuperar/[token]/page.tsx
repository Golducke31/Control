import { FormularioRestablecer } from './FormularioRestablecer'

/** Restablecimiento de contraseña: el token viene en la ruta. */
export default async function PaginaRestablecer({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <FormularioRestablecer token={token} />
    </main>
  )
}
