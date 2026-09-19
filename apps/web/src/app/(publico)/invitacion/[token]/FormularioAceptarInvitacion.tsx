'use client'

import { useState } from 'react'

/**
 * Acepta la invitación: nombre y contraseña para la cuenta que se está creando.
 *
 * El token viene en la ruta y se envía al servidor, que crea el usuario y su membresía y abre
 * sesión. Quien recibe la invitación no necesita saber a qué empresa entra: el token lo dice.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

export function FormularioAceptarInvitacion({ token, correo }: { token: string; correo: string }) {
  const [nombre, setNombre] = useState('')
  const [contrasena, setContrasena] = useState('')
  const [estado, setEstado] = useState<Estado>({ tipo: 'idle' })

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault()
    if (nombre.trim().length < 2) {
      setEstado({ tipo: 'error', mensaje: 'Ingresá tu nombre.' })
      return
    }
    if (contrasena.length < 6) {
      setEstado({ tipo: 'error', mensaje: 'Usá al menos 6 caracteres.' })
      return
    }
    setEstado({ tipo: 'cargando' })
    try {
      const respuesta = await fetch('/api/auth/invitacion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, nombre: nombre.trim(), contrasena }),
      })
      const datos = (await respuesta.json()) as { ok: boolean; redirect?: string; error?: string }
      if (!datos.ok || datos.redirect === undefined) {
        setEstado({ tipo: 'error', mensaje: 'La invitación no es válida o expiró.' })
        return
      }
      window.location.href = datos.redirect
    } catch {
      setEstado({ tipo: 'error', mensaje: 'No se pudo conectar con el servidor.' })
    }
  }

  return (
    <form
      onSubmit={enviar}
      className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 shadow-sm"
    >
      <div>
        <h1 className="font-titulos text-xl font-semibold text-principal">Aceptar invitación</h1>
        <p className="mt-1 text-sm text-secundario">
          Te invitaron como <strong className="text-principal">{correo}</strong>. Completá tus datos para entrar.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        Nombre
        <input
          required
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className="rounded-[var(--control-radio-sm)] border border-borde-control bg-lienzo px-3 py-2 text-principal outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        Contraseña
        <input
          type="password"
          required
          minLength={6}
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
          autoComplete="new-password"
          className="rounded-[var(--control-radio-sm)] border border-borde-control bg-lienzo px-3 py-2 text-principal outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        />
      </label>

      {estado.tipo === 'error' && (
        <p role="alert" className="rounded-[var(--control-radio-sm)] bg-peligro-suave px-3 py-2 text-sm text-peligro-tinta">
          {estado.mensaje}
        </p>
      )}

      <button
        type="submit"
        disabled={estado.tipo === 'cargando'}
        className="rounded-[var(--control-radio-sm)] bg-accion px-4 py-2 font-medium text-sobre-accion hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco disabled:opacity-60"
      >
        {estado.tipo === 'cargando' ? 'Creando cuenta…' : 'Aceptar e ingresar'}
      </button>
    </form>
  )
}
