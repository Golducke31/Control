import { z } from 'zod'

/**
 * Enums del dominio, espejando exactamente los `pg_enum` del motor.
 *
 * Esta es la única fuente de los valores de enumeración que el frontend conoce.
 * La suite `enums-sync.test.ts` extrae los `CREATE TYPE ... AS ENUM` de
 * `db/migrations` y falla si alguno diverge: un valor que el motor agregó y el
 * contrato no, o uno que el contrato inventó. Es la misma disciplina que el
 * proyecto ya aplica a las tablas —un control que no mira lo que dice mirar no
 * sirve—, aplicada a los datos en vez del esquema.
 *
 * La clave es `schema.nombre` (p. ej. `billing.doc_type`) para coincidir con el
 * nombre cualificado del tipo en Postgres.
 */
export const ENUMS = {
  'app.tenant_status': z.enum(['active', 'suspended', 'trial', 'churned']),
  'app.industry_vertical': z.enum(['retail', 'services', 'distributor', 'logistics', 'mixed']),
  'app.user_status': z.enum(['invited', 'active', 'suspended']),
  'billing.afip_environment': z.enum(['homologation', 'production']),
  'billing.afip_result': z.enum(['approved', 'rejected', 'observed', 'error']),
  'billing.receipt_kind': z.enum(['invoice', 'credit_note', 'debit_note']),
  'billing.doc_type': z.enum(['A', 'B', 'C', 'E', 'M']),
  'logistics.shipment_status': z.enum([
    'draft',
    'preparing',
    'ready',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'incident',
    'cancelled',
  ]),
  'logistics.stop_kind': z.enum(['pickup', 'delivery']),
  'logistics.stop_state': z.enum(['pending', 'arrived', 'completed', 'failed', 'skipped']),
  'app.stock_move_kind': z.enum([
    'purchase_in',
    'sale_out',
    'transfer_out',
    'transfer_in',
    'adjustment_pos',
    'adjustment_neg',
    'return_in',
    'reservation',
    'release',
  ]),
  'accounting.account_kind': z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  'accounting.entry_source': z.enum([
    'invoice',
    'credit_note',
    'debit_note',
    'payment',
    'purchase',
    'supplier_payment',
    'stock_movement',
    'payroll',
    'tax',
    'depreciation',
    'opening',
    'closing',
    'manual',
  ]),
  'accounting.period_status': z.enum(['open', 'closing', 'closed']),
  'treasury.account_kind': z.enum(['cash', 'bank']),
  'treasury.check_state': z.enum([
    'in_portfolio',
    'deposited',
    'cleared',
    'rejected',
    'endorsed',
    'cancelled',
  ]),
  'treasury.movement_direction': z.enum(['credit', 'debit']),
  'treasury.movement_kind': z.enum([
    'opening',
    'customer_payment',
    'check_cleared',
    'check_rejected',
    'supplier_payment',
    'transfer_in',
    'transfer_out',
    'bank_fee',
    'deposit',
    'withdrawal',
    'adjustment',
    'other',
  ]),
  'treasury.reconciliation_status': z.enum(['open', 'balanced', 'closed']),
} as const

export type NombreEnum = keyof typeof ENUMS

/** Único punto donde el resto del código pide un enum por su nombre cualificado. */
export function enumPorNombre(nombre: NombreEnum): z.ZodEnum<[string, ...string[]]> {
  return ENUMS[nombre] as unknown as z.ZodEnum<[string, ...string[]]>
}
