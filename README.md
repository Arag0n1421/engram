# Engram

**Track 2 — The Agent That Can Explain Why.** Engram investigates a medical-product recall across the notice, the facility's operational data and its own prior decisions, and shows the evidence behind every conclusion. When the evidence does not support an answer, it says so instead of guessing.

> Prototype. Recall sources are real public notices; all sites, inventory, demand and local records are **fictional**. Nothing here is a medical or regulatory decision, and no physical stock action is ever performed or claimed.


## Demo video and submission materials

- Demo video (3 min): [`submission/OAH2026-Engram-ExplainWhy-Demo.mp4`](submission/OAH2026-Engram-ExplainWhy-Demo.mp4)
- Slide deck: [`submission/Engram-deck.pdf`](submission/Engram-deck.pdf) · [`submission/Engram-deck.pptx`](submission/Engram-deck.pptx)
- Write-up and sponsor explanation: [`submission/write-up.md`](submission/write-up.md)
- Evaluation log and source audit: [`submission/RESULTS.md`](submission/RESULTS.md)
- Screenshots of the live run: [`submission/screenshots/`](submission/screenshots/)

## What it does

1. **Reads the sources.** Public recall notices (FDA, MHRA, manufacturer letters) and operational views (inventory, shipments, demand, products, sites, reviewed recall scope) served by **Zetaris**.
2. **Investigates with an agent.** NVIDIA **Nemotron 3.5 Super**, served through **Meterless Nightshift**, chooses which sources to inspect, which sections to read and which record checks to run. Tool calls are bound to one run and one immutable evidence snapshot.
3. **Checks deterministically.** Field comparisons (lot, manufacture date, product identity), stock exposure and the transfer plan are computed by backend code, not by the model.
4. **Explains, with proof.** The model writes notice findings that must cite verbatim, hash-bound quotes. Record findings are rendered by the backend from the stored comparisons. A validator rejects unsupported dates, counts, scope reductions, clearance claims and record classifications, and feeds the codes back for a bounded correction (at most three report attempts).
5. **Keeps humans in charge.** Holds and reservations are sandbox records only. Rejected or incomplete investigations show the bound evidence with an explicit "not accepted, human review required" label.

## Architecture

```
 Zetaris (6 SQL views) ──┐                       ┌─> deterministic record checks ─┐
 Public notices (hashed) ─┼─> evidence snapshot ──┤                                 ├─> validator ─> UI
                          │      (run-bound)       └─> Nemotron via Meterless ──────┘    (feedback loop,
 Operator memory (H-MEM) ─┘                              (tool calls, quotes)              ≤3 attempts)
```

## Sponsor technology

| Sponsor | How Engram uses it |
| --- | --- |
| Zetaris | Local Zetaris platform (Docker). Engram reads five operational views plus a reviewed FDA-scope view through the Zetaris REST SQL API; one sequential, pinned six-view snapshot per investigation. |
| Meterless | Nightshift M1–M4 local runtime is the only model gateway (OpenAI-compatible `/v1`). Per-request cache scopes, route attribution checks and empty-output checks. **Meterless engine: H-MEM** — consulted before every investigation for prior reviewer resolutions and updated after checked plans (live event `meterless.hmem`; tests in `tests/memory/`). |
| NVIDIA | `nvidia/nemotron-3.5-super-vl-120b-a12b` performs every agent step; Engram verifies the reported route on each response. |
| Cursor | Built with Claude Code and Codex. Cursor was made optional by the organisers' HackOS announcement of 22 October. |

## Run it

Requires Node 24, npm, and for live mode a running Zetaris platform and Meterless Nightshift.

```sh
npm ci
cp .env.example .env.local   # replay mode works without credentials
npm run dev                  # API 127.0.0.1:4317, UI http://127.0.0.1:4318
npm test && npm run typecheck
```

