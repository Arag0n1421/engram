import { randomUUID } from "node:crypto";
import { validateMeterlessConfig, type MeterlessConfig } from "./config.ts";
import { fetchJson, IntegrationError, isRecord, type FetchLike, type ResponseEvidence } from "./http.ts";

export interface MeterlessCallEvidence extends ResponseEvidence {
  requestedModel: string;
  reportedModel?: string;
  provider?: string;
  completionId?: string;
  usage: Record<string, number>;
  routeAttribution: MeterlessRouteAttribution;
}

export interface MeterlessRouteAttribution {
  status: "response_reports_nemotron" | "missing_route_metadata" | "non_nemotron_route" | "conflicting_route_metadata" | "invalid_route_metadata";
  /** Top-level response model can echo a requested routing alias. It never establishes attribution. */
  responseModel?: string;
  /** Official provider_model is the Meterless routing ID, not vendor-model proof. */
  providerModel?: string;
  routedModel?: string;
  winningRoute?: string | Record<string, string>;
  /** Normalized comparison identity; exact endpoint labels remain in the fields above. */
  underlyingModel?: string;
  reason: string;
}

export interface ToolRoundTripEvidence {
  status: "passed";
  model: string;
  tool: "inspect_smoke_fixture";
  toolArgumentsValidated: true;
  toolResultObserved: true;
  calls: MeterlessCallEvidence[];
  nemotronAttribution: {
    status: "response_reports_nemotron" | "not_established";
    limitation: string;
  };
}

const TOOL_NAME = "inspect_smoke_fixture";
const SMOKE_LABEL = "recallops-smoke";
const SMOKE_VALUE = "RECALLOPS_SMOKE_OK_3";

