import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fingerprintSnapshot } from "../../src/domain/fingerprint.ts";
import type { Snapshot } from "../../src/domain/types.ts";
import { applyScenario, loadSeed } from "../../src/runtime/seed.ts";
import { runWhatIf, whatIfInputSchema } from "../../src/runtime/what-if.ts";

const repoRoot = resolve(process.cwd());

async function seedSnapshot(): Promise<Snapshot> {
  return (await loadSeed(repoRoot)).snapshot;
}

async function qaMissingSnapshot(): Promise<Snapshot> {
  return applyScenario(await seedSnapshot(), "qa_missing");
}

test("ETA hypothesis is deterministic, read-only, and reports only a non-approvable summary", async () => {
  const snapshot = await qaMissingSnapshot();
  const beforeBytes = JSON.stringify(snapshot);
  const beforeFingerprint = fingerprintSnapshot(snapshot);
  const input = { shipmentEta: [{ shipmentId: "DEMO-SUP-001", eta: "2025-05-02T14:00:00Z" }] };
  const first = runWhatIf(snapshot, input);
  const second = runWhatIf(snapshot, input);

  assert.deepEqual(first, second);
  assert.equal(first.label, "HYPOTHETICAL");
  assert.equal(first.snapshotHash, beforeFingerprint);
  assert.equal(first.baseline.projectedInboundEa, 0);
  assert.equal(first.hypothesis.projectedInboundEa, 40);
  assert.equal(first.comparison.projectedInboundDeltaEa, 40);
  assert.equal(first.baseline.shortfallEa, 30);
  assert.equal(first.hypothesis.shortfallEa, 0);
  assert.deepEqual(first.hypothesis.transfers.map(({ originSiteId, destinationSiteId, quantityEa }) => ({ originSiteId, destinationSiteId, quantityEa })), [
    { originSiteId: "B", destinationSiteId: "A", quantityEa: 10 },
    { originSiteId: "C", destinationSiteId: "A", quantityEa: 20 },
  ]);
  assert.equal(first.hypothesis.transportCostPoints, 70);
  assert.ok(first.assumptions.some((line) => line.startsWith("Baseline condition INBOUND_AFTER_CUTOFF (DEMO-SUP-001)")));
  assert.equal(first.cannotApprove, true);
  assert.equal(first.neverMutatesSource, true);
  assert.equal("transfers" in first, false);
  assert.equal(JSON.stringify(snapshot), beforeBytes);
  assert.equal(fingerprintSnapshot(snapshot), beforeFingerprint);
});

test("QA hypothesis adds one evidence reference without mutating the snapshot or resolving unrelated review rows", async () => {
  const snapshot = await qaMissingSnapshot();
  const target = snapshot.inventory.find((row) => row.id === "DEMO-INV-B-FAULTABLE")!;
  const beforeBytes = JSON.stringify(snapshot);
  const result = runWhatIf(snapshot, { qaEvidence: [{ inventoryId: target.id, evidenceRef: "QA-REVIEW-HYPOTHESIS-01" }] });

  assert.equal(result.label, "HYPOTHETICAL");
  assert.equal(result.baseline.status, "infeasible");
  assert.equal(result.baseline.shortfallEa, 30);
  assert.equal(result.hypothesis.status, "feasible");
  assert.equal(result.hypothesis.shortfallEa, 0);
  assert.deepEqual(result.hypothesis.transfers.map(({ originSiteId, destinationSiteId, quantityEa }) => ({ originSiteId, destinationSiteId, quantityEa })), [
    { originSiteId: "B", destinationSiteId: "A", quantityEa: 50 },
    { originSiteId: "C", destinationSiteId: "A", quantityEa: 20 },
  ]);
  assert.equal(result.hypothesis.transportCostPoints, 110);
  assert.ok(result.assumptions.some((line) => line.startsWith(`Baseline condition QA_NOT_RELEASED (${target.id})`)));
  assert.equal(result.assumptions.some((line) => line.startsWith(`Hypothesis condition QA_NOT_RELEASED (${target.id})`)), false);
  assert.ok(result.assumptions.some((line) => line.includes("QA-REVIEW-HYPOTHESIS-01")));
  assert.equal(JSON.stringify(snapshot), beforeBytes);
});

