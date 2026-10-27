import assert from "node:assert/strict";
import test from "node:test";
import { assessSnapshot, planReplenishment } from "../../src/domain/index.ts";
import { checkClaims, claimCitationGuide, claimResponseJsonSchema, claimResponseWireJsonSchema, encodeClaimWire } from "../../src/domain/claims.ts";
import type { InventoryLot, Snapshot } from "../../src/domain/types.ts";

function stock(id: string, siteId: string, quantityEa: number, changes: Partial<InventoryLot> = {}): InventoryLot {
  return {
    id, siteId, internalSku: "DEMO-SKU", manufacturerRef: "MFG-1", lot: `LOT-${id}`,
    unit: "EA", packagingLevel: "EACH", quantityEa, reservedEa: 0, allocationHold: false,
    expiresAt: "2027-01-01", qaStatus: "RELEASED", qaEvidenceRef: `QA-${id}`,
    expiryEvidenceRef: `EXP-${id}`, version: 1, evidenceRefs: [`STOCK-${id}`], ...changes,
  };
}

function fixture(): Snapshot {
  return {
    dataMode: "fixture", targetSku: "DEMO-SKU", recipientSiteId: "A",
    clock: { analysisAt: "2026-01-01T10:00:00Z", dispatchAt: "2026-01-01T11:00:00Z", cutoff: "2026-01-01T16:00:00Z" },
    sourceVersions: { inventory: 1, demand: 1, routes: 1, shipments: 1, recall: 1, catalog: 1 },
    scope: { recallId: "R-1", manufacturerRef: "MFG-1", affectedLots: ["AFFECTED"], complete: true, reviewLots: [], version: 1, evidenceRefs: ["RECALL-SCOPE"] },
    catalog: [{ internalSku: "DEMO-SKU", manufacturerRef: "MFG-1", unit: "EA", approvedForDemo: true, evidenceRefs: ["CATALOG-APPROVAL"] }],
    inventory: [
      stock("A-GOOD", "A", 20), stock("A-RECALLED", "A", 120, { lot: "AFFECTED" }),
      stock("B-BASE", "B", 80), stock("B-EXTRA", "B", 40), stock("C-BASE", "C", 100),
    ],
    demands: [
      { id: "D-A", siteId: "A", internalSku: "DEMO-SKU", demandEa: 80, requiredReserveEa: 10, version: 1 },
      { id: "D-B", siteId: "B", internalSku: "DEMO-SKU", demandEa: 50, requiredReserveEa: 20, version: 1 },
      { id: "D-C", siteId: "C", internalSku: "DEMO-SKU", demandEa: 50, requiredReserveEa: 20, version: 1 },
    ],
    routes: [
      { id: "R-B-A", originSiteId: "B", destinationSiteId: "A", leadTimeMinutes: 60, costPointsPerEa: 1, capacityEa: 120, version: 1 },
      { id: "R-C-A", originSiteId: "C", destinationSiteId: "A", leadTimeMinutes: 120, costPointsPerEa: 3, capacityEa: 100, version: 1 },
    ],
    shipments: [{
      id: "SUP-1", destinationSiteId: "A", internalSku: "DEMO-SKU", manufacturerRef: "MFG-1", lot: "SUP-LOT",
      unit: "EA", packagingLevel: "EACH", quantityEa: 40, eta: "2026-01-01T14:00:00Z",
      status: "PROJECTED_INBOUND_NOT_RECEIVED", conditionalOnReceiptAndAcceptance: true,
      expiresAt: "2027-01-01", qaStatus: "PROJECTED_RELEASE", qaEvidenceRef: "QA-SUP-1", expiryEvidenceRef: "EXP-SUP-1",
      version: 1, evidenceRefs: ["SHIPMENT-SUP-1"],
    }],
  };
}