export class MeterlessClient {
  private readonly config: MeterlessConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: MeterlessConfig, fetchImpl: FetchLike = fetch) {
    this.config = validateMeterlessConfig(config);
    this.fetchImpl = fetchImpl;
  }

  /** Runtime model discovery only. This does not prove the underlying Nemotron route or inference capability. */
  async listModels(): Promise<{ modelIds: string[]; runtimeRoutingIds: string[]; runtimeStatus: "online" | "not_identified"; evidence: ResponseEvidence }> {
    const { body, evidence } = await fetchJson(this.fetchImpl, "Meterless", `${this.config.baseUrl}/models`, { headers: this.headers() }, this.config.timeoutMs ?? 180_000);
    const rows = isRecord(body) && Array.isArray(body.data) ? body.data : null;
    if (!rows) throw new IntegrationError("INVALID_RESPONSE", "Meterless catalog response did not contain a model list", evidence.status, evidence);
    const modelIds = rows.flatMap((row) => isRecord(row) && typeof row.id === "string" && /^[a-zA-Z0-9._:/-]{1,200}$/.test(row.id) ? [row.id] : []);
    const runtimeRoutingIds = modelIds.filter((id) => id.startsWith("meterless/"));
    return { modelIds, runtimeRoutingIds, runtimeStatus: runtimeRoutingIds.length ? "online" : "not_identified", evidence };
  }

  /** Two real inference requests. Caller must obtain explicit permission before invoking this method. */
  async smokeToolRoundTrip(options: { onCallEvidence?: (evidence: MeterlessCallEvidence) => void; requireNemotronEvidence?: boolean } = {}): Promise<ToolRoundTripEvidence> {
    const messages: Record<string, unknown>[] = [{
      role: "user",
      content: `Integration smoke test only. Call ${TOOL_NAME} with label ${SMOKE_LABEL}. After the tool returns, reply with its result_code exactly. Do not invent the tool result.`,
    }];
    const first = await this.complete({
      messages,
      tools: [{ type: "function", function: {
        name: TOOL_NAME,
        description: "Read the harmless fixed RecallOps integration smoke fixture.",
        parameters: { type: "object", properties: { label: { type: "string", enum: [SMOKE_LABEL] } }, required: ["label"], additionalProperties: false },
      } }],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    });
    options.onCallEvidence?.(first.evidence);
    if (options.requireNemotronEvidence && first.evidence.routeAttribution.status !== "response_reports_nemotron") {
      throw new IntegrationError("NEMOTRON_NOT_ESTABLISHED", "The first call did not establish an actual Nemotron route; a second inference request was not sent");
    }
    const choice = Array.isArray(first.body.choices) ? first.body.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length !== 1 || !isRecord(calls[0])) throw new IntegrationError("TOOL_CALL_MISSING", "Configured endpoint did not return exactly one smoke tool call");
    const toolCall = calls[0];
    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
    if (typeof toolCall.id !== "string" || !toolCall.id || toolCall.type !== "function" || fn?.name !== TOOL_NAME || typeof fn.arguments !== "string") {
      throw new IntegrationError("INVALID_TOOL_CALL", "Configured endpoint returned an invalid smoke tool call");
    }
    let args: unknown;
    try { args = JSON.parse(fn.arguments); } catch { throw new IntegrationError("INVALID_TOOL_ARGUMENTS", "Configured endpoint returned non-JSON smoke tool arguments"); }
    if (!isRecord(args) || Object.keys(args).length !== 1 || args.label !== SMOKE_LABEL) {
      throw new IntegrationError("INVALID_TOOL_ARGUMENTS", "Configured endpoint smoke tool arguments failed validation");
    }
    messages.push({ role: "assistant", content: typeof message?.content === "string" ? message.content : null, tool_calls: [toolCall] });
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ label: SMOKE_LABEL, safe_units: 3, result_code: SMOKE_VALUE }) });
    const second = await this.complete({ messages });
    options.onCallEvidence?.(second.evidence);
    const secondChoice = Array.isArray(second.body.choices) ? second.body.choices[0] : undefined;
    const finalMessage = isRecord(secondChoice) && isRecord(secondChoice.message) ? secondChoice.message : undefined;
    if (typeof finalMessage?.content !== "string" || finalMessage.content.trim() !== SMOKE_VALUE) {
      throw new IntegrationError("TOOL_RESULT_NOT_OBSERVED", "Configured endpoint did not reproduce the observed smoke tool result");
    }
    const reportsNemotron = [first.evidence, second.evidence].every((call) => call.routeAttribution.status === "response_reports_nemotron");
    if (options.requireNemotronEvidence && !reportsNemotron) throw new IntegrationError("NEMOTRON_NOT_ESTABLISHED", "The endpoint completed the tool smoke but did not report an underlying Nemotron model on both calls");
    return {
      status: "passed", model: this.config.model, tool: TOOL_NAME, toolArgumentsValidated: true, toolResultObserved: true, calls: [first.evidence, second.evidence],
      nemotronAttribution: { status: reportsNemotron ? "response_reports_nemotron" : "not_established", limitation: "Both calls require coherent actual-route metadata. Requested or echoed model names do not establish attribution; endpoint-reported metadata is not independent award-eligibility proof" },
    };
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json", "meterless-app": this.config.appId! };
  }

  private async complete(request: Record<string, unknown>): Promise<{ body: Record<string, unknown>; evidence: MeterlessCallEvidence }> {
    const { body, evidence } = await fetchJson(this.fetchImpl, "Meterless", `${this.config.baseUrl}/chat/completions`, {
      method: "POST", headers: { ...this.headers(), "meterless-scope": `user:engram:smoke:${randomUUID()}`, "meterless-tier-split": "off", "meterless-deliberation": "off" }, body: JSON.stringify({ model: this.config.model, max_tokens: 2048, stream: false, ...request }),
    }, this.config.timeoutMs ?? 180_000);
    assertMeterlessResponseSuccess(body);
    if (declaresCacheReplay(body)) throw new IntegrationError("MODEL_CACHE_REPLAY", "Meterless declared a cache replay; the smoke requires a fresh model response.", evidence.status, evidence);
    if (!isRecord(body) || !Array.isArray(body.choices)) throw new IntegrationError("INVALID_RESPONSE", "Meterless completion response did not contain choices", evidence.status, evidence);
    const ignored = body["ignored_parameters"];
    if (Array.isArray(ignored) && ignored.some((field) => typeof field === "string" && /tools|tool_choice/.test(field))) {
      throw new IntegrationError("TOOL_CAPABILITY_DROPPED", "Configured endpoint disclosed dropped tool parameters", evidence.status, evidence);
    }
    const usage: Record<string, number> = {};
    if (isRecord(body.usage)) {
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
        const value = body.usage[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
      }
    }
    return { body, evidence: {
      ...evidence,
      requestedModel: this.config.model,
      reportedModel: safeLabel(body.model, this.config.token),
      provider: safeLabel(body.provider, this.config.token),
      completionId: safeLabel(body.id, this.config.token),
      usage,
      routeAttribution: extractMeterlessAttribution(body, this.config.token),
    } };
  }
}

/** Only known metadata enums are inspected; cached content and receipts are never exposed. */
function declaresCacheReplay(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.meterless)) return false;
  const metadata = body.meterless;
  if (metadata.from_cache === true) return true;
  const receipt = isRecord(metadata.receipt) ? metadata.receipt : null;
  return [metadata.cache, receipt?.cache].some(cache => isRecord(cache) && typeof cache.status === "string"
    && ["exact", "semantic_hard", "hit", "replay"].includes(cache.status.trim().toLowerCase()));
}

function safeLabel(value: unknown, secret: string): string | undefined {
  return typeof value === "string" && (!secret || !value.includes(secret)) && /^[a-zA-Z0-9 ._:/-]{1,200}$/.test(value) ? value : undefined;
}

