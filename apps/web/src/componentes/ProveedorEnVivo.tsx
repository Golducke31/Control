'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Canal } from '@control/contracts'
import type { EstadoConexion } from '@control/contracts'
import { ETIQUETA_CONEXION, TIPO_ENVIO_ACTUALIZADO } from '@/datos/eventos'

/**
 * El proveedor de tiempo real (§5.6).
 *
 * **Se monta una sola vez, en la carcasa, y abre una sola conexión por pestaña.** El
 * `Canal` de `@control/contracts` decide si tiene que haber conexión y quién escucha
 * qué; este componente es el único que toca el `EventSource`.
 *
 * Tres decisiones que no son obvias:
 *
 * 1. **Los eventos invalidan consultas, no escriben estado propio.** Cuando llega un
 *    evento, el proveedor avisa a quien escucha y cada ventana invalida *sus* claves de
 *    TanStack Query. Si el proveedor escribiera el estado, habría dos fuentes de verdad
 *    para los mismos datos y la que llegó por el stream podría contradecir a la que
 *    llegó por la consulta.
 * 2. **La reconexión la maneja el canal, no el `EventSource`.** El navegador reconecta
 *    solo, pero con su propio criterio y sin jitter: N pestañas caídas con el mismo
 *    servidor vuelven en el mismo instante y lo tumban de nuevo.
 * 3. **Con la pestaña oculta la conexión se cierra.** Mantenerla gasta batería y ancho
 *    de banda para nadie; al volver se reanuda y la consulta que dispara la ventana es
 *    la resincronización.
 */

interface ValorEnVivo {
  estado: EstadoConexion
  suscribir: (id: string, topicos: readonly string[], alEvento: (topico: string) => void) => void
  desuscribir: (id: string) => void
}

const ContextoEnVivo = createContext<ValorEnVivo | null>(null)

/** Lee el tópico de un marco. Un marco ilegible se ignora: el stream sigue. */
function leerTopico(datos: string): string | null {
  try {
    const analizado: unknown = JSON.parse(datos)
    if (typeof analizado === 'object' && analizado !== null && 'topico' in analizado) {
      const topico = (analizado as { topico: unknown }).topico
      return typeof topico === 'string' ? topico : null
    }
    return null
  } catch {
    return null
  }
}

export function ProveedorEnVivo({ children }: { children: ReactNode }) {
  // El canal se crea una vez y sobrevive a los renders: es el estado compartido de la
  // pestaña, y recrearlo en cada render abriría una conexión por render.
  const canalRef = useRef<Canal | null>(null)
  if (canalRef.current === null) canalRef.current = new Canal()
  const canal = canalRef.current

  const [estado, setEstado] = useState<EstadoConexion>('sin_conexion')
  const fuenteRef = useRef<EventSource | null>(null)
  const temporizadorRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const manejadoresRef = useRef(new Map<string, (topico: string) => void>())
  // `abrir` necesita llamar a `reconciliar` y `reconciliar` a `abrir`: el ref corta el
  // ciclo sin que ninguna de las dos dependa de la identidad de la otra.
  const reconciliarRef = useRef<(() => void) | null>(null)

  const cerrar = useCallback(() => {
    if (temporizadorRef.current !== null) {
      clearTimeout(temporizadorRef.current)
      temporizadorRef.current = null
    }
    fuenteRef.current?.close()
    fuenteRef.current = null
  }, [])

  const abrir = useCallback(() => {
    const fuente = new EventSource('/api/logistica/eventos')
    fuenteRef.current = fuente

    fuente.onopen = () => {
      canal.conectar()
      setEstado(canal.estado)
    }

    fuente.addEventListener(TIPO_ENVIO_ACTUALIZADO, (evento) => {
      const topico = leerTopico((evento as MessageEvent<string>).data)
      if (topico === null) return
      for (const id of canal.escuchan(topico)) {
        manejadoresRef.current.get(id)?.(topico)
      }
    })

    fuente.onerror = () => {
      cerrar()
      canal.caida()
      setEstado(canal.estado)
      // Sólo se reprograma si todavía hay a quién servir: si la pestaña quedó oculta o
      // nadie escucha, el canal ya dice que no corresponde estar conectado.
      if (canal.conexiones === 0 && canal.suscriptoresActivos > 0 && canal.pestanaVisible) {
        const espera = canal.proximoReintentoMs(Math.random)
        temporizadorRef.current = setTimeout(() => reconciliarRef.current?.(), espera)
      }
    }
  }, [canal, cerrar])

  const reconciliar = useCallback(() => {
    if (canal.conexiones === 1 && fuenteRef.current === null) abrir()
    else if (canal.conexiones === 0 && fuenteRef.current !== null) cerrar()
    setEstado(canal.estado)
  }, [abrir, canal, cerrar])

  reconciliarRef.current = reconciliar

  const suscribir = useCallback(
    (id: string, topicos: readonly string[], alEvento: (topico: string) => void) => {
      manejadoresRef.current.set(id, alEvento)
      canal.suscribir(id, topicos)
      reconciliar()
    },
    [canal, reconciliar],
  )

  const desuscribir = useCallback(
    (id: string) => {
      manejadoresRef.current.delete(id)
      canal.desuscribir(id)
      reconciliar()
    },
    [canal, reconciliar],
  )

  // Visibilidad: la conexión sigue a la pestaña.
  useEffect(() => {
    const alCambiar = () => {
      if (document.visibilityState === 'hidden') canal.ocultarPestana()
      else canal.mostrarPestana()
      reconciliar()
    }
    document.addEventListener('visibilitychange', alCambiar)
    return () => document.removeEventListener('visibilitychange', alCambiar)
  }, [canal, reconciliar])

  // Al desmontar la carcasa no puede quedar una conexión viva.
  useEffect(() => cerrar, [cerrar])

  const valor = useMemo<ValorEnVivo>(() => ({ estado, suscribir, desuscribir }), [estado, suscribir, desuscribir])

  return <ContextoEnVivo.Provider value={valor}>{children}</ContextoEnVivo.Provider>
}

