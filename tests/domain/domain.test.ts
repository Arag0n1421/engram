import test from "node:test";
import assert from "node:assert/strict";
import {
  assessEligibility, assessRecallMatch, assessSnapshot, assessShipmentEligibility,
  canonicalJson, fingerprintSnapshot, planReplenishment, validateAllocations,
  validatePlanAgainstSnapshot,
} from "../../src/domain/index.ts";
import type { FeasiblePlan, InventoryLot, Snapshot } from "../../src/domain/index.ts";

function stock(id: string, siteId: string, quantityEa: number, changes: Partial<InventoryLot> = {}): InventoryLot {
  return {
    id, siteId, internalSku: "DEMO-SKU-SALINE-100", manufacturerRef: "RDI30296", lot: `DEMO-LOT-${id}`,
    packagingLevel: "EACH", unit: "EA", quantityEa, reservedEa: 0,
    expiresAt: "2026-05-01", qaStatus: "RELEASED", qaEvidenceRef: `DEMO-QA-${id}`,
    expiryEvidenceRef: `DEMO-EXP-${id}`, allocationHold: false, version: 1, evidenceRefs: [`DEMO-STOCK-${id}`], ...changes,
  };
}

function fixture(): Snapshot {
  return {
    dataMode: "fixture", targetSku: "DEMO-SKU-SALINE-100", recipientSiteId: "A",
    clock: { analysisAt: "2025-05-02T12:00:00Z", dispatchAt: "2025-05-02T13:00:00Z", cutoff: "2025-05-02T16:00:00Z" },
    sourceVersions: { inventory: 1, demand: 1, routes: 1, shipments: 1, recall: 1, catalog: 1 },
    scope: {
      recallId: "Z-1706-2025", manufacturerRef: "RDI30296", complete: true, version: 1,
      affectedLots: ["23DJA038", "23DJA070", "23DJA114", "23EJA057", "23EJA128", "23EJA144", "23FJA110", "23GJA041", "23GJA118", "23GJA132", "23HJA033", "23IJA045", "23IJA052", "23IJA102", "23JJA103", "23JJA119", "23JJA144", "23LJA114", "24AJA025", "24AJA061", "24AJA180", "24BJA038", "24BJA092", "24BJA119", "24BJA158", "24CJA048", "24CJA117", "24CJA147", "24DJA010", "24HJA075", "24HJA178", "24KJA148"],
      reviewLots: ["23IJA103"], evidenceRefs: ["FDA-PRODUCT-LOT-SCOPE", "MFG-LOT-SCOPE"],
    },
    catalog: [{ internalSku: "DEMO-SKU-SALINE-100", manufacturerRef: "RDI30296", unit: "EA", approvedForDemo: true, evidenceRefs: ["DEMO-CATALOG-APPROVAL-001"] }],
    inventory: [
      stock("A-ELIGIBLE", "A", 20),
      stock("A-AFFECTED", "A", 120, { lot: "23JJA103" }),
      stock("A-REVIEW", "A", 10, { lot: null, qaStatus: "UNVERIFIED" }),
      stock("B-BASE", "B", 80), stock("B-FAULTABLE", "B", 40), stock("C-ELIGIBLE", "C", 100),
    ],
    demands: [
      { id: "DEMAND-A", siteId: "A", internalSku: "DEMO-SKU-SALINE-100", demandEa: 80, requiredReserveEa: 10, version: 1 },
      { id: "DEMAND-B", siteId: "B", internalSku: "DEMO-SKU-SALINE-100", demandEa: 50, requiredReserveEa: 20, version: 1 },
      { id: "DEMAND-C", siteId: "C", internalSku: "DEMO-SKU-SALINE-100", demandEa: 50, requiredReserveEa: 20, version: 1 },
    ],
    routes: [
      { id: "ROUTE-B-A", originSiteId: "B", destinationSiteId: "A", leadTimeMinutes: 60, costPointsPerEa: 1, capacityEa: 120, version: 1 },
      { id: "ROUTE-C-A", originSiteId: "C", destinationSiteId: "A", leadTimeMinutes: 120, costPointsPerEa: 3, capacityEa: 100, version: 1 },
    ],
    shipments: [{
      id: "DEMO-SUP-001", destinationSiteId: "A", internalSku: "DEMO-SKU-SALINE-100", manufacturerRef: "RDI30296", lot: "DEMO-LOT-SUP-001",
      packagingLevel: "EACH", unit: "EA", quantityEa: 40, eta: "2025-05-02T14:00:00Z", status: "PROJECTED_INBOUND_NOT_RECEIVED",
      expiresAt: "2026-05-01", qaStatus: "PROJECTED_RELEASE", qaEvidenceRef: "DEMO-QA-SUP-001", expiryEvidenceRef: "DEMO-EXP-SUP-001",
      conditionalOnReceiptAndAcceptance: true, version: 1, evidenceRefs: ["DEMO-SHIPMENT-001"],
    }],
  };
}

