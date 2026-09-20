/**
 * @control/ui — componentes de interfaz de Control.
 *
 * Sin lógica de negocio y sin acceso a datos: sólo presentación y accesibilidad. Todo
 * el color pasa por las variables de `@control/tokens`; no hay un solo valor literal
 * en este paquete, y el lint lo verifica.
 */

export { cn } from './cn'
export type { Clase } from './cn'

export { Boton } from './Boton'
export type { PropsDeBoton, TamanoDeBoton, VarianteDeBoton } from './Boton'

export { Tarjeta } from './Tarjeta'
export type { PropsDeTarjeta } from './Tarjeta'

export { Insignia } from './Insignia'
export type { PropsDeInsignia, TonoDeInsignia } from './Insignia'

export { Esqueleto } from './Esqueleto'
export type { PropsDeEsqueleto } from './Esqueleto'

export { EstadoVacio } from './EstadoVacio'
export type { PropsDeEstadoVacio } from './EstadoVacio'

export { EncabezadoDeVentana } from './EncabezadoDeVentana'
export type { PropsDeEncabezadoDeVentana } from './EncabezadoDeVentana'

export { DataTable } from './DataTable'
export type { Columna, PropsDataTable, AccionVacia } from './DataTable'
