# Engram local demo

Engram follows real FDA recall Z-1706-2025 for Medline saline reference RDI30296, 100 mL individual bottles (EA), across three fictional sites. The reviewed FDA capture contains 32 exact affected lots. It was retrieved on 22 October 2026 and reports a dataset update of 19 October 2026; the operational scenario replays 2 May 2025. This current capture must not be described as knowledge available at the replay date. The interface has Recall, Exposure, Response plan and Actions views. It renders server Workspace data; checked counts, allocations, and action receipts are not hardcoded in the UI.

## Current verified run

On 23 October 2026, a live baseline investigation completed with five requests and five responses attributed to `nvidia/nemotron-3.5-lightning-30b-a3b`. The run took 58.084 seconds by the persisted agent timer and reported 42,109 input and 3,448 output tokens. It captured one immutable six-view source snapshot in 17.718 seconds. The deterministic result was 120 affected EA, 240 eligible EA, 10 EA requiring review, one 30-EA transfer B→A, 40 EA projected inbound conditional on receipt and acceptance, and no action receipts. The typed terminal claim was verified without a repair. All five responses reported cache misses. Evidence: `../work/engram-baseline-live-evidence.json`.

A second live investigation, started from the browser button with the dedicated delayed-supplier plus withdrawn-QA source condition, completed in 55.926 seconds with five verified Nemotron responses, 43,284 input / 3,917 output tokens, no repair and no receipts. Its six-view snapshot took 6.946 seconds. The plan was infeasible with a 30-EA shortfall: 120 affected EA, 200 eligible EA and 50 EA requiring review. A manually entered, source-bound H-MEM resolution was applied before the first model request. It changed the investigation's next question to physical label verification; it did not change inventory matching, QA status, the plan or action eligibility. Evidence: `../work/engram-infeasible-memory-live-evidence.json`.

The terminal response is a structured serialization of the server-built checked claim template, not independent model arithmetic. The deterministic checker binds it to the run's immutable snapshot and prepared plan, and verifies exact per-claim citations, quantities, cutoff and allocations. One failed response may receive one bounded same-model repair; exact raw wire arguments from both attempts remain in the audit. The UI's checked descriptions come from validated fields. Historical model runs and their text remain in audit history; they are not the current checked result.

## Start and build

- API target: `http://127.0.0.1:4317`.
- Vite development URL: `http://127.0.0.1:4318`.
- Web root: `web`; build output: `web/dist`.
- Start: `npm run dev`. Build: `npm run build`; serve the build with `npm start`.
- Use Node 24. `npm run dev` reads private `.env.local`.

The live setup reads five operational views plus the dedicated reviewed FDA scope view from the local Zetaris stack. Those six reads are sequential and pinned once per investigation; separate page refreshes and action approvals can read sources again. Request timeouts are bounded. Local replay controls are hidden in live mode. A dedicated helper can switch the fictional source files for delayed-supplier and missing-QA scenarios; refresh the browser after a change.

For the final local inspection, port 4317 preserves the original workspace and its two historical sandbox receipts; port 4318 holds the isolated verified QA/memory workspace. This is separate from the usual development port arrangement above. Root preserved and hashed the final test workspace plus H-MEM state and ledger under ignored `state/engram-demo-final`; evidence is in `../work/engram-demo-backup-evidence.json`. The original receipt IDs and state hash were rechecked unchanged. Do not replace the original receipt-bearing workspace with the test state.

## Demonstration sequence

1. **Recall.** Show the source date, disclosure and 32 exact affected lots. Preserve the `23IJA103` / `23JJA103` documentary discrepancy and the pending physical quarantine, disposition, response and downstream-review obligations. A documentary resolution is not a physical stock identification.
2. **Exposure.** Show 120 affected EA excluded, 240 eligible EA and 10 EA requiring review in the baseline. Inspect QA and expiry evidence separately; a QA release cannot override an exact recall match. The 40-EA inbound shipment is conditional and has not been received.
3. **Response plan.** The baseline deterministic plan transfers 30 EA from B to A, counts the 40-EA inbound conditionally and ends with balances A10/B40/C50. The planning cost is 30 demo points. Explain that the server solver creates these values; the model only returns a checked claim receipt.
4. **Memory and infeasibility.** In a fresh investigation, show the separately entered operator resolution retrieved before the first model call. Its scope is exact to the document conflict and current evidence. It changes the next question to verifying the physical label. Under delayed supply plus withdrawn QA, the result remains infeasible with shortfall 30 EA and no transfers.
5. **Approval boundary.** A feasible current plan can be explicitly held or reserved through the UI after fresh server validation. Those receipts represent sandbox records only; they do not confirm physical quarantine, dispatch, receipt or delivery. The two receipts described in the dated 22 October history below are not receipts from the 23 October investigations.

## API behavior

Initial state is `GET /api/workspace`. Mutations use JSON POST and expect Workspace or `{error}`:

- `/api/plan` `{}`
- `/api/scenario` `{scenario: "on_time" | "supplier_late" | "qa_missing"}`
- `/api/reset` `{}`
- `/api/actions/hold` current assessment fingerprint, confirmed-match inventory IDs and a new UUID idempotency key
- `/api/actions/reserve` current feasible plan fingerprint and a new UUID idempotency key
- `/api/analyze` optional user message
- `/api/cancel` `{runId}` from the running agent state

Stale and infeasible plans cannot be approved. After reservation, calculation, scenario and hold controls are disabled; a new incident preserves server audit history. Server-side validation remains authoritative.

## Historical state and limits

On 22 October, an earlier full run completed after a failed empty synthesis and returned an advisory narrative that incorrectly called 120 recalled EA eligible. A separate UI flow then created the historical sandbox hold `f4c3963b-ba01-4091-8dc9-f1182e0d03dc` and reservation `92124573-ac09-4da8-97f2-4af04bb7473e`; both IDs survived the documented restart and browser reload. Those actions and narrative are retained as historical audit, not represented as the latest run. The 23 October baseline and infeasible-memory runs each had zero receipts.

The clean replay gate passed on Node 24.22.1 with 140 tests, typecheck and production build; details and cache limits are in [the clean replay proof](engram-repro.md). The initial installation matched all 130 manifest files; the final gate confirmed 124 program files unchanged, excluding six documentation files. This documentation-only refresh occurred after the build. Root confirmed both actual cases and their UI results, with the final test state backed up separately. Recorded agent times include polling of up to four seconds and exclude the final fresh workspace read. These individual runs are not a performance guarantee and do not establish production readiness, physical handling, delivery, manufacturer response or hackathon eligibility.

Final acceptance is complete. The direct Nightshift runtime readback at 08:04:26 UTC on 23 October retained the verified QA run, 30-EA shortfall, zero receipts and source-bound memory question. All three baseline, QA and memory screenshots were visually inspected. The source, state, backup and readback checks are recorded in the [final verification report](../../outputs/engram-build-verification.json).

Organizer-channel clarification reported by Ahmed on 22 October 2026 makes Cursor optional. No Cursor credits are provided, and no Cursor migration or development-evidence gate applies.
