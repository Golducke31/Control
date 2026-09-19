import { Insignia, Tarjeta } from '@control/ui'

import { EncabezadoDeVentana } from '@control/ui'
import type { Ventana } from '@/rutas'

/**
 * Lo que muestra una ventana en F1.
 *
 * F1 entrega la carcasa y la navegación, no las catorce ventanas con sus datos: eso es
 * F4 a F8. Pero en vez de dejar catorce páginas en blanco, cada ventana declara acá lo
 * que el mapa dice de ella —su permiso, su bandera, su fase y sus subrutas— y así el
 * mapa queda **legible y verificable a simple vista**, no sólo en el archivo.
 *
 * Cuando llegue la fase de cada ventana, este componente se reemplaza por su contenido.
 */
export function VentanaPendiente({ ventana }: { ventana: Ventana }) {
  return (
    <div className="flex flex-col gap-6">
      <EncabezadoDeVentana
        titulo={ventana.titulo}
        descripcion={ventana.descripcion}
        acciones={
          <>
            <Insignia tono="neutro">Fase {ventana.fase}</Insignia>
            {ventana.funcionalidad !== undefined && (
              <Insignia tono="informacion">Requiere {ventana.funcionalidad}</Insignia>
            )}
          </>
        }
      />

      <Tarjeta
        titulo="Ventana declarada, contenido pendiente"
        descripcion={`La carcasa y la navegación están listas. El contenido de esta ventana —sus datos y sus gráficos— se implementa en la fase ${ventana.fase}.`}
      >
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Dato etiqueta="Ruta" valor={`/e/[empresa]/${ventana.segmento}`} mono />
          <Dato etiqueta="Permiso" valor={ventana.permiso ?? 'basta con tener sesión'} mono={ventana.permiso !== null} />
          <Dato etiqueta="Grupo del menú" valor={ventana.grupo} />
          <Dato
            etiqueta="Subrutas"
            valor={ventana.subrutas.length === 0 ? 'ninguna' : String(ventana.subrutas.length)}
          />
        </dl>

        {ventana.subrutas.length > 0 && (
          <div className="mt-5 border-t border-borde-sutil pt-4">
            <p className="mb-2.5 text-xs font-medium tracking-wide text-terciario uppercase">
              Subrutas declaradas
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {ventana.subrutas.map((subruta) => (
                <li key={subruta.id}>
                  <Insignia tono="neutro">
                    <span className="cifras font-mono text-[11px]">{subruta.segmento}</span>
                    <span className="text-terciario">·</span>
                    {subruta.fase}
                  </Insignia>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Tarjeta>
    </div>
  )
}

function Dato({
  etiqueta,
  valor,
  mono = false,
}: {
  etiqueta: string
  valor: string
  mono?: boolean
}) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-terciario uppercase">{etiqueta}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-sm text-principal' : 'mt-0.5 text-sm text-principal'}>
        {valor}
      </dd>
    </div>
  )
}
