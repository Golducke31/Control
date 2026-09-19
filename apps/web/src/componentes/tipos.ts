import type { Grupo, Ventana } from '@/rutas'

/**
 * Un bloque del menú.
 *
 * Es un tipo aparte y no `ReturnType<typeof menuPorGrupo>` porque cruza la frontera
 * entre el servidor y el cliente: tiene que ser serializable, y declararlo explícito
 * deja eso a la vista.
 */
export interface BloqueDeMenu {
  grupo: Grupo
  titulo: string
  ventanas: readonly Ventana[]
}
