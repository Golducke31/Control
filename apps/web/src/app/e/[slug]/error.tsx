'use client'

import { Boton } from '@control/ui'

/**
 * La frontera de error de una ventana (F9).
 *
 * Es la respuesta al defecto 1 del prototipo, que era una sola página con ocho vistas:
 * «imposible aislar fallos». Acá un error en una ventana se detiene **en la ventana**:
 * la carcasa, el menú, el selector de empresa y las demás ventanas siguen funcionando.
 *
 * Next monta esta frontera por segmento, así que el `reset` vuelve a intentar **sólo** el
 * subárbol que falló, sin recargar la aplicación ni perder la sesión.
 *
 * El `digest` se muestra: sin él, un error en producción es «algo salió mal» y no hay
 * forma de cruzarlo con el log del servidor. El mensaje crudo no se muestra cuando hay
 * digest, porque en producción el mensaje puede llevar datos de la consulta.
 */
export default function ErrorDeVentana({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col gap-4 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta p-6">
      <div>
        <h1 className="text-base font-medium text-principal">Esta ventana falló</h1>
        <p className="mt-1 text-sm text-secundario">
          El resto de la aplicación sigue funcionando: podés cambiar de ventana desde el menú o reintentar acá.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Boton variante="primario" tamano="sm" onClick={reset}>
          Reintentar
        </Boton>
      </div>

      {error.digest !== undefined ? (
        <p className="font-mono text-xs text-terciario">Referencia para el soporte: {error.digest}</p>
      ) : (
        <p className="font-mono text-xs text-terciario">{error.message}</p>
      )}
    </div>
  )
}
