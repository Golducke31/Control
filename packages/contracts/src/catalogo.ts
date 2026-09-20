import { z } from 'zod'
import { coleccionSchema } from './comun.ts'

/** Estado de ciclo de vida de un producto en el catálogo. */
export const ProductoEstado = z.enum(['activo', 'inactivo', 'descontinuado'])
export type ProductoEstado = z.infer<typeof ProductoEstado>

export const CategoriaSchema = z.object({
  id: z.string(),
  nombre: z.string(),
})
export type Categoria = z.infer<typeof CategoriaSchema>

export const MarcaSchema = z.object({
  id: z.string(),
  nombre: z.string(),
})
export type Marca = z.infer<typeof MarcaSchema>

/**
 * Producto del catálogo.
 *
 * `precio` y `costo` van en la menor unidad de la moneda (centavos) para no
 * arrastrar errores de punto flotante; el formateo lo hace `Intl.NumberFormat`
 * con la configuración del inquilino (§5.11). `moneda` es `ARS` o `USD`.
 */
export const ProductoSchema = z.object({
  id: z.string(),
  sku: z.string(),
  nombre: z.string(),
  descripcion: z.string().optional(),
  categoriaId: z.string(),
  marcaId: z.string(),
  estado: ProductoEstado,
  precio: z.number().int().nonnegative(),
  costo: z.number().int().nonnegative(),
  moneda: z.enum(['ARS', 'USD']),
  stock: z.number().int().nonnegative(),
  creadoEn: z.string(),
  actualizadoEn: z.string(),
})
export type Producto = z.infer<typeof ProductoSchema>

/** Respuesta de la colección de productos (Catálogo). */
export const ProductoListadoSchema = coleccionSchema(ProductoSchema)
export type ProductoListado = z.infer<typeof ProductoListadoSchema>

/** Filtros admitidos en la lista de productos. */
export const ProductoFiltrosSchema = z.object({
  texto: z.string().optional(),
  categoriaId: z.string().optional(),
  marcaId: z.string().optional(),
  estado: ProductoEstado.optional(),
})
export type ProductoFiltros = z.infer<typeof ProductoFiltrosSchema>
