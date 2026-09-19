import { redirect } from 'next/navigation'

import { EMPRESA_POR_DEFECTO } from '@/empresa'

/**
 * La raíz no es una pantalla: es una decisión.
 *
 * En F2 resuelve a la empresa de la sesión —o al ingreso si no hay sesión—. Hoy lleva a
 * la empresa de demostración, para que abrir la aplicación lleve a algún lado en vez de
 * a una página de bienvenida que no aporta nada.
 */
export default function Inicio() {
  redirect(`/e/${EMPRESA_POR_DEFECTO}/panel`)
}
