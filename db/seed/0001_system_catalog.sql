-- =============================================================================
-- Control · seed · Permisos RBAC, roles de sistema y plantillas de UI
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Catálogo de permisos (resource.action)
-- -----------------------------------------------------------------------------
INSERT INTO app.permissions (code, resource, action, description) VALUES
  -- Plataforma / empresa
  ('tenant.settings',        'tenant',    'settings',        'Editar datos y configuración de la empresa'),
  ('tenant.branding',        'tenant',    'branding',        'Administrar identidad visual y plantillas'),
  ('tenant.features',        'tenant',    'features',        'Habilitar/deshabilitar módulos contratados'),
  -- Equipo
  ('team.invite',            'team',      'invite',          'Invitar usuarios a la empresa'),
  ('team.manage',            'team',      'manage',          'Modificar y desactivar miembros'),
  ('team.manage_roles',      'team',      'manage_roles',    'Crear y editar roles y permisos'),
  -- Catálogo
  ('catalog.read',           'catalog',   'read',            'Ver productos y variantes'),
  ('catalog.write',          'catalog',   'write',           'Crear y editar productos'),
  ('catalog.delete',         'catalog',   'delete',          'Dar de baja productos'),
  ('catalog.prices',         'catalog',   'prices',          'Administrar listas de precios'),
  -- Stock
  ('inventory.read',         'inventory', 'read',            'Consultar stock y movimientos'),
  ('inventory.adjust',       'inventory', 'adjust',          'Realizar ajustes de inventario'),
  ('inventory.transfer',     'inventory', 'transfer',        'Crear y confirmar transferencias'),
  ('inventory.warehouses',   'inventory', 'warehouses',      'Administrar depósitos'),
  -- Ventas
  ('sales.read',             'sales',     'read',            'Ver órdenes de venta'),
  ('sales.write',            'sales',     'write',           'Crear y editar órdenes'),
  ('sales.cancel',           'sales',     'cancel',          'Anular órdenes'),
  ('payments.manage',        'payments',  'manage',          'Registrar cobranzas'),
  -- Facturación
  ('billing.read',           'billing',   'read',            'Ver comprobantes'),
  ('billing.issue_invoice',  'billing',   'issue_invoice',   'Emitir comprobantes electrónicos'),
  ('billing.credit_note',    'billing',   'credit_note',     'Emitir notas de crédito/débito'),
  ('billing.afip_credentials','billing',  'afip_credentials','Administrar certificados AFIP'),
  ('billing.manage',         'billing',   'manage',          'Administración fiscal completa'),
  -- Logística
  ('logistics.read',         'logistics', 'read',            'Ver envíos y tracking'),
  ('logistics.write',        'logistics', 'write',           'Crear y editar envíos'),
  ('logistics.dispatch',     'logistics', 'dispatch',        'Despachar y actualizar estados'),
  ('logistics.deliver',      'logistics', 'deliver',         'Confirmar entregas y descargas'),
  ('logistics.config',       'logistics', 'config',          'Configurar el módulo de transporte'),
  -- Clientes
  ('customers.read',         'customers', 'read',            'Ver clientes'),
  ('customers.write',        'customers', 'write',           'Crear y editar clientes'),
  -- Reportes y auditoría
  ('reports.export',         'reports',   'export',          'Exportar a XLSX/PDF'),
  ('reports.financial',      'reports',   'financial',       'Acceder a reportes financieros'),
  ('audit.read',             'audit',     'read',            'Consultar la bitácora de auditoría')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Roles de sistema (tenant_id NULL => aplican a todas las empresas)
-- -----------------------------------------------------------------------------
INSERT INTO app.roles (id, tenant_id, code, name, description, is_system) VALUES
  ('11111111-1111-1111-1111-000000000001', NULL, 'owner',      'Propietario',        'Acceso total. Único rol no eliminable.',                     true),
  ('11111111-1111-1111-1111-000000000002', NULL, 'admin',      'Administrador',      'Gestión completa excepto certificados AFIP y facturación.',  true),
  ('11111111-1111-1111-1111-000000000003', NULL, 'accountant', 'Contador',           'Facturación, reportes financieros y exportaciones.',         true),
  ('11111111-1111-1111-1111-000000000004', NULL, 'warehouse',  'Encargado de depósito','Stock, transferencias y preparación de envíos.',           true),
  ('11111111-1111-1111-1111-000000000005', NULL, 'sales',      'Vendedor',           'Órdenes de venta, clientes y consulta de catálogo/stock.',   true),
  ('11111111-1111-1111-1111-000000000006', NULL, 'driver',     'Conductor',          'App móvil: actualiza tracking y confirmaciones.',            true),
  ('11111111-1111-1111-1111-000000000007', NULL, 'viewer',     'Sólo lectura',       'Consulta de información sin permisos de escritura.',         true)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Mapeo rol -> permisos