function goodResponse(snapshot: Snapshot) {
  const assessment = assessSnapshot(snapshot);
  const plan = planReplenishment(snapshot);
  const guide = claimCitationGuide(snapshot, plan);
  return {
    snapshotHash: guide.snapshotHash,
    planFingerprint: guide.planFingerprint,
    claims: {
      inventory: { affectedEa: assessment.totalAffectedEa, eligibleEa: assessment.totalEligibleEa, citations: guide.inventory },
      plan: {
        status: plan.status, cutoff: snapshot.clock.cutoff, totalRequiredEa: plan.totalRequiredEa, projectedInboundEa: plan.projectedInboundEa,
        projectedInbound: assessment.shipments.filter((row) => row.status === "CONDITIONAL_PROJECTED").map((row) => {
          const shipment = snapshot.shipments.find((item) => item.id === row.entityId)!;
          return { shipmentId: shipment.id, quantityEa: row.eligibleEa, eta: shipment.eta, conditionalOnReceiptAndAcceptance: true as const };
        }),
        shortfallEa: plan.status === "feasible" ? null : plan.shortfallEa, citations: guide.plan,
      },
      transfers: plan.status === "feasible" ? plan.transfers.map((row) => ({
        lineId: row.lineId, routeId: row.routeId, originSiteId: row.originSiteId, destinationSiteId: row.destinationSiteId,
        quantityEa: row.quantityEa, arriveAt: row.arriveAt, arrivesByCutoff: true as const, stockAllocations: row.stockAllocations,
        citations: guide.transfers.find((entry) => entry.lineId === row.lineId)!.citations,
      })) : [],
    },
  };
}

test("typed claim response schema is constrained and correct checked fields produce display descriptions", () => {
  const snapshot = fixture();
  const result = checkClaims(goodResponse(snapshot), snapshot, planReplenishment(snapshot));
  assert.equal(result.valid, true);
  assert.deepEqual(result.feedbackCodes, []);
  assert.equal(result.checked?.affectedEa, 120);
  assert.equal(result.checked?.eligibleEa, 240);
  assert.equal(result.checked?.transfers[0]?.quantityEa, 30);
  assert.match(result.checked?.descriptions.join(" ") ?? "", /B to A: 30 EA/);
  assert.equal(claimResponseJsonSchema.type, "object");
});

test("checker rejects missing or invented citations and an incorrect eligible total", () => {
  const snapshot = fixture();
  const base = goodResponse(snapshot);
  const missing = structuredClone(base); missing.claims.inventory.citations = [];
  assert.ok(checkClaims(missing, snapshot, planReplenishment(snapshot)).feedbackCodes.includes("MISSING_CITATIONS"));
  const unknown = structuredClone(base); unknown.claims.plan.citations = ["not-a-source-ref"];
  assert.ok(checkClaims(unknown, snapshot, planReplenishment(snapshot)).feedbackCodes.includes("UNKNOWN_CITATION"));
  const irrelevant = structuredClone(base); irrelevant.claims.inventory.citations.push("SUP-1");
  assert.ok(checkClaims(irrelevant, snapshot, planReplenishment(snapshot)).feedbackCodes.includes("IRRELEVANT_CITATION"));
  const wrongTotal = structuredClone(base); wrongTotal.claims.inventory.eligibleEa = 120;
  assert.ok(checkClaims(wrongTotal, snapshot, planReplenishment(snapshot)).feedbackCodes.includes("CLAIM_MISMATCH"));
});

test("checker rejects stale snapshot binding, stale plans, and tampered transfer or timing facts", () => {
  const snapshot = fixture();
  const response = goodResponse(snapshot);
  const staleClaim = structuredClone(response); staleClaim.snapshotHash = "old-snapshot";
  assert.ok(checkClaims(staleClaim, snapshot, planReplenishment(snapshot)).feedbackCodes.includes("STALE_SNAPSHOT"));

  const staleSnapshot = structuredClone(snapshot); staleSnapshot.inventory[0]!.reservedEa = 1;
  assert.ok(checkClaims(response, staleSnapshot, planReplenishment(staleSnapshot)).feedbackCodes.includes("STALE_SNAPSHOT"));

  const plan = planReplenishment(snapshot);
  assert.equal(plan.status, "feasible");
  if (plan.status !== "feasible") return;
  const tampered = structuredClone(plan); tampered.transfers[0]!.arriveAt = "2026-01-01T11:01:00Z";
  assert.ok(checkClaims(response, snapshot, tampered).feedbackCodes.includes("STALE_PLAN"));
  const badTransfer = structuredClone(response); badTransfer.claims.transfers[0]!.quantityEa++;
  assert.ok(checkClaims(badTransfer, snapshot, plan).feedbackCodes.includes("CLAIM_MISMATCH"));
});

