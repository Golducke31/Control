'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { EncabezadoDeVentana, DataTable, Boton, Insignia } from '@control/ui'
import type { Columna } from '@control/ui'
import type { Deposito, NivelStock } from '@control/contracts'
import { aplicarRecuento } from '@control/contracts'
import { getCliente } from '@/datos/cliente'
import { formatearNumero } from '@/datos/formato'

/** La clave de una línea: el mismo producto puede estar en más de un depósito. */
const clave = (n: { productoId: string; depositoId: string }) => `${n.productoId}|${n.depositoId}`

type Resultado = { ok: true; delta: number; tipo: string } | { ok: false; motivo: string }

/**
 * Recuento (F5 · Stock) — la planilla de conteo físico.
 *
 * **Regla de la puerta de F5 (1):** aplicar un recuento ajusta el saldo **y** escribe
 * su fila en el libro mayor. Las dos cosas salen de `aplicarRecuento`, la función pura
 * que también corre el backend: acá no hay una segunda versión de la regla.
 *
 * No hay documento de recuento porque el motor no tiene esa tabla: un recuento es un
 * conjunto de movimientos de ajuste. Por eso la planilla es estado de pantalla y lo
 * que queda escrito es el libro.
 *
 * El depósito elegido vive en la URL (`?deposito=`), como el resto del estado de vista
 * (A12): recargar deja el mismo depósito seleccionado.
 */
