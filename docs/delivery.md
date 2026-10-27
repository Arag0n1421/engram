# RecallOps delivery contract

> **Historical record notice — updated 23 October 2026.** The entries below preserve the 22 October development and acceptance history. Current verification supersedes its “second full run” and local-acceptance claims where noted. On 23 October, root completed two live investigations: the baseline and an infeasible delayed-supplier/withdrawn-QA case with manually scoped memory. Both completed with five actual Nemotron responses, verified claims, no repair and zero new action receipts. The Node 24 clean replay gate also passed 140 tests, typecheck and production build. Root confirmed the source/build and actual UI acceptance and preserved a separately hashed demo-state backup; this is not a deployment or publication.

Final source, state, backup, direct-runtime readback and screenshot inspection checks are complete; see the [23 October verification report](../../outputs/engram-build-verification.json).

Build a local recall-response workspace for one sourced recall, one exact product, three fictional sites and one planning deadline. The historical 22 October acceptance included live Zetaris SQL, Nemotron through Meterless, explicit UI approvals and receipt persistence after restart/reload. Current 23 October validation is summarized below; root has confirmed its source/build and actual UI acceptance. No public deployment or submission is authorized by this build request.

Organizer-channel clarification reported by Ahmed on 22 October 2026 makes Cursor optional. No Cursor credits are provided, and no Cursor migration or development-evidence gate applies.

## Acceptance

- Actual sponsor health evidence: Meterless Nemotron tool round trip and a cross-source Zetaris query with changed-row readback.
- Source-backed exposure classification; unknown or affected inventory never allocated.
- Baseline B30; supplier delay B50+C20; missing40B produces infeasible target shortfall30.
- Independent reserves, timing, quantities and input-version checks.
- Explicit UI approval, persisted sandbox holds/reservations, idempotency and stale-plan rejection.
- Separate software receipt, physical quarantine, dispatch, delivery and disposition states.
- Model traces contain actual model/route/usage where available and no secrets or hidden reasoning.
- No fake live providers: replay mode is visibly labelled and live failure stays failure.

## Work ledger

| ID | Owner | Scope | Dependency | Acceptance | Status |
|---|---|---|---|---|---|
| T1 | integrations worker | src/integrations, src/memory, vendor, tests, smoke script | official APIs | contract tests and nonsecret smoke evidence | actual Meterless tool smoke passed; all seven Zetaris DFFS sources and seven views verified |
| T2 | seed worker | data source pack | real FDA case | all32 lots and balanced scenario verified | checked |
| T3 | domain worker | src/domain, tests/domain | fixture | matching, eligibility, feasible/infeasible and version guards | checked |
| T4 | coordinator | agent, channels, app API/store | T1,T3 | workflow, persisted approvals, safe routes | complete: live scenarios, agent retry, explicit UI approvals and restart persistence verified |
| T5 | UI lane | web | app API contract | usable exposure/plan/action workspace | complete: production build, fresh live reload, checked facts and saved receipt readback verified |
| T6 | independent review | read-only implementation review | integration | no blocking correctness issues | findings repaired and scoped re-review passed |

## Current external gates

The official Nightshift 0.92.1 app is running with the user's approved NVIDIA key configured in the app. Its Meterless runtime at `http://127.0.0.1:8088/v1` completed an authorized two-call tool smoke: both responses were HTTP 200 and reported the actual route `nvidia/nemotron-3.5-lightning-30b-a3b`, with 947 total reported tokens. This verifies that smoke, not every later app response or a billing-confirmed $0 cost. Actual Meterless H-MEM is also vendored unchanged, tested and exercised in the application.

All seven local Zetaris DFFS sources and seven views are registered and verified. Actual live reads reproduced baseline B30 at cost30, delayed supply B50+C20 at cost110, and withdrawn QA with shortfall30. A stale approval returned HTTP 409 and created zero receipts. Creation of a durable API key was approved; it expires on 29 October 2026. Private `.env.local` enables live data and authorized inference. Previous replay state is preserved; live runs use separate `state/live` state.

**Historical 22 October first workflow attempt:** it received six Nemotron responses and exercised `read_notice`, `investigate_stock`, `fetch_constraints`, `solve_plan`, H-MEM, `validate` and `prepare_actions`. Its final synthesis failed with `MODEL_RESPONSE_ERROR`; Meterless's matching decision recorded `nvidia/nemotron-3.5-lightning-30b-a3b_empty_response`. The application failed closed and released no final output. The subsequent 22 October revision temporarily allowed an 8,192-token final response; the current terminal and repair ceiling is 4,096 tokens.

**Historical 22 October run:** the second full run completed at `2026-10-22T15:58:39.862Z`, with five actual Nemotron responses from five requests. It retrieved one H-MEM record and stored one new record, `mem-3`, solved baseline B30, performed fresh validation and prepared actions. It made zero automatic approvals. The later UI recalculation stored `mem-4`. Its timing and output describe that earlier implementation and are not a current performance baseline.

**Historical 22 October UI action flow:** a 120-EA allocation hold recorded receipt `f4c3963b-ba01-4091-8dc9-f1182e0d03dc`; a later explicit 30-EA B-to-A reservation recorded receipt `92124573-ac09-4da8-97f2-4af04bb7473e`. Both receipts persisted across the documented restart and reload. They remain historical sandbox records and were not created by the 23 October investigations.

