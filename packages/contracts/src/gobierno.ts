import { z } from 'zod'
import { ENUMS } from './enums.ts'
import { coleccionSchema } from './comun.ts'

/** Miembro de una empresa: su rol y los permisos que tiene ahí (autorización por usuario). */
export const MiembroSchema = z.object({
  usuarioId: z.string(),
  nombre: z.string(),
  iniciales: z.string(),
  rol: z.string(),
  permisos: z.array(z.string()),
  estado: ENUMS['app.user_status'],
})
export type Miembro = z.infer<typeof MiembroSchema>

export const MiembroListadoSchema = coleccionSchema(MiembroSchema)
export type MiembroListado = z.infer<typeof MiembroListadoSchema>

/** Evento de auditoría. */
export const AuditoriaEventoSchema = z.object({
  id: z.string(),
  fecha: z.string(),
  actor: z.string(),
  accion: z.string(),
  entidad: z.string(),
  entidadId: z.string().optional(),
  detalle: z.string().optional(),
})
export type AuditoriaEvento = z.infer<typeof AuditoriaEventoSchema>

export const AuditoriaListadoSchema = coleccionSchema(AuditoriaEventoSchema)
export type AuditoriaListado = z.infer<typeof AuditoriaListadoSchema>

/**
 * **Las tareas programadas no viven acá.** La ventana Tareas muestra los jobs del motor
 * (`ops.jobs` / `ops.job_runs`) —con su cadencia, su última corrida y su atraso—, y su
 * contrato es `trabajos.ts`. Este archivo tuvo un `TareaSchema` que modelaba una tarea de
 * gobierno —un pendiente con título y vencimiento— y **ninguna ventana lo usaba**: el
 * nombre coincidía con el de la ventana y el contenido no. Se eliminó en F9 en vez de
 * dejarlo como esquema huérfano, porque un esquema que nadie consume y cuyo nombre
 * sugiere lo contrario es peor que no tenerlo.
 */