Live mode: set `RECALLOPS_DATA_MODE=live`, `RECALLOPS_ALLOW_INFERENCE=true`, the `METERLESS_*` and `ZETARIS_*` variables (see `.env.example` and `docs/integrations.md`). Credentials stay server-side.

## Results (27 October 2026)

All runs use live inference: Meterless Nightshift → `nvidia/nemotron-3.5-super-vl-120b-a12b`, one at a time.

| Run | Data | Outcome |
| --- | --- | --- |
| Live Medline investigation (live mode) | Real FDA recall Z-1706-2025; **Zetaris** live read of 6 views (6 inventory, 1 shipment, 3 demand, 1 product, 3 sites, 32 reviewed-scope rows); fictional sites/stock | **Complete, claims verified** (run 00ee3741, 3 min 53 s, 11 Nemotron responses): agent inspected evidence → report accepted on attempt 2 and routed to checked calculation → read stock and constraints → solve → independent validation → checklist prepared → typed claims verified (120 EA affected, 240 eligible, 30 EA B→A, all sites at/above reserve). Earlier runs tonight failed (model claimed stock data was missing) until explicit calculation requests were routed to the checked calculator. |
| N01 — MHRA ChloraPrep 2025 notices | Public notice text + fictional records | **Partially verified**: summary + 3 notice findings accepted (manually audited: accurate), 2 findings withheld, 4 backend record findings. |
| R04 — Olympus ViziShot 2025/2026 | Public notice text + fictional records | **Not accepted**: scope/supersession correct, but the summary classified records → fails closed. |
| R05 — Medtronic MiniMed 2019/2021 | Public notice text + fictional records | **Not accepted**: unsupported "narrows scope" claim and record claims rejected. |

R04/R05/N01 were used during development (regression cases, not an unseen benchmark). Full log and source audit: `outputs/engram-v10-20261027/RESULTS.md` in the working folder (not part of this repository). Tests: 400/400 runtime + domain tests pass; typecheck clean.

## Known limitations

- The validator checks quote binding, cited literals, counts and a fixed set of claim patterns. It does **not** prove that a paraphrase is semantically correct; every accepted report still needs human review against the full notice.
- Record checks cover lot, manufacture date and product identity only. Attributes such as ring colour or device configuration remain documentary review items.
- Regression cases R04/R05/N01 were used during development; they are not an unseen benchmark.
- Local, single-user prototype; no authentication, no production deployment.

## Pre-existing components

The repository starts from the `eve` framework scaffold (initial commit 22 October 2026). All other code was written during the build window. Third-party packages are listed in `package.json`; `vendor/` contains the Meterless H-MEM wrapper.

---

# Technical details

Engram is a local Track 2 explainable investigation prototype for working through a recall with sourced facts, checked claims, and a reviewable allocation plan. It follows one real FDA device recall—Z-1706-2025 for Medline saline reference RDI30296—across three fictional sites. The operational inventory, demand, shipments, QA states, and sites are demonstration data; they do not describe a real facility or patient exposure.

The FDA response is preserved as raw JSON with its source URL, retrieval time, and SHA-256 under `data/fda/`. Its `code_info` identifies the scoped product, labeled each and case UDIs, and 32 exact lot tokens. The capture was retrieved on 22 October 2026 and reports dataset `last_updated` 19 October 2026. The scenario clock is a historical replay at 2 May 2025. These dates describe different things: the captured FDA source, the source's own update field, and the demo's replay. Check source freshness before relying on it for a new real-world investigation.

`npm run source:fda` is an explicit, bounded refresh of the one known openFDA record. It writes a SHA-256-keyed candidate under ignored `work/fda-candidates/` with `review_required` status; it never replaces the active reviewed evidence. Human review and an explicit promotion step are required before a candidate can become active.

### Source investigation and what-if checks

