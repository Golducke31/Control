import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { EMPRESAS } from '@/empresa'
import { TrackingCliente, TrackingNoEncontrado } from './TrackingCliente'

export const metadata: Metadata = {
  title: 'Seguimiento del envío',
  // Un link de seguimiento no se indexa: es de quien lo recibió.
  robots: { index: false, follow: false },
}

/**
 * Seguimiento público (F7).
 *
 * Vive **fuera de la carcasa**: no hay sesión, no hay menú, no hay empresa en la URL.
 * El token es lo único que identifica el envío, y el `tracking_code` es único por
 * empresa en el motor (`sh_tracking_unique`).
 *
 * En el sistema real el backend resuelve el token entre todas las empresas; acá se
 * resuelve contra la empresa de demostración, porque el adaptador simulado es de una
 * sola. Lo que **no** es de demostración es la proyección: se construye con
 * `proyeccionPublica`, que devuelve una lista blanca de siete campos y está verificada
 * por `tracking.test.ts` — la página no puede mostrar lo que no recibe.
 */
export default async function Pagina({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const empresa = EMPRESAS[0]
  if (empresa === undefined) return <TrackingNoEncontrado token={token} />

  const seguimiento = await getCliente().obtenerTrackingPublico(empresa.slug, token)
  if (seguimiento === null) return <TrackingNoEncontrado token={token} />

  return <TrackingCliente seguimiento={seguimiento} />
}
