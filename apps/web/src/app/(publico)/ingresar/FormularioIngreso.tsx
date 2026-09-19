'use client'

import { useState } from 'react'

/**
 * Formulario de ingreso.
 *
 * Es cliente porque maneja el estado del formulario y el POST. Lo único que hace con la
 * respuesta es navegar: el servidor fija la cookie `httpOnly` y devuelve adónde ir. Si el
 * usuario usa dos factores, el servidor no abre sesión: devuelve un desafío y el formulario
 * deriva a la pantalla de verificación.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

const CREDENCIALES_DEMO = [
  { correo: 'ana@control.app', nota: 'Propietaria · con 2FA' },
  { correo: 'beto@control.app', nota: 'Encargado de depósito · pocos permisos' },
]

export function FormularioIngreso() {
  const [correo, setCorreo] = useState('ana@control.app')
  const [contrasena, setContrasena] = useState('control123')
  const [estado, setEstado] = useState<Estado>({ tipo: 'idle' })

  async function enviar(evento: React.FormEvent, modo: 'credenciales' | 'google') {
    evento.preventDefault()
    setEstado({ tipo: 'cargando' })

    try {
      const respuesta = await fetch(modo === 'google' ? '/api/auth/sso' : '/api/auth/ingresar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(modo === 'google' ? { correo } : { correo, contrasena }),
      })
      const datos = (await respuesta.json()) as {
        ok: boolean
        redirect?: string
        dosFactores?: boolean
        desafio?: string
        error?: string
      }

      if (!datos.ok || datos.redirect === undefined) {
        setEstado({ tipo: 'error', mensaje: mensajeDeError(datos.error) })
        return
      }
      if (datos.dosFactores && datos.desafio !== undefined) {
        window.location.href = `/ingresar/verificar?d=${encodeURIComponent(datos.desafio)}`
        return
      }
      window.location.href = datos.redirect
    } catch {
      setEstado({ tipo: 'error', mensaje: 'No se pudo conectar con el servidor.' })
    }
  }

  return (
    <form
      onSubmit={(e) => enviar(e, 'credenciales')}
      className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 shadow-sm"
    >
      <div>
        <h1 className="font-titulos text-xl font-semibold text-principal">Ingresar a Control</h1>
        <p className="mt-1 text-sm text-secundario">Accedé con tu cuenta o con Google.</p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        Correo
        <input
          type="email"
          required
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
          autoComplete="username"
          className="rounded-[var(--control-radio-sm)] border border-borde-control bg-lienzo px-3 py-2 text-principal outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        Contraseña
        <input
          type="password"
          required
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
          autoComplete="current-password"
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
        {estado.tipo === 'cargando' ? 'Ingresando…' : 'Ingresar'}
      </button>

      <button
        type="button"
        onClick={(e) => enviar(e, 'google')}
        className="rounded-[var(--control-radio-sm)] border border-borde-control px-4 py-2 font-medium text-principal hover:bg-carcasa-sutil focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
      >
        Continuar con Google
      </button>

      <div className="mt-2 rounded-[var(--control-radio-sm)] bg-carcasa-sutil px-3 py-2 text-xs text-secundario">
        <p className="font-medium text-principal">Cuentas de demostración</p>
        <ul className="mt-1 space-y-0.5">
          {CREDENCIALES_DEMO.map((c) => (
            <li key={c.correo}>
              <code className="text-principal">{c.correo}</code> · control123 — {c.nota}
            </li>
          ))}
        </ul>
      </div>
    </form>
  )
}

function mensajeDeError(error?: string): string {
  switch (error) {
    case 'credenciales':
      return 'Correo o contraseña incorrectos.'
    case 'no-google':
      return 'Es correo no está habilitado para ingreso con Google.'
    default:
      return 'No se pudo ingresar. Intentá de nuevo.'
  }
}
