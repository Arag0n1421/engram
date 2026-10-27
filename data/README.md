# RecallOps reproducible seed

This is a local operational simulation using real public recall identifiers. Every site, stock quantity, operational row, DEMO-prefixed lot, QA/expiry reference, route, supplier shipment, cost and demand is fictional. The 120-bottle presence of actual affected lot `23JJA103` is simulated. This is not a real inventory or product-safety assessment.

The clock is frozen at **2025-05-02 12:00 UTC**, dispatch by 13:00, coverage cutoff 16:00. Source pages were inspected in October 2026; the scenario is a replay and does not establish the exact historical state of every source field on the replay date. Expiry checks must use the scenario clock, not today's date.

## Files

| File | Purpose |
| --- | --- |
| `inventory.csv` | Six fictional stock rows, all individual bottles (`EA`) |
| `catalog.json` | One real product's public identifiers, fictional SKU/sites, frozen clock, fictional QA and expiry evidence |
| `demand.json` | Demand and required ending reserves |
| `shipments.json` | Conditional projected inbound plus two versioned fault events |
| `routes.json` | Two permitted transfer routes, capacities and demo costs |
| `recall-evidence.json` | All 32 actual FDA-listed lots, source locators and short excerpts, source conflict, pending required tasks |
| `validate_seed.py` | Independent integer enumeration and consistency checks; reads only |
| `manifest.json` | SHA-256 and byte counts for seed files; metadata are local and do not assert whole-source downloads |

## Matching and availability

The scope is FDA **Z-1706-2025**, manufacturer reference **RDI30296**, individual bottles. FDA each UDI is `10884389338247`; case UDI is `10884389338230`. No case conversion or substitution is enabled. The notice packet's separate sterile-water product must not be combined with this product.

Match the exact manufacturer reference plus lot. Affected stock is excluded even if it had a prior QA release. Missing lot remains review-only and excluded. A nonmatching lot is `NOT_LISTED_IN_THIS_RECALL`; that label alone never establishes safety or allocation eligibility. Only the separately documented fictional local release, acceptable expiry, lack of holds, available balance and timing permit use in this planning exercise. DEMO lots are explicit synthetic identifiers, not verified manufacturer lots.

The supplier's 40 units are **projected inbound**, conditional on receipt and acceptance. Do not merge them into received on-hand inventory. A transfer approval creates sandbox reservations/orders; it does not prove dispatch or delivery.

## Exact scenario expectations

| Site | Eligible on hand | Affected | Review | Demand | Required ending reserve |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 20 | 120 | 10 | 80 | 10 |
| B | 120 | 0 | 0 | 50 | 20 |
| C | 100 | 0 | 0 | 50 | 20 |

Total physical stock is 370, of which 240 is initially eligible, 120 affected and 10 review-only. All quantities are bottles. Required demand plus ending reserves is 230.

- On-time 40-unit inbound at 14:00: transfer B→A 30; C→A 0. Endings after demand are A10/B40/C50. Demo transport cost is 30 points.
- Inbound delayed to 18:00: exclude it from the 16:00 coverage calculation; transfer B→A 50 and C→A 20. Endings are A10/B20/C30. Cost is 110 points.
- Additionally revoke QA evidence for `DEMO-INV-B-FAULTABLE` (40 units): eligible stock is 200 versus 230 required; no feasible plan and shortfall is 30. Execution approval must be disabled.

B is split into 80 and 40 units to support the last fault. Required reserves are ending balances, not existing reservations. Source versions are incremented by the declared events so an earlier approval must be rejected as stale. Duplicate approval should return its existing receipt, not create duplicate reservations.

## Sourced obligations remain pending

Preserve separate tasks for physical quarantine, authorized destruction, manufacturer response and conditional downstream notification. A digital allocation hold does not establish physical quarantine. A draft response does not prove destruction, submission, receipt or credit. This seed sends nothing, writes to no external service and includes no actual onward-distribution history.

The public manufacturer/distributor packet has a real discrepancy: its cover table shows `23IJA103`, while FDA and the manufacturer attachment show `23JJA103`. Do not silently repair stock identifiers. This fixture uses the concordant FDA/manufacturer rule and stores the discrepancy for review. Manufacturer updates can supersede older sources; source precedence must consider issue date and scope.

## Reproduce

Run `python3 work/recallops-seed/validate_seed.py` from the workspace, or run `python3 validate_seed.py` in this directory. It checks all JSON and CSV, source scope, QA/expiry references, totals, routes, all three plans and manifest hashes. It additionally checks the original planning fixture when `outputs/recallops_demo_scenario.json` is present. It does not call Nemotron, Meterless, Zetaris or any external system.

Primary record: https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfres/res.cfm?id=213286

Manufacturer letter in public distributor packet: https://adapthealth.com/wp-content/uploads/2025/05/Medline-Urgent-Product-Recall-regarding-speci_Kelly-Williams.pdf
