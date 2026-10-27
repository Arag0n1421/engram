# Engram — submission write-up (draft for Ahmed's review)

**Track:** 2 — The Agent That Can Explain Why

## One sentence

Engram is an agent that investigates medical-product recalls across changing notices, operational data and prior decisions, and shows the exact evidence behind every conclusion — or says it cannot verify one.

## Problem and users

When a recall notice is updated — a January letter supersedes an August one, the scope grows from listed lots to all lots, a "replace" becomes an "offer" — hospital pharmacy and materials teams must work out what changed, which of their stock and prior decisions are affected, and what to do next. Their records rarely line up with the notice (missing lots, different product names, earlier decisions). An assistant that is fluent but wrong is dangerous here: reversing "verify there is no irregularity", or treating an offer as a requirement, is a patient-safety error.

## What Engram does

1. Reads public recall notices (hash-bound) and six operational views from **Zetaris** (inventory, shipments, demand, products, sites, reviewed FDA scope) into one pinned snapshot per run.
2. An agent on **NVIDIA Nemotron 3.5 Super**, served through **Meterless Nightshift**, chooses which sources and sections to inspect and which record checks to run, using strict tool schemas bound to the run.
3. Deterministic backend code performs the field comparisons (lot, manufacture date, product identity), stock exposure and transfer planning. The model never does the arithmetic.
4. The model writes notice findings that must cite verbatim, hash-checked quotes; record findings are rendered by the backend from the stored comparisons. A validator rejects uncited dates/numbers, unsupported counts, scope reductions, clearance claims and record classifications, and feeds structured codes back for at most three report attempts.
5. If only some findings fail on the final attempt, those findings are withheld and listed, and the reduced report must pass the full check again ("partially verified"). Otherwise the run fails closed and shows the bound evidence with "human review required".
6. Approvals (holds, transfer reservations) are sandbox records only; Engram never claims physical action.

## Sponsor technology

- **Zetaris:** local Zetaris platform; Engram's Zetaris client reads five operational SQL views plus a separately registered reviewed-FDA-scope view through the REST SQL API, sequentially, once per investigation, and pins the result. On 27 October the live run read all six views in 34.6 s (32 reviewed-scope rows, 6 inventory rows) and pinned them as snapshot `c8159d5d…`.
- **Meterless:** Nightshift M1–M4 is Engram's only model gateway (OpenAI-compatible); Engram uses per-request cache scopes and verifies the reported model route on every response. **Meterless engine used: H-MEM.** Feature: operator memory for recall investigations — before every investigation Engram consults H-MEM for prior reviewer resolutions of the same document discrepancy (e.g. 23IJA103 vs 23JJA103) and binds them as advisory context, and after a checked plan it stores the investigation for future runs. Live evidence: in tonight's live run H-MEM was consulted three times and stored record `mem-2` (event `meterless.hmem`). Tests: `tests/memory/hmem.test.ts`, `tests/memory/resolution.test.ts`, `tests/runtime/memory-flow.test.ts` (all passing). Advisory only: H-MEM can never change recall matching, stock, QA or approval gates.
- **NVIDIA:** `nvidia/nemotron-3.5-super-vl-120b-a12b` performs every agent and report step in the runs reported below.
- **Cursor:** Engram was built with Claude Code and Codex. The organisers' HackOS announcement of 22 October made Cursor optional ("any AI coding tool"; no free Cursor credits).

**What is unique:** Zetaris is used as the system of record for a pinned, hashed evidence snapshot, so every number the agent cites can be traced to a specific view read in a specific run; Meterless is used not only as a model gateway but as an audited one (route attribution, cache-scope isolation).

## Results on the exact build (27 October 2026)

All runs use live inference: Meterless Nightshift → `nvidia/nemotron-3.5-super-vl-120b-a12b`, one at a time.

| Run | Data | Outcome |
| --- | --- | --- |
| Live Medline investigation (live mode) | Real FDA recall Z-1706-2025; **Zetaris** live read of 6 views (6 inventory, 1 shipment, 3 demand, 1 product, 3 sites, 32 reviewed-scope rows); fictional sites/stock | **Complete, claims verified** (run 00ee3741, 3 min 53 s, 11 Nemotron responses): agent inspected evidence → report accepted on attempt 2 and routed to checked calculation → read stock and constraints → solve → independent validation → checklist prepared → typed claims verified (120 EA affected, 240 eligible, 30 EA B→A, all sites at/above reserve). Earlier runs tonight failed (model claimed stock data was missing) until explicit calculation requests were routed to the checked calculator. |
| N01 — MHRA ChloraPrep 2025 notices | Public notice text + fictional records | **Partially verified**: summary + 3 notice findings accepted (manually audited: accurate), 2 findings withheld, 4 backend record findings. |
| R04 — Olympus ViziShot 2025/2026 | Public notice text + fictional records | **Not accepted**: scope/supersession correct, but the summary classified records → fails closed. |
| R05 — Medtronic MiniMed 2019/2021 | Public notice text + fictional records | **Not accepted**: unsupported "narrows scope" claim and record claims rejected. |

R04/R05/N01 were used during development (regression cases, not an unseen benchmark). Full log and source audit: `outputs/engram-v10-20261027/RESULTS.md` (working folder). Tests: 400/400 runtime + domain tests pass; typecheck clean.

These three cases (R04 Olympus ViziShot 2025/2026, R05 Medtronic MiniMed 2019/2021, N01 MHRA ChloraPrep 2025) use real public notice text and **fictional** local records, and were used during development; they are regression cases, not an unseen benchmark.

## Limitations

- The validator checks quote binding, cited literals, counts and specific claim patterns; it does not prove a paraphrase is semantically correct. Every report needs human review against the full notice.
- Record checks cover lot, manufacture date and product identity; device attributes such as ring colour remain documentary review items.
- Local single-user prototype; not a medical device or regulatory tool.

## Pre-existing components

The repository starts from the `eve` agent-framework scaffold (initial commit 22 October 2026, 11:09 UTC). `vendor/meterless/hmem-reference` is vendored from the Meterless project under its licence. Everything else was built during the hackathon window.

**Repository:** [link after Ahmed approves publishing] · **Video:** [link] · **Slides:** `Engram-deck.pptx`
