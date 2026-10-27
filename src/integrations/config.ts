export interface MeterlessConfig {
  token: string;
  model: string;
  baseUrl: string;
  appId?: string;
  timeoutMs?: number;
}

export type RecallOpsView = "inventory" | "shipments" | "demand" | "products" | "sites";

export interface ZetarisConfig {
  baseUrl: string;
  apiKey: string;
  orgId: string;
  timeoutMs?: number;
  views?: Partial<Record<RecallOpsView, string>>;
  /** Optional separately registered exact FDA lot-scope view. */
  reviewedScopeView?: string;
}

export type ConfigReadiness<T> =
  | { status: "ready"; config: T; missing: []; errors: [] }
  | { status: "missing_config" | "invalid_config"; missing: string[]; errors: string[] };

export interface IntegrationConfiguration {
  meterless: ConfigReadiness<MeterlessConfig>;
  zetaris: ConfigReadiness<ZetarisConfig>;
}

export function validateBaseUrl(value: string, service: "meterless" | "zetaris"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${service} base URL must be a valid absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${service} base URL must not contain credentials, a query, or a fragment`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith(".local");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (service === "zetaris" || loopback || privateHost))) {
    throw new Error(`${service} base URL must use HTTPS (HTTP is allowed for local tests or Zetaris)`);
  }
  if (service === "zetaris" && !/\/api\/v1\.0\/?$/.test(url.pathname)) {
    throw new Error("zetaris base URL must end in /api/v1.0; the UI origin is a different endpoint");
  }
  if (service === "meterless" && !/\/v1\/?$/.test(url.pathname)) {
    throw new Error("meterless base URL must end in /v1");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateMeterlessConfig(config: MeterlessConfig): MeterlessConfig {
  if (!config.token?.trim() || config.token.trim() === "rt-local") throw new Error("METERLESS_RUNTIME_TOKEN must contain the real runtime token; rt-local is not accepted");
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(config.model)) {
    throw new Error("METERLESS_MODEL must be an explicit model or routing ID from the configured endpoint");
  }
  const baseUrl = normalizeMeterlessBaseUrl(config.baseUrl);
  const appId = config.appId ?? "recallops";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(appId)) throw new Error("METERLESS_APP_ID must be a stable lowercase app identifier");
  validateTimeout(config.timeoutMs);
  return { ...config, token: config.token.trim(), baseUrl, appId };
}

/** Normalizes a supplied endpoint only; it never chooses or discovers an endpoint. */
export function normalizeMeterlessBaseUrl(value: string): string {
  if (!value?.trim()) throw new Error("METERLESS_BASE_URL is required; no provider endpoint is assumed");
  let input = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(input) || /^[^/]+\.local(?::\d+)?(?:\/|$)/.test(input);
    input = `${local ? "http" : "https"}://${input}`;
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("meterless base URL must be a valid absolute URL"); }
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/v1\/(chat\/completions|models)$/, "/v1");
  if (url.pathname === "" || url.pathname === "/healthz") url.pathname = "/v1";
  return validateBaseUrl(url.toString(), "meterless");
}

export function validateZetarisConfig(config: ZetarisConfig): ZetarisConfig {
  if (!config.apiKey?.trim()) throw new Error("ZETARIS_API_KEY is required");
  if (!/^[1-9]\d*$/.test(config.orgId)) throw new Error("ZETARIS_ORG_ID must be the actual positive numeric organisation ID");
  const baseUrl = validateBaseUrl(config.baseUrl, "zetaris");
  validateTimeout(config.timeoutMs);
  if (config.views) validateViewMap(config.views);
  const reviewedScopeView = config.reviewedScopeView?.trim();
  if (reviewedScopeView && !isSafeQualifiedSqlIdentifier(reviewedScopeView)) throw new Error("ZETARIS_VIEW_REVIEWED_SCOPE must be a safe qualified SQL identifier");
  return { ...config, apiKey: config.apiKey.trim(), baseUrl, ...(reviewedScopeView ? { reviewedScopeView } : {}) };
}

export function isSafeQualifiedSqlIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*){0,2}$/.test(value);
}

const VIEW_NAMES = ["inventory", "shipments", "demand", "products", "sites"];

function validateViewMap(value: unknown): asserts value is Partial<Record<RecallOpsView, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ZETARIS_VIEW_MAP must be a JSON object");
  for (const [name, identifier] of Object.entries(value)) {
    if (!VIEW_NAMES.includes(name) || !isSafeQualifiedSqlIdentifier(identifier)) {
      throw new Error("ZETARIS_VIEW_MAP contains an unsupported view or unsafe SQL identifier");
    }
  }
}

export function parseZetarisViewMap(value: string | undefined): Partial<Record<RecallOpsView, string>> | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("ZETARIS_VIEW_MAP must be valid JSON"); }
  validateViewMap(parsed);
  return parsed;
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
    throw new Error("timeoutMs must be an integer between 1 and 300000");
  }
}

function parseZetarisTimeout(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error("ZETARIS_TIMEOUT_MS must be an integer between 1 and 300000");
  return Number(value.trim());
}

function readiness<T>(env: NodeJS.ProcessEnv, required: string[], validate: () => T): ConfigReadiness<T> {
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) return { status: "missing_config", missing, errors: [] };
  try {
    return { status: "ready", config: validate(), missing: [], errors: [] };
  } catch (error) {
    return { status: "invalid_config", missing: [], errors: [error instanceof Error ? error.message : "Invalid integration configuration"] };
  }
}

/** Reads only the provided environment. This does not read files, create keys or call providers. */
export function loadIntegrationConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfiguration {
  return {
    meterless: readiness(env, ["METERLESS_RUNTIME_TOKEN", "METERLESS_MODEL", "METERLESS_BASE_URL"], () => validateMeterlessConfig({
      token: env.METERLESS_RUNTIME_TOKEN!,
      model: env.METERLESS_MODEL!,
      baseUrl: env.METERLESS_BASE_URL!,
      appId: env.METERLESS_APP_ID,
    })),
    zetaris: readiness(env, ["ZETARIS_REST_URL", "ZETARIS_API_KEY", "ZETARIS_ORG_ID"], () => validateZetarisConfig({
      baseUrl: env.ZETARIS_REST_URL!,
      apiKey: env.ZETARIS_API_KEY!,
      orgId: env.ZETARIS_ORG_ID!,
      timeoutMs: parseZetarisTimeout(env.ZETARIS_TIMEOUT_MS),
      views: parseZetarisViewMap(env.ZETARIS_VIEW_MAP),
      reviewedScopeView: env.ZETARIS_VIEW_REVIEWED_SCOPE,
    })),
  };
}

/** Safe readiness for evidence and logs: deliberately excludes all credential-bearing config. */
export function configurationSummary(configuration: IntegrationConfiguration) {
  const summarize = <T>(entry: ConfigReadiness<T>) => ({ status: entry.status, missing: entry.missing, errors: entry.errors });
  return { meterless: summarize(configuration.meterless), zetaris: summarize(configuration.zetaris) };
}
