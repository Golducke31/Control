/**
 * Banda de impersonación.
 *
 * Aparece cuando un usuario de plataforma está actuando como otro. Es **persistente y no
 * descartable**: no tiene cierre dentro de la banda misma, porque la única forma de salir
 * es volver a la sesión real (el backend lo fuerza). Muestra a quién se impersona, el
 * usuario real y el tiempo que le queda, para que nadie se confunda sobre con qué identidad
 * está operando.
 */

export function BandaImpersonacion({ objetivo, por, exp }: { objetivo: string; por: string; exp: number }) {
  const segundosRestantes = Math.max(0, exp - Math.floor(Date.now() / 1000))
  const minutos = Math.floor(segundosRestantes / 60)

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-peligro-solido px-4 py-1.5 text-center text-sm font-medium text-sobre-peligro"
    >
      <span aria-hidden="true">⚠</span>
      <span>
        Modo impersonación: actuando como <strong>{objetivo}</strong> · sesión real de {por} · vence en {minutos} min.
      </span>
      <form action="/api/auth/impersonar" method="post" className="ml-2">
        <input type="hidden" name="detener" value="1" />
        <button
          type="submit"
          className="rounded-[var(--control-radio-sm)] bg-sobre-peligro px-2 py-0.5 text-xs font-semibold text-peligro-solido hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
        >
          Volver a mi sesión
        </button>
      </form>
    </div>
  )
}