export function RecuentoCliente({
  slug,
  niveles,
  depositos,
}: {
  slug: string
  niveles: NivelStock[]
  depositos: Deposito[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const depositoElegido = searchParams.get('deposito') ?? 'todos'

  const [contados, setContados] = useState<Record<string, string>>({})
  const [aplicados, setAplicados] = useState<Record<string, string>>({})
  const [enviando, setEnviando] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const lineas = useMemo(
    () => (depositoElegido === 'todos' ? niveles : niveles.filter((n) => n.depositoId === depositoElegido)),
    [niveles, depositoElegido],
  )

  function elegirDeposito(valor: string) {
    const sp = new URLSearchParams(searchParams.toString())
    if (valor === 'todos') sp.delete('deposito')
    else sp.set('deposito', valor)
    router.replace(`?${sp.toString()}`, { scroll: false })
  }

  /** La previsualización del ajuste: la misma función que después se aplica. */
  function previsualizar(nivel: NivelStock): Resultado | null {
    const crudo = contados[clave(nivel)]
    if (crudo === undefined || crudo.trim() === '') return null
    const contado = Number(crudo)
    if (!Number.isInteger(contado) || contado < 0) return { ok: false, motivo: 'cantidad inválida' }

    const r = aplicarRecuento(nivel, contado, { idMovimiento: 'previsualización', fecha: 'previsualización' })
    if (!r.ok) return { ok: false, motivo: 'por debajo de lo reservado' }
    const delta = contado - nivel.cantidad
    return {
      ok: true,
      delta,
      tipo: delta === 0 ? 'sin diferencia' : delta > 0 ? 'ajuste positivo' : 'ajuste negativo',
    }
  }

  async function aplicar(nivel: NivelStock) {
    const crudo = contados[clave(nivel)]
    if (crudo === undefined) return
    const contado = Number(crudo)
    const k = clave(nivel)
    setEnviando(k)
    setError(null)
    try {
      const r = await getCliente().aplicarRecuento({ empresaSlug: slug, nivel, contado })
      if (r.ok) {
        setAplicados((prev) => ({
          ...prev,
          [k]:
            r.ajuste.movimiento === null
              ? 'sin diferencia: no se escribió nada'
              : `${r.ajuste.movimiento.tipo} ${r.ajuste.movimiento.cantidad > 0 ? '+' : ''}${r.ajuste.movimiento.cantidad} → saldo ${r.ajuste.nivel.cantidad}`,
        }))
        setContados((prev) => ({ ...prev, [k]: '' }))
      } else {
        setError(
          r.motivo === 'contado_por_debajo_de_lo_reservado'
            ? `${nivel.sku}: hay ${r.reservada} reservadas, no se puede contar menos que eso.`
            : `${nivel.sku}: ${r.motivo}.`,
        )
      }
    } finally {
      setEnviando(null)
    }
  }

  const columnas = useMemo<Columna<NivelStock>[]>(
    () => [
      {
        id: 'sku',
        titulo: 'SKU',
        cuerpo: (n) => <span className="font-mono text-xs text-secundario">{n.sku}</span>,
      },
      { id: 'nombre', titulo: 'Producto', cuerpo: (n) => n.nombre },
      {
        id: 'deposito',
        titulo: 'Depósito',
        cuerpo: (n) => <span className="text-secundario">{n.depositoNombre}</span>,
      },
      {
        id: 'sistema',
        titulo: 'Sistema',
        alinear: 'derecha',
        cuerpo: (n) => formatearNumero.format(n.cantidad),
      },
      {
        id: 'reservada',
        titulo: 'Reservada',
        alinear: 'derecha',
        cuerpo: (n) => <span className="text-secundario">{formatearNumero.format(n.reservada)}</span>,
      },
      {
        id: 'contado',
        titulo: 'Contado',
        alinear: 'derecha',
        cuerpo: (n) => (
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={contados[clave(n)] ?? ''}
            onChange={(e) => setContados((prev) => ({ ...prev, [clave(n)]: e.target.value }))}
            aria-label={`Cantidad contada de ${n.sku} en ${n.depositoNombre}`}
            placeholder="—"
            className="h-8 w-20 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-2 text-right text-sm tabular-nums text-principal placeholder:text-terciario focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
          />
        ),
      },
      {
        id: 'efecto',
        titulo: 'Efecto',
        cuerpo: (n) => {
          const aplicado = aplicados[clave(n)]
          if (aplicado !== undefined) {
            return (
              <Insignia tono="exito" conPunto>
                {aplicado}
              </Insignia>
            )
          }
          const previa = previsualizar(n)
          if (previa === null) return <span className="text-xs text-terciario">sin contar</span>
          if (!previa.ok) return <span className="text-xs text-peligro">{previa.motivo}</span>
          return (
            <span className={previa.delta === 0 ? 'text-xs text-terciario' : 'text-xs text-secundario'}>
              {previa.tipo}
              {previa.delta !== 0 && ` ${previa.delta > 0 ? '+' : ''}${previa.delta}`}
            </span>
          )
        },
      },
      {
        id: 'acciones',
        titulo: 'Acciones',
        cuerpo: (n) => {
          const previa = previsualizar(n)
          const listo = previa !== null && previa.ok
          return (
            <Boton
              variante="secundario"
              tamano="sm"
              disabled={!listo || enviando === clave(n)}
              onClick={() => void aplicar(n)}
            >
              Aplicar
            </Boton>
          )
        },
      },
    ],
    [contados, aplicados, enviando],
  )

  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo="Recuento"
        descripcion="Contá lo que hay y aplicá el ajuste. Aplicar escribe el movimiento de ajuste en el libro mayor y mueve el saldo: no hay un documento de recuento, hay movimientos."
        barra={
          <>
            <label className="flex items-center gap-2 text-sm text-secundario">
              Depósito
              <select
                value={depositoElegido}
                onChange={(e) => elegirDeposito(e.target.value)}
                className="h-9 rounded-[var(--control-radio)] border border-borde-control bg-tarjeta px-2 text-sm text-principal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foco"
              >
                <option value="todos">Todos</option>
                {depositos.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.nombre}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-terciario">
              {formatearNumero.format(lineas.length)} renglones para contar
            </span>
          </>
        }
      />

      {error !== null && (
        <p className="rounded-[var(--control-radio)] bg-peligro-suave px-3 py-2 text-sm text-peligro">{error}</p>
      )}

      <DataTable<NivelStock>
        columnas={columnas}
        datos={lineas}
        cargando={false}
        error={null}
        tituloVacia="No hay niveles en este depósito"
        descripcionVacia="Sin saldo materializado no hay nada que contar: la primera entrada crea el nivel."
      />
    </div>
  )
}
