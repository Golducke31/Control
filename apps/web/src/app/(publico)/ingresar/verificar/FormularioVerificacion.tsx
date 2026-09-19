'use client'

import { useState } from 'react'

/**
 * Segundo factor.
 *
 * Recibe el desafío firmado del paso anterior y lo cambia por la sesión cuando el código
 * cuadra. En la demo el código es cualquier secuencia de 6 dígitos: el objetivo es ejercitar
 * el flujo y el aislamiento de la sesión, no un TOTP real.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

export function FormularioVerificacion({ desafio }: { desafio: string }) {
  const [codigo, setCodigo] = useState('')
  const [estado, setEstado] = useState<Estado>({ tipo: 'idle' })

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault()
    setEstado({ tipo: 'cargando' })
    try {
      const respuesta = await fetch('/api/auth/verificar-2fa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ desafio, codigo }),
      })
      const datos = (await respuesta.json()) as { ok: boolean; redirect?: string; error?: string }
      if (!datos.ok || datos.redirect === undefined) {
        setEstado({ tipo: 'error', mensaje: datos.error === 'codigo' ? 'Código incorrecto.' : 'El desafío expiró. Volvé a ingresar.' })
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
        <h1 className="font-titulos text-xl font-semibold text-principal">Verificación en dos pasos</h1>
        <p className="mt-1 text-sm text-secundario">
          Ingresá el código de 6 dígitos de tu autenticador. En la demostración, cualquier código de 6 dígitos sirve.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        Código
        <input
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
          autoFocus
          className="rounded-[var(--control-radio-sm)] border border-borde-control bg-lienzo px-3 py-2 text-center text-lg tracking-[0.5em] text-principal outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
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
        {estado.tipo === 'cargando' ? 'Verificando…' : 'Verificar'}
      </button>

      <a href="/ingresar" className="text-center text-sm text-acento hover:underline">
        Volver al ingreso
      </a>
    </form>
  )
}