function feasible(snapshot: Snapshot): FeasiblePlan {
  const plan = planReplenishment(snapshot);
  assert.equal(plan.status, "feasible", JSON.stringify(plan));
  if (plan.status !== "feasible") throw new Error("Expected feasible plan");
  return plan;
}
const context = (snapshot: Snapshot) => ({ targetSku: snapshot.targetSku, catalog: snapshot.catalog, cutoff: snapshot.clock.cutoff, analysisAt: snapshot.clock.analysisAt });
const codes = (result: { reasons: Array<{ code: string }> }) => result.reasons.map((row) => row.code);

test("exact sourced lot wins over prior QA release; known source conflict is reviewed without I/J repair", () => {
  const snapshot = fixture();
  const lot = snapshot.inventory[1]!;
  assert.equal(assessRecallMatch(lot, snapshot.scope).status, "CONFIRMED_MATCH");
  assert.equal(assessEligibility(lot, snapshot.scope, context(snapshot)).eligibleEa, 0);
  assert.equal(assessRecallMatch({ ...lot, lot: " 23jja103 " }, snapshot.scope).status, "CONFIRMED_MATCH");
  assert.equal(assessRecallMatch({ ...lot, lot: "23IJA103" }, snapshot.scope).status, "POSSIBLE_MATCH_REVIEW");
  assert.equal(assessRecallMatch({ ...lot, lot: "23JJA10I" }, snapshot.scope).status, "NOT_LISTED_IN_THIS_RECALL");
  assert.equal(assessRecallMatch({ ...lot, lot: "23JJA-103" }, snapshot.scope).status, "NOT_LISTED_IN_THIS_RECALL");
});

test("missing identifiers and incomplete recall scope cannot establish allocation eligibility", () => {
  const snapshot = fixture();
  const lot = snapshot.inventory[0]!;
  for (const changes of [{ lot: null }, { manufacturerRef: null }]) {
    assert.equal(assessEligibility({ ...lot, ...changes }, snapshot.scope, context(snapshot)).eligibleEa, 0);
  }
  assert.equal(assessEligibility(lot, { ...snapshot.scope, complete: false }, context(snapshot)).eligibleEa, 0);
  assert.equal(assessRecallMatch(snapshot.inventory[1]!, { ...snapshot.scope, complete: false }).status, "CONFIRMED_MATCH");
  assert.equal(assessEligibility(lot, { ...snapshot.scope, evidenceRefs: [] }, context(snapshot)).eligibleEa, 0);
});

