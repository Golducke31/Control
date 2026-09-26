import { reiniciarAlmacen } from '@/datos/cliente'

/**
 * Reinicia el almacén simulado. **Sólo en desarrollo.**
 *
 * Los E2E corren contra un servidor ya levantado y el almacén del adaptador simulado
 * dura lo que dura el proceso: un recuento aplicado deja el saldo cambiado, y una
 * transferencia despachada deja de ofrecer «Despachar». Esta ruta da un punto de
 * partida conocido para que el resultado de un test no dependa de qué corrió antes.
 *
 * En producción no existe: la ruta devuelve 404 antes de tocar nada, y además el
 * modo HTTP —que es el de producción— no tiene almacén que reiniciar. Se implementa
 * igual para que el fallo sea un 404 explícito y no un 405 confuso.
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return new Response('No encontrado', { status: 404 })
  }
  reiniciarAlmacen()
  return Response.json({ ok: true })
}
