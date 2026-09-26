'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

/**
 * Segundo factor.
 *
 * Recibe el desafío firmado del paso anterior y lo cambia por la sesión cuando el código
 * cuadra. En la demo el código es cualquier secuencia de 6 dígitos: el objetivo es ejercitar
 * el flujo y el aislamiento de la sesión, no un TOTP real.
 */

type Estado = { tipo: 'idle' } | { tipo: 'cargando' } | { tipo: 'error'; mensaje: string }

export function FormularioVerificacion({ desafio }: { desafio: string }) {
  const t = useTranslations('verificar')
  const tc = useTranslations('comun')
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
        setEstado({ tipo: 'error', mensaje: datos.error === 'codigo' ? t('errorCodigo') : t('errorDesafio') })
        return
      }
      window.location.href = datos.redirect
    } catch {
      setEstado({ tipo: 'error', mensaje: t('errorDeRed') })
    }
  }

  return (
    <form
      onSubmit={enviar}
      /*
        El `action` y el campo oculto existen para el envío que **no** maneja React.
        El HTML llega antes que el JavaScript: en esa ventana, un `<form>` sin `action` que
        se envía lo procesa el navegador, y un envío nativo va a la ruta **sin la query
        string** — así que el desafío se perdía y la pantalla respondía «No hay una
        verificación en curso» con la clave correcta, justo después de venir del ingreso.
        Con el desafío también en un campo, un envío nativo vuelve a esta misma pantalla con
        el desafío intacto y la persona sólo tiene que volver a escribir el código.
      */
      action="/ingresar/verificar"
      method="get"
      className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--control-radio)] border border-borde-sutil bg-tarjeta p-6 shadow-sm"
    >
      <input type="hidden" name="d" value={desafio} />
      <div>
        <h1 className="font-titulos text-xl font-semibold text-principal">{t('titulo')}</h1>
        <p className="mt-1 text-sm text-secundario">{t('subtitulo')}</p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium text-principal">
        {t('codigo')}
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
        {estado.tipo === 'cargando' ? t('verificando') : t('verificar')}
      </button>

      <a href="/ingresar" className="text-center text-sm text-acento hover:underline">
        {tc('volverAlIngreso')}
      </a>
    </form>
  )
}
