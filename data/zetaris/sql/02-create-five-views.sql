-- Documented Zetaris schema-store grammar; not yet executed in a tenant.

-- Requires source registration and count/uniqueness checks first.

CREATE SCHEMASTORE CONTAINER recallops_v1;

CREATE SCHEMASTORE VIEW inventory_v1 WITH CONTAINER recallops_v1 AS
SELECT
  i.id,
  s.id AS site_id,
  i.internal_sku,
  p.manufacturer_ref AS manufacturer_ref,
  i.lot,
  i.packaging_level,
  p.unit AS unit,
  i.quantity,
  i.reserved_quantity,
  i.expires_at,
  i.qa_status,
  i.qa_evidence_ref,
  i.expiry_evidence_ref,
  i.allocation_hold,
  i.physical_quarantine_status,
  i.source_version,
  i.is_fictional
FROM ops_warehouse_v1.inventory_raw i
LEFT JOIN ops_catalog_v1.products_raw p ON i.internal_sku = p.internal_sku
LEFT JOIN ops_sites_v1.sites_raw s ON i.site_id = s.id;

CREATE SCHEMASTORE VIEW shipments_v1 WITH CONTAINER recallops_v1 AS
SELECT id, destination_site_id, internal_sku, manufacturer_ref, lot, packaging_level, unit, quantity, eta, status, expires_at, qa_status, qa_evidence_ref, expiry_evidence_ref, planning_availability_is_conditional_on_receipt_and_acceptance, source_version
FROM ops_supplier_v1.shipments_raw;

CREATE SCHEMASTORE VIEW demand_v1 WITH CONTAINER recallops_v1 AS
SELECT id, site_id, internal_sku, demand_quantity, required_ending_reserve, source_version
FROM ops_warehouse_v1.demand_raw;

CREATE SCHEMASTORE VIEW products_v1 WITH CONTAINER recallops_v1 AS
SELECT internal_sku, manufacturer_ref, description, each_udi, case_udi, unit, unit_description, pack_conversion_enabled, approved_item_for_demo, approval_evidence_ref, product_identifier_source_id, allowed_substitute_skus
FROM ops_catalog_v1.products_raw;

CREATE SCHEMASTORE VIEW sites_v1 WITH CONTAINER recallops_v1 AS
SELECT id, name, is_fictional
FROM ops_sites_v1.sites_raw;
