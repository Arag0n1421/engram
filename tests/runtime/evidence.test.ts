import assert from "node:assert/strict";
import test from "node:test";
import { claimCitationGuide } from "../../src/domain/claims.ts";
import { planReplenishment } from "../../src/domain/index.ts";
import { buildEvidenceRegistry, inspectEvidence, validateInvestigationReport } from "../../src/runtime/evidence.ts";
import { loadSeed } from "../../src/runtime/seed.ts";
import type { EvidenceDocument, InvestigationReportInput } from "../../src/shared/investigation.ts";

type NoticeSpan = { id: string; summary: string; locator?: string; quote?: string };
type NoticeSource = { id: string; observed_spans: NoticeSpan[] };
const fixture = await loadSeed(process.cwd());
const registry = buildEvidenceRegistry(fixture.snapshot, fixture.evidence);
const entry = (id: string) => {
  const result = inspectEvidence(registry, id);
  assert.ok("sourceHash" in result, `expected evidence entry for ${id}`);
  return result;
};

test("registry binds exact source text to hashes and resolves row evidence aliases", () => {
  const inventory = fixture.snapshot.inventory[0]!;
  const inventoryEntry = inspectEvidence(registry, inventory.evidenceRefs[0]!);
  assert.ok("sourceHash" in inventoryEntry);
  assert.equal(inventoryEntry.authority, "fictional-record");
  assert.match(inventoryEntry.content, /Fictional operational row capture/);
  const qaAlias = inspectEvidence(registry, inventory.qaEvidenceRef!);
  assert.ok("sourceHash" in qaAlias);
  assert.equal(qaAlias.id, inventory.id);
  assert.equal(qaAlias.sourceHash, inventoryEntry.sourceHash);
  assert.match(qaAlias.content, /metadata aliases on this normalized row only/);
  assert.match(qaAlias.content, /do not represent independently verified documents/);

  const catalog = fixture.snapshot.catalog.find(row => row.internalSku === fixture.snapshot.targetSku)!;
  const productReference = inspectEvidence(registry, fixture.snapshot.scope.manufacturerRef);
  assert.ok("sourceHash" in productReference);
  assert.equal(productReference.id, catalog.internalSku);
  assert.ok(productReference.content.includes(catalog.manufacturerRef));
  assert.equal(registry.snapshotHash, registry.entries[0]?.snapshotHash);
});

test("an exact QA document ID takes precedence over its row alias while other row aliases stay on the row", () => {
  const inventory = fixture.snapshot.inventory[0]!;
  const qaId = inventory.qaEvidenceRef!;
  const expiryId = inventory.expiryEvidenceRef!;
  const independentQa: EvidenceDocument = {
    id: qaId, title: "Supplied QA record", kind: "record", sourceURL: "urn:test:qa-record",
    version: 1, retrievedAt: fixture.snapshot.clock.analysisAt,
    content: "Fictional QA record body supplied separately for this test.", refs: [], authority: "fictional-record",
  };
  const withIndependentQa = buildEvidenceRegistry(fixture.snapshot, fixture.evidence, [independentQa]);
  const qaEntry = inspectEvidence(withIndependentQa, qaId);
  const inventoryEntry = inspectEvidence(withIndependentQa, inventory.id);
  const expiryEntry = inspectEvidence(withIndependentQa, expiryId);
  assert.ok("sourceHash" in qaEntry);
  assert.ok("sourceHash" in inventoryEntry);
  assert.ok("sourceHash" in expiryEntry);
  assert.equal(qaEntry.id, qaId);
  assert.equal(qaEntry.content, independentQa.content);
  assert.notEqual(qaEntry.sourceHash, inventoryEntry.sourceHash);
  assert.equal(expiryEntry.id, inventory.id);
  assert.equal(expiryEntry.sourceHash, inventoryEntry.sourceHash);
});

test("unknown references stay explicitly unknown and generic registry has no predeclared finding", () => {
  assert.deepEqual(inspectEvidence(registry, "unseen-ref"), { status: "unknown", id: "unseen-ref" });
  assert.equal("findings" in registry, false);
  assert.ok(registry.entries.some(candidate => candidate.id === "FDA-PRODUCT-LOT-SCOPE"));
  assert.ok(registry.entries.some(candidate => candidate.id === "MFG-LOT-SCOPE"));
  assert.ok(registry.entries.some(candidate => candidate.id === "DISTRIBUTOR-COVER-LOT-SCOPE"));
  assert.ok(registry.entries.some(candidate => candidate.id === "MFG-RESPONSE"));
  assert.ok(registry.entries.some(candidate => candidate.id === "MFG-DOWNSTREAM"));
  assert.equal(entry("MFG-RESPONSE").authority, "public-source-excerpt");
  assert.equal(entry("MFG-DOWNSTREAM").authority, "curated-source-summary");
});

