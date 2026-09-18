-- =============================================================================
-- Control · 0005 · Transporte, tracking en tiempo real y entrega en cliente
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Transportistas (propios o tercerizados)
-- -----------------------------------------------------------------------------
CREATE TABLE logistics.carriers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  tax_id      text,
  phone       text,
  email       citext,
  -- 'own' = flota propia, 'third_party' = subcontratado
  ownership   text NOT NULL DEFAULT 'own',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT carriers_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT carriers_id_tenant   UNIQUE (tenant_id, id),
  CONSTRAINT carriers_ownership   CHECK (ownership IN ('own','third_party'))
);

CREATE TRIGGER trg_carriers_touch BEFORE UPDATE ON logistics.carriers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE logistics.vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  carrier_id    uuid NOT NULL,
  plate         text NOT NULL,
  model         text,
  capacity_kg   numeric(10,2),
  capacity_m3   numeric(10,3),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vehicles_plate_unique UNIQUE (tenant_id, plate),
  CONSTRAINT vehicles_carrier_fk   FOREIGN KEY (tenant_id, carrier_id) REFERENCES logistics.carriers(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER trg_vehicles_touch BEFORE UPDATE ON logistics.vehicles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Envíos
-- -----------------------------------------------------------------------------
CREATE TABLE logistics.shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  tracking_code   text NOT NULL,             -- código público para el cliente
  order_id        uuid,
  invoice_id      uuid,
  customer_id     uuid NOT NULL,
  carrier_id      uuid,
  vehicle_id      uuid,
  driver_user_id  uuid REFERENCES app.users(id) ON DELETE SET NULL,
  status          logistics.shipment_status NOT NULL DEFAULT 'draft',
  priority        smallint NOT NULL DEFAULT 3,   -- 1=urgente .. 5=baja
  -- Ventana de entrega comprometida
  scheduled_from  timestamptz,
  scheduled_to    timestamptz,
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  -- Origen / destino desnormalizados (snapshot para el mapa y el PDF)
  origin_address  text,
  origin_geo      point,
  dest_address    text NOT NULL,
  dest_geo        point,
  distance_meters integer,
  -- Cierre por el cliente: firma y confirmación de descarga
  proof_of_delivery jsonb,                   -- { signerName, docNumber, photoUrl, notes, geo }
  delivered_confirmed_by uuid,
  pod_url         text,
  notes           text,
  created_by      uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sh_tracking_unique UNIQUE (tenant_id, tracking_code),
  CONSTRAINT sh_id_tenant       UNIQUE (tenant_id, id),
  CONSTRAINT sh_customer_fk     FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sh_order_fk        FOREIGN KEY (tenant_id, order_id)    REFERENCES billing.sales_orders(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT sh_invoice_fk      FOREIGN KEY (tenant_id, invoice_id)  REFERENCES billing.invoices(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT sh_carrier_fk      FOREIGN KEY (tenant_id, carrier_id)  REFERENCES logistics.carriers(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT sh_vehicle_fk      FOREIGN KEY (tenant_id, vehicle_id)  REFERENCES logistics.vehicles(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT sh_window_valid    CHECK (scheduled_to IS NULL OR scheduled_from IS NULL OR scheduled_to >= scheduled_from),
  CONSTRAINT sh_delivered_ts    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);

CREATE INDEX idx_sh_tenant_status    ON logistics.shipments(tenant_id, status);
CREATE INDEX idx_sh_tenant_created   ON logistics.shipments(tenant_id, created_at DESC);
CREATE INDEX idx_sh_active_board     ON logistics.shipments(tenant_id, status, priority)
  WHERE status NOT IN ('delivered','cancelled');
CREATE INDEX idx_sh_driver           ON logistics.shipments(tenant_id, driver_user_id) WHERE driver_user_id IS NOT NULL;
CREATE INDEX idx_sh_tracking         ON logistics.shipments(tracking_code);

CREATE TRIGGER trg_shipments_touch BEFORE UPDATE ON logistics.shipments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Ítems cargados en el envío
CREATE TABLE logistics.shipment_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  variant_id  uuid,
  description text NOT NULL,
  quantity    numeric(14,3) NOT NULL,
  -- Descarga parcial confirmada en destino
  qty_delivered numeric(14,3) NOT NULL DEFAULT 0,
  qty_rejected  numeric(14,3) NOT NULL DEFAULT 0,
  rejection_reason text,

  CONSTRAINT shi_shipment_fk FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT shi_variant_fk  FOREIGN KEY (tenant_id, variant_id)  REFERENCES app.product_variants(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT shi_qty_pos     CHECK (quantity > 0 AND qty_delivered >= 0 AND qty_rejected >= 0)
);

CREATE INDEX idx_shi_shipment ON logistics.shipment_items(tenant_id, shipment_id);

-- Paradas de la ruta (pickup / delivery, multi-parada)
CREATE TABLE logistics.shipment_stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  shipment_id  uuid NOT NULL,
  seq          smallint NOT NULL,
  kind         logistics.stop_kind NOT NULL,
  state        logistics.stop_state NOT NULL DEFAULT 'pending',
  customer_id  uuid,
  address      text NOT NULL,
  geo          point,
  contact_name text,
  contact_phone text,
  window_from  timestamptz,
  window_to    timestamptz,
  arrived_at   timestamptz,
  completed_at timestamptz,
  notes        text,

  CONSTRAINT stop_unique_seq  UNIQUE (shipment_id, seq),
  CONSTRAINT stop_shipment_fk FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stop_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES app.customers(tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT stop_seq_pos     CHECK (seq > 0)
);

CREATE INDEX idx_stops_shipment ON logistics.shipment_stops(tenant_id, shipment_id, seq);

-- -----------------------------------------------------------------------------
-- Eventos de tracking: fuente de verdad del timeline + stream en vivo
-- -----------------------------------------------------------------------------
CREATE TABLE logistics.tracking_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  status      logistics.shipment_status NOT NULL,
  event_code  text NOT NULL,          -- 'created','picked_up','at_hub','out_for_delivery','delivered','incident'
  description text NOT NULL,
  geo         point,
  speed_kmh   numeric(6,2),
  heading     smallint,
  odometer_km numeric(12,2),
  -- Actor que dispara el evento: usuario, conductor o cliente
  actor_kind  text NOT NULL DEFAULT 'system',   -- system|user|driver|customer|webhook
  actor_id    uuid,
  -- Si el evento requiere confirmación del cliente
  requires_customer_ack boolean NOT NULL DEFAULT false,
  customer_ack_at timestamptz,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Clave de deduplicación para reintentos de la app móvil offline-first
  client_event_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT te_shipment_fk FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT te_actor_kind  CHECK (actor_kind IN ('system','user','driver','customer','webhook')),
  CONSTRAINT te_client_dedup UNIQUE NULLS NOT DISTINCT (tenant_id, shipment_id, client_event_id)
);

CREATE INDEX idx_te_tenant_shipment ON logistics.tracking_events(tenant_id, shipment_id, occurred_at DESC);
CREATE INDEX idx_te_tenant_recent   ON logistics.tracking_events(tenant_id, occurred_at DESC);

-- Posiciones GPS crudas (alta frecuencia, se particiona por mes y se purga)
CREATE TABLE logistics.position_pings (
  id          bigserial,
  tenant_id   uuid NOT NULL,
  shipment_id uuid NOT NULL,
  vehicle_id  uuid,
  driver_user_id uuid,
  geo         point NOT NULL,
  speed_kmh   numeric(6,2),
  heading     smallint,
  accuracy_m  numeric(8,2),
  recorded_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Particiones: la app crea la del mes corriente de forma anticipada
CREATE TABLE logistics.position_pings_2026_09 PARTITION OF logistics.position_pings
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE logistics.position_pings_2026_10 PARTITION OF logistics.position_pings
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE logistics.position_pings_default PARTITION OF logistics.position_pings DEFAULT;

CREATE INDEX idx_pings_shipment_time ON logistics.position_pings(tenant_id, shipment_id, recorded_at DESC);

-- Confirmación de descarga / recepción por el cliente (portal público)
CREATE TABLE logistics.delivery_confirmations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
  shipment_id   uuid NOT NULL,
  -- Se accede desde un link público firmado (token efímero de un solo uso)
  access_token_hash text NOT NULL,
  token_expires_at  timestamptz NOT NULL,
  confirmed_at  timestamptz,
  signer_name   text,
  signer_doc    text,
  signature_url text,
  photo_urls    text[] NOT NULL DEFAULT '{}',
  geo           point,
  conform      boolean,               -- true = recibido conforme, false = con reservas
  discrepancy_notes text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dc_shipment_fk UNIQUE (tenant_id, shipment_id),
  CONSTRAINT dc_token_unique UNIQUE (access_token_hash)
);

CREATE TRIGGER trg_delivery_confirmations_touch BEFORE UPDATE ON logistics.delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Configuración del módulo de transporte por empresa (opcional por rubro)
-- -----------------------------------------------------------------------------
CREATE TABLE logistics.tenant_logistics_config (
  tenant_id            uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  -- 'last_mile' = reparto propio, 'full_truckload' = distribuidora, 'mixed'
  mode                 text NOT NULL DEFAULT 'last_mile',
  require_pod          boolean NOT NULL DEFAULT true,     -- prueba de entrega obligatoria
  require_customer_ack boolean NOT NULL DEFAULT true,     -- confirmación del cliente
  allow_partial_delivery boolean NOT NULL DEFAULT true,
  auto_assign_carrier  boolean NOT NULL DEFAULT false,
  sla_hours            integer NOT NULL DEFAULT 48,
  -- Ventanas horarias de reparto permitidas
  delivery_windows     jsonb NOT NULL DEFAULT '[]'::jsonb,
  notification_channels text[] NOT NULL DEFAULT ARRAY['email','whatsapp'],
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tlc_mode_valid CHECK (mode IN ('last_mile','full_truckload','mixed'))
);

CREATE TRIGGER trg_tenant_logistics_config_touch BEFORE UPDATE ON logistics.tenant_logistics_config
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