An investigation binds a source registry to its immutable snapshot. Source references open the matching current or run-bound record in the evidence drawer, with its source URL, version, retrieval time, content and hash. Preliminary model requests use a compact context bound to that snapshot, with the source index, inspected source content, report feedback and applicable advisory history. A report selects presented excerpt references from inspected canonical sources. Each reference binds the run, snapshot, source hash and contiguous offsets; the adapter resolves that model-selected reference to the exact stored quote. Full original sources remain stored, and omitted excerpt ranges are explicit. The server does not choose an excerpt for the model or repair a paraphrased quote. The checker verifies those bindings; it does not verify that an interpretation is semantically correct. The model reports an explicit next step: `answer_document_question`, `ask_operator_for_new_evidence`, or `continue_to_checked_calculation`. The adapter records that raw choice and maps it one-to-one to the existing `answered`, `needs_evidence`, or `plan` outcome. A calculation request is a handoff to checked math and does not assert feasibility. No branch or finding is chosen by the server.

The preliminary budget allows three exploratory model requests. After an actual source inspection the model may call the flat `request_investigation_report` tool; that marker, or the three-request discovery limit, starts the documentary report stage. Reports use strict JSON Schema with an enum of only the quote IDs actually presented in the bounded excerpt catalog and no outbound model tools. The report context separates pinned record-family presence, captured read receipts, current read permission and retrieval after an accepted checked-calculation handoff; an empty captured source is distinct from a forbidden read. These capabilities do not certify data quality, QA or eligibility. Their phase task asks for documentary facts and next-step routing while preserving the exact original question. Run-bound target SKU, recall/manufacturer IDs and raw catalog mappings identify the working target; this nonnumeric metadata creates no finding, same-product assertion or citation. The server binds a valid whole JSON object and internally dispatches it to the existing report handler; this is labelled internal dispatch, never a native model tool choice. Invalid shape is retained as bounded untrusted audit and produces proof-bound internal feedback so Eve accounts for the original response usage before a fresh request. Up to three report requests fit within the five-request preliminary budget; no format correction bypasses either ceiling. The store enforces at most 12 model requests. Initial inspection, planning and final-claim calls allow 4096 output tokens each; documentary report-only calls allow 8192 only after a bound source has actually been inspected. Exploratory reads and the flat report-request marker remain at 4096. This exception follows a real Super 3.5 diagnostic that needed 4277 reported completion tokens to emit its report. Eve checks prior reported session usage before each call and pauses at 64,000 input or 16,000 output tokens; these are stop thresholds, not pre-reserved hard ceilings, and a crossing call can finish. The separately bounded one-claim repair also remains 4096. Verification records actual cumulative reported usage; Meterless counters may include estimates. No finding or disposition is assumed by the server.

The read-only what-if tool accepts only bounded ETA changes to existing projected, unreceived shipments and explicit QA-evidence hypotheses for eligible, non-held, unlisted inventory in the exact target product scope. It returns a hypothetical comparison on a clone of the bound snapshot. It cannot approve a plan or change source records, receipts, or memory.

### How an investigation is checked

**Server-rendered record findings (27 October 2026).** In atomic-receipt reports the model no longer writes findings about local records. After a report passes validation, the backend appends one finding per local record, rendered from the stored run-bound field comparisons (`src/runtime/server-record-findings.ts`) and citing only those comparisons' own source quotes; these findings are labelled "Backend record check" in the UI. Model findings that name a record, cite a record row, select record results or make a record classification are rejected with `record_findings_are_server_generated`. A sentence that names no record, states no match or classification and only recommends review is treated as a documentary review criterion. On a retry, flagged uncited literals are listed with the presented notice quotes that contain them; the model must still choose the citation or remove the literal.

An investigation starts from a versioned snapshot of its evidence. The typed claim checker compares proposed facts with that snapshot. The model gets one bounded repair opportunity; the resulting raw response is audited before the UI presents checked claims and causal explanations. This limits unsupported claims but does not establish model correctness by itself.