test("reviewed seed claim citations resolve to bounded capture metadata with a distinct content hash", () => {
  const provenance = fixture.snapshot.recallProvenance!;
  const rawCaptureRef = `FDA-RAW-SHA256:${provenance.rawsha256}`;
  const provenanceEntry = inspectEvidence(registry, rawCaptureRef);
  assert.ok("sourceHash" in provenanceEntry);
  assert.equal(provenanceEntry.id, "FDA-CAPTURE-PROVENANCE");
  assert.equal(provenanceEntry.authority, "curated-source-summary");
  assert.ok(provenanceEntry.content.includes(provenance.rawsha256));
  assert.ok(provenanceEntry.content.includes("full raw capture body is not embedded"));
  assert.ok(provenanceEntry.content.length < 1000);
  assert.notEqual(provenanceEntry.sourceHash, provenance.rawsha256);

  const guide = claimCitationGuide(fixture.snapshot, planReplenishment(fixture.snapshot));
  const refs = [...guide.inventory, ...guide.plan, ...guide.transfers.flatMap(row => row.citations)];
  for (const ref of refs) assert.ok("sourceHash" in inspectEvidence(registry, ref), `unresolved claim citation ${ref}`);
});

test("public scope entries remain tied to their stored source material when snapshot scope changes", () => {
  const changedSnapshot = structuredClone(fixture.snapshot);
  changedSnapshot.scope.affectedLots = ["CHANGED-SNAPSHOT-ONLY"];
  changedSnapshot.scope.manufacturerRef = "CHANGED-REFERENCE-ONLY";
  const changedRegistry = buildEvidenceRegistry(changedSnapshot, fixture.evidence);
  const originalManufacturer = entry("MFG-LOT-SCOPE");
  const changedManufacturer = entryFrom(changedRegistry.entries, "MFG-LOT-SCOPE");
  const originalFda = entry("FDA-PRODUCT-LOT-SCOPE");
  const changedFda = entryFrom(changedRegistry.entries, "FDA-PRODUCT-LOT-SCOPE");
  const manufacturerSpan = fixture.evidence.sources.find((source: NoticeSource) => source.id === "MANUFACTURER-R-25-057")
    ?.observed_spans.find((span: NoticeSpan) => span.id === "MFG-LOT-SCOPE");
  assert.ok(manufacturerSpan);
  assert.equal(changedManufacturer.content, originalManufacturer.content);
  assert.equal(changedManufacturer.sourceHash, originalManufacturer.sourceHash);
  assert.ok(changedManufacturer.content.includes(manufacturerSpan.summary));
  assert.ok(!changedManufacturer.content.includes("CHANGED-SNAPSHOT-ONLY"));
  assert.equal(changedFda.content, originalFda.content);
  assert.ok(changedFda.content.includes(fixture.evidence.recall.affected_lots[0]));
  assert.ok(!changedFda.content.includes("CHANGED-SNAPSHOT-ONLY"));
});

test("validator rejects stale hashes, unselected sources, and forged quote text", () => {
  const source = entry("FDA-REQUIRED-ACTIONS");
  const goodQuote = source.content.slice(0, 20);
  const report: InvestigationReportInput = {
    disposition: "answered", summary: "The stored action excerpt supports this observation.",
    findings: [{ id: "f1", kind: "observation", summary: "Stored text checked.", evidence: [
      { sourceId: source.id, sourceHash: "stale", quote: goodQuote },
      { sourceId: source.id, sourceHash: source.sourceHash, quote: "forged quote absent from the source" },
    ] }],
  };
  const checked = validateInvestigationReport(registry, [], report);
  assert.equal(checked.valid, false);
  assert.ok(checked.codes.includes("unselected_evidence"));
  assert.ok(checked.codes.includes("stale_source_hash"));
  assert.ok(checked.codes.includes("quote_not_found"));
});

test("conflict findings require two distinct selected sources and exact nonempty quotes", () => {
  const fda = entry("FDA-PRODUCT-LOT-SCOPE");
  const manufacturer = entry("MFG-LOT-SCOPE");
  const manufacturerSummary = fixture.evidence.sources.find((source: NoticeSource) => source.id === "MANUFACTURER-R-25-057")!
    .observed_spans.find((span: NoticeSpan) => span.id === "MFG-LOT-SCOPE")!.summary;
  const report: InvestigationReportInput = {
    disposition: "answered", summary: "Two source records differ.",
    findings: [{ id: "conflict", kind: "conflict", summary: "Compare these two scoped records.", evidence: [
      { sourceId: fda.id, sourceHash: fda.sourceHash, quote: fixture.evidence.recall.affected_lots[0] },
      { sourceId: manufacturer.id, sourceHash: manufacturer.sourceHash, quote: manufacturerSummary.slice(0, 20) },
    ] }],
  };
  assert.deepEqual(validateInvestigationReport(registry, [fda.id, manufacturer.id], report), { valid: true, codes: [] });
  report.findings[0]!.evidence.pop();
  assert.ok(validateInvestigationReport(registry, [fda.id], report).codes.includes("conflict_needs_two_sources"));
});

