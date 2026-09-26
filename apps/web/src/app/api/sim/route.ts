import { METODOS_SIMULADOS, SimuladoCliente } from '@/datos/cliente'

/**
 * El servidor simulado del modo `simulado`.
 *
 * Existe por una razón que no se ve hasta que se escribe algo: el almacén del adaptador
 * simulado es estado de módulo, y hay **dos** reinos —el del proceso de Node y el del
 * navegador—. Si el navegador escribe contra su propio almacén y el Server Component lee
 * del suyo, la escritura no llega a ninguna lectura: el recuento mostraba el ajuste
 * aplicado en su insignia y el libro mayor seguía sin la fila, porque el libro lo
 * renderiza el servidor.
 *
 * En modo `http` esto no puede pasar: hay un solo almacén, el backend. Así que el modo
 * simulado tiene que parecerse a eso — un almacén, del lado del servidor — y el navegador
 * tiene que pedirle las cosas a él. Eso es lo que hace esta ruta: el navegador delega
 * acá cada llamada, y acá se resuelve contra el mismo almacén que leen los Server
 * Components.
 *
 * La lista de operaciones **no se escribe a mano**: sale del prototipo de `SimuladoCliente`,
 * así que agregar un método al `ApiClient` no puede olvidarse de exponerlo, y una
 * operación que no existe se rechaza sola.
 */
export async function POST(pedido: Request): Promise<Response> {
  const modo = process.env.NEXT_PUBLIC_API_MODE ?? 'simulado'
  if (modo !== 'simulado') {
    return new Response('No encontrado', { status: 404 })
  }

  let cuerpo: { operacion?: unknown; parametros?: unknown }
  try {
    cuerpo = (await pedido.json()) as typeof cuerpo
  } catch {
    return Response.json({ error: 'cuerpo ilegible' }, { status: 400 })
  }

  const { operacion, parametros } = cuerpo
  if (typeof operacion !== 'string' || !METODOS_SIMULADOS.includes(operacion)) {
    return Response.json({ error: `operación desconocida: ${String(operacion)}` }, { status: 400 })
  }

  const cliente = new SimuladoCliente()
  const metodo = cliente[operacion as keyof typeof cliente]
  if (typeof metodo !== 'function') {
    return Response.json({ error: `operación desconocida: ${operacion}` }, { status: 400 })
  }

  try {
    // Los métodos del adaptador toman a lo sumo un parámetro, y ya devuelven el
    // resultado validado con Zod: la validación en el borde sigue estando, del lado
    // del servidor simulado.
    const resultado = await (metodo as (p: unknown) => Promise<unknown>).call(cliente, parametros)
    return Response.json(resultado)
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : 'error desconocido'
    return Response.json({ error: mensaje }, { status: 500 })
  }
}