test("raw model text is parsed only as JSON, with an optional complete JSON fence", () => {
  const snapshot = fixture(); const plan = planReplenishment(snapshot); const response = goodResponse(snapshot);
  assert.equal(checkClaims(`\`\`\`json\n${JSON.stringify(response)}\n\`\`\``, snapshot, plan).valid, true);
  assert.deepEqual(checkClaims("The plan is feasible and has 240 eligible bottles.", snapshot, plan).feedbackCodes, ["MALFORMED_RESPONSE"]);
});

test("infeasible claims must report the checked shortfall and contain no transfer lines", () => {
  const snapshot = fixture();
  snapshot.shipments[0]!.eta = "2026-01-01T18:00:00Z";
  snapshot.inventory.find((row) => row.id === "B-EXTRA")!.qaStatus = "UNVERIFIED";
  const plan = planReplenishment(snapshot);
  assert.equal(plan.status, "infeasible");
  const response = goodResponse(snapshot);
  assert.equal(checkClaims(response, snapshot, plan).valid, true);
  const wrong = structuredClone(response); wrong.claims.plan.shortfallEa = 0;
  assert.ok(checkClaims(wrong, snapshot, plan).feedbackCodes.includes("CLAIM_MISMATCH"));
  const fabricated = structuredClone(response);
  fabricated.claims.transfers.push({
    lineId: "made-up", routeId: "R-B-A", originSiteId: "B", destinationSiteId: "A", quantityEa: 1,
    arriveAt: snapshot.clock.cutoff, arrivesByCutoff: true,
    stockAllocations: [{ inventoryId: "B-BASE", quantityEa: 1 }], citations: ["R-B-A", "B-BASE", "STOCK-B-BASE", "QA-B-BASE", "EXP-B-BASE"],
  });
  assert.ok(checkClaims(fabricated, snapshot, plan).feedbackCodes.includes("CLAIM_MISMATCH"));
});

test("compact citation wire round-trips full claims without changing the canonical schema", () => {
  const snapshot = fixture();
  const plan = planReplenishment(snapshot);
  const response = goodResponse(snapshot);
  const original = structuredClone(response);
  const encoded = encodeClaimWire(response);
  assert.equal(checkClaims(encoded, snapshot, plan).valid, true);
  assert.deepEqual(response, original);
  assert.ok(encoded.claims.inventory.citations.split(" ").length > 16);
  assert.ok(encoded.claims.plan.citations.split(" ").length > 16);
  const canonical = claimResponseJsonSchema as unknown as {properties: {claims: {properties: {inventory: {properties: {citations: {type: string}}}}}}};
  assert.equal(canonical.properties.claims.properties.inventory.properties.citations.type, "array");
  const wireInventoryCitationSchema = claimResponseWireJsonSchema.properties.claims.properties.inventory.properties.citations as {type?: string};
  const wireTransferCitationSchema = claimResponseWireJsonSchema.properties.claims.properties.transfers.items.properties.citations as {maxLength?: number};
  assert.equal(wireInventoryCitationSchema.type, "string");
  assert.equal(wireTransferCitationSchema.maxLength, 16_384);
});