function modelIdentity(value: string): string | undefined {
  const model = value.trim().toLowerCase();
  // Runtime routing aliases cannot identify an underlying model, even when named "nemotron".
  if (model.startsWith("meterless/")) return undefined;
  const normalized = model.replace(/^openrouter\//, "").replace(/^nvidia\//, "").replace(/:free$/, "");
  return /^[a-z0-9][a-z0-9._:/-]*$/.test(normalized) ? normalized : undefined;
}

function isNemotronIdentity(value: string): boolean {
  return /^(?:nvidia[-_])?(?:nemotron|llama-[0-9]+(?:\.[0-9]+)?-nemotron)(?:[-_:][a-z0-9._:-]+)?$/.test(value);
}

/** Shared by nonstream smoke and each SSE frame; never exposes provider error bodies. */
export function assertMeterlessResponseSuccess(body: unknown): void {
  if (!isRecord(body)) throw new IntegrationError("INVALID_MODEL_RESPONSE", "Meterless response frame must be a JSON object.");
  const failed = (value: unknown): boolean => typeof value === "string" && /^(?:error|failed|failure|cancelled|canceled|content_filter|response\.failed|response\.error)$/i.test(value);
  if (body.error != null || body.success === false || [body.status, body.type, body.object, body.event, body.finish_reason].some(failed)) {
    throw new IntegrationError("MODEL_RESPONSE_ERROR", "Meterless reported a failed model response; output was not released to the agent.");
  }
  if (Array.isArray(body.choices) && body.choices.some(choice => isRecord(choice) && (choice.error != null || failed(choice.finish_reason)))) {
    throw new IntegrationError("MODEL_RESPONSE_ERROR", "Meterless reported a failed completion choice; output was not released to the agent.");
  }
}

/** Inspect actual Meterless route metadata only; body.model is retained as an echo, not proof. */
export function extractMeterlessAttribution(body: unknown, secret = ""): MeterlessRouteAttribution {
  const responseModel = isRecord(body) ? safeLabel(body.model, secret) : undefined;
  const base = responseModel ? { responseModel } : {};
  if (!isRecord(body) || !isRecord(body.meterless)) {
    return { ...base, status: "missing_route_metadata", reason: "Actual Meterless route metadata is absent; an echoed response model cannot establish Nemotron." };
  }
  const metadata = body.meterless;
  const labels: Record<string, string> = {};
  const models: string[] = [];
  let invalid = false;
  for (const field of ["provider_model", "routed_model"] as const) {
    const value = metadata[field];
    if (value == null) continue;
    const label = safeLabel(value, secret);
    if (!label) { invalid = true; continue; }
    labels[field] = label;
    if (field === "provider_model") continue;
    const identity = modelIdentity(label);
    if (identity) models.push(identity);
    else if (!label.toLowerCase().startsWith("meterless/")) invalid = true;
  }
  let winningRoute: MeterlessRouteAttribution["winningRoute"];
  if (metadata.winning_route != null) {
    if (typeof metadata.winning_route === "string") {
      winningRoute = safeLabel(metadata.winning_route, secret);
      if (!winningRoute) invalid = true;
      // A string route/lane ID is preserved, but is not guessed to be a model ID.
    } else if (isRecord(metadata.winning_route)) {
      const route: Record<string, string> = {};
      for (const field of ["id", "name", "label", "provider", "kind", "tier", "model", "model_id", "provider_model", "routed_model"]) {
        if (metadata.winning_route[field] == null) continue;
        const raw = metadata.winning_route[field];
        const label = ["label", "kind", "tier", "name"].includes(field)
          ? typeof raw === "string" && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) && (!secret || !raw.includes(secret)) ? raw : undefined
          : safeLabel(raw, secret);
        if (!label) { invalid = true; continue; }
        route[field] = label;
        if (field === "model") {
          const identity = modelIdentity(label);
          if (identity) models.push(identity);
          else if (!label.toLowerCase().startsWith("meterless/")) invalid = true;
        }
      }
      winningRoute = route;
    } else invalid = true;
  }
  const evidence = {
    ...base,
    ...(labels.provider_model ? { providerModel: labels.provider_model } : {}),
    ...(labels.routed_model ? { routedModel: labels.routed_model } : {}),
    ...(winningRoute !== undefined ? { winningRoute } : {}),
  };
  if (invalid) return { ...evidence, status: "invalid_route_metadata", reason: "Actual route fields are malformed or cannot be retained safely." };
  const identities = [...new Set(models)];
  if (identities.length === 0) return { ...evidence, status: "missing_route_metadata", reason: "No actual underlying model identity is reported; route aliases alone are insufficient." };
  if (identities.length !== 1) return { ...evidence, status: "conflicting_route_metadata", reason: "Actual routed and winning-route model identities disagree." };
  const underlyingModel = identities[0]!;
  return isNemotronIdentity(underlyingModel)
    ? { ...evidence, underlyingModel, status: "response_reports_nemotron", reason: "Coherent actual-route fields report an underlying Nemotron model." }
    : { ...evidence, underlyingModel, status: "non_nemotron_route", reason: "The actual route reports a model outside the Nemotron family." };
}
