import { z } from 'zod'

/** Dirección de ordenamiento de una columna. */
export const OrdenDireccion = z.enum(['asc', 'desc'])
export type OrdenDireccion = z.infer<typeof OrdenDireccion>

/** Una columna por la que se ordena la colección. */
export const OrdenSchema = z.object({
  campo: z.string(),
  dir: OrdenDireccion,
})
export type Orden = z.infer<typeof OrdenSchema>

/**
 * Metadatos de paginación que devuelve el servidor.
 *
 * `pagina` es base-1; `paginas` es el total de páginas. El cliente los refleja en
 * la URL (A12), no en estado propio.
 */
export const PaginacionSchema = z.object({
  pagina: z.number().int().nonnegative(),
  porPagina: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  paginas: z.number().int().nonnegative(),
})
export type Paginacion = z.infer<typeof PaginacionSchema>

/**
 * Error de la API en la frontera servidor/cliente.
 *
 * `ruta` es la ruta del campo que falló la validación cuando el error viene del
 * contrato (p. ej. `items.3.precio`), para que el formulario pueda mapearlo al
 * campo correcto en vez de mostrar un aviso genérico.
 */
export const ErrorApiSchema = z.object({
  codigo: z.string(),
  mensaje: z.string(),
  ruta: z.string().optional(),
  requestId: z.string().optional(),
})
export type ErrorApi = z.infer<typeof ErrorApiSchema>

/** Sobre genérico de una colección paginada. */
export function coleccionSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    paginacion: PaginacionSchema,
  })
}

export type Coleccion<T> = {
  items: T[]
  paginacion: Paginacion
}

/**
 * Marcador de contrato para las ventanas que aún no se cablean en el frontend.
 *
 * El registro de `apps/web` lo usa para declarar que la ventana *tiene* un contrato
 * (aunque sea pendiente), de modo que la puerta «toda ventana declara su contrato»
 * se cumple sin tener que inventar un esquema falso. Cuando la ventana se construye,
 * se reemplaza por el esquema real de su dominio.
 */
export const PendienteSchema = z
  .object({ pendiente: z.literal(true) })
  .describe('Contrato aún no implementado en el frontend')
export type Pendiente = z.infer<typeof PendienteSchema>
