import type { MeterlessConfig } from "../integrations/config.ts";
import { IntegrationError, isRecord } from "../integrations/http.ts";

export const NATIVE_TOOL_ISOLATION_SCOPE = "validated M1M4 web installation contract; no universal runtime toolcount claim" as const;
export interface NativeToolIsolationProof {
  contract: "nightshift-m1m4-web-v1";
  scope: typeof NATIVE_TOOL_ISOLATION_SCOPE;
  checkedAt: string;
  origin: string;
  health: {httpStatus: 200; status: "ok"; engine: "meterless"; build: "m1-m4"; served: "app"; engineReady: true};
  toolsEndpoint: {httpStatus: 501; errorCode: "not_available_in_web"};
  universalRuntimeToolCountClaim: false;
}
export type NativeToolIsolationVerifier = (config: Pick<MeterlessConfig, "baseUrl" | "token">, fetchImpl?: typeof fetch) => Promise<NativeToolIsolationProof>;

const reject = (): never => {throw new IntegrationError("NATIVE_TOOL_ISOLATION_UNVERIFIED", "The validated M1M4 web installation contract was not established; required native tool choice is disabled.");};
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return reject();
  const reader = response.body?.getReader();
  if (!reader) return reject();
  const chunks: Uint8Array[] = []; let bytes = 0;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, fail) => {
    onAbort = () => fail(new Error("Native tool isolation metadata deadline"));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, {once: true});
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8_192) {void reader.cancel().catch(() => undefined); return reject();}
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
    return JSON.parse(new TextDecoder().decode(body));
  } finally {signal.removeEventListener("abort", onAbort); reader.releaseLock();}
}

/** Read metadata only. A full/unknown tools endpoint is rejected before its body is read. No settings are changed. */
export async function verifyNativeToolIsolation(config: Pick<MeterlessConfig, "baseUrl" | "token">, fetchImpl: typeof fetch = fetch): Promise<NativeToolIsolationProof> {
  try {
    const base = new URL(config.baseUrl);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/+$/, "") !== "/v1" || !config.token) return reject();
    const signal = AbortSignal.timeout(10_000);
    const headers = {Authorization: `Bearer ${config.token}`, Accept: "application/json"};
    const healthResponse = await fetchImpl(new URL("/healthz", base), {method: "GET", headers, redirect: "error", signal});
    if (healthResponse.status !== 200) {void healthResponse.body?.cancel().catch(() => undefined); return reject();}
    const health = await boundedJson(healthResponse, signal);
    if (!isRecord(health) || health.status !== "ok" || health.engine !== "meterless" || health.build !== "m1-m4" || health.served !== "app" || health.engine_ready !== true) return reject();
    const toolsResponse = await fetchImpl(new URL("/v1/meterless/tools", base), {method: "GET", headers, redirect: "error", signal});
    if (toolsResponse.status !== 501) {void toolsResponse.body?.cancel().catch(() => undefined); return reject();}
    const tools = await boundedJson(toolsResponse, signal);
    if (!isRecord(tools) || !isRecord(tools.error) || tools.error.code !== "not_available_in_web") return reject();
    return {
      contract: "nightshift-m1m4-web-v1", scope: NATIVE_TOOL_ISOLATION_SCOPE,
      checkedAt: new Date().toISOString(), origin: base.origin,
      health: {httpStatus: 200, status: "ok", engine: "meterless", build: "m1-m4", served: "app", engineReady: true},
      toolsEndpoint: {httpStatus: 501, errorCode: "not_available_in_web"}, universalRuntimeToolCountClaim: false,
    };
  } catch {return reject();}
}
