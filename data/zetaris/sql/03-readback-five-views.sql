-- Read-only: API needs exact adapter columns, each statement sent separately.

SELECT 1 AS one;

SHOW LIGHTNING DATABASES;

SHOW DATASOURCE VIEWS;

-- inventory: expected 6 rows and explicit adapter column order.
SELECT id, site_id, internal_sku, manufacturer_ref, lot, packaging_level, unit, quantity, reserved_quantity, expires_at, qa_status, qa_evidence_ref, expiry_evidence_ref, allocation_hold, physical_quarantine_status, source_version, is_fictional FROM recallops_v1.inventory_v1 LIMIT 1000;

-- shipments: expected 1 rows and explicit adapter column order.
SELECT id, destination_site_id, internal_sku, manufacturer_ref, lot, packaging_level, unit, quantity, eta, status, expires_at, qa_status, qa_evidence_ref, expiry_evidence_ref, planning_availability_is_conditional_on_receipt_and_acceptance, source_version FROM recallops_v1.shipments_v1 LIMIT 1000;

-- demand: expected 3 rows and explicit adapter column order.
SELECT id, site_id, internal_sku, demand_quantity, required_ending_reserve, source_version FROM recallops_v1.demand_v1 LIMIT 1000;

-- products: expected 1 rows and explicit adapter column order.
SELECT internal_sku, manufacturer_ref, description, each_udi, case_udi, unit, unit_description, pack_conversion_enabled, approved_item_for_demo, approval_evidence_ref, product_identifier_source_id, allowed_substitute_skus FROM recallops_v1.products_v1 LIMIT 1000;

-- sites: expected 3 rows and explicit adapter column order.
SELECT id, name, is_fictional FROM recallops_v1.sites_v1 LIMIT 1000;

SELECT COUNT(*) AS rows, SUM(CAST(quantity AS BIGINT)) AS physical_ea FROM recallops_v1.inventory_v1;

SELECT internal_sku, COUNT(*) AS rows FROM ops_catalog_v1.products_raw GROUP BY internal_sku HAVING COUNT(*) <> 1;

SELECT id, COUNT(*) AS rows FROM ops_sites_v1.sites_raw GROUP BY id HAVING COUNT(*) <> 1;

SELECT id, COUNT(*) AS rows FROM recallops_v1.inventory_v1 GROUP BY id HAVING COUNT(*) <> 1;

SELECT id FROM recallops_v1.inventory_v1 WHERE site_id IS NULL OR manufacturer_ref IS NULL OR unit IS NULL;
