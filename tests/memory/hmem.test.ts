import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { METERLESS_HMEM_COMMIT, RecallOpsMemory } from "../../src/memory/index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const input = {
  analysisId: "analysis-1", recallId: "FDA-213286", snapshotHash: HASH_A,
  summary: "Historical analysis: review packaging evidence before allocating saline stock. Site A needed a transfer; current QA and stock must be queried again.",
  sourceRefs: ["FDA-213286#affected-lots", "DEMO-QA-B-001", "inventory:DEMO-INV-B-BASE@1"],
};

test("vendored Meterless reference matches pinned upstream blob hashes exactly", () => {
  const root = new URL("../../vendor/meterless/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
  assert.equal(manifest.commit, METERLESS_HMEM_COMMIT);
  assert.equal(manifest.license, "Apache-2.0");
  for (const file of manifest.files) {
    const content = readFileSync(new URL(file.localPath, root));
    const hash = createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
    assert.equal(hash, file.blobSha, `unmodified upstream file ${file.localPath}`);
  }
});

test("actual H-MEM records, retrieves and persists analysis plus exact source references", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-hmem-"));
  try {
    const memory = new RecallOpsMemory({ persistDir: dir, clock: () => Date.parse("2026-10-22T12:00:00Z") });
    const receipt = memory.recordAnalysis(input);
    assert.equal(receipt.created, true);
    const result = new RecallOpsMemory({ persistDir: dir }).queryEvidence({ query: "packaging evidence saline transfer", recallId: input.recallId, currentSnapshotHash: HASH_A });
    assert.equal(result.engine, "Meterless H-MEM reference");
    assert.equal(result.status, "advisory_only");
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0].sourceRefs, input.sourceRefs);
    assert.equal(result.matches[0].memoryId, receipt.memoryId);
    assert.equal(result.matches[0].staleAgainstCurrentSnapshot, false);
    const audit = new RecallOpsMemory({ persistDir: dir }).audit(receipt.memoryId);
    assert.ok(audit.some((entry) => entry.action === "create"));
    assert.ok(audit.some((entry) => entry.action === "read"));
    assert.deepEqual(audit.find((entry) => entry.action === "create")?.newState?.provenance?.refs, input.sourceRefs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory remains historical under changed QA/stock snapshot and cannot override current facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-hmem-"));
  try {
    const memory = new RecallOpsMemory({ persistDir: dir });
    memory.recordAnalysis({ ...input, summary: "Historical stock QA report: 40 units were released for transfer at Site B." });
    const current = { snapshotHash: HASH_B, availableQuantity: 0, qaStatus: "UNVERIFIED" };
    const before = structuredClone(current);
    const result = memory.queryEvidence({ query: "stock QA report transfer", recallId: input.recallId, currentSnapshotHash: current.snapshotHash });
    assert.equal(result.cannotAuthorizeActions, true);
    assert.equal(result.matches[0].staleAgainstCurrentSnapshot, true);
    assert.equal(result.matches[0].neverAuthority, true);
    assert.match(result.context, /Current recall evidence, QA evidence, inventory and solver validation always take precedence/);
    assert.deepEqual(current, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recall scope and required source provenance prevent cross-case memory leakage", () => {
  const dir = mkdtempSync(join(tmpdir(), "recallops-hmem-"));
  try {
    const memory = new RecallOpsMemory({ persistDir: dir });
    memory.recordAnalysis(input);
    const other = memory.queryEvidence({ query: "packaging evidence saline transfer", recallId: "OTHER-RECALL", currentSnapshotHash: HASH_A });
    assert.equal(other.matches.length, 0);
    assert.ok(!other.context.includes(input.summary));
    assert.throws(() => memory.recordAnalysis({ ...input, analysisId: "analysis-no-sources", sourceRefs: [] }));
    assert.equal(memory.recordAnalysis(input).created, false);
    assert.throws(() => memory.recordAnalysis({ ...input, snapshotHash: HASH_B }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