**Historical narrative limitation:** the 22 October raw model text incorrectly called 120 recalled EA “eligible.” The deterministic engine excluded those 120 EA. The newer 23 October terminal flow returns a bounded typed claim receipt copied from a server-built template, bound to the pinned snapshot and deterministic plan, then checked for counts, plan status, cutoff, allocations and exact citations. This is serialization of checked facts, not independent model arithmetic.

The local Zetaris stack runs Intel/amd64 components under emulation on this Mac. Cold reads have been slow during host contention, and the driver restarted once; its original shutdown trigger was not established. The five operational views now load sequentially with bounded timeouts. Container liveness alone does not establish query or workflow readiness.

Node 24.22.1, Docker 29.9.2, Compose 5.6.1 and Colima 0.10.3 are installed. Do not create additional keys, accept further terms, buy credits or start paid infrastructure without applicable authorization. A successful model smoke does not establish hackathon or award eligibility.

## Local verification 22 October 2026

- Latest TypeScript, 67/67 tests and frontend/eve production build pass. The tests include independent domain checks, HTTP contracts, actual H-MEM, model-run isolation and current-run attribution. The public frontend bundle check examined three files and found zero credential matches.
- Seed checksum/quantity validator passes.
- Browser → API → seed → checked plan → explicit sandbox hold/reservation → persisted receipt works. Baseline B30, late B50+C20, QA failure shortfall30 observed. Reload retains state. Earlier receipts remain after a new incident.
- Separately, actual live Zetaris reads verify baseline B30/cost30, late B50+C20/cost110 and withdrawn-QA shortfall30. Stale live approval returns 409 with zero receipts. Positive live UI hold and reservation receipts survived server restart and browser reload unchanged; fresh live source readback, revision 53 and disabled repeat controls are verified.
- Actual Meterless H-MEM stores source references and retrieves historical analysis. It does not authorize current data or actions.
- The full live retry completed with five verified Nemotron responses, one retrieved H-MEM record and one new stored record (`mem-3`). UI recalculation later stored `mem-4`. Its raw narrative contains the recalled/eligible error described above; deterministic exposure, validation and approval guards remain authoritative.
- Tests cover concurrent approval, same-key retry across restart, content/version changes, malformed source values, source outage recovery and originating model-run isolation.
- Every model response requires coherent actual Nemotron route metadata before any model/tool bytes reach the agent. Requested/echoed names, routing aliases, mixed routes, stream errors and oversized/incomplete responses cannot pass. The two-call smoke checks both actual routes.
- Running investigations poll persisted local progress without SQL reads or overlapping requests. A burst of 25 progress reads completed while a live refresh was blocked; planning and approval still read fresh sources, and an externally changed ETA rejected approval without creating a receipt.
- `npm audit` high advisory was removed with compatible undici override. Four moderate inherited advisories remain around just-bash/sprintf; shell tools are disabled and the app is local only. This is not a production release.
- Replay scenario controls are hidden in live mode; live scenario changes use the dedicated fictional source files.
- Configuration readiness, the successful Meterless smoke, verified live data scenarios, agent-run completion, explicit UI approvals and restart persistence are each verified for this local demonstration. Evidence is saved in [the live screenshot](../../outputs/recallops-live-demo.jpg) and [the readback verification](../../outputs/recallops-live-verification.json). This local acceptance establishes neither production readiness nor hackathon/award eligibility.

## 23 October final runtime evidence

- Baseline investigation `f10da2be-9c0e-422e-ba13-64a81f4b17de`: complete with verified claims; five requests and five Nemotron responses; no repair; 58.084 seconds agent elapsed, 39.195 seconds model elapsed, 42,109 input and 3,448 output tokens. One immutable six-view snapshot took 17.718 seconds. The checked assessment was 120 affected EA, 240 eligible EA and 10 review EA; the feasible plan was B→A30 with conditional inbound40. It created zero action receipts. All responses reported cache misses. Evidence: `../work/engram-baseline-live-evidence.json`.
- Infeasible-memory investigation `eda8aea1-76ea-47e0-b2fc-af654f171fe0`: complete with verified claims; five requests and responses; no repair; 55.926 seconds agent elapsed, 46.751 seconds model elapsed, 43,284 input and 3,917 output tokens. One six-view snapshot took 6.946 seconds. The checked assessment was affected120/eligible200/review50 and infeasible with shortfall30. A manual source-bound resolution was applied before the first model request and changed the next question to physical label verification; it did not change the source classification, plan or approval state. No action receipts were created. Evidence: `../work/engram-infeasible-memory-live-evidence.json`.
- The current clean replay proof is Node 24.22.1 with offline `npm ci` using the active npm cache, 140 tests, typecheck and production build, all passing. It is not a fresh-cache proof. The earlier fresh-cache proof with 97 tests remains dated historical evidence. Root independently matched 130 runtime/source files to the clean export. Proof: `/private/tmp/engram-clean-export-20261023-10/proof.json`.
- Root confirmed E7 source/build and actual UI acceptance. The isolated workspace and H-MEM state/ledger are backed up as three hashed files under ignored `state/engram-demo-final`; the original two receipt IDs and original state hash remain unchanged (`../work/engram-demo-backup-evidence.json`).
