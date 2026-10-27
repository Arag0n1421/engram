# Engram v10 — evaluation log, 27 October 2026

All runs: previously exposed regression cases R04, R05, N01 (real public notice text + fictional local records), replay data mode (no Zetaris in these cases), live inference via Meterless Nightshift → `nvidia/nemotron-3.5-super-vl-120b-a12b`, one case at a time. Harness: `outputs/engram-accuracy-20261027/run-system-batch-v3.mjs`. Per-run summaries: `summary-build-*.md`.

| Build | Change | R04 | R05 | N01 |
|---|---|---|---|---|
| A | backend-rendered record findings; documentary-only model findings | failed (3 rejected drafts) | not run | not run |
| B | + scope false-positive fix, explicit boundary code, uncited-literal citation options | failed (3 rejected; same draft repeated) | stopped after 1 rejected draft | not run |
| C | + generic review-criterion boundary; refer to notices without dates | failed (2 rejected + 1 malformed response) | stopped after 1 rejected draft | not run |
| D (final, frozen) | + final-attempt partial verification (withhold flagged findings, re-validate rest) | **failed** (329 s, 8 model responses) | **failed** (287 s, 7) | **partially verified** (311 s, 6): 3 model notice findings + 4 backend record findings accepted, 2 findings withheld |

Freeze D: `freeze-D-pre.sha256` (source, tests, built server). Post-run check: all files unchanged except `src/runtime/http.ts`, edited during the run to add a bounded server-side error log for the live-demo diagnosis; the tested server bundle was built before that edit.

## Source audit of build D outputs (manual, against the notice text and fictional records)

**N01 (accepted as partially verified).**
- Summary: correct — the July 2025 notice adds batch 4255106 for the same product (same PL, GTIN, SNOMED), links the issue to EL(25)A/22, and keeps the stop-supply / quarantine / return-to-supplier instruction, patient advice and contacts.
- Finding 1: correct batch details (expiry 30/09/2027, pack 60, first distributed 10/03/2025) and linkage statement.
- Finding 2: correct — 4255106 is not in the May table (which lists 4255105/4255107/4255108).
- Finding 3: correct verbatim action text; cosmetic defect: prose mentions internal quote aliases ("E4", "E8").
- Backend record findings: R1 lot 4255106 matches the July notice; R2 lot 4255105 matches the May notice; R3 has no lot; R4 is a 3 mL product. R4 wording in the tested build said "lot does not match" although the lot is listed — the comparison is a non-match because the product differs. Wording fixed after the run (`server-record-findings.ts`); not part of the tested build.
- Withheld: a correct description of the May notice (validator false positive on "distributed to pharmacy/wholesaler level … affected-batch table") and a record-review finding that classified the 3 mL record as "outside the 1mL recall scope" (correctly withheld).
- The V9 errors (23-batch miscount, overstated forwarding duty) did not recur; the count validator rejected numeric batch claims in attempts 1–2.

**R04 (failed).** Final draft: scope expansion to all lots, explicit supersession, recall number 0473 → 0486 and unchanged items are correct. Defects: "adds immediate quarantine/cease-use" understates that the August notice already required quarantine and no use for listed lots; "sub-steps consolidated into a read-the-notification instruction" is unsupported. Rejected because the summary classified records ("local records matching the model must be re-checked"), which blocks partial acceptance.

**R05 (failed).** Rejected on all attempts for record claims and an unsupported scope reduction ("narrows" to clear-ring pumps). Earlier drafts also described the 2021 replacement *offer* as a requirement; the validator does not detect offer-vs-requirement errors.

**Overall:** 0/3 fully accepted, 1/3 partially verified (accurate on audit, one wording defect since fixed), 2/3 correctly failed closed. These are previously exposed regression cases, not an unseen benchmark.

## Live Medline workflow (after routing fix), 27 October ~21:29–21:33 UTC

Change: when the user's own question explicitly requests the checked calculation (and does not negate it or make it conditional), the report's next step is constrained to `continue_to_checked_calculation`; the deterministic calculator then decides feasibility. Partial verification now applies in every report mode. 442/442 tests pass.

Run `00ee3741` (live mode, Zetaris 6 views, Nemotron 3.5 Super via Nightshift, 11 responses): report attempt 1 rejected (uncited count), attempt 2 **accepted with no issues** (disposition plan) → stock/constraint reads → solve_plan (feasible) → validate_plan (passed) → prepare_actions (checklist, no action) → claims verified. Audit: report cites the verbatim FDA action "all affected product be destroyed", Z-1706-2025 / RDI30296 / 32 lots, and 23JJA103 matching FDA rather than the distributor cover — all correct. Verified claims: 120 EA affected, 240 eligible, required 230, 40 EA inbound conditional, B→A 30 EA, endings A 10/10, B 40/20, C 50/20 — consistent with the deterministic assessment. Two earlier live runs tonight failed before this fix (model claimed stock data was missing / malformed response).
