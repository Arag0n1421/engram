-- Proposed driver mount: sources/ -> /recallops-sources, read-only.

-- Run only after the executor can actually read these paths; one statement per call.

CREATE LIGHTNING DATABASE ops_warehouse_v1;

CREATE LIGHTNING FILESTORE TABLE inventory_raw FROM ops_warehouse_v1 FORMAT CSV
OPTIONS (path "/recallops-sources/warehouse/inventory_raw.csv", header "true", inferSchema "false");

CREATE LIGHTNING FILESTORE TABLE demand_raw FROM ops_warehouse_v1 FORMAT CSV
OPTIONS (path "/recallops-sources/warehouse/demand_raw.csv", header "true", inferSchema "false");

CREATE LIGHTNING DATABASE ops_supplier_v1;

CREATE LIGHTNING FILESTORE TABLE shipments_raw FROM ops_supplier_v1 FORMAT CSV
OPTIONS (path "/recallops-sources/supplier/shipments_raw.csv", header "true", inferSchema "false");

CREATE LIGHTNING DATABASE ops_catalog_v1;

CREATE LIGHTNING FILESTORE TABLE products_raw FROM ops_catalog_v1 FORMAT CSV
OPTIONS (path "/recallops-sources/catalog/products_raw.csv", header "true", inferSchema "false");

CREATE LIGHTNING DATABASE ops_sites_v1;

CREATE LIGHTNING FILESTORE TABLE sites_raw FROM ops_sites_v1 FORMAT CSV
OPTIONS (path "/recallops-sources/sites/sites_raw.csv", header "true", inferSchema "false");
