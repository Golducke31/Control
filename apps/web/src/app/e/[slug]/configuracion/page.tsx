import type { Metadata } from 'next'

import { VentanaPendiente } from '@/componentes/VentanaPendiente'
import { ventanaPorId } from '@/rutas'

/**
 * La ventana se declara en el mapa de rutas, con su permiso, su grupo y sus subrutas.
 * El contenido llega en la fase que el mapa indica; hasta entonces esta página muestra
 * lo que el mapa dice de ella, para que la arquitectura sea verificable a simple vista.
 */
const ventana = ventanaPorId('configuracion')

export const metadata: Metadata = { title: ventana.titulo }

export default function Pagina() {
  return <VentanaPendiente ventana={ventana} />
}
