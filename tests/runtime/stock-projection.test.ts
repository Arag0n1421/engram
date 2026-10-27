import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { assessSnapshot } from "../../src/domain/index.ts";
import type { Snapshot } from "../../src/domain/types.ts";
import { applyScenario, loadSeed } from "../../src/runtime/seed.ts";
import { projectStockEvidence } from "../../src/runtime/stock-projection.ts";

const repoRoot = resolve(process.cwd());
const sort = (values: string[]) => [...new Set(values)].sort();

async function scenarioSnapshot(scenario: "on_time" | "supplier_late" | "qa_missing"): Promise<Snapshot> {
  const { snapshot } = await loadSeed(repoRoot);
  return applyScenario(snapshot, scenario);
}

test("site projections preserve global totals and exact selected row evidence across scenarios", async () => {
  for (const scenario of ["on_time", "supplier_late", "qa_missing"] as const) {
    const snapshot = await scenarioSnapshot(scenario);
    const before = JSON.stringify(snapshot);
    const assessment = assessSnapshot(snapshot);
    assert.equal(assessment.totalAffectedEa, 120);
    assert.equal(assessment.totalEligibleEa, scenario === "qa_missing" ? 200 : 240);
    assert.equal(assessment.totalReviewOrExcludedEa, scenario === "qa_missing" ? 50 : 10);

    for (const siteId of ["A", "B", "C"] as const) {
      const projection = projectStockEvidence(snapshot, assessment, siteId);
      assert.equal(projection.dataMode, "fixture");
      assert.equal(projection.investigation.snapshotAsOf, snapshot.clock.analysisAt);
      assert.equal(projection.investigation.freshSourceRead, false);
      assert.equal(projection.inputFingerprint, assessment.inputFingerprint);
      assert.deepEqual(projection.sourceVersions, snapshot.sourceVersions);
      assert.equal(projection.scope.affectedLotCount, snapshot.scope.affectedLots.length);
      assert.equal(projection.scope.reviewLotCount, snapshot.scope.reviewLots.length);
      assert.equal(projection.scope.version, snapshot.scope.version);
      assert.deepEqual(projection.totals, {
        valid: assessment.valid,
        totalEligibleEa: assessment.totalEligibleEa,
        totalAffectedEa: assessment.totalAffectedEa,
        totalReviewOrExcludedEa: assessment.totalReviewOrExcludedEa,
        reasonCodes: sort(assessment.reasons.map((reason) => reason.code)),
      });
      assert.deepEqual(projection.inventory.map((row) => row.id), snapshot.inventory.filter((row) => row.siteId === siteId).map((row) => row.id));
      assert.deepEqual(projection.shipments.map((row) => row.id), snapshot.shipments.filter((row) => row.destinationSiteId === siteId).map((row) => row.id));

      for (const row of projection.inventory) {
        const source = snapshot.inventory.find((candidate) => candidate.id === row.id)!;
        const evaluation = assessment.inventory.find((candidate) => candidate.entityId === row.id)!;
        assert.equal(row.eligibleEa, evaluation.eligibleEa);
        assert.equal(row.eligibility, evaluation.status);
        assert.equal(row.recallMatch, evaluation.recallMatch.status);
        const reasons = [...evaluation.recallMatch.reasons, ...evaluation.reasons];
        assert.deepEqual(row.reasons, [...new Map(reasons.map((reason) => [`${reason.code}\u0000${reason.message}`, {code: reason.code, message: reason.message}])).values()]);
        assert.deepEqual(row.citationRefs, sort([...source.evidenceRefs, ...evaluation.recallMatch.evidenceRefs, ...evaluation.evidenceRefs, ...reasons.flatMap((reason) => reason.evidenceRefs)]));
      }
      for (const row of projection.shipments) {
        const source = snapshot.shipments.find((candidate) => candidate.id === row.id)!;
        const evaluation = assessment.shipments.find((candidate) => candidate.entityId === row.id)!;
        assert.equal(row.eligibleEa, evaluation.eligibleEa);
        assert.equal(row.eligibility, evaluation.status);
        assert.equal(row.recallMatch, evaluation.recallMatch.status);
        assert.equal(row.conditionalOnReceiptAndAcceptance, source.conditionalOnReceiptAndAcceptance);
        const reasons = [...evaluation.recallMatch.reasons, ...evaluation.reasons];
        assert.deepEqual(row.reasons, [...new Map(reasons.map((reason) => [`${reason.code}\u0000${reason.message}`, {code: reason.code, message: reason.message}])).values()]);
        assert.deepEqual(row.citationRefs, sort([...source.evidenceRefs, ...evaluation.recallMatch.evidenceRefs, ...evaluation.evidenceRefs, ...reasons.flatMap((reason) => reason.evidenceRefs)]));
      }
    }
    const all = projectStockEvidence(snapshot, assessment);
    assert.equal(all.inventory.length, snapshot.inventory.length);
    assert.equal(all.shipments.length, snapshot.shipments.length);
    assert.equal(JSON.stringify(snapshot), before, "projection must not mutate the immutable investigation snapshot");
  }
});

test("supplier scenarios retain conditional shipment gates and B QA exclusion", async () => {
  for (const scenario of ["on_time", "supplier_late", "qa_missing"] as const) {
    const snapshot = await scenarioSnapshot(scenario);
    const assessment = assessSnapshot(snapshot);
    const projection = projectStockEvidence(snapshot, assessment, "A");
    assert.equal(projection.shipments.length, snapshot.shipments.filter((row) => row.destinationSiteId === "A").length);
    for (const shipment of projection.shipments) {
      assert.equal(shipment.conditionalOnReceiptAndAcceptance, true);
      assert.equal(shipment.eligibleEa, assessment.shipments.find((row) => row.entityId === shipment.id)!.eligibleEa);
    }
    const bProjection = projectStockEvidence(snapshot, assessment, "B");
    const faultable = bProjection.inventory.find((row) => row.id === "DEMO-INV-B-FAULTABLE")!;
    if (scenario === "qa_missing") {
      assert.equal(faultable.eligibleEa, 0);
      assert.ok(faultable.reasons.some((reason) => reason.code === "QA_NOT_RELEASED"));
      assert.ok(faultable.citationRefs.includes("DEMO-QA-B-002-REVOKED"));
    }
  }
});

test("serialized site evidence is materially smaller than the former global assessment payload", async () => {
  let oldBytes = 0;
  let projectedBytes = 0;
  const snapshot = await scenarioSnapshot("on_time");
  const assessment = assessSnapshot(snapshot);
  for (const siteId of ["A", "B", "C"] as const) {
    const oldOutput = {
      dataMode: snapshot.dataMode,
      clock: snapshot.clock,
      inputFingerprint: assessment.inputFingerprint,
      sourceVersions: snapshot.sourceVersions,
      inventory: snapshot.inventory.filter((row) => row.siteId === siteId),
      shipments: snapshot.shipments,
      assessment,
    };
    oldBytes += Buffer.byteLength(JSON.stringify(oldOutput));
    projectedBytes += Buffer.byteLength(JSON.stringify(projectStockEvidence(snapshot, assessment, siteId)));
  }
  assert.ok(projectedBytes < oldBytes * 0.65, `expected >=35% reduction; old=${oldBytes}B new=${projectedBytes}B`);
});
