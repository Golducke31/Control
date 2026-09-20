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

/** Tarea de gobierno (ventana Tareas). */
export const TareaSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  estado: z.enum(['abierta', 'en_curso', 'completada', 'cancelada']),
  asignadoA: z.string().optional(),
  vence: z.string().optional(),
})
export type Tarea = z.infer<typeof TareaSchema>

export const TareaListadoSchema = coleccionSchema(TareaSchema)
export type TareaListado = z.infer<typeof TareaListadoSchema>
