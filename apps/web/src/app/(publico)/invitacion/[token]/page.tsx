import { empresaPorSlug } from '@/empresa'
import { invitacionPorToken } from '@/sesion'
import { FormularioAceptarInvitacion } from './FormularioAceptarInvitacion'

/**
 * Aceptación de invitación.
 *
 * Resuelve el token en el servidor para mostrar a qué empresa y con qué correo se invitó, y
 * verifica que la empresa exista antes de pintar el formulario. Un token inválido o de una
 * empresa borrada no llega al formulario: muestra un mensaje y nada más.
 */
export default async function PaginaInvitacion({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const invitacion = invitacionPorToken(token)
  const empresa = invitacion ? empresaPorSlug(invitacion.empresaSlug) : undefined

  if (invitacion === undefined || empresa === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
        <div className="rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 text-center">
          <p className="text-principal">Esta invitación no es válida o expiró.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <FormularioAceptarInvitacion token={token} correo={invitacion.correo} />
    </main>
  )
}
