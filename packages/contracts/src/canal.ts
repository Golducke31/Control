/**
 * El canal de tiempo real (§5.6).
 *
 * **La regla que este módulo existe para garantizar: una sola conexión por pestaña,
 * multiplexada por tópico.** Una conexión por componente no escala, y la torre de
 * control con doscientos envíos en el mapa es exactamente el caso que lo rompe: si
 * cada tarjeta abriera su `EventSource`, serían doscientas conexiones contra el
 * servidor para ver los mismos datos.
 *
 * El módulo es lógica pura —no abre ninguna conexión—: mantiene el estado que decide
 * si la conexión tiene que estar abierta, y quién escucha qué. La apertura real la
 * hace el proveedor, que es un único componente montado en la carcasa. Separarlo así
 * es lo que permite probar la regla: `canal.test.ts` suscribe doscientos tópicos y
 * comprueba que la cantidad de conexiones es **uno**.
 *
 * El transporte es SSE y no WebSocket porque el flujo es servidor→cliente (§5.6).
 */

/** El estado que ve el usuario en el encabezado. Una pantalla que parece actualizada y no lo está es peor que una que avisa. */
export type EstadoConexion = 'en_vivo' | 'reconectando' | 'sin_conexion'

export interface OpcionesCanal {
  baseRetrocesoMs?: number
  maxRetrocesoMs?: number
}

/**
 * Retroceso exponencial con **jitter completo**.
 *
 * El valor se reparte entre 0 y el tope exponencial en vez de usar el tope tal cual.
 * La razón no es elegancia: sin jitter, las N pestañas que se cayeron con el mismo
 * servidor reconectan en el mismo instante y lo vuelven a tumbar — el mismo problema
 * que el `EXCLUDE` de precios resolvió en la base, pero del lado del cliente.
 *
 * Recibe el azar por parámetro para que la prueba sea determinista: una función que
 * llama a `Math.random()` por dentro no se puede verificar.
 */
export function retrocesoMs(
  intento: number,
  azar: () => number,
  opciones: OpcionesCanal = {},
): number {
  const base = opciones.baseRetrocesoMs ?? 1000
  const tope = opciones.maxRetrocesoMs ?? 30000
  const exponencial = Math.min(tope, base * 2 ** Math.max(0, intento - 1))
  return Math.round(exponencial * azar())
}

/**
 * El multiplexor.
 *
 * No conoce el transporte: sabe **si** tiene que haber una conexión y **qué tópicos**
 * le interesan a quién. El proveedor lo consulta y abre o cierra en consecuencia.
 */
export class Canal {
  /** tópico → ids de quienes lo escuchan. */
  private readonly suscriptores = new Map<string, Set<string>>()
  /** Si hay una conexión abierta ahora mismo. */
  private conexionAbierta = false
  private intentos = 0
  private visible = true
  private readonly baseRetrocesoMs: number
  private readonly maxRetrocesoMs: number

  constructor(opciones: OpcionesCanal = {}) {
    this.baseRetrocesoMs = opciones.baseRetrocesoMs ?? 1000
    this.maxRetrocesoMs = opciones.maxRetrocesoMs ?? 30000
  }

  /**
   * Cuántas conexiones hay abiertas. **Nunca puede pasar de 1**, y es el número que
   * la puerta de F7 vigila.
   */
  get conexiones(): number {
    return this.conexionAbierta ? 1 : 0
  }

  /** Cuántos suscriptores distintos hay, sumando todos los tópicos. */
  get suscriptoresActivos(): number {
    const ids = new Set<string>()
    for (const conjunto of this.suscriptores.values()) for (const id of conjunto) ids.add(id)
    return ids.size
  }

  /** Los tópicos con al menos un suscriptor. */
  get topicos(): string[] {
    return [...this.suscriptores.entries()]
      .filter(([, ids]) => ids.size > 0)
      .map(([topico]) => topico)
      .sort()
  }

  /**
   * Quiénes escuchan un tópico.
   *
   * El proveedor la usa para repartir un evento entrante: el canal sabe a quién
   * avisar, y así el proveedor no tiene que replicar el índice de suscripciones (que
   * es justo el estado que este módulo existe para tener en un solo lugar).
   */
  escuchan(topico: string): string[] {
    return [...(this.suscriptores.get(topico) ?? [])]
  }

  get intentosFallidos(): number {
    return this.intentos
  }

  get estado(): EstadoConexion {
    if (this.conexionAbierta) return 'en_vivo'
    if (this.deberiaEstarAbierta()) return 'reconectando'
    return 'sin_conexion'
  }

  /** El próximo reintento, con el jitter aplicado. */
  proximoReintentoMs(azar: () => number): number {
    return retrocesoMs(this.intentos, azar, {
      baseRetrocesoMs: this.baseRetrocesoMs,
      maxRetrocesoMs: this.maxRetrocesoMs,
    })
  }

  /**
   * Suscribe un componente a uno o más tópicos.
   *
   * Se puede llamar doscientas veces con doscientos ids distintos: la conexión sigue
   * siendo una.
   */
  suscribir(id: string, topicos: readonly string[]): void {
    for (const topico of topicos) {
      const conjunto = this.suscriptores.get(topico) ?? new Set<string>()
      conjunto.add(id)
      this.suscriptores.set(topico, conjunto)
    }
    this.reconciliar()
  }

  /** Desuscribe un componente de todos sus tópicos. Se llama al desmontar la ventana. */
  desuscribir(id: string): void {
    for (const [topico, conjunto] of this.suscriptores) {
      conjunto.delete(id)
      if (conjunto.size === 0) this.suscriptores.delete(topico)
    }
    this.reconciliar()
  }

  /**
   * Un intento de conexión falló.
   *
   * Cuenta un intento **aunque ya estuviera caída**: el proveedor la llama una vez
   * por intento, y el retroceso necesita saber cuántos van acumulados — si sólo
   * contara la primera caída, el reintento se quedaría siempre en el primer escalón y
   * martillaría el servidor cada segundo.
   *
   * Si no hay nada que servir (nadie escucha, o la pestaña está oculta) no cuenta:
   * no hay reintento que programar.
   */
  caida(): void {
    this.conexionAbierta = false
    if (!this.deberiaEstarAbierta()) return
    this.intentos += 1
  }

  /** La conexión se estableció. */
  conectar(): void {
    this.conexionAbierta = true
    this.intentos = 0
  }

  /**
   * Con la pestaña oculta la conexión se cierra (§5.6): mantenerla abierta gasta
   * batería y ancho de banda para nadie. Al volver, se reanuda con una consulta de
   * resincronización — que es responsabilidad del proveedor, no de este módulo.
   */
  ocultarPestana(): void {
    this.visible = false
    this.reconciliar()
  }

  mostrarPestana(): void {
    this.visible = true
    this.reconciliar()
  }

  get pestanaVisible(): boolean {
    return this.visible
  }

  /** Verdadero cuando hay algo que escuchar y la pestaña está a la vista. */
  private deberiaEstarAbierta(): boolean {
    return this.suscriptores.size > 0 && this.visible
  }

  /** La única puerta por la que la conexión cambia: así no hay dos caminos que se contradigan. */
  private reconciliar(): void {
    if (this.deberiaEstarAbierta() && !this.conexionAbierta) {
      this.conexionAbierta = true
      this.intentos = 0
    } else if (!this.deberiaEstarAbierta() && this.conexionAbierta) {
      this.conexionAbierta = false
    }
  }
}
