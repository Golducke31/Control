'use client'

import type { ReactNode } from 'react'
import { cn } from './cn'
import { Esqueleto } from './Esqueleto'
import { EstadoVacio } from './EstadoVacio'
import { Boton } from './Boton'
import type { Orden, Paginacion } from '@control/contracts'

export interface Columna<T> {
  id: string
  titulo: string
  /** Alineación: las columnas numéricas van a la derecha con cifras tabulares. */
  alinear?: 'izquierda' | 'derecha'
  ordenable?: boolean
  /** Campo que se envía a `alOrdenar` al hacer clic en el encabezado. */
  campoOrden?: string
  cuerpo: (fila: T, indice: number) => ReactNode
}

export interface AccionVacia {
  etiqueta: string
  href?: string
  onClick?: () => void
}

export interface PropsDataTable<T> {
  columnas: Columna<T>[]
  datos: T[]
  /** Estado de carga (la fuente aún no responde). */
  cargando?: boolean
  /** Mensaje de error de la frontera; si está presente, se muestra el estado de error. */
  error?: string | null
  alReintentar?: () => void
  /** Orden actual y callback de ordenamiento por columna. */
  orden?: Orden | null
  alOrdenar?: (campo: string) => void
  /** Paginación y callback de cambio de página. */
  paginacion?: Paginacion | null
  alPaginar?: (pagina: number) => void
  /** Verdadero cuando hay un filtro activo: distingue «vacío» de «vacío por filtro». */
  filtroActivo?: boolean
  tituloVacia?: string
  descripcionVacia?: string
  accionVacia?: AccionVacia
  /** Texto accesible de la tabla. */
  caption?: string
  ariaLabel?: string
}

/**
 * Tabla de datos única del frontend.
 *
 * Los cinco estados obligatorios (§5.9) se resuelven aquí, no en cada ventana:
 *
 * 1. **Error** — `error` presente: panel con el mensaje y un botón de reintento.
 * 2. **Carga** — `cargando` y sin filas: esqueletos del tamaño real, sin salto de
 *    composición.
 * 3. **Vacío por filtro** — sin filas pero con filtro activo: invita a limpiarlo.
 * 4. **Vacío** — sin filas ni filtro: con la acción principal de la ventana.
 * 5. **Éxito** — las filas.
 *
 * Toda columna numérica se alinea a la derecha y usa cifras tabulares; los
 * encabezados llevan `scope="col"` y la tabla un `caption` accesible cuando aporta.
 */
export function DataTable<T>({
  columnas,
  datos,
  cargando = false,
  error = null,
  alReintentar,
  orden = null,
  alOrdenar,
  paginacion = null,
  alPaginar,
  filtroActivo = false,
  tituloVacia,
  descripcionVacia,
  accionVacia,
  caption,
  ariaLabel,
}: PropsDataTable<T>) {
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6"
      >
        <p className="text-sm font-medium text-principal">No se pudieron cargar los datos</p>
        <p className="text-sm text-terciario">{error}</p>
        {alReintentar && (
          <Boton variante="primario" onClick={alReintentar}>
            Reintentar
          </Boton>
        )}
      </div>
    )
  }

  if (cargando && datos.length === 0) {
    return (
      <div aria-busy className="overflow-hidden rounded-[var(--control-radio)] border border-borde-sutil">
        <div className="border-b border-borde-sutil bg-carcasa px-4 py-3">
          <Esqueleto filas={columnas.length} alto="texto" ocultoParaLectores />
        </div>
        <div className="space-y-2 bg-tarjeta p-4">
          <Esqueleto filas={6} alto="texto" ocultoParaLectores />
        </div>
      </div>
    )
  }

  if (!cargando && datos.length === 0) {
    const accionNodo = accionVacia ? (
      <Boton
        variante="primario"
        {...(accionVacia.href !== undefined ? { href: accionVacia.href } : {})}
        {...(accionVacia.onClick !== undefined ? { onClick: accionVacia.onClick } : {})}
      >
        {accionVacia.etiqueta}
      </Boton>
    ) : undefined
    return (
      <EstadoVacio
        titulo={tituloVacia ?? (filtroActivo ? 'Sin resultados para este filtro' : 'No hay registros todavía')}
        descripcion={
          descripcionVacia ??
          (filtroActivo
            ? 'Ajustá o limpiá los filtros para ver más resultados.'
            : 'Cuando haya datos, aparecerán listados acá.')
        }
        accion={accionNodo}
      />
    )
  }

  const pagina = paginacion?.pagina ?? 1
  const paginas = paginacion?.paginas ?? 1

  return (
    <div className="overflow-hidden rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta">
      <table className="w-full border-collapse text-sm" aria-label={ariaLabel} aria-busy={cargando || undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-borde-sutil bg-carcasa">
            {columnas.map((col) => {
              const activo = orden?.campo === col.campoOrden
              return (
                <th
                  key={col.id}
                  scope="col"
                  className={cn(
                    'px-4 py-3 font-medium text-sobre-carcasa',
                    col.alinear === 'derecha' ? 'text-right' : 'text-left',
                  )}
                >
                  {col.ordenable && col.campoOrden ? (
                    <button
                      type="button"
                      onClick={() => alOrdenar?.(col.campoOrden!)}
                      className="inline-flex items-center gap-1 rounded-[var(--control-radio-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
                      aria-sort={activo ? (orden?.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
                    >
                      {col.titulo}
                      <span aria-hidden className="text-terciario">
                        {activo ? (orden?.dir === 'desc' ? '↓' : '↑') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.titulo
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {datos.map((fila, i) => (
            <tr key={i} className="border-b border-borde-sutil last:border-0">
              {columnas.map((col) => (
                <td
                  key={col.id}
                  className={cn(
                    'px-4 py-3 align-middle text-principal',
                    col.alinear === 'derecha' && 'text-right tabular-nums',
                  )}
                >
                  {col.cuerpo(fila, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {paginacion && alPaginar && (
        <div className="flex items-center justify-between gap-3 border-t border-borde-sutil bg-carcasa px-4 py-3 text-sm text-sobre-carcasa">
          <span className="text-terciario">
            {paginacion.total} registros · página {pagina} de {paginas}
          </span>
          <div className="flex gap-2">
            <Boton
              variante="secundario"
              tamano="sm"
              disabled={pagina <= 1}
              onClick={() => alPaginar(pagina - 1)}
            >
              Anterior
            </Boton>
            <Boton
              variante="secundario"
              tamano="sm"
              disabled={pagina >= paginas}
              onClick={() => alPaginar(pagina + 1)}
            >
              Siguiente
            </Boton>
          </div>
        </div>
      )}
    </div>
  )
}
