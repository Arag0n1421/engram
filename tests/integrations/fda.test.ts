import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadSeed } from "../../src/runtime/seed.ts";
import { applyReviewedFdaScope, reviewFdaRecord, type ReviewedFdaScope } from "../../src/integrations/fda.ts";

const root = process.cwd();
const reviewed = JSON.parse(await readFile(resolve(root, "data/fda/reviewed_scope.json"), "utf8")) as ReviewedFdaScope;
const source = JSON.parse(await readFile(resolve(root, "data/fda/source.json"), "utf8")) as { sourceURL: string; retrievedAt: string; rawsha256: string; rawJSON: string };
const rawFile = await readFile(resolve(root, "data/fda/raw-openfda-device-recall-213286.json"), "utf8");
const rawSha256 = createHash("sha256").update(source.rawJSON, "utf8").digest("hex");
const sourceEvidence = { sourceURL: source.sourceURL, retrievedAt: source.retrievedAt, rawsha256: source.rawsha256, rawJSON: source.rawJSON };
const alteredSource = (overrides: Record<string, unknown>) => {
  const payload = JSON.parse(source.rawJSON) as { results: Record<string, unknown>[] };
  payload.results[0] = { ...payload.results[0]!, ...overrides };
  const rawJSON = JSON.stringify(payload);
  return { ...sourceEvidence, rawJSON, rawsha256: createHash("sha256").update(rawJSON, "utf8").digest("hex") };
};

test("reviews the current raw FDA response and all 32 exact lot tokens", () => {
  assert.equal(rawSha256, source.rawsha256);
  assert.equal(sourceEvidence.rawJSON, rawFile);
  const result = reviewFdaRecord(sourceEvidence, reviewed);
  assert.equal(result.status, "reviewed");
  if (result.status !== "reviewed") return;
  assert.equal(result.scope.affectedLots.length, 32);
  assert.deepEqual(result.scope.affectedLots, reviewed.affectedLots);
  assert.equal(result.scope.complete, true);
});

test("rejects a declared hash that does not match exact raw JSON bytes", () => {
  assert.equal(reviewFdaRecord({ ...sourceEvidence, rawsha256: "b".repeat(64) }, reviewed).status, "abstained");
});

test("abstains for a near-match or a missing lot token", () => {
  const codeInfo = JSON.parse(source.rawJSON).results[0].code_info as string;
  const nearMatch = codeInfo.replace(reviewed.affectedLots[0]!, "23DJA039");
  assert.equal(reviewFdaRecord(alteredSource({ code_info: nearMatch }), reviewed).status, "abstained");
  assert.equal(reviewFdaRecord(alteredSource({ code_info: reviewed.affectedLots.slice(1).join(", ") }), reviewed).status, "abstained");
});

test("abstains for unknown, mixed, or wrong product descriptions", () => {
  for (const product of ["RDI30296 Normal Saline", "RDI30295 Sterile Water, 100 mL Bottle", "Unknown Normal Saline, 100 mL Bottle"]) {
    assert.equal(reviewFdaRecord(alteredSource({ product_description: product }), reviewed).status, "abstained");
  }
});

test("abstains for ranges, truncation, and negation even when all same lot tokens remain", () => {
  const codeInfo = JSON.parse(source.rawJSON).results[0].code_info as string;
  for (const ending of ["23DJA038 through 23DJA070", "all remaining lots", "23DJA038...", `except these lots: ${reviewed.affectedLots[0]}`, `not affected: ${reviewed.affectedLots[1]}`, `and others ${reviewed.affectedLots[2]}`]) {
    assert.equal(reviewFdaRecord(alteredSource({ code_info: `${codeInfo}; ${ending}` }), reviewed).status, "abstained");
  }
});

test("numeric mixed UDIs never supply lot tokens", () => {
  const result = reviewFdaRecord(alteredSource({ code_info: `UDI ${reviewed.eachUdi} EA and ${reviewed.caseUdi} CS` }), reviewed);
  assert.equal(result.status, "abstained");
});

test("abstention makes an applied snapshot scope incomplete", async () => {
  const snapshot = (await loadSeed(root)).snapshot;
  snapshot.scope = { recallId: "old", manufacturerRef: "old", affectedLots: ["OLDLOT001"], complete: true, reviewLots: [], version: 1, evidenceRefs: ["old"] };
  const next = applyReviewedFdaScope(snapshot, { status: "abstained", reasons: ["missing source"] });
  assert.equal(next.scope.complete, false);
  assert.deepEqual(next.scope.affectedLots, []);
  assert.deepEqual(snapshot.scope.affectedLots, ["OLDLOT001"]);
});

test("successful scope application preserves explicit source conflict and evidence refs", async () => {
  const snapshot = (await loadSeed(root)).snapshot;
  snapshot.scope = { recallId: "old", manufacturerRef: "old", affectedLots: ["OLDLOT001"], complete: true, reviewLots: ["23IJA103"], version: 1, evidenceRefs: ["MFG-LOT-SCOPE"] };
  const review = reviewFdaRecord(sourceEvidence, reviewed);
  assert.equal(review.status, "reviewed");
  const next = applyReviewedFdaScope(snapshot, review);
  assert.deepEqual(next.scope.reviewLots, ["23IJA103"]);
  assert.ok(next.scope.evidenceRefs.includes("MFG-LOT-SCOPE"));
  assert.ok(next.scope.evidenceRefs.includes("FDA-CODE-INFO-EXACT-SPAN"));
  assert.ok(next.scope.evidenceRefs.some(ref => ref.startsWith("FDA-RAW-SHA256:")));
});
