-- Read-only template for the offline fixture. It reports only exact product+lot matches.
-- Register reviewed_scope as a read-only table using data/zetaris/reviewed_scope.csv.
SELECT
  i.id,
  i.site_id,
  i.internal_sku,
  i.manufacturer_ref,
  i.lot,
  i.quantity,
  i.unit,
  CASE
    WHEN i.lot IS NULL OR TRIM(i.lot) = '' THEN 'REVIEW_MISSING_LOT'
    WHEN p.internal_sku IS NULL THEN 'REVIEW_UNKNOWN_PRODUCT'
    WHEN r.lot_number IS NOT NULL THEN 'EXACT_RECALL_MATCH'
    ELSE 'NOT_LISTED_IN_REVIEWED_SCOPE'
  END AS reviewed_scope_status,
  r.recall_id,
  r.record_id
FROM recallops_v1.inventory_v1 i
LEFT JOIN recallops_v1.products_v1 p
  ON p.internal_sku = i.internal_sku
 AND p.manufacturer_ref = i.manufacturer_ref
 AND p.description = 'Medline Sterile 0.9% Normal Saline, USP, 100mL'
LEFT JOIN reviewed_scope r
  ON p.manufacturer_ref = r.manufacturer_ref
 AND i.lot = r.lot_number;