-- -----------------------------------------------------------------------------
-- owner: todos los permisos
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000001', code FROM app.permissions
ON CONFLICT DO NOTHING;

-- admin: todo menos afip_credentials y credit_note
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000002', code
FROM app.permissions
WHERE code NOT IN ('billing.afip_credentials','billing.credit_note')
ON CONFLICT DO NOTHING;

-- accountant
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000003', code FROM (VALUES
  ('billing.read'), ('billing.issue_invoice'), ('billing.credit_note'), ('billing.manage'),
  ('sales.read'), ('customers.read'), ('reports.export'), ('reports.financial'),
  ('catalog.read'), ('inventory.read'), ('audit.read'), ('payments.manage')
) AS t(code) ON CONFLICT DO NOTHING;

-- warehouse
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000004', code FROM (VALUES
  ('inventory.read'), ('inventory.adjust'), ('inventory.transfer'), ('inventory.warehouses'),
  ('catalog.read'), ('logistics.read'), ('logistics.write'), ('logistics.dispatch'),
  ('sales.read'), ('reports.export')
) AS t(code) ON CONFLICT DO NOTHING;

-- sales
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000005', code FROM (VALUES
  ('sales.read'), ('sales.write'), ('sales.cancel'), ('customers.read'), ('customers.write'),
  ('catalog.read'), ('inventory.read'), ('logistics.read'), ('billing.read'),
  ('reports.export'), ('payments.manage')
) AS t(code) ON CONFLICT DO NOTHING;

-- driver
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000006', code FROM (VALUES
  ('logistics.read'), ('logistics.dispatch'), ('logistics.deliver')
) AS t(code) ON CONFLICT DO NOTHING;

-- viewer
INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '11111111-1111-1111-1111-000000000007', code FROM (VALUES
  ('catalog.read'), ('inventory.read'), ('sales.read'), ('billing.read'),
  ('logistics.read'), ('customers.read')
) AS t(code) ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Plantillas de UI por rubro
-- -----------------------------------------------------------------------------
INSERT INTO app.ui_templates (key, name, vertical, description, default_config) VALUES
  ('retail-glass', 'Retail Glass', 'retail',
   'Dashboard de comercio minorista: foco en ventas diarias, ticket promedio y rotación de productos.',
   '{"density":"comfortable","glassIntensity":0.72,"cardRadius":20,"sidebar":"expanded",
     "kpis":["sales_today","ticket_avg","units_sold","active_skus"],
     "charts":["sales_timeline","top_products","category_mix"]}'::jsonb),

  ('services-glass', 'Services Glass', 'services',
   'Portal de servicios: foco en órdenes abiertas, SLA y carga por profesional.',
   '{"density":"comfortable","glassIntensity":0.68,"cardRadius":18,"sidebar":"rail",
     "kpis":["open_orders","avg_resolution_hours","sla_compliance","billable_hours"],
     "charts":["workload_by_resource","sla_trend","revenue_by_service"]}'::jsonb),

  ('distributor-glass', 'Distributor Glass', 'distributor',
   'Distribuidora y logística: foco en stock multi-depósito, rutas activas y cumplimiento de entregas.',
   '{"density":"compact","glassIntensity":0.62,"cardRadius":16,"sidebar":"expanded",
     "kpis":["stock_value","low_stock_alerts","shipments_active","on_time_delivery_rate"],
     "charts":["warehouse_heatmap","delivery_funnel","stock_evolution","sales_timeline"]}'::jsonb),

  ('logistics-glass', 'Logistics Glass', 'logistics',
   'Operación logística pura: mapa en vivo, torre de control y productividad de flota.',
   '{"density":"compact","glassIntensity":0.58,"cardRadius":14,"sidebar":"rail",
     "kpis":["shipments_active","in_transit","delivered_today","incidents_open"],
     "charts":["live_map","fleet_utilization","dwell_time","delivery_funnel"]}'::jsonb),

  ('mixed-glass', 'Mixed Glass', 'mixed',
   'Rubro mixto: comercio con depósito y reparto propio. Vista equilibrada de ventas y logística.',
   '{"density":"comfortable","glassIntensity":0.70,"cardRadius":20,"sidebar":"expanded",
     "kpis":["sales_today","stock_value","shipments_active","pending_invoices"],
     "charts":["sales_timeline","stock_evolution","delivery_funnel"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