export function useEnVivo(): ValorEnVivo {
  const valor = useContext(ContextoEnVivo)
  if (valor === null) {
    throw new Error('useEnVivo necesita estar dentro de <ProveedorEnVivo>, que se monta en la carcasa.')
  }
  return valor
}

/**
 * Suscribe una ventana a sus tópicos mientras está montada.
 *
 * El callback va por ref para que el efecto no se vuelva a ejecutar en cada render: si
 * dependiera de la identidad de la función, cada render desuscribiría y volvería a
 * suscribir, y con eso el canal cerraría y abriría la conexión sin parar.
 */
export function useSuscripcion(
  id: string,
  topicos: readonly string[],
  alEvento: (topico: string) => void,
): void {
  const { suscribir, desuscribir } = useEnVivo()
  const clave = topicos.join('|')
  const alEventoRef = useRef(alEvento)
  alEventoRef.current = alEvento

  useEffect(() => {
    const estable = (topico: string) => alEventoRef.current(topico)
    suscribir(id, clave === '' ? [] : clave.split('|'), estable)
    return () => desuscribir(id)
  }, [id, clave, suscribir, desuscribir])
}

const TONO_PUNTO: Record<EstadoConexion, string> = {
  en_vivo: 'bg-exito',
  reconectando: 'bg-atencion',
  sin_conexion: 'bg-terciario',
}

/**
 * El indicador del encabezado.
 *
 * §5.6 es explícito: **el usuario tiene que saber si lo que ve es actual**. Una pantalla
 * que parece actualizada y no lo está es peor que una que avisa, porque el operador
 * toma decisiones sobre datos que ya cambiaron. Por eso el estado de la conexión es
 * visible siempre, y no sólo cuando algo falla.
 */
export function IndicadorDeConexion() {
  const { estado } = useEnVivo()

  return (
    <span
      className="hidden items-center gap-1.5 rounded-[var(--control-radio-sm)] px-1.5 py-1 text-xs text-sobre-carcasa-sutil sm:flex"
      title={`Estado de la conexión en vivo: ${ETIQUETA_CONEXION[estado]}`}
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${TONO_PUNTO[estado]}`} />
      <span>{ETIQUETA_CONEXION[estado]}</span>
      <span className="sr-only">
        Estado de la conexión en vivo: {ETIQUETA_CONEXION[estado]}. Los datos pueden no estar actualizados.
      </span>
    </span>
  )
}
