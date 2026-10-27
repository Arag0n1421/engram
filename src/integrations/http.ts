export type FetchLike = typeof fetch;

export interface ResponseEvidence {
  status: number;
  requestIds: Record<string, string>;
  elapsedMs: number;
}

export class IntegrationError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly evidence?: ResponseEvidence;

  constructor(code: string, message: string, status?: number, evidence?: ResponseEvidence) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.status = status;
    this.evidence = evidence;
  }
}

const EVIDENCE_HEADERS = ["x-request-id", "request-id", "x-provider", "x-meterless-model", "x-meterless-provider", "x-meterless-route"];

function responseEvidence(response: Response, elapsedMs: number, secrets: string[]): ResponseEvidence {
  const requestIds: Record<string, string> = {};
  for (const name of EVIDENCE_HEADERS) {
    const value = response.headers.get(name);
    if (value && /^[a-zA-Z0-9 ._:/-]{1,180}$/.test(value) && !secrets.some((secret) => value.includes(secret))) requestIds[name] = value;
  }
  return { status: response.status, requestIds, elapsedMs };
}

/** Never includes provider error bodies, request headers or network exception text in thrown errors. */
export async function fetchJson(
  fetchImpl: FetchLike,
  service: "Meterless" | "Zetaris",
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<{ body: unknown; evidence: ResponseEvidence }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let evidence: ResponseEvidence | undefined;
  const authorization = new Headers(init.headers).get("authorization");
  const secrets = authorization ? [authorization, authorization.replace(/^Bearer\s+/i, "")] : [];
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    evidence = responseEvidence(response, Math.round(performance.now() - started), secrets);
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntegrationError("HTTP_ERROR", `${service} returned HTTP ${response.status}`, response.status, evidence);
    }
    const text = await boundedText(response, 2_000_000);
    try {
      return { body: JSON.parse(text), evidence };
    } catch {
      throw new IntegrationError("INVALID_JSON", `${service} returned a non-JSON response`, response.status, evidence);
    }
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (controller.signal.aborted) throw new IntegrationError("TIMEOUT", `${service} request timed out`, undefined, evidence);
    throw new IntegrationError("NETWORK_ERROR", `${service} request failed before a valid response`, undefined, evidence);
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new IntegrationError("RESPONSE_TOO_LARGE", "Integration response exceeded the allowed size");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeError(error: unknown): { code: string; message: string; status?: number; evidence?: ResponseEvidence } {
  if (error instanceof IntegrationError) {
    return { code: error.code, message: error.message, status: error.status, evidence: error.evidence };
  }
  return { code: "UNEXPECTED_ERROR", message: "An unexpected integration check failed; details omitted to protect credentials" };
}
