# Optional Zetaris FDA reviewed-scope query

The FDA reviewed-scope view is a separate optional read. Configure its registered qualified SQL identifier with the server-side environment variable `ZETARIS_VIEW_REVIEWED_SCOPE`, for example `recallops.reviewed_scope`. The value must be one to three dot-separated SQL identifier parts. It is validated independently of `ZETARIS_VIEW_MAP`; the existing five-view `RecallOpsView` union and adapter stay unchanged.

`ZetarisClient.queryReviewedScope(limit = 1000)` returns rows with this exact ordered column contract:

```text
source_url, retrieved_at, rawsha256, recall_id, record_id, manufacturer_ref,
product_description, each_udi, case_udi, lot_source_field, lot_number
```

The query selects only those fixed columns from the configured view and applies a bounded limit from 1 to 1000. It accepts no caller-provided SQL, filters, or column names. A full limit is flagged as possibly truncated by the ordinary query result shape.

When `ZETARIS_VIEW_REVIEWED_SCOPE` is absent, the rest of Zetaris config remains ready and `queryReviewedScope` returns `VIEW_NOT_CONFIGURED`. That state does not establish that the reviewed scope was queried or verified. Consumers should compare returned provenance and exact lot rows with the FDA source review before using them.

## Refreshing the FDA source candidate

`npm run source:fda` makes one request to the exact `cfres_id:213286` openFDA URL. It has a 30-second abort timeout, rejects redirects, and caps the streamed response at 2 MiB. It writes raw bytes and source metadata under ignored `work/fda-candidates/<sha256>/` and prints `status: review_required`; identical content is verified and reused, while conflicting content at a candidate path is refused. It never writes `data/fda/`, `reviewed_scope.json`, or Zetaris. A human must inspect a candidate and explicitly promote reviewed evidence before runtime activation.

The reviewed-scope source CSV is `data/zetaris/reviewed_scope.csv`; its read-only inventory join template is `data/zetaris/sql/04-reviewed-scope-exact-match.sql`. Neither file establishes remote registration or a live query.
