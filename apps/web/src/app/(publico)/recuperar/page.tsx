'use client'

import { useState } from 'react'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

/**
 * Solicitud de recuperación.
 *
 * Pide el correo y dispara `/api/auth/recuperar`. En la demo el servidor devuelve el token en
 * la respuesta (en producción iría por correo), así que lo mostramos como un enlace para poder
 * probar el flujo. El mensaje de éxito es idéntico haya o no usuario: no revelamos qué correos
 * existen.
 */

export default function PaginaRecuperar() {
  const t = useTranslations('recuperar')
  const tc = useTranslations('comun')
  const [correo, setCorreo] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [enviado, setEnviado] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const respuesta = await fetch('/api/auth/recuperar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ correo }),
      })
      const datos = (await respuesta.json()) as { ok: boolean; token?: string }
      if (!datos.ok) {
        setError(t('errorEnvio'))
        return
      }
      setEnviado(true)
      setToken(datos.token ?? null)
    } catch {
      setError(t('errorDeRed'))
    } finally {
      setCargando(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-lienzo px-4 py-10">
      <form
        onSubmit={enviar}
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

        {error !== null && (
          <p role="alert" className="rounded-[var(--control-radio-sm)] bg-peligro-suave px-3 py-2 text-sm text-peligro-tinta">
            {error}
          </p>
        )}

        {enviado && (
          <div className="rounded-[var(--control-radio-sm)] bg-exito-suave px-3 py-2 text-sm text-exito-tinta">
            <p>{t('enviado')}</p>
            {token !== null && (
              <p className="mt-1">
                <Link href={`/recuperar/${token}`} className="font-medium underline">
                  {t('abrirDemo')}
                </Link>
              </p>
            )}
          </div>
        )}

        {!enviado && (
          <button
            type="submit"
            disabled={cargando}
            className="rounded-[var(--control-radio-sm)] bg-accion px-4 py-2 font-medium text-sobre-accion hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco disabled:opacity-60"
          >
            {cargando ? t('enviando') : t('enviar')}
          </button>
        )}

        <Link href="/ingresar" className="text-center text-sm text-acento hover:underline">
          {tc('volverAlIngreso')}
        </Link>
      </form>
    </main>
  )
}
