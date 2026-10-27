import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureKnownFdaCandidate, KNOWN_FDA_URL } from "../../scripts/fda-source.ts";

const validRaw = JSON.stringify({
  meta: { results: { total: 1 } },
  results: [{ cfres_id: "213286", product_res_number: "Z-1706-2025", product_description: "fixture payload" }],
});
const response = (body: BodyInit, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

async function activePackHashes(): Promise<Record<string, string>> {
  const root = resolve(process.cwd(), "data/fda");
  const result: Record<string, string> = {};
  for (const name of ["raw-openfda-device-recall-213286.json", "source.json", "reviewed_scope.json"]) {
    const bytes = await readFile(resolve(root, name));
    result[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return result;
}

test("saves a hash-keyed candidate and leaves the active FDA pack unchanged", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fda-candidate-test-"));
  const outputRoot = resolve(temp, "candidates");
  const before = await activePackHashes();
  try {
    const candidate = await captureKnownFdaCandidate({
      outputRoot,
      fetchImpl: async (url, init) => {
        assert.equal(url, KNOWN_FDA_URL);
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal instanceof AbortSignal);
        return response(validRaw);
      },
    });
    assert.equal(candidate.status, "review_required");
    assert.equal(candidate.recordId, "213286");
    assert.match(candidate.rawsha256, /^[a-f0-9]{64}$/);
    assert.equal(candidate.candidatePath, resolve(outputRoot, candidate.rawsha256));
    assert.equal(await readFile(resolve(candidate.candidatePath, "raw-openfda-device-recall-213286.json"), "utf8"), validRaw);
    const metadata = JSON.parse(await readFile(resolve(candidate.candidatePath, "source.json"), "utf8"));
    assert.equal(metadata.status, "review_required");
    assert.equal(metadata.sourceURL, KNOWN_FDA_URL);
    assert.equal(metadata.rawsha256, candidate.rawsha256);
    assert.equal(metadata.rawJSON, validRaw);

    const reused = await captureKnownFdaCandidate({ outputRoot, fetchImpl: async () => response(validRaw) });
    assert.equal(reused.candidatePath, candidate.candidatePath);
    assert.equal(reused.retrievedAt, candidate.retrievedAt);
    assert.deepEqual(await activePackHashes(), before);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("times out/rejects fetch failures without creating a candidate", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fda-candidate-timeout-"));
  const outputRoot = resolve(temp, "candidates");
  try {
    await assert.rejects(captureKnownFdaCandidate({
      outputRoot,
      fetchImpl: async (_url, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        throw new DOMException("request timed out", "TimeoutError");
      },
    }), /timed out/);
    await assert.rejects(access(outputRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects a response larger than 2 MiB without writing it", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fda-candidate-large-"));
  const outputRoot = resolve(temp, "candidates");
  try {
    await assert.rejects(captureKnownFdaCandidate({
      outputRoot,
      fetchImpl: async () => response(new Uint8Array(2 * 1024 * 1024 + 1)),
    }), /exceeded the 2 MiB candidate limit/);
    await assert.rejects(access(outputRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects redirects without following them or creating a candidate", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "fda-candidate-redirect-"));
  const outputRoot = resolve(temp, "candidates");
  try {
    await assert.rejects(captureKnownFdaCandidate({
      outputRoot,
      fetchImpl: async (_url, init) => {
        assert.equal(init?.redirect, "error");
        return response("", 302);
      },
    }), /HTTP 302/);
    await assert.rejects(access(outputRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("refuses active data/fda as candidate output before making a request", async () => {
  let called = false;
  await assert.rejects(captureKnownFdaCandidate({
    outputRoot: resolve(process.cwd(), "data/fda"),
    fetchImpl: async () => { called = true; return response(validRaw); },
  }), /cannot be written inside the active data\/fda pack/);
  assert.equal(called, false);
  await readdir(resolve(process.cwd(), "data/fda"));
});
