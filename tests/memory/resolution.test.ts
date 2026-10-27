import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessSnapshot, planReplenishment } from "../../src/domain/index.ts";
import type { Snapshot } from "../../src/domain/types.ts";
import { RecallOpsMemory, resolutionSourceHash, type RecordResolutionInput } from "../../src/memory/index.ts";

const DEMO_RESOLUTION={recallId:"Z-1706-2025",manufacturerRef:"RDI30296",observedLot:"23IJA103",canonicalLot:"23JJA103"};
const HASH_AFFECTED = ["23JJA103", "23DJA038"];
const SOURCE_REFS = ["FDA-PRODUCT-LOT-SCOPE", "MFG-LOT-SCOPE", "DISTRIBUTOR-COVER-PAGE-1"];
const CONTEXT = {
  recallId: DEMO_RESOLUTION.recallId,
  manufacturerRef: DEMO_RESOLUTION.manufacturerRef,
  affectedLots: HASH_AFFECTED,
  observedLot: DEMO_RESOLUTION.observedLot,
  canonicalLot: DEMO_RESOLUTION.canonicalLot,
  sourceRefs: SOURCE_REFS,
};
const HASH = resolutionSourceHash(CONTEXT);
const NOW = Date.parse("2026-10-23T10:00:00.000Z");

function input(overrides: Partial<RecordResolutionInput> = {}): RecordResolutionInput {
  return {
    resolutionId: "human-review-001", operator: "Ahmed Rahimi", recallId: CONTEXT.recallId,
    manufacturerRef: CONTEXT.manufacturerRef, sourceHash: HASH,
    observedLot: CONTEXT.observedLot, canonicalLot: CONTEXT.canonicalLot,
    reason: "Compared the FDA lot list with the manufacturer attachment; the distributor cover contains the inconsistent character.",
    sourceRefs: SOURCE_REFS, effectiveAt: "2026-10-23T09:00:00.000Z", expiresAt: "2026-10-24T09:00:00.000Z",
    sourceContext: CONTEXT, ...overrides,
  };
}

function snapshot(): Snapshot {
  const common = (id: string, siteId: string, lot: string | null, quantityEa: number, qaStatus: "RELEASED" | "UNVERIFIED") => ({
    id, siteId, internalSku: "SALINE", manufacturerRef: "RDI30296", lot, unit: "EA", packagingLevel: "EACH",
    quantityEa, reservedEa: 0, allocationHold: false, expiresAt: "2027-01-01", qaStatus,
    qaEvidenceRef: `QA-${id}`, expiryEvidenceRef: `EXP-${id}`, version: 1, evidenceRefs: [`STOCK-${id}`],
  });
  return {
    dataMode: "fixture", targetSku: "SALINE", recipientSiteId: "A",
    clock: { analysisAt: "2026-10-23T09:00:00Z", dispatchAt: "2026-10-23T10:00:00Z", cutoff: "2026-10-23T16:00:00Z" },
    sourceVersions: { inventory: 1, demand: 1, routes: 1, shipments: 1, recall: 1, catalog: 1 },
    scope: { recallId: CONTEXT.recallId, manufacturerRef: "RDI30296", affectedLots: ["23JJA103"], complete: true, reviewLots: ["23IJA103"], version: 1, evidenceRefs: SOURCE_REFS.slice(0, 2) },
    catalog: [{ internalSku: "SALINE", manufacturerRef: "RDI30296", unit: "EA", approvedForDemo: true, evidenceRefs: ["CATALOG-APPROVAL"] }],
    inventory: [
      common("A-AMBIGUOUS", "A", "23IJA103", 120, "UNVERIFIED"),
      common("B-GOOD", "B", "23JJA103", 80, "RELEASED"),
      common("C-GOOD", "C", "23DJA038", 100, "RELEASED"),
    ],
    demands: [
      { id: "D-A", siteId: "A", internalSku: "SALINE", demandEa: 80, requiredReserveEa: 10, version: 1 },
      { id: "D-B", siteId: "B", internalSku: "SALINE", demandEa: 50, requiredReserveEa: 20, version: 1 },
      { id: "D-C", siteId: "C", internalSku: "SALINE", demandEa: 50, requiredReserveEa: 20, version: 1 },
    ],
    routes: [
      { id: "B-A", originSiteId: "B", destinationSiteId: "A", leadTimeMinutes: 60, costPointsPerEa: 1, capacityEa: 120, version: 1 },
      { id: "C-A", originSiteId: "C", destinationSiteId: "A", leadTimeMinutes: 120, costPointsPerEa: 3, capacityEa: 100, version: 1 },
    ],
    shipments: [],
  };
}

