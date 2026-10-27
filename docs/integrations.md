# RecallOps integration and memory evidence

> **Historical record notice — updated 23 October 2026.** The provider smoke, first/second agent runs, 8,192-token terminal allowance, narrative limitation and UI receipt flow documented below describe the 22 October implementation and remain as dated history. The latest verified runtime uses the bounded `report_claims` receipt and a 4,096-token terminal/repair ceiling. Two independent live runs completed on 23 October with five actual Nemotron responses each, verified claims, no repair and zero new receipts. Current clean replay evidence is 140 tests plus typecheck and production build, using the active npm cache offline; this is not a fresh-cache claim. Root confirmed source/build and actual UI acceptance and a separately hashed backup of the isolated workspace and H-MEM state/ledger; the original receipt-bearing state remains unchanged.

Final direct Nightshift readback, source/state/backup checks and visual screenshot inspection also passed; see the [23 October verification report](../../outputs/engram-build-verification.json).

## Current 23 October live verification

- Baseline run `f10da2be-9c0e-422e-ba13-64a81f4b17de`: complete, claim status verified, five requests/five Nemotron responses, no repair, no receipts, and all responses reported cache misses. Agent elapsed 58.084 seconds, model elapsed 39.195 seconds, usage 42,109 input / 3,448 output tokens. One six-view source snapshot took 17.718 seconds. Assessment: affected120/eligible240/review10; feasible B→A30 with conditional inbound40. See `../work/engram-baseline-live-evidence.json`.
- Infeasible-memory run `eda8aea1-76ea-47e0-b2fc-af654f171fe0`: started through the browser button; complete with claim status verified, five requests/five Nemotron responses, no repair and no receipts. Agent elapsed 55.926 seconds, model elapsed 46.751 seconds, usage 43,284 input / 3,917 output tokens. One six-view snapshot took 6.946 seconds. Assessment: affected120/eligible200/review50; infeasible shortfall30. A manual source-bound resolution was applied before the first model request and changed the next investigation question to physical label verification. The source classification, QA state, solver result and action gates remained unchanged. See `../work/engram-infeasible-memory-live-evidence.json`.
- Terminal claims are serialized from a trusted checked template bound to the current pinned snapshot and deterministic prepared plan. The model formats the receipt; the checker verifies factual fields and citation sets. This does not establish independent model arithmetic or any physical action.
- Root's clean proof `/private/tmp/engram-clean-export-20261023-10/proof.json` passed 140 tests, typecheck and production build with offline `npm ci`, replay mode and inference disabled. It used the active npm cache and is not a fresh-cache proof. Root matched 130 runtime/source files to the clean export. The earlier 97-test public-download fresh-cache result remains historical; details are in [the reproducibility note](engram-repro.md).

This lane implements configured HTTP clients and an actual vendored Meterless H-MEM advisory-memory wrapper. Mocked tests do not establish live provider connectivity. No token, account, model fleet, credits, licence or award eligibility is verified by code being present.

Organizer-channel clarification reported by Ahmed on 22 October 2026 makes Cursor optional. No Cursor credits are provided, and no Cursor migration or development-evidence gate applies.

## Meterless identity