test("catalog approval, exact item, QA, expiry, packaging and holds are independent prerequisites", () => {
  const snapshot = fixture();
  const lot = snapshot.inventory[0]!;
  const rejected: Array<Partial<InventoryLot>> = [
    { unit: "CS" }, { packagingLevel: "CASE" }, { qaStatus: "UNVERIFIED" },
    { qaStatus: "PROJECTED_RELEASE" }, { qaEvidenceRef: null }, { expiresAt: null },
    { expiresAt: "2025-05-02T15:00:00Z" }, { expiresAt: "2026-02-30" }, { expiryEvidenceRef: null },
    { allocationHold: true }, { manufacturerRef: "RDI30295" }, { internalSku: "OTHER-SKU" },
  ];
  for (const changes of rejected) assert.equal(assessEligibility({ ...lot, ...changes }, snapshot.scope, context(snapshot)).eligibleEa, 0, JSON.stringify(changes));
  assert.equal(assessEligibility(lot, snapshot.scope, { ...context(snapshot), catalog: [] }).eligibleEa, 0);
  assert.equal(assessEligibility(lot, snapshot.scope, context(snapshot)).eligibleEa, 20, "Frozen 2025 replay must not use wall clock");
});

test("snapshot exposes the 120 affected and 10 review EA without counting either as available", () => {
  const result = assessSnapshot(fixture());
  assert.equal(result.valid, true);
  assert.equal(result.totalEligibleEa, 240);
  assert.equal(result.totalAffectedEa, 120);
  assert.equal(result.totalReviewOrExcludedEa, 10);
  assert.equal(result.sites.find((row) => row.siteId === "A")!.onHandEa, 150);
});

test("baseline chooses B30 plus conditional inbound40, preserving every reserve", () => {
  const snapshot = fixture();
  const plan = feasible(snapshot);
  assert.deepEqual(plan.transfers.map((row) => [row.originSiteId, row.quantityEa]), [["B", 30]]);
  assert.deepEqual(plan.projectedEndEa, { A: 10, B: 40, C: 50 });
  assert.equal(plan.transportCostPoints, 30);
  assert.equal(plan.projectedInboundEa, 40);
  assert.deepEqual(plan.projectedInboundIds, ["DEMO-SUP-001"]);
  assert.ok(codes(plan).includes("PROJECTED_INBOUND_CONDITIONAL"));
  assert.equal(validatePlanAgainstSnapshot(plan, snapshot).valid, true);
  assert.equal(snapshot.inventory[0]!.quantityEa, 20, "Pure planning must not receive inbound or mutate source stock");
});

test("supplier delay forces B50+C20, expected end balances and cost110", () => {
  const snapshot = fixture(); snapshot.shipments[0]!.eta = "2025-05-02T18:00:00Z";
  const plan = feasible(snapshot);
  assert.deepEqual(plan.transfers.map((row) => [row.originSiteId, row.quantityEa]), [["B", 50], ["C", 20]]);
  assert.deepEqual(plan.projectedEndEa, { A: 10, B: 20, C: 30 });
  assert.equal(plan.transportCostPoints, 110);
  assert.equal(plan.projectedInboundEa, 0);
  assert.ok(plan.transfers.every((row) => row.stockAllocations.every((allocation) => !allocation.inventoryId.startsWith("A-"))));
});

test("late supplier and either unknown lot or withdrawn QA for B40 yield infeasible30; no partial executable plan", () => {
  for (const changes of [{ lot: null }, { qaStatus: "UNVERIFIED" as const }]) {
    const snapshot = fixture(); snapshot.shipments[0]!.eta = "2025-05-02T18:00:00Z";
    Object.assign(snapshot.inventory.find((row) => row.id === "B-FAULTABLE")!, changes);
    const plan = planReplenishment(snapshot);
    assert.equal(plan.status, "infeasible");
    assert.equal(plan.shortfallEa, 30);
    assert.equal(plan.totalEligibleEa, 200);
    assert.equal(plan.totalRequiredEa, 230);
    assert.equal(plan.executionApprovalEnabled, false);
    assert.equal("transfers" in plan, false);
  }
});

