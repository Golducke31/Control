'use client'

import { useState } from 'react'

/**
 * Restablece la contraseña con el token de la URL.
 *
 * El token viene en la ruta; el formulario lo envía tal cual a `/api/auth/restablecer`. Tras
 * el éxito, el servidor fija la cookie y devuelve adónde ir.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

export function FormularioRestablecer({ token }: { token: string }) {
  const [contrasena, setContrasena] = useState('')
  const [estado, setEstado] = useState<Estado>({ tipo: 'idle' })

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault()
    if (contrasena.length < 6) {
      setEstado({ tipo: 'error', mensaje: 'Usá al menos 6 caracteres.' })
      return
    }
    setEstado({ tipo: 'cargando' })
    try {
      const respuesta = await fetch('/api/auth/restablecer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, contrasena }),
      })
      const datos = (await respuesta.json()) as { ok: boolean; redirect?: string; error?: string }
      if (!datos.ok || datos.redirect === undefined) {
        setEstado({ tipo: 'error', mensaje: 'El enlace no es válido o expiró.' })
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
        <h1 className="font-titulos text-xl font-semibold text-principal">Nueva contraseña</h1>
        <p className="mt-1 text-sm text-secundario">Elegí una contraseña para tu cuenta.</p>
      </div>

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
        {estado.tipo === 'cargando' ? 'Guardando…' : 'Restablecer'}
      </button>
    </form>
  )
}