After an actual documentary source is inspected, exploratory requests may call the read-only stock and constraint tools before reporting. Their exact results are retained separately from advisory history, bound to the run and immutable snapshot, and repeated identical reads reuse those results. These reads do not automatically select citation sources or verify model prose. Only an accepted `plan` report together with successful unfiltered `stock:all` and `constraints` reads permits calculation; separate site reads do not satisfy the unfiltered-stock requirement; post-handoff requests expose only missing reads until those requirements are met. Server checkpoints then require solving, validation and checklist preparation before a terminal answer. These steps are bound to the current snapshot and proposal; a new calculation revokes earlier preparation. Infeasible plans still complete a checked shortfall report, with operational approval disabled.

After preparation, the server supplies a compact, checker-valid claim template and requests one complete assistant JSON object through strict JSON Schema, with no native tools. This is a serialization format: it gives the model no operational action to execute and does not test independent model arithmetic. The server records the exact assistant content before parsing; fences, string-wrapped objects and invalid outer JSON fail closed. The unchanged checker verifies every field and complete citation set. A schema-invalid object may receive one repair with deterministic feedback and the same current template. Both responses have a 4096-token ceiling; all investigation request and session limits remain in force. A planning or terminal-finalization run cannot finish complete without a verified, valid claim audit; an exhausted unverified repair finishes failed.

Citation references use a lossless space-delimited string on the terminal wire. The checker splits only the known citation fields on literal ASCII spaces before applying the existing strict array schema and exact citation comparisons. It never changes case, fills missing references or removes duplicates. The original wire response remains in the audit.

The local Nightshift adapter requests complete JSON responses from the configured model and uses the AI SDK's streaming middleware to deliver them to Eve. Each response still passes the same actual-route attribution and empty-output checks before any tool call is released. This compatibility path buffers each model response; it does not provide live token streaming.

A documentary report must be one complete JSON object in assistant content, with no Markdown, prose wrapper, native tool call or repaired fragments. The report stage includes successful operational-read receipt metadata; full numeric read bodies remain stored for the deterministic planner and their deliberate omission does not mean inputs are missing. Exact presented documentary excerpts, history and review feedback remain available, with full canonical sources retained privately. A `plan` disposition requests checked calculation without asserting feasibility. Terminal claim receipts keep their existing strict contract. When the configured model is exactly `nvidia/nemotron-3.5-super-vl-120b-a12b`, Engram requests `reasoning_effort: "low"` for all active preliminary exploration and documentary reporting, and `"none"` after an accepted planning handoff for missing-read collection, deterministic workflow dispatch, terminal formatting and repair. It audits the requested effort. Its runtime effect requires an adapter that forwards the documented NVIDIA field; sending the field alone does not establish reduced reasoning or faster responses.

Active exploratory and missing-read turns require a native tool choice from the filtered allowlist; the model still chooses which allowed source or read to request. Plain prose cannot substitute for an investigation step. Before a generic required-tool request, a fail-closed metadata preflight verifies the current Nightshift M1–M4 web installation contract: a ready app-served M1–M4 `/healthz` response and a `501 not_available_in_web` tools endpoint. A changed/full/unknown build or accessible tools endpoint rejects before inference, and an accessible tools response body is never read. This is a validated installation contract, not a universal runtime tool-count claim; it does not change Nightshift settings.

Each inference request uses a unique scope under the same stable app identity, and declared cache replays are rejected. This avoids the installed Nightshift version's text-only cache replay of tool responses. It also isolates Nightshift's native inference memory per request; Engram's explicit H-MEM investigation and operator-resolution memory remain separate and unchanged.

H-MEM historical analysis retrieval may be stale and is always advisory; it does not authorize the current case, change recall scope, clear a lot, or approve a plan. Only a manual operator resolution can be applied, and only while its recall, product, source hash, time window, expiry, and revocation checks match. Pending actions and manual confirmations remain unchanged until an operator resolves them.