test("needs_evidence requires a concrete question and a missing-evidence finding", () => {
  const report: InvestigationReportInput = { disposition: "needs_evidence", summary: "Need a source record." , findings: [] };
  const checked = validateInvestigationReport(registry, [], report);
  assert.ok(checked.codes.includes("concrete_question_required"));
  assert.ok(checked.codes.includes("missing_evidence_finding_required"));
});

test("validator rejects empty reports and findings without quotes, while repeated selections are allowed", () => {
  const source = entry("FDA-REQUIRED-ACTIONS");
  const empty: InvestigationReportInput = { disposition: "answered", summary: "No finding submitted.", findings: [] };
  assert.ok(validateInvestigationReport(registry, [], empty).codes.includes("invalid_findings"));
  const noQuote: InvestigationReportInput = {
    disposition: "answered", summary: "A finding without evidence.",
    findings: [{ id: "f1", kind: "observation", summary: "No quote attached.", evidence: [] }],
  };
  assert.ok(validateInvestigationReport(registry, [source.id], noQuote).codes.includes("invalid_finding"));
  const withQuote: InvestigationReportInput = {
    disposition: "answered", summary: "A finding with a quote.",
    findings: [{ id: "f1", kind: "observation", summary: "A stored excerpt is cited.", evidence: [
      { sourceId: source.id, sourceHash: source.sourceHash, quote: source.content.slice(0, 20) },
    ] }],
  };
  assert.deepEqual(validateInvestigationReport(registry, [source.id, source.id], withQuote), { valid: true, codes: [] });
});

test("explicit heldout documents replace seed notices and retain their declared authority as data", () => {
  const heldout: EvidenceDocument = {
    id: "heldout-source", title: "Injected fictional note", kind: "notice",
    sourceURL: "urn:test:heldout", version: 1, retrievedAt: "2026-10-23T00:00:00Z",
    content: "This injected fictional note says LOT-EXAMPLE.", refs: ["heldout-alias"],
    authority: "fictional-record",
  };
  const synthetic = structuredClone(fixture.snapshot);
  synthetic.catalog[0] = { ...synthetic.catalog[0]!, internalSku: "SYNTH-SKU-TARGET", manufacturerRef: "SYNTH-MED-204" };
  synthetic.targetSku = "SYNTH-SKU-TARGET";
  synthetic.scope.manufacturerRef = "SYNTH-MED-204";
  const injected = buildEvidenceRegistry(synthetic, fixture.evidence, [heldout]);
  assert.deepEqual(inspectEvidence(injected, "heldout-alias"), injected.entries.find(candidate => candidate.id === heldout.id));
  const absentSeedSource = inspectEvidence(injected, "FDA-PRODUCT-LOT-SCOPE");
  assert.equal("status" in absentSeedSource ? absentSeedSource.status : "present", "unknown");
  const injectedEntry = entryFrom(injected.entries, heldout.id);
  assert.equal(injectedEntry.authority, "fictional-record");
  assert.equal(injectedEntry.sourceHash, entryFrom(injected.entries, heldout.id).sourceHash);
  assert.ok(injected.entries.some(candidate => candidate.id === fixture.snapshot.inventory[0]?.id), "normalized operational rows remain available");
  const syntheticProduct = inspectEvidence(injected, "SYNTH-MED-204");
  assert.ok("sourceHash" in syntheticProduct);
  assert.equal(syntheticProduct.id, "SYNTH-SKU-TARGET");
  assert.ok(syntheticProduct.content.includes("SYNTH-MED-204"));

  synthetic.catalog.push({ ...synthetic.catalog[0]!, internalSku: "SYNTH-SKU-DUPLICATE" });
  const ambiguous = buildEvidenceRegistry(synthetic, fixture.evidence, [heldout]);
  assert.deepEqual(inspectEvidence(ambiguous, "SYNTH-MED-204"), { status: "unknown", id: "SYNTH-MED-204" });
});

function entryFrom(entries: typeof registry.entries, id: string) {
  const found = entries.find(candidate => candidate.id === id);
  assert.ok(found);
  return found;
}