test("QA hypotheses refuse recalled, held, or blocked inventory", async () => {
  const snapshot = await seedSnapshot();
  const target = snapshot.inventory.find((row) => row.id === "DEMO-INV-B-FAULTABLE")!;
  target.qaStatus = "UNVERIFIED";
  target.qaEvidenceRef = null;
  target.lot = snapshot.scope.affectedLots[0]!;
  assert.throws(() => runWhatIf(snapshot, { qaEvidence: [{ inventoryId: target.id, evidenceRef: "QA-HYPOTHESIS" }] }), /NOT_LISTED_IN_THIS_RECALL/);

  const cleared = await seedSnapshot();
  cleared.scope.affectedLots = ["NOT-PRESENT-IN-SNAPSHOT"];
  cleared.scope.reviewLots = [];
  const heldTarget = cleared.inventory.find((row) => row.id === "DEMO-INV-B-FAULTABLE")!;
  heldTarget.qaStatus = "UNVERIFIED";
  heldTarget.allocationHold = true;
  assert.throws(() => runWhatIf(cleared, { qaEvidence: [{ inventoryId: heldTarget.id, evidenceRef: "QA-HYPOTHESIS" }] }), /held inventory/);

  const blocked = structuredClone(cleared);
  const blockedTarget = blocked.inventory.find((row) => row.id === heldTarget.id)!;
  blockedTarget.allocationHold = false;
  blockedTarget.qaStatus = "BLOCKED";
  assert.throws(() => runWhatIf(blocked, { qaEvidence: [{ inventoryId: heldTarget.id, evidenceRef: "QA-HYPOTHESIS" }] }), /UNVERIFIED inventory/);
});

test("schema and execution reject unknown fields, empty changes, unknown IDs, duplicates, and nonprojected shipments", async () => {
  assert.equal(whatIfInputSchema.safeParse({}).success, false);
  assert.equal(whatIfInputSchema.safeParse({ arbitraryStatus: "RELEASED", qaEvidence: [{ inventoryId: "x", evidenceRef: "e" }] }).success, false);
  assert.equal(whatIfInputSchema.safeParse({ qaEvidence: [{ inventoryId: "x", evidenceRef: "e", quantityEa: 20 }] }).success, false);
  assert.equal(whatIfInputSchema.safeParse({ shipmentEta: [{ shipmentId: "x", eta: "2025-05-02T14:00:00Z" }, { shipmentId: "x", eta: "2025-05-02T15:00:00Z" }] }).success, false);
  assert.equal(whatIfInputSchema.safeParse({ shipmentEta: [{ shipmentId: "x", eta: "2025-05-02T14:00:00+02:00" }] }).success, false);

  const snapshot = await seedSnapshot();
  assert.throws(() => runWhatIf(snapshot, { shipmentEta: [{ shipmentId: "UNKNOWN", eta: "2025-05-02T14:00:00Z" }] }), /Unknown shipment identifier/);
  const received = structuredClone(snapshot);
  received.shipments[0]!.status = "RECEIVED";
  assert.throws(() => runWhatIf(received, { shipmentEta: [{ shipmentId: received.shipments[0]!.id, eta: "2025-05-02T14:00:00Z" }] }), /projected, unreceived shipment/);
  assert.throws(() => runWhatIf(snapshot, { qaEvidence: [{ inventoryId: "UNKNOWN", evidenceRef: "e" }] }), /Unknown inventory identifier/);
});

test("hypotheses are limited to ten total changes", async () => {
  const snapshot = await seedSnapshot();
  const changes = Array.from({ length: 11 }, (_, index) => ({ shipmentId: `S-${index}`, eta: "2025-05-02T14:00:00Z" }));
  assert.equal(whatIfInputSchema.safeParse({ shipmentEta: changes }).success, false);
  assert.throws(() => runWhatIf(snapshot, { shipmentEta: changes }), /At most 10 total hypothesis changes/);
});
