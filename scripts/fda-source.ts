import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const KNOWN_FDA_URL = 'https://api.fda.gov/device/recall.json?limit=1&search=cfres_id%3A%22213286%22';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type FdaCandidate = {
  status: "review_required";
  candidatePath: string;
  rawsha256: string;
  retrievedAt: string;
  sourceURL: string;
  recordId: "213286";
};

type CaptureOptions = {
  fetchImpl?: typeof fetch;
  outputRoot?: string;
};

async function readResponseLimited(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("FDA response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("FDA response exceeded the 2 MiB candidate limit").catch(() => undefined);
        throw new Error("FDA response exceeded the 2 MiB candidate limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateKnownRecord(rawJSON: string): void {
  const payload: unknown = JSON.parse(rawJSON);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new Error("FDA response does not contain a results array");
  }
  const envelope = payload as { meta?: { results?: { total?: number } }; results: unknown[] };
  const record = envelope.results[0] as Record<string, unknown> | undefined;
  if (envelope.meta?.results?.total !== 1 || envelope.results.length !== 1 || record?.cfres_id !== "213286" || record?.product_res_number !== "Z-1706-2025") {
    throw new Error("FDA response does not identify the single requested recall record");
  }
}

async function verifyExistingCandidate(candidatePath: string, rawBytes: Uint8Array, rawsha256: string): Promise<FdaCandidate> {
  const existingRaw = await readFile(resolve(candidatePath, "raw-openfda-device-recall-213286.json"));
  const existingMeta = JSON.parse(await readFile(resolve(candidatePath, "source.json"), "utf8")) as Record<string, unknown>;
  const existingHash = createHash("sha256").update(existingRaw).digest("hex");
  if (!Buffer.from(existingRaw).equals(Buffer.from(rawBytes)) || existingHash !== rawsha256 || existingMeta.rawsha256 !== rawsha256 || existingMeta.rawJSON !== Buffer.from(rawBytes).toString("utf8") || existingMeta.sourceURL !== KNOWN_FDA_URL || typeof existingMeta.retrievedAt !== "string") {
    throw new Error("An existing FDA candidate path does not match the requested content; refusing to overwrite it");
  }
  return { status: "review_required", candidatePath, rawsha256, retrievedAt: existingMeta.retrievedAt, sourceURL: KNOWN_FDA_URL, recordId: "213286" };
}

/** Fetches the single approved FDA record into an immutable, hash-keyed candidate directory for human review. */
export async function captureKnownFdaCandidate(options: CaptureOptions = {}): Promise<FdaCandidate> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const workingRoot = process.cwd();
  const outputRoot = resolve(options.outputRoot ?? resolve(workingRoot, "work/fda-candidates"));
  const activePack = resolve(workingRoot, "data/fda");
  const relativeToActive = relative(activePack, outputRoot);
  if (relativeToActive === "" || (!relativeToActive.startsWith(`..${sep}`) && relativeToActive !== "..")) {
    throw new Error("FDA candidate output cannot be written inside the active data/fda pack");
  }

  const response = await fetchImpl(KNOWN_FDA_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`FDA request failed with HTTP ${response.status}`);
  const rawBytes = await readResponseLimited(response);
  const rawJSON = Buffer.from(rawBytes).toString("utf8");
  validateKnownRecord(rawJSON);
  const rawsha256 = createHash("sha256").update(rawBytes).digest("hex");
  const retrievedAt = new Date().toISOString();
  const candidatePath = resolve(outputRoot, rawsha256);
  const metadata = { status: "review_required", sourceURL: KNOWN_FDA_URL, retrievedAt, rawsha256, rawJSON };

  await mkdir(outputRoot, { recursive: true });
  try {
    await mkdir(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return verifyExistingCandidate(candidatePath, rawBytes, rawsha256);
  }
  try {
    await writeFile(resolve(candidatePath, "raw-openfda-device-recall-213286.json"), rawBytes, { flag: "wx" });
    await writeFile(resolve(candidatePath, "source.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    // Keep any partial candidate for inspection; never replace files automatically.
    throw error;
  }
  return { status: "review_required", candidatePath, rawsha256, retrievedAt, sourceURL: KNOWN_FDA_URL, recordId: "213286" };
}

async function main(): Promise<void> {
  const candidate = await captureKnownFdaCandidate();
  console.log(JSON.stringify(candidate));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