test("wire decoding normalizes only known citation slots and accepts legacy arrays", () => {
  const snapshot = fixture(); const plan = planReplenishment(snapshot); const response = goodResponse(snapshot);
  assert.equal(checkClaims(response, snapshot, plan).valid, true);
  const withUnknown = structuredClone(response) as typeof response & {claims: {inventory: {extra: string}}};
  withUnknown.claims.inventory.extra = "x";
  assert.ok(checkClaims(withUnknown, snapshot, plan).feedbackCodes.includes("MALFORMED_RESPONSE"));
  const wrongCase = structuredClone(encodeClaimWire(response));
  (wrongCase.claims.inventory as unknown as Record<string, unknown>).Citations = "unknown";
  assert.ok(checkClaims(wrongCase, snapshot, plan).feedbackCodes.includes("MALFORMED_RESPONSE"));
  const wrongType = encodeClaimWire(response);
  (wrongType.claims.plan as unknown as {citations: unknown}).citations = 17;
  assert.ok(checkClaims(wrongType, snapshot, plan).feedbackCodes.includes("MALFORMED_RESPONSE"));
});

test("compact wire rejects ambiguous whitespace and preserves duplicates for checker rejection", () => {
  const snapshot = fixture(); const plan = planReplenishment(snapshot); const response = goodResponse(snapshot);
  const encoded = encodeClaimWire(response);
  for (const bad of ["\t", "\n", "\r", "  ", ` ${encoded.claims.inventory.citations}`, `${encoded.claims.inventory.citations} `]) {
    const candidate = structuredClone(encoded); candidate.claims.inventory.citations = bad;
    assert.ok(checkClaims(candidate, snapshot, plan).feedbackCodes.includes("MALFORMED_RESPONSE"), JSON.stringify(bad));
  }
  const duplicate = structuredClone(encoded);
  const first = duplicate.claims.inventory.citations.split(" ")[0]!;
  duplicate.claims.inventory.citations += ` ${first}`;
  assert.ok(checkClaims(duplicate, snapshot, plan).feedbackCodes.includes("MISSING_CITATIONS"));
  const irrelevant = structuredClone(encoded);
  irrelevant.claims.inventory.citations += " SUP-1";
  assert.ok(checkClaims(irrelevant, snapshot, plan).feedbackCodes.includes("IRRELEVANT_CITATION"));
  const unknown = structuredClone(encoded);
  unknown.claims.inventory.citations += " absent-ref";
  assert.ok(checkClaims(unknown, snapshot, plan).feedbackCodes.includes("UNKNOWN_CITATION"));
  const wrongCase = structuredClone(encoded);
  const refs = wrongCase.claims.inventory.citations.split(" ");
  refs[0] = refs[0]!.toLowerCase();
  wrongCase.claims.inventory.citations = refs.join(" ");
  assert.ok(checkClaims(wrongCase, snapshot, plan).feedbackCodes.includes("UNKNOWN_CITATION"));
});

test("encoder refuses whitespace in canonical refs and empty wire strings remain empty arrays", () => {
  const snapshot = fixture(); const plan = planReplenishment(snapshot); const response = goodResponse(snapshot);
  const invalidRef = structuredClone(response); invalidRef.claims.inventory.citations[0] = "has space";
  assert.throws(() => encodeClaimWire(invalidRef), /whitespace/);
  const tooLong = structuredClone(response); tooLong.claims.inventory.citations = ["x".repeat(16_385)];
  assert.throws(() => encodeClaimWire(tooLong), /limit/);
  const empty = structuredClone(response);
  empty.claims.transfers = [];
  empty.claims.inventory.citations = [];
  const wire = encodeClaimWire(empty);
  assert.equal(wire.claims.inventory.citations, "");
  assert.deepEqual(wire.claims.transfers, []);
  assert.ok(checkClaims(wire, snapshot, plan).feedbackCodes.includes("MISSING_CITATIONS"));
  const overLimit = structuredClone(wire); overLimit.claims.inventory.citations = "x".repeat(16_385);
  assert.ok(checkClaims(overLimit, snapshot, plan).feedbackCodes.includes("MALFORMED_RESPONSE"));
});
