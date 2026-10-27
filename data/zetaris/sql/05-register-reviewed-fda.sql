-- Exact dedicated-sandbox registration/readback DDL recorded on 22 October 2026.
-- Portable logical DFFS locator: file://file-store/recallops/engram_reviewed_scope_20261022.csv
-- The executed Zetaris FILESTORE path was dffs://recallops/engram_reviewed_scope_20261022.csv.
CREATE LIGHTNING DATABASE ops_fda_engram_v1;

CREATE LIGHTNING FILESTORE TABLE reviewed_scope_raw FROM ops_fda_engram_v1 FORMAT CSV
OPTIONS (path "dffs://recallops/engram_reviewed_scope_20261022.csv", header "true", inferSchema "false");

CREATE SCHEMASTORE VIEW reviewed_scope_engram_v1 WITH CONTAINER recallops_v1 AS
SELECT source_url, retrieved_at, rawsha256, recall_id, record_id, manufacturer_ref,
       product_description, each_udi, case_udi, lot_source_field, lot_number
FROM ops_fda_engram_v1.reviewed_scope_raw;

CREATE SCHEMASTORE VIEW inventory_fda_engram_v1 WITH CONTAINER recallops_v1 AS
SELECT i.id, i.site_id, i.internal_sku, i.manufacturer_ref, i.lot, i.quantity, i.unit,
       CASE
         WHEN i.lot IS NULL OR TRIM(i.lot) = '' THEN 'REVIEW_MISSING_LOT'
         WHEN p.internal_sku IS NULL THEN 'REVIEW_UNKNOWN_PRODUCT'
         WHEN r.lot_number IS NOT NULL THEN 'EXACT_RECALL_MATCH'
         ELSE 'NOT_LISTED_IN_REVIEWED_SCOPE'
       END AS reviewed_scope_status,
       r.recall_id, r.record_id
FROM recallops_v1.inventory_v1 i
LEFT JOIN recallops_v1.products_v1 p
  ON p.internal_sku = i.internal_sku
 AND p.manufacturer_ref = i.manufacturer_ref
 AND p.description = 'Medline Sterile 0.9% Normal Saline, USP, 100mL'
 AND p.unit = 'EA'
 AND p.each_udi = '10884389338247'
 AND p.case_udi = '10884389338230'
LEFT JOIN ops_fda_engram_v1.reviewed_scope_raw r
  ON p.manufacturer_ref = r.manufacturer_ref
 AND i.lot = r.lot_number
 AND r.recall_id = 'Z-1706-2025'
 AND r.record_id = '213286'
 AND r.each_udi = p.each_udi
 AND r.case_udi = p.case_udi;