Planning uses individual bottles (EA), with no case conversion or clinical substitution. A later approval uses a fresh source read and checks whether the proposal is still valid. The saved approval is a local digital overlay for the investigation; it does not prove that stock was physically quarantined, destroyed, dispatched, received, or communicated about.

HTTP failures remain failures and never release model output or execute tools. A bounded error read records only fixed diagnostic categories/messages, status and timing, request hashes, and an accurately labelled complete-body or prefix hash; raw upstream text and error-response header values are omitted. The diagnostic does not establish an actual model route or token usage for a failed request and does not trigger a retry.

### Local run

Use Node 24 and npm with the included, pinned lockfile:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4318`. The local agent API listens on `127.0.0.1:4317`. `npm run build` builds the interface and agent; `npm start` serves the built workspace locally. These commands do not publish the app.

For the isolated replay proof, see [docs/engram-repro.md](docs/engram-repro.md). It uses a fresh source copy and pinned lockfile; public npm package downloads are separate from all application data/model services. Set `ENGRAM_CLEAN_OFFLINE=1` to require a warmed cache. Clean child processes receive a minimal environment; local `.env` files, user npm config, integration credentials, and provider settings are not copied or passed.

### Held-out investigation fixtures

The runtime evaluation collector runs one fixture through the actual local API and writes an observation containing the selected sources, findings, validation feedback, model route and usage. Start an isolated server with `ENGRAM_INVESTIGATION_CASE_PATH` and `ENGRAM_INVESTIGATION_CASE_ID` pointing to a runtime-input case, and set a separate `RECALLOPS_STATE_DIR` for each run. Set `ENGRAM_MEMORY_MODE=on` or `off` to choose the comparison mode. For example:

```sh
ENGRAM_INVESTIGATION_CASE_PATH=/path/to/runtime-inputs.json \
ENGRAM_INVESTIGATION_CASE_ID=case-id \
ENGRAM_MEMORY_MODE=off \
RECALLOPS_STATE_DIR=/tmp/engram-case-memory-off \
npm run dev:api
```

In another terminal, collect the runtime observation:

```sh
node --experimental-transform-types scripts/evaluate-investigation.ts \
  --inputs /path/to/runtime-inputs.json \
  --case case-id \
  --url http://127.0.0.1:4317 \
  --out /path/to/observation.json
```

Run memory-on and memory-off comparisons with isolated server processes and state directories. This collector does not load or accept gold labels; score observations separately against the held-out evaluation criteria.

### Optional live sources

Configured live integration checks are separate from the offline replay. They require explicitly supplied server-side endpoints and credentials. The optional sixth Zetaris view, `ZETARIS_VIEW_REVIEWED_SCOPE`, has a fixed reviewed-scope column contract documented in [docs/engram-fda-query.md](docs/engram-fda-query.md). Without that view configured and read back, the app must not describe the remote reviewed scope as verified. The sanitized example rows and SQL in `data/zetaris/` are local fixtures and templates; they do not prove remote registration.

The optional FDA reviewed-scope source was registered and read back in a dedicated Zetaris sandbox on 22 October 2026; its 32 rows matched the captured source hash. The joined view returned six fictional inventory rows, including 120 EA matched to the reviewed recall scope and 10 EA requiring missing-lot review. This remote readback does not imply stock was physically handled. See [data/zetaris/README.md](data/zetaris/README.md) and `data/zetaris/provenance.json` for the exact readback and limits.

The app is a local demonstration, not a medical decision tool or a replacement for the current FDA or manufacturer instructions. Verify current sources and resolve ambiguous identifiers with a responsible human before taking operational action.

When the compact source index is complete, `list_evidence` and the index-only `read_notice` alias are omitted from the model tools. A real `inspect_evidence` read is required before a report; the model chooses new canonical source IDs and a reason. Already-selected immutable sources remain available in the run, and their IDs are excluded from new inspection choices. Partial indexes retain bounded discovery query/result observations across requests.
