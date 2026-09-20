import type { Metadata } from 'next'
import { getCliente } from '@/datos/cliente'
import { EMPRESAS } from '@/empresa'
import { ChoferCliente } from './ChoferCliente'

export const metadata: Metadata = {
  title: 'Panel del conductor',
  // La PWA del conductor no se indexa.
  robots: { index: false, follow: false },
}

/**
 * Panel del conductor (F7).
 *
 * Vive fuera de la carcasa porque el conductor no tiene menú ni permisos de oficina: su
 * alcance es el tracking y las entregas (rol `driver`, tres permisos). En el sistema
 * real la sesión resuelve qué envíos son suyos; acá se muestran los activos de la
 * empresa de demostración.
 *
 * Lo que sí es real es la cola offline: `colaOffline.ts` es lógica pura con su suite, y
 * el componente la usa tal cual — no hay una segunda versión de la regla escrita en el
 * JSX.
 */
export default async function Pagina() {
  const empresa = EMPRESAS[0]
  const envios = empresa === undefined ? [] : (await getCliente().listarEnvios({ empresaSlug: empresa.slug, pagina: 1, porPagina: 100 })).items

  return <ChoferCliente slug={empresa?.slug ?? '—'} envios={envios} />
}