function queryInput() {
  return {
    recallId: CONTEXT.recallId, manufacturerRef: CONTEXT.manufacturerRef, sourceHash: HASH,
    observedLot: CONTEXT.observedLot, canonicalLot: CONTEXT.canonicalLot, sourceRefs: SOURCE_REFS,
  };
}

test("manual resolution persists across H-MEM sessions and changes only the next question", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-resolution-"));
  try {
    const fixedClock = () => NOW;
    const first = new RecallOpsMemory({ persistDir: dir, clock: fixedClock });
    const unresolved = first.queryResolutions(queryInput());
    assert.equal(unresolved.decisions.length, 0);
    assert.match(unresolved.nextInvestigationQuestion, /Can an operator resolve/);
    const receipt = first.recordResolution(input());
    assert.equal(receipt.created, true);
    assert.equal(receipt.provenance, "manual");
    const second = new RecallOpsMemory({ persistDir: dir, clock: fixedClock });
    const retrieved = second.queryResolutions(queryInput());
    assert.equal(retrieved.decisions.length, 1);
    assert.equal(retrieved.decisions[0]?.status, "applied");
    assert.match(retrieved.nextInvestigationQuestion, /physical stock label/);
    assert.ok(!retrieved.nextInvestigationQuestion.includes("resolve the documented 23IJA103"));
    assert.equal(retrieved.neverAuthority, true);
    assert.equal(retrieved.cannotChangeInventoryOrAuthorizeActions, true);

    const liveBefore = snapshot(); const beforeAssessment = assessSnapshot(liveBefore); const beforePlan = planReplenishment(liveBefore);
    const ambiguousBefore = structuredClone(liveBefore.inventory[0]);
    const after = snapshot(); const afterAssessment = assessSnapshot(after); const afterPlan = planReplenishment(after);
    assert.equal(beforeAssessment.totalEligibleEa, afterAssessment.totalEligibleEa);
    assert.equal(beforeAssessment.totalAffectedEa, afterAssessment.totalAffectedEa);
    assert.deepEqual(beforePlan, afterPlan);
    assert.deepEqual(after.inventory[0], ambiguousBefore, "the uncertain stock row and missing QA remain untouched");
    assert.equal(afterAssessment.inventory.find((row) => row.entityId === "A-AMBIGUOUS")?.eligibleEa, 0);
    assert.equal(after.scope.reviewLots.includes("23IJA103"), true, "fresh recall approval still preserves the source conflict");
    const history = second.audit(receipt.memoryId);
    assert.ok(history.some((entry) => entry.action === "create"));
    assert.ok(history.some((entry) => entry.action === "read"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("source changes, product mismatch, expiry, revocation and source-scoped identifiers are checked without hardcoded identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-resolution-reject-"));
  try {
    let now = NOW;
    const memory = new RecallOpsMemory({ persistDir: dir, clock: () => now });
    memory.recordResolution(input({
      resolutionId: "wrong-product", manufacturerRef: "OTHER-REF",
      sourceContext: { ...CONTEXT, manufacturerRef: "OTHER-REF" },
      sourceHash: resolutionSourceHash({ ...CONTEXT, manufacturerRef: "OTHER-REF" }),
    }));
    const product = memory.queryResolutions(queryInput()).decisions.find((row) => row.resolutionId === "wrong-product");
    assert.equal(product?.status, "rejected");
    assert.ok(product?.reasonCodes.includes("WRONG_PRODUCT"));

    memory.recordResolution(input({ resolutionId: "old-source", sourceContext: { ...CONTEXT, affectedLots: [...CONTEXT.affectedLots, "24AJA025"] }, sourceHash: resolutionSourceHash({ ...CONTEXT, affectedLots: [...CONTEXT.affectedLots, "24AJA025"] }) }));
    const oldSource = memory.queryResolutions(queryInput()).decisions.find((row) => row.resolutionId === "old-source");
    assert.ok(oldSource?.reasonCodes.includes("SOURCE_CONTEXT_MISMATCH"));

    memory.recordResolution(input({ resolutionId: "expired", expiresAt: "2026-10-23T09:59:59.000Z" }));
    const expired = memory.queryResolutions(queryInput()).decisions.find((row) => row.resolutionId === "expired");
    assert.ok(expired?.reasonCodes.includes("EXPIRED"));

    const revoke = memory.recordResolution(input({ resolutionId: "revoked" }));
    memory.revokeResolution(revoke.memoryId, "Operator withdrew the note after reviewing a newer source revision.");
    const revoked = memory.queryResolutions(queryInput()).decisions.find((row) => row.resolutionId === "revoked");
    assert.ok(revoked?.reasonCodes.includes("REVOKED"));
    assert.ok(memory.audit(revoke.memoryId).some((entry) => entry.action === "update"));

    memory.recordResolution(input({
      resolutionId: "different-source-canonical", canonicalLot: "23DJA038",
      sourceContext: { ...CONTEXT, canonicalLot: "23DJA038" },
      sourceHash: resolutionSourceHash({ ...CONTEXT, canonicalLot: "23DJA038" }),
    }));
    const changedCanonical=memory.queryResolutions(queryInput()).decisions.find(row=>row.resolutionId==="different-source-canonical");
    assert.equal(changedCanonical?.status,"rejected");
    assert.ok(changedCanonical?.reasonCodes.includes("CONFLICT_MISMATCH"));
    assert.throws(() => memory.recordResolution(input({resolutionId: "unsupported-observed", observedLot: "23DJA038", sourceContext: {...CONTEXT, observedLot: "23DJA038"}, sourceHash: resolutionSourceHash({...CONTEXT, observedLot: "23DJA038"})})), /observed conflict/);
    const corrupted = memory.recordResolution(input({resolutionId: "corrupted-time"}));
    const file=join(dir,"state.json");const persisted=JSON.parse(readFileSync(file,"utf8"));
    const row=persisted.records.find((record: {id:string})=>record.id===corrupted.memoryId);
    const metadata=JSON.parse(row.provenance.label);metadata.expiresAt="not-a-date";row.provenance.label=JSON.stringify(metadata);writeFileSync(file,JSON.stringify(persisted));
    const rejected=new RecallOpsMemory({persistDir:dir,clock:()=>now}).queryResolutions(queryInput()).decisions.find(decision=>decision.resolutionId==="corrupted-time");
    assert.equal(rejected?.status,"rejected");assert.ok(rejected?.reasonCodes.includes("INVALID_TIME_SCOPE"));
    now += 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("analysis memories cannot be interpreted as human resolutions", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-resolution-analysis-"));
  try {
    const memory = new RecallOpsMemory({ persistDir: dir, clock: () => NOW });
    memory.recordAnalysis({ analysisId: "analysis-1", recallId: CONTEXT.recallId, snapshotHash: "a".repeat(64), summary: "A model proposes that the lot discrepancy may be a typo.", sourceRefs: SOURCE_REFS });
    const result = memory.queryResolutions(queryInput());
    assert.equal(result.decisions.length, 0);
    assert.match(result.nextInvestigationQuestion, /Can an operator resolve/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("operator resolution uses source-bound identities from a different recall without fixture constants",()=>{const dir=mkdtempSync(join(tmpdir(),"engram-generic-resolution-"));try{const memory=new RecallOpsMemory({persistDir:dir,clock:()=>NOW});const context={recallId:"SYNTH-RECALL-OTHER",manufacturerRef:"SYNTH-OTHER",affectedLots:["25ABC777"],observedLot:"25ABC778",canonicalLot:"25ABC777",sourceRefs:["OTHER-NOTICE-1","OTHER-NOTICE-2"]};const sourceHash=resolutionSourceHash(context);memory.recordResolution({resolutionId:"other-resolution",operator:"Test operator",...context,sourceHash,sourceContext:context,reason:"Compared the two independently recorded fictional source documents.",effectiveAt:"2026-10-23T09:00:00.000Z",expiresAt:"2026-10-24T09:00:00.000Z"});const result=memory.queryResolutions({...context,sourceHash});assert.equal(result.decisions[0]?.status,"applied");assert.equal(result.cannotChangeInventoryOrAuthorizeActions,true);}finally{rmSync(dir,{recursive:true,force:true});}});