test("current reservations reduce transferable availability without double-counting required reserves", () => {
  const snapshot = fixture(); snapshot.inventory.find((row) => row.id === "B-BASE")!.reservedEa = 30;
  const plan = feasible(snapshot);
  assert.deepEqual(plan.transfers.map((row) => [row.originSiteId, row.quantityEa]), [["B", 20], ["C", 10]]);
  assert.equal(plan.projectedEndEa.B, 20);
  assert.equal(plan.transportCostPoints, 50);
});

test("route deadline and capacity are actual feasibility constraints; exact cutoff arrival is allowed", () => {
  const snapshot = fixture(); snapshot.shipments[0]!.eta = "2025-05-02T18:00:00Z";
  snapshot.routes[1]!.leadTimeMinutes = 181;
  const rejected = planReplenishment(snapshot);
  assert.equal(rejected.status, "infeasible"); assert.equal(rejected.shortfallEa, 20);
  assert.ok(codes(rejected).includes("ROUTE_AFTER_CUTOFF"));
  snapshot.routes[1]!.leadTimeMinutes = 180;
  assert.equal(feasible(snapshot).transfers[1]!.arriveAt, "2025-05-02T16:00:00.000Z");
  snapshot.routes[1]!.capacityEa = 10;
  assert.equal(planReplenishment(snapshot).status, "infeasible");
});

test("projected supply is never counted twice after receipt, past its ETA, or without conditional acceptance", () => {
  const snapshot = fixture(); const shipment = snapshot.shipments[0]!;
  for (const changes of [
    { status: "RECEIVED" as const }, { status: "CANCELLED" as const },
    { eta: "2025-05-02T11:59:00Z" }, { conditionalOnReceiptAndAcceptance: false },
  ]) assert.equal(assessShipmentEligibility({ ...shipment, ...changes }, snapshot.scope, context(snapshot)).eligibleEa, 0);
  assert.equal(assessShipmentEligibility({ ...shipment, eta: snapshot.clock.cutoff }, snapshot.scope, context(snapshot)).eligibleEa, 40);
});

test("allocation validator rejects affected stock, reserve violations, lot reuse and forged arrival", () => {
  const snapshot = fixture(); const plan = feasible(snapshot);
  const recalled = structuredClone(plan.transfers);
  recalled[0]!.stockAllocations = [{ inventoryId: "A-AFFECTED", quantityEa: 30 }];
  assert.ok(codes(validateAllocations(snapshot, recalled)).includes("INELIGIBLE_LOT_ALLOCATION"));
  const excessive = structuredClone(plan.transfers);
  excessive[0]!.quantityEa = 70; excessive[0]!.stockAllocations = [{ inventoryId: "B-BASE", quantityEa: 70 }];
  assert.ok(codes(validateAllocations(snapshot, excessive)).includes("DEMAND_OR_RESERVE_SHORTFALL"));
  const duplicate = [...plan.transfers, { ...plan.transfers[0]!, lineId: "second", quantityEa: 60, stockAllocations: [{ inventoryId: "B-BASE", quantityEa: 60 }] }];
  assert.ok(codes(validateAllocations(snapshot, duplicate)).includes("LOT_AVAILABILITY_EXCEEDED"));
  const arrival = structuredClone(plan.transfers); arrival[0]!.arriveAt = "2025-05-02T13:01:00Z";
  assert.ok(codes(validateAllocations(snapshot, arrival)).includes("TRANSFER_ARRIVAL_MISMATCH"));
});

