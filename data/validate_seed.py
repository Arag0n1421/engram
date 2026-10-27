#!/usr/bin/env python3
"""Read-only deterministic validation for the disclosed RecallOps seed fixture."""
import csv
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read_json(name):
    return json.loads((ROOT / name).read_text())


def main():
    catalog = read_json("catalog.json")
    evidence = read_json("recall-evidence.json")
    demand = read_json("demand.json")
    shipments = read_json("shipments.json")
    routes = read_json("routes.json")
    with (ROOT / "inventory.csv").open(newline="") as file:
        inventory = list(csv.DictReader(file))

    lots = evidence["recall"]["affected_lots"]
    assert len(lots) == len(set(lots)) == 32
    assert "23JJA103" in lots and "23IJA103" not in lots
    assert len(inventory) == 6
    assert len({row["id"] for row in inventory}) == 6
    assert len({row["id"] for row in catalog["fictional_evidence_records"]}) == len(catalog["fictional_evidence_records"])
    evidence_refs = {row["id"] for row in catalog["fictional_evidence_records"]}
    analysis = datetime.fromisoformat(catalog["scenario_clock"]["analysis_at"])
    cutoff = datetime.fromisoformat(catalog["scenario_clock"]["coverage_cutoff"])
    assert str(analysis.date()) == "2025-05-02"
    assert sum(int(row["quantity"]) for row in inventory) == 370
    groups = {site: {"eligible": 0, "affected": 0, "review": 0} for site in "ABC"}
    for row in inventory:
        assert row["unit"] == "EA" and row["packaging_level"] == "EACH"
        assert row["manufacturer_ref"] == "RDI30296" and row["is_fictional"] == "true"
        assert int(row["reserved_quantity"]) == 0 and row["allocation_hold"] == "false"
        assert row["qa_evidence_ref"] in evidence_refs and row["expiry_evidence_ref"] in evidence_refs
        assert datetime.fromisoformat(row["expires_at"]).date() > cutoff.date()
        quantity = int(row["quantity"])
        if row["lot"] in lots:
            groups[row["site_id"]]["affected"] += quantity
        elif not row["lot"]:
            groups[row["site_id"]]["review"] += quantity
        else:
            assert row["lot"].startswith("DEMO-")
            assert row["qa_status"] == "RELEASED"
            groups[row["site_id"]]["eligible"] += quantity
    assert groups == {
        "A": {"eligible": 20, "affected": 120, "review": 10},
        "B": {"eligible": 120, "affected": 0, "review": 0},
        "C": {"eligible": 100, "affected": 0, "review": 0},
    }
    demands = {row["site_id"]: row["demand_quantity"] for row in demand["rows"]}
    reserves = {row["site_id"]: row["required_ending_reserve"] for row in demand["rows"]}
    assert demands == {"A": 80, "B": 50, "C": 50}
    assert reserves == {"A": 10, "B": 20, "C": 20}
    assert sum(demands.values()) + sum(reserves.values()) == 230
    supplier = shipments["rows"][0]
    assert supplier["quantity"] == 40 and supplier["lot"].startswith("DEMO-")
    assert supplier["status"] == "PROJECTED_INBOUND_NOT_RECEIVED"
    assert supplier["qa_evidence_ref"] in evidence_refs
    assert supplier["expiry_evidence_ref"] in evidence_refs
    assert datetime.fromisoformat(supplier["eta"]) < cutoff
    assert datetime.fromisoformat(shipments["fault_events"][0]["to"]) > cutoff
    assert shipments["fault_events"][1]["quantity_excluded"] == 40
    assert shipments["fault_events"][1]["evidence_ref"] in evidence_refs
    dispatch = datetime.fromisoformat(routes["dispatch_by"])
    by_origin = {row["origin_site_id"]: row for row in routes["rows"]}
    for route in by_origin.values():
        assert (cutoff - dispatch).total_seconds() / 60 >= route["lead_time_minutes"]

    # Independently enumerate every feasible integer donor allocation.
    def best_plan(inbound, excluded_b=0):
        eligible = {site: values["eligible"] for site, values in groups.items()}
        eligible["B"] -= excluded_b
        candidates = []
        for from_b in range(by_origin["B"]["capacity_units"] + 1):
            for from_c in range(by_origin["C"]["capacity_units"] + 1):
                endings = {
                    "A": eligible["A"] + inbound + from_b + from_c - demands["A"],
                    "B": eligible["B"] - from_b - demands["B"],
                    "C": eligible["C"] - from_c - demands["C"],
                }
                if all(endings[site] >= reserves[site] for site in "ABC"):
                    cost = from_b * by_origin["B"]["cost_points_per_unit"] + from_c * by_origin["C"]["cost_points_per_unit"]
                    candidates.append((cost, from_b, from_c, endings))
        return min(candidates, key=lambda row: row[:3]) if candidates else None

    assert best_plan(40) == (30, 30, 0, {"A": 10, "B": 40, "C": 50})
    assert best_plan(0) == (110, 50, 20, {"A": 10, "B": 20, "C": 30})
    assert best_plan(0, excluded_b=40) is None
    assert sum(row["eligible"] for row in groups.values()) - 40 == 200
    assert 230 - 200 == 30
    task_types = {task["type"] for task in evidence["required_tasks"]}
    assert task_types == {"PHYSICAL_QUARANTINE", "AUTHORIZED_DISPOSITION", "MANUFACTURER_RESPONSE", "DOWNSTREAM_NOTIFICATION_REVIEW"}
    assert all(task["status"].startswith("PENDING") for task in evidence["required_tasks"])

    planning_path = ROOT.parent.parent / "outputs" / "recallops_demo_scenario.json"
    if planning_path.exists():
        plan = json.loads(planning_path.read_text())
        for site in "ABC":
            assert groups[site]["eligible"] == plan["sites"][site]["eligible_units"]
            assert groups[site]["affected"] == plan["sites"][site]["confirmed_affected_units"]
            assert groups[site]["review"] == plan["sites"][site]["review_units"]
            assert demands[site] == plan["sites"][site]["demand_units"]
            assert reserves[site] == plan["sites"][site]["required_reserve_units"]
    manifest_path = ROOT / "manifest.json"
    if manifest_path.exists():
        for entry in read_json("manifest.json")["files"]:
            payload = (ROOT / entry["path"]).read_bytes()
            assert hashlib.sha256(payload).hexdigest() == entry["sha256"], entry["path"]
            assert len(payload) == entry["bytes"], entry["path"]
    print(json.dumps({
        "status": "PASS",
        "inventory_rows": len(inventory),
        "physical_on_hand_units": 370,
        "recall_match_units": 120,
        "review_units": 10,
        "initial_eligible_on_hand_units": 240,
        "affected_lots_in_source": len(lots),
        "on_time_plan": {"B_to_A": 30, "C_to_A": 0, "cost_points": 30},
        "late_plan": {"B_to_A": 50, "C_to_A": 20, "cost_points": 110},
        "late_plus_unverified": {"feasible": False, "shortfall_units": 30},
        "source_quotes_total_words": {source["id"]: sum(len(span.get("quote", "").split()) for span in source["observed_spans"]) for source in evidence["sources"]},
        "scope": "Local fixture checks only; no application or provider integration validated."
    }, indent=2))


if __name__ == "__main__":
    main()
