# Zetaris reviewed-scope source

This folder contains the sanitized, fictional Zetaris demonstration rows and the exact FDA scope registration SQL. A later readback in a dedicated Zetaris sandbox registered a separate FDA source and confirmed the joined result. The four statements in `sql/05-register-reviewed-fda.sql` reproduce that registration's DDL; the earlier `sql/01`–`03` files and local snapshots remain fixture artifacts.

The registered source was `engram_reviewed_scope_20261022.csv`, with portable logical locator `file://file-store/recallops/engram_reviewed_scope_20261022.csv`; the executed FILESTORE statement used the DFFS locator `dffs://recallops/engram_reviewed_scope_20261022.csv`. The exact source and adapter contract are captured in `reviewed_scope.csv` and `reviewed_scope.json`.

The FDA scope readback returned 32 rows and raw-source SHA-256 `21b61a0b173e3f2e99c2e3197fb02c64d57692924cdfdd0b2a29bef57041977b`. The left join preserved all six fictional inventory rows: one exact affected lot with 120 EA and one missing-lot review row with 10 EA. Unknown stock was preserved. “Not listed” does not authorize stock, and the join does not prove physical quarantine or any other handling action.

The FDA response was retrieved on 22 October 2026; its `last_updated` field is 19 October 2026. The scenario is a historical replay at 2 May 2025, while the FDA record's posting date is 1 May 2025. These timestamps are distinct. A separate FDA enforcement-report artifact for 7 May 2025 was not included, so no report contents are asserted.

The offline `on_time` snapshot under `snapshot-2026-10-22/` is fictional demo data. It is not the registered remote source. No operational rows were modified as part of the FDA source registration.