test("content or revision changes stale a proposal even when the change does not break feasibility", () => {
  const snapshot = fixture(); const plan = feasible(snapshot);
  for (const mutate of [
    (next: Snapshot) => { next.shipments[0]!.eta = "2025-05-02T15:00:00Z"; },
    (next: Snapshot) => { next.inventory[3]!.reservedEa = 1; },
    (next: Snapshot) => { next.sourceVersions.inventory = 2; },
    (next: Snapshot) => { next.scope.version = 2; },
    (next: Snapshot) => { next.routes[0]!.capacityEa = 100; },
  ]) {
    const changed = structuredClone(snapshot); mutate(changed);
    const checked = validatePlanAgainstSnapshot(plan, changed);
    assert.equal(checked.valid, false); assert.equal(checked.stale, true); assert.ok(codes(checked).includes("STALE_PLAN"));
  }
  assert.ok(codes(validatePlanAgainstSnapshot(plan, snapshot, "2025-05-02T13:00:01Z")).includes("PLAN_EXPIRED"));
  const tampered = structuredClone(plan); tampered.transportCostPoints = 0;
  assert.ok(codes(validatePlanAgainstSnapshot(tampered, snapshot)).includes("PLAN_FINGERPRINT_MISMATCH"));
});

test("canonical fingerprints ignore key/source-row ordering but reject silent JSON loss", () => {
  const snapshot = fixture(); const changed = structuredClone(snapshot);
  changed.inventory.reverse(); changed.demands.reverse(); changed.routes.reverse(); changed.scope.affectedLots.reverse();
  assert.equal(fingerprintSnapshot(snapshot), fingerprintSnapshot(changed));
  assert.equal(feasible(snapshot).planFingerprint, feasible(changed).planFingerprint);
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ missing: undefined }));
  assert.throws(() => canonicalJson({ quantity: NaN }));
});

test("invalid, fractional, overflowing and duplicate inputs fail explicitly", () => {
  for (const mutate of [
    (next: Snapshot) => { next.inventory[0]!.quantityEa = 0.5; },
    (next: Snapshot) => { next.inventory[0]!.reservedEa = 100; },
    (next: Snapshot) => { next.inventory[1]!.id = next.inventory[0]!.id; },
    (next: Snapshot) => { next.demands[0]!.demandEa = -1; },
    (next: Snapshot) => { next.routes[0]!.costPointsPerEa = Number.MAX_SAFE_INTEGER + 1; },
    (next: Snapshot) => { next.routes[0]!.leadTimeMinutes = Number.MAX_SAFE_INTEGER; },
    (next: Snapshot) => { next.routes[0]!.destinationSiteId = "C"; },
    (next: Snapshot) => { next.clock.dispatchAt = "2025-05-02T11:00:00Z"; },
  ]) {
    const snapshot = fixture(); mutate(snapshot);
    assert.equal(planReplenishment(snapshot).status, "invalid_input");
  }
});

test("held-out quantity/cost variants agree with exhaustive independent integer oracle", () => {
  const variants = [
    [0, 80, 100, 40, 1, 3], [30, 110, 90, 0, 3, 1], [10, 75, 75, 0, 2, 4],
    [40, 100, 100, 20, 4, 2], [20, 150, 70, 10, 3, 1], [10, 90, 130, 30, 2, 2],
  ];
  for (const [a, b, c, supplier, bCost, cCost] of variants) {
    const snapshot = fixture();
    snapshot.inventory[0]!.quantityEa = a!;
    snapshot.inventory[3]!.quantityEa = b!; snapshot.inventory[4]!.quantityEa = 0;
    snapshot.inventory[5]!.quantityEa = c!; snapshot.shipments[0]!.quantityEa = supplier!;
    snapshot.routes[0]!.costPointsPerEa = bCost!; snapshot.routes[1]!.costPointsPerEa = cCost!;
    let best = Infinity;
    for (let fromB = 0; fromB <= b! - 70; fromB++) for (let fromC = 0; fromC <= c! - 70; fromC++) {
      if (a! + supplier! + fromB + fromC >= 90) best = Math.min(best, fromB * bCost! + fromC * cCost!);
    }
    const plan = planReplenishment(snapshot);
    if (Number.isFinite(best)) { assert.equal(plan.status, "feasible"); if (plan.status === "feasible") assert.equal(plan.transportCostPoints, best); }
    else assert.equal(plan.status, "infeasible");
  }
});
