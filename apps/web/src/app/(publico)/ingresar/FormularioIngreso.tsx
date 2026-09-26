'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

/**
 * Formulario de ingreso.
 *
 * Es cliente porque maneja el estado del formulario y el POST. Lo único que hace con la
 * respuesta es navegar: el servidor fija la cookie `httpOnly` y devuelve adónde ir. Si el
 * usuario usa dos factores, el servidor no abre sesión: devuelve un desafío y el formulario
 * deriva a la pantalla de verificación.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

/**
 * Las cuentas de demostración.
 *
 * Guardan la **clave del mensaje**, no el texto: la nota que se muestra es interfaz, y si
 * estuviera acá habría que traducirla en el mismo archivo del que se está sacando. El `as
 * const` no es decorativo — hace que el tipo de `nota` sea la unión de las dos claves, así
 * que `t(c.nota)` sigue verificado.
 */
const CREDENCIALES_DEMO = [
  { correo: 'ana@control.app', nota: 'demoPropietaria' },
  { correo: 'beto@control.app', nota: 'demoDeposito' },
] as const

export function FormularioIngreso() {
  const t = useTranslations('ingreso')
  const [correo, setCorreo] = useState('ana@control.app')
  const [contrasena, setContrasena] = useState('control123')
  const [estado, setEstado] = useState<Estado>({ tipo: 'idle' })

  /**
   * El error del servidor se traduce con una clave, no con un texto.
   *
   * Los mensajes de error son interfaz igual que un título: si vivieran acá, no habría
   * forma de revisarlos junto con el resto ni de que el lint los viera.
   */
  function claveDeError(error?: string): 'errorCredenciales' | 'errorSinGoogle' | 'errorGenerico' {
    switch (error) {
      case 'credenciales':
        return 'errorCredenciales'
      case 'no-google':
        return 'errorSinGoogle'
      default:
        return 'errorGenerico'
    }
  }

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

      if (!datos.ok) {
        setEstado({ tipo: 'error', mensaje: t(claveDeError(datos.error)) })
        return
      }
      /*
        El orden importa, y estaba al revés: la comprobación de `redirect` iba antes que la
        del segundo factor, y la respuesta de un usuario con 2FA **no trae `redirect`** —trae
        el desafío, porque la sesión todavía no está abierta—. Así que la rama del 2FA era
        inalcanzable y quien tuviera dos factores veía «No se pudo ingresar» con la clave
        correcta. Primero el segundo factor, después el destino.
      */
      if (datos.dosFactores && datos.desafio !== undefined) {
        window.location.href = `/ingresar/verificar?d=${encodeURIComponent(datos.desafio)}`
        return
      }
      if (datos.redirect === undefined) {
        setEstado({ tipo: 'error', mensaje: t('errorSinDestino') })
        return
      }
      window.location.href = datos.redirect
    } catch {
      setEstado({ tipo: 'error', mensaje: t('errorDeRed') })
    }
  }

  return (
    <form
      onSubmit={(e) => enviar(e, 'credenciales')}
      className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 shadow-sm"
    >
      <div>
        <h1 className="font-titulos text-xl font-semibold text-principal">{t('titulo')}</h1>
        <p className="mt-1 text-sm text-secundario">{t('subtitulo')}</p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        {t('correo')}
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
        {t('contrasena')}
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
        {estado.tipo === 'cargando' ? t('ingresando') : t('ingresar')}
      </button>

      <button
        type="button"
        onClick={(e) => enviar(e, 'google')}
        className="rounded-[var(--control-radio-sm)] border border-borde-control px-4 py-2 font-medium text-principal hover:bg-carcasa-sutil focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
      >
        {t('conGoogle')}
      </button>

      <div className="mt-2 rounded-[var(--control-radio-sm)] bg-carcasa-sutil px-3 py-2 text-xs text-secundario">
        <p className="font-medium text-principal">{t('cuentasDemo')}</p>
        <ul className="mt-1 space-y-0.5">
          {CREDENCIALES_DEMO.map((c) => (
            <li key={c.correo}>
              {/*
                La línea mezcla texto y marcado —el correo va en `<code>`—, así que se
                traduce entera con `t.rich`: partirla en fragmentos dejaría «· control123 —»
                como una clave suelta, que no se puede traducir a nada.
              */}
              {t.rich('lineaDemo', {
                correo: c.correo,
                nota: t(c.nota),
                code: (trozos) => <code className="text-principal">{trozos}</code>,
              })}
            </li>
          ))}
        </ul>
      </div>
    </form>
  )
}