The official sponsor is [Meterless/Meterless](https://github.com/Meterless/Meterless): Nightshift and open context engines. The [prompt library](https://github.com/Meterless/Meterless/blob/main/docs/agent-ready/prompt-library.md) links to the [Runtime 0.90 provider contract](https://github.com/Meterless/Meterless/blob/main/docs/agent-ready/add-meterless-provider.md).

The runtime is an OpenAI-compatible local/network hotspot. The running local endpoint is `http://127.0.0.1:8088/v1`; its real token comes from the runtime. IDs such as `meterless/auto` are routing modes and do not identify the underlying model. An Experiential account or endpoint is not required or assumed, and no relationship to this sponsor has been established.

The adapter requires an explicit endpoint/token/model. It does not read token files, scan ports, install Nightshift or silently substitute cloud inference. It normalizes supplied URLs with `/v1/models`, `/v1/chat/completions` or `/healthz` to one `/v1` base.

| Environment variable | Purpose |
|---|---|
| `METERLESS_BASE_URL` | Actual explicit endpoint, no default |
| `METERLESS_RUNTIME_TOKEN` | Real private runtime token; `rt-local` is rejected |
| `METERLESS_MODEL` | Explicit routing/model ID from that endpoint |
| `METERLESS_APP_ID` | Optional lowercase app ID; defaults to `recallops` |
| `ZETARIS_REST_URL` | Actual API base ending in `/api/v1.0` |
| `ZETARIS_API_KEY` | User-provided read-capable key |
| `ZETARIS_ORG_ID` | Actual positive numeric organisation ID |
| `ZETARIS_VIEW_MAP` | Optional JSON mapping of `inventory`, `shipments`, `demand`, `products`, `sites` to verified registered SQL views |
| `ZETARIS_TIMEOUT_MS` | Optional integer 1–300000 ms; unset/blank keeps 30000. Recommend 120000 for slow local cold starts. |

Every Meterless request sends Bearer auth and `meterless-app`. Investigation SDK requests use a unique `user:engram:<run UUID>:<request UUID>` scope under the same stable app identity; each standalone smoke inference call similarly uses `user:engram:smoke:<request UUID>`. Model discovery is unchanged. Installed Nightshift 0.92.1 uses this header to partition its exact and semantic inference cache separately from app routing policy. A fresh scope prevents cached text from replacing structured tool calls, and both inference paths reject metadata-declared replay before accepting the response. This also isolates Nightshift's native inference-side H-MEM per request; the application's vendored H-MEM store is separate and unchanged. Scope is caller-selected isolation, not an authorization boundary. No Nightshift data is cleared or modified by this adapter.

The runtime timeout defaults to 180 seconds for cold model loads. `GET /v1/models`, rather than `/healthz`, establishes recognized runtime status. HTTP 401/403 remains an authorization error, not an offline process. SDK wiring sends the same explicit endpoint, real token and required headers. Keep all credentials server-side.

## Exported clients

Import from `src/integrations/index.ts`:

- `loadIntegrationConfig(env?)`: zero-network config validation; `configurationSummary` strips credential-bearing config for logs.
- `MeterlessClient(config, fetch?)`: `listModels()` reads `/v1/models`; `smokeToolRoundTrip({onCallEvidence?,requireNemotronEvidence?})` makes the explicitly requested real tool-call check.
- `ZetarisClient(config, fetch?)`: `listDatasources()`, `checkConnection()`, `queryRecallOpsView(view,filters?,limit?)`. No arbitrary SQL or writes.
- `RECALL_OPS_COLUMNS`: deterministic ordered raw-fixture columns. Query results contain `columns` and `rows`; mismatched widths fail.
- `IntegrationError` and `safeError`: bounded errors that omit tokens, provider error bodies and raw network exceptions.

View names are not guessed. For example, `{"inventory":"recallops.inventory"}` is valid mapping syntax, not proof that view exists. Filters allow raw fixture columns `site_id`, `internal_sku`, `manufacturer_ref`, `lot`, `destination_site_id` only where present in that view. The data layer must normalize numbers, dates, units and domain records. A result at its row limit is `possiblyTruncated`, not exhaustive exposure.

The [current Zetaris starter adapter](https://github.com/zetaris/getting-started/blob/main/scripts/zetaris_sql.py) documents Bearer key + numeric `X-Org-ID` + UUID `X-Request-ID`; `GET /datasource/datasources`; and `POST /sql-editor/sqls/run` with `{queryId,sql,source:"SqlEditor",limit}`. It reads row arrays from `data`. Its raw API base is distinct from the UI `/api/proxy` origin. Match the installed instance's OpenAPI version. [Client guide](https://zetaris.github.io/getting-started/docs/connections/client-setup.html)

## Run checks

Use Node 24+. The root compiler needs `allowImportingTsExtensions: true` with `noEmit: true`.

```sh
node scripts/check-integrations.ts --output work/integration-evidence.json
```

The default writes nonsecret evidence, validates config and makes zero network requests. Missing/invalid config exits 1. Config readiness alone is labelled `configuration_ready_only`.

```sh
node --env-file=.env.local scripts/check-integrations.ts --check-read-only --output work/integration-evidence.json
```

Read-only mode checks model discovery, Zetaris datasource listing and exact `SELECT 1 AS one` readback. It does not run inference or query operational datasets. A listed routing mode does not prove Nemotron selection or tool support.

Only after explicit inference authorization and runtime/model availability are confirmed:

```sh
node --env-file=.env.local scripts/check-integrations.ts --allow-inference --require-nemotron-evidence --output work/integration-evidence.json
```

A normal successful smoke uses two real requests: request a harmless fixed fixture tool, validate its function/arguments, return its result, then check the final result code. It can incur cost if the runtime routes to paid inference. Invalid tools/arguments/results fail, with partial call evidence retained. There are no automatic client retries or model substitutions; the runtime itself can route across its fleet. Missing usage is unknown cost, not zero.

Tool success and Nemotron attribution are separate. Requested or echoed names, including `meterless/auto`, never establish the underlying model. The official `meterless.provider_model` field is also a routing ID. `--require-nemotron-evidence` requires coherent actual `meterless.routed_model` or `meterless.winning_route.model` evidence on both calls; an unverified first response prevents a second inference request. Every app response is checked too. JSON or streamed tool output is withheld from the SDK until bounded whole-response attribution and error checks pass. This adds stream latency. Exact safe route/model labels and usage are recorded per originating run. Endpoint-reported metadata is not independent prize eligibility proof.

## Actual Meterless H-MEM

`vendor/meterless/hmem-reference/src/` contains ten unmodified source files (about 43 KB), pinned to official commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`. `LICENSE` preserves Apache 2.0 and `UPSTREAM.json` records original paths and Git blob SHAs. Tests recompute all those hashes. No Nightshift binary, model weights or big repository download is included.

The upstream README describes a deterministic reference, not a production library: hash-mock embeddings and JSON persistence. The [official hackathon starter](https://github.com/Meterless/Meterless/blob/main/templates/agentathon-starter/README.md) uses this same real H-MEM reference without API keys.

Import `RecallOpsMemory` from `src/memory/index.ts`:

```text
new RecallOpsMemory({persistDir: absolutePrivateDirectory, clock?})
recordAnalysis({analysisId,recallId,snapshotHash,summary,sourceRefs})
queryEvidence({query,recallId,currentSnapshotHash,topN?})
audit(memoryId)
```

The wrapper calls actual H-MEM `add`, `query`, persistence and append-only ledger services. Source references live in upstream `provenance.refs`. Retrieved records retain ranking traces, exact sources and a snapshot-mismatch flag, scoped to the recall. Reusing an analysis ID cannot overwrite a different historical analysis.

Memory is always advisory. It may suggest evidence to inspect again; it cannot establish current recall scope, QA release, inventory, availability or solver feasibility, or authorize actions. Context states that current authoritative facts take precedence and quotes historical content as data. Root must preserve that boundary in agent wiring. No sleep, dream synthesis or automatic conflict resolution is exposed.

Use one wrapper per private state directory in one process. Concurrent writers, crash recovery, production storage and real semantic embeddings are outside this reference's validated scope.

## Practical routes and remaining gates

H-MEM code can run without Nightshift or a GPU. The [native-edition docs](https://github.com/Meterless/Meterless/blob/main/docs/products/nightshift/editions.md) distinguish M5+ Mac preorder from the free M1–M4 edition. The free edition also supports cloud routes; no local NVIDIA model weights or M5 hardware purchase is needed for that route. The web edition provides no app hotspot.

The official Nightshift 0.92.1 app is now running on this Mac under importante.ahmed@gmail.com, with the user's NVIDIA key configured in the app. An authorized two-call tool smoke through `http://127.0.0.1:8088/v1` passed: both responses were HTTP 200, both actual routes reported `nvidia/nemotron-3.5-lightning-30b-a3b`, and total reported usage was 947 tokens. No billing-confirmed $0 cost or free-credit balance has been established. This smoke proves that round trip; each later application response still needs its own actual-route check.

**Historical 22 October run.** The first full RecallOps investigation received six successful model responses and executed its corresponding tools, but the seventh model response, intended to explain the final result, failed with `nvidia/nemotron-3.5-lightning-30b-a3b_empty_response`. It contained neither visible text nor tool calls. The subsequent bounded retry completed at 15:58:39.862Z with five requests and five responses carrying verified actual Nemotron route evidence. Its final request used an 8192-token output ceiling and returned successfully after 53.271 seconds. The complete local run took approximately 14 minutes 25 seconds. These were completion and model-attribution checks, not validation of every statement in the generated narrative.

The completed run actually retrieved one prior H-MEM record and stored one new record, `mem3`. A later UI recalculation stored `mem4`; these identifiers are not counts of newly stored records. The raw advisory summary incorrectly described 120 affected EA as eligible and remains unchanged. The independent engine correctly excludes those 120 EA and computed 240 eligible, unreserved EA before reservation. After reserving 30 EA, it reports 210 eligible, unreserved EA. The UI now keeps raw text behind a collapsed advisory section and presents checked engine facts separately. Neither a successful model response nor an H-MEM record establishes allocation eligibility, and the raw narrative has not been validated.

NVIDIA documents the exact model's thinking switch as `chat_template_kwargs.enable_thinking`; the hosted API exposes `reasoning_budget`, whereas self-hosted NIM documents `thinking_token_budget`. Reasoning and visible text share the generated-token budget, so exhausted reasoning is a possible explanation for the empty result, not a confirmed diagnosis. The installed Meterless request path does not forward these controls from RecallOps, so adding an unsupported `extra_body` parameter would not establish that NVIDIA received it. No thinking-disable setting or provider fallback has been silently applied. [Exact model API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer), [NVIDIA model guide](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html)

The installed0.92.1 source exposes the native NVIDIA route `nvidia/nemotron-3.5-lightning-30b-a3b`, including tool calls, through Meterless's gateway and the user's own NVIDIA key. Its native mode disables the shared/keyless relay. Setup → Providers → NVIDIA links to NVIDIA's key page. No OpenRouter account is needed for that path. The [public model registry](https://meterless.ai/Nightshift/WEB/js/engine/models.js) and [provider adapter](https://meterless.ai/Nightshift/WEB/js/engine/providers.js) also expose `openrouter/nvidia/nemotron-3.5-lightning:free` as an alternative requiring an authorized OpenRouter key and account allowance. A bound app policy can override the requested model, so configure RecallOps to allow only the chosen Nemotron lane and inspect actual response route metadata on both smoke requests and subsequent app calls. Verify account trial access before inference. Empty-pool requests may trigger a local model download in this build; establish the configured cloud provider and lane before sending a smoke request.

H-MEM plus separately named direct NVIDIA cloud inference is technically possible, but it is not inference “through Meterless” and is not silently substituted here. The current [Academy overview](https://academy.genai.works/courses/open-agent-hackathon-2026/details) describes Nemotron through Meterless; [live event rules](https://hackathon.genai.works/event/open-agent-hackathon-2026#rules) govern eligibility. Confirm the accepted inference route and award requirements before claiming eligibility. Meterless repo dates/tracks/rubric differ from the current event and must not replace its rules.

Four local Zetaris services are healthy on the external SSD. An approved durable token expires on 29 October 2026. It inherits the creating administrator account's permissions; it is not a separately scoped read-only credential. It remains private and server-side. RecallOps itself exposes only its constrained read queries through this integration.

All seven DFFS source tables and seven views are registered, and exact source/view readbacks passed. The accepted source paths are `dffs://recallops/<raw-file>.csv`; they are logical NDP file-store paths, not host or container paths. The inventory view joins the warehouse source with catalog and sites in Zetaris. Five views supply the baseline adapter contract, with two additional views providing delayed-supplier and missing-QA scenarios. These are fictional operational fixtures joined against real, source-bound FDA recall evidence.

The verified transport is the raw local API at `http://127.0.0.1:8888/api/v1.0`, using Bearer authentication, the actual numeric organisation ID and a fresh request UUID. Source reads run sequentially with a 120-second request timeout for this local instance. A cold metadata query previously completed after the original 60-second client timeout; that attempt stopped before any DDL. The separate continuation preserved existing registrations, used no overwrite/drop commands and passed its final readback checks.

Live API/domain checks produced the expected plans: baseline transfers 30 EA from B at a total demo cost of 30; delayed supplier transfers 50 EA from B and 20 EA from C at a total cost of 110; missing QA produces a 30 EA shortfall and no feasible plan. A stale approval returned HTTP 409 with zero action receipts. These results verify those live data and API paths. The full agent retry has completed, with the advisory-content limitation recorded above.

Positive browser UI action checks passed. Applying the sandbox hold covered 120 affected EA and returned receipt `f4c3963b-ba01-4091-8dc9-f1182e0d03dc` at 16:03:54.757. The hold made the existing plan stale and disabled reservation. UI recalculation at 16:05:57 produced the baseline 30 EA B-to-A plan; reserving that transfer returned receipt `92124573-ac09-4da8-97f2-4af04bb7473e` at 16:07:56.010Z. After reservation, repeat reservation and calculation controls were disabled. These are local sandbox holds and reservations, not physical quarantine or dispatch.

Local sandbox acceptance is verified. The app restarted as PID 3605 on `http://localhost:4317`; a browser reload performed a fresh live Zetaris read and retained the same incident at revision 53. Both exact receipt IDs above remained unchanged, and both action controls remained disabled. Checked facts visibly showed 120 affected EA excluded, 210 eligible/unreserved EA and 10 EA requiring review; the raw narrative remained collapsed and labelled advisory. The [live demo screenshot](../../outputs/recallops-live-demo.jpg) and [verification JSON](../../outputs/recallops-live-verification.json) were saved and read back successfully. This acceptance verifies the local demo and persisted sandbox state; it does not establish physical fulfilment, a production deployment or hackathon award eligibility.

Private `.env.local` is configured for live data and authorized inference. Previous replay state is preserved, with live runs using separate `state/live` state. Configuration and a successful provider smoke do not establish complete application acceptance. The integration badge verifies only coherent actual Nemotron response evidence persisted in the current investigation; a later rejection or failed run removes that status. Local progress polling makes no provider reads, while planning and action approval retain fresh-source validation.

## Local tests

```sh
node --test tests/integrations/contracts.test.ts
node --experimental-transform-types --test tests/memory/hmem.test.ts
```

HTTP tests inject fetch and call no providers. Memory tests execute actual vendored H-MEM for source fidelity, persistence, source refs, recall isolation, idempotence and advisory/stale behavior. Direct Node needs `--experimental-transform-types` for upstream parameter properties; eve's bundler handles TypeScript. An eve 0.82 registry lookup was attempted but DNS failed; no native connector was discovered or installed.

**Historical 22 October gate:** TypeScript, 67/67 tests and the frontend/eve production build passed. Three public bundle files were checked with zero credential matches. Restart/reload persistence readback and positive browser UI hold/reservation checks also passed. The current 23 October source/test/build and live-run state is summarized at the top of this document; root has confirmed source/build and actual UI acceptance, with the isolated demo state backed up separately.
