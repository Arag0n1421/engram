import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configurationSummary, FDA_SCOPE_COLUMNS, IntegrationError, loadIntegrationConfig, MeterlessClient, normalizeMeterlessBaseUrl, RECALL_OPS_COLUMNS, safeError, ZetarisClient,
  extractMeterlessAttribution, type FetchLike,
} from "../../src/integrations/index.ts";
import { checkIntegrations, parseCheckArguments } from "../../scripts/check-integrations.ts";

const KEY = "private-test-key-never-log";
const MODEL = "meterless/auto";
const REPORTED_MODEL = "nvidia/nemotron-smoke-fixture";
const meterless = { token: KEY, model: MODEL, baseUrl: "http://127.0.0.1:8088/v1" };
const zetaris = { apiKey: KEY, orgId: "1", baseUrl: "http://localhost:8888/api/v1.0" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const fakeFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike => (async (input, init) => handler(String(input), init ?? {})) as FetchLike;

test("config readiness distinguishes missing/invalid config without echoing secrets", () => {
  assert.equal(loadIntegrationConfig({}).meterless.status, "missing_config");
  const config = loadIntegrationConfig({ METERLESS_RUNTIME_TOKEN: KEY, METERLESS_MODEL: MODEL, METERLESS_BASE_URL: meterless.baseUrl, ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: `http://${KEY}@localhost:8888/api/v1.0`, ZETARIS_ORG_ID: "organisation-name" });
  assert.equal(config.meterless.status, "ready");
  assert.equal(config.zetaris.status, "invalid_config");
  assert.ok(!JSON.stringify(configurationSummary(config)).includes(KEY));
});

test("explicit view-map JSON is validated and invalid identifiers are not accepted", () => {
  const env = { ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: zetaris.baseUrl, ZETARIS_ORG_ID: "1", ZETARIS_VIEW_MAP: '{"inventory":"recallops.inventory"}' };
  const loaded = loadIntegrationConfig(env).zetaris;
  assert.equal(loaded.status, "ready");
  if (loaded.status === "ready") assert.equal(loaded.config.views?.inventory, "recallops.inventory");
  assert.equal(loadIntegrationConfig({ ...env, ZETARIS_VIEW_MAP: '{"inventory":"x;DROP TABLE y"}' }).zetaris.status, "invalid_config");
});

test("optional reviewed-scope view config accepts only a safe qualified identifier", () => {
  const env = { ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: zetaris.baseUrl, ZETARIS_ORG_ID: "1" };
  const absent = loadIntegrationConfig(env).zetaris;
  assert.equal(absent.status, "ready");
  if (absent.status === "ready") assert.equal(absent.config.reviewedScopeView, undefined);
  const configured = loadIntegrationConfig({ ...env, ZETARIS_VIEW_REVIEWED_SCOPE: "recallops.reviewed_scope" }).zetaris;
  assert.equal(configured.status, "ready");
  if (configured.status === "ready") assert.equal(configured.config.reviewedScopeView, "recallops.reviewed_scope");
  assert.equal(loadIntegrationConfig({ ...env, ZETARIS_VIEW_REVIEWED_SCOPE: "x; DROP TABLE y" }).zetaris.status, "invalid_config");
});

test("optional Zetaris timeout accepts bounded integer milliseconds and preserves the default when blank", () => {
  const env = { ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: zetaris.baseUrl, ZETARIS_ORG_ID: "1" };
  for (const value of [undefined, "", "   "]) {
    const loaded = loadIntegrationConfig({...env, ZETARIS_TIMEOUT_MS: value}).zetaris;
    assert.equal(loaded.status, "ready");
    if (loaded.status !== "ready") assert.fail();
    assert.equal(loaded.config.timeoutMs, undefined, "Unspecified timeout must retain the client's 30-second default, not become zero");
  }
  for (const value of ["1", "120000", "300000"]) {
    const loaded = loadIntegrationConfig({...env, ZETARIS_TIMEOUT_MS: value}).zetaris;
    assert.equal(loaded.status, "ready");
    if (loaded.status !== "ready") assert.fail();
    assert.equal(loaded.config.timeoutMs, Number(value));
  }
  for (const value of ["NaN", "0", "300001", "1.5", "1e3", "0x10", "Infinity", "-1"]) {
    assert.equal(loadIntegrationConfig({...env, ZETARIS_TIMEOUT_MS: value}).zetaris.status, "invalid_config", `${value} must not become an accepted timeout`);
  }
});

test("default checker performs zero network calls and reports unverified config", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => { throw new Error("Unexpected network call"); });
  try {
    const evidence = await checkIntegrations({ checkReadOnly: false, allowInference: false, output: "/unused" }, {});
    assert.equal(evidence.status, "incomplete");
    assert.match(JSON.stringify(evidence.checks), /not_run/);
    const configured = await checkIntegrations({ checkReadOnly: false, allowInference: false, output: "/unused" }, { METERLESS_RUNTIME_TOKEN: KEY, METERLESS_MODEL: MODEL, METERLESS_BASE_URL: meterless.baseUrl, ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: zetaris.baseUrl, ZETARIS_ORG_ID: "1" });
    assert.equal(configured.status, "configuration_ready_only");
    assert.ok(!JSON.stringify(configured).includes(KEY));
    assert.equal(parseCheckArguments([]).allowInference, false);
    assert.throws(() => parseCheckArguments(["--unknown"]));
  } finally { globalThis.fetch = original; }
});

test("Zetaris sends documented query endpoint, auth and UUID headers; verifies SELECT 1", async () => {
  const client = new ZetarisClient(zetaris, fakeFetch((url, init) => {
    assert.equal(url, `${zetaris.baseUrl}/sql-editor/sqls/run`);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("X-Org-ID"), "1");
    assert.match(headers.get("X-Request-ID")!, /^[a-f0-9-]{36}$/);
    const body = JSON.parse(String(init.body));
    assert.equal(body.sql, "SELECT 1 AS one");
    assert.equal(body.source, "SqlEditor");
    assert.equal(body.limit, 2);
    assert.match(body.queryId, /^[a-f0-9-]{36}$/);
    return json({ data: [["1"]] });
  }));
  assert.equal((await client.checkConnection()).status, "passed");
});

test("registered-view adapter escapes lot text, detects possible truncation and rejects unsafe filters", async () => {
  let requests = 0;
  const client = new ZetarisClient({ ...zetaris, views: { inventory: "recallops.inventory" } }, fakeFetch((_url, init) => {
    requests++;
    assert.equal(JSON.parse(String(init.body)).sql, `SELECT ${RECALL_OPS_COLUMNS.inventory.join(", ")} FROM recallops.inventory WHERE lot = 'LOT''7' LIMIT 1`);
    return json({ data: [RECALL_OPS_COLUMNS.inventory.map((column) => column === "lot" ? "LOT'7" : "fixture")] });
  }));
  const result = await client.queryRecallOpsView("inventory", { lot: "LOT'7" }, 1);
  assert.equal(result.possiblyTruncated, true);
  assert.deepEqual(result.columns, RECALL_OPS_COLUMNS.inventory);
  await assert.rejects(client.queryRecallOpsView("inventory", { lot: "bad\\lot" }), { code: "INVALID_FILTER" });
  await assert.rejects(client.queryRecallOpsView("shipments"), { code: "VIEW_NOT_CONFIGURED" });
  assert.equal(requests, 1);
});

test("reviewed-scope query uses its fixed 11-column contract and requires explicit configuration", async () => {
  const client = new ZetarisClient({ ...zetaris, reviewedScopeView: "recallops.reviewed_scope" }, fakeFetch((url, init) => {
    assert.equal(url, `${zetaris.baseUrl}/sql-editor/sqls/run`);
    const body = JSON.parse(String(init.body));
    assert.equal(body.sql, `SELECT ${FDA_SCOPE_COLUMNS.join(", ")} FROM recallops.reviewed_scope LIMIT 32`);
    assert.equal(body.limit, 32);
    return json({ data: [FDA_SCOPE_COLUMNS.map(column => column === "lot_number" ? "23DJA038" : "fixture")] });
  }));
  const result = await client.queryReviewedScope(32);
  assert.deepEqual(result.columns, FDA_SCOPE_COLUMNS);
  assert.equal(result.rows[0]?.[10], "23DJA038");
  assert.equal(result.possiblyTruncated, false);
  await assert.rejects(new ZetarisClient(zetaris, fakeFetch(() => { throw new Error("must not query"); })).queryReviewedScope(), { code: "VIEW_NOT_CONFIGURED" });
  assert.throws(() => new ZetarisClient({ ...zetaris, reviewedScopeView: "x; DROP TABLE y" }, fakeFetch(() => json({ data: [] }))));
});

test("Zetaris does not turn malformed response or wrong SELECT 1 into success", async () => {
  await assert.rejects(new ZetarisClient(zetaris, fakeFetch(() => json({ data: [{ one: 1 }] }))).checkConnection(), { code: "INVALID_RESPONSE" });
  await assert.rejects(new ZetarisClient(zetaris, fakeFetch(() => json({ data: [["0"]] }))).checkConnection(), { code: "SMOKE_RESULT_MISMATCH" });
  await assert.rejects(new ZetarisClient({ ...zetaris, views: { inventory: "recallops.inventory" } }, fakeFetch(() => json({ error: "query failed", data: [] }))).queryRecallOpsView("inventory"), { code: "QUERY_REJECTED" });
});

test("HTTP error bodies and reflected secret headers are excluded from evidence", async () => {
  const client = new ZetarisClient(zetaris, fakeFetch(() => json({ error: `bad token ${KEY}` }, 401, { "x-request-id": KEY })));
  try { await client.listDatasources(); assert.fail("expected failure"); }
  catch (error) {
    assert.ok(error instanceof IntegrationError);
    const safe = JSON.stringify(safeError(error));
    assert.ok(!safe.includes(KEY));
    assert.match(safe, /401/);
  }
});

test("timeout aborts a request and exposes only a safe error", async () => {
  const client = new ZetarisClient({ ...zetaris, timeoutMs: 5 }, fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error(`abort ${KEY}`)), { once: true });
  })));
  await assert.rejects(client.listDatasources(), { code: "TIMEOUT" });
});

test("Nemotron smoke uses two real-shaped tool messages and records model/provider/usage", async () => {
  let requests = 0;
  const scopes: string[] = [];
  const client = new MeterlessClient(meterless, fakeFetch((url, init) => {
    assert.equal(url, `${meterless.baseUrl}/chat/completions`);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${KEY}`);
    assert.equal(new Headers(init.headers).get("meterless-app"), "recallops");
    const scope = new Headers(init.headers).get("meterless-scope")!;
    assert.match(scope, /^user:engram:smoke:[0-9a-f-]{36}$/);
    scopes.push(scope);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, MODEL);
    requests++;
    if (requests === 1) {
      assert.equal(body.tool_choice.function.name, "inspect_smoke_fixture");
      return json({ id: "smoke-1", model: MODEL, provider: "local-fixture", meterless: {provider_model: "meterless/auto", routed_model: `openrouter/${REPORTED_MODEL}:free`, winning_route: {label: "Nemotron (free)", kind: "api", tier: "—", provider: "openrouter", model: REPORTED_MODEL}}, choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, cost: 0.001 } }, 200, { "x-request-id": "provider-request-1" });
    }
    assert.equal(body.messages[1].tool_calls[0].id, "call-1");
    assert.equal(body.messages[1].tool_calls[0].function.name, "inspect_smoke_fixture");
    assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"label":"recallops-smoke"}');
    assert.equal(body.messages[2].tool_call_id, "call-1");
    const toolResult = JSON.parse(body.messages[2].content);
    assert.equal(toolResult.safe_units, 3);
    return json({ id: "smoke-2", model: MODEL, provider: "local-fixture", meterless: {provider_model: "meterless/auto", routed_model: REPORTED_MODEL, winning_route: {provider: "openrouter", model: REPORTED_MODEL}}, choices: [{ message: { content: toolResult.result_code } }], usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } });
  }));
  const result = await client.smokeToolRoundTrip();
  assert.equal(result.toolResultObserved, true);
  assert.equal(result.calls[0].usage.total_tokens, 70);
  assert.equal(result.calls[0].provider, "local-fixture");
  assert.equal(result.calls[0].reportedModel, MODEL, "The response can echo the auto alias while actual route proves Nemotron");
  assert.equal(result.calls[0].routeAttribution.providerModel, "meterless/auto");
  assert.equal(result.calls[0].routeAttribution.routedModel, `openrouter/${REPORTED_MODEL}:free`);
  assert.equal(result.nemotronAttribution.status, "response_reports_nemotron");
  assert.equal(requests, 2);
  assert.equal(new Set(scopes).size, 2, "Each smoke inference request must use a distinct cache scope under the same app identity");
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("smoke rejects declared cache replay before accepting even a nonempty tool call", async () => {
  for (const cacheMetadata of [
    {from_cache: true},
    {cache: {status: "exact"}},
    {cache: {status: "miss"}, receipt: {cache: {status: "semantic_hard"}}},
  ]) {
    let calls = 0;
    const evidence: unknown[] = [];
    const client = new MeterlessClient(meterless, fakeFetch(() => {
      calls++;
      return json({model: MODEL, meterless: {routed_model: REPORTED_MODEL, ...cacheMetadata}, choices: [{message: {
        content: "private cached narration",
        tool_calls: [{id: "cached-call", type: "function", function: {name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}'}}],
      }}]});
    }));
    await assert.rejects(client.smokeToolRoundTrip({requireNemotronEvidence: true, onCallEvidence: item => evidence.push(item)}), {code: "MODEL_CACHE_REPLAY"});
    assert.equal(calls, 1, "A cached tool call must never authorize the continuation request");
    assert.deepEqual(evidence, []);
  }
});

test("tool smoke refuses dropped tools and unsafe tool arguments", async () => {
  const response = { model: MODEL, choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect_smoke_fixture", arguments: '{"label":"other"}' } }] } }] };
  await assert.rejects(new MeterlessClient(meterless, fakeFetch(() => json(response))).smokeToolRoundTrip(), { code: "INVALID_TOOL_ARGUMENTS" });
  await assert.rejects(new MeterlessClient(meterless, fakeFetch(() => json({ ...response, ignored_parameters: ["tool_choice"] }))).smokeToolRoundTrip(), { code: "TOOL_CAPABILITY_DROPPED" });
});

test("Meterless endpoint is explicit, normalizes pasted URLs and rejects placeholder auth", () => {
  assert.equal(normalizeMeterlessBaseUrl("127.0.0.1:8088/v1/models"), meterless.baseUrl);
  assert.equal(normalizeMeterlessBaseUrl("http://localhost:8088/healthz"), "http://localhost:8088/v1");
  assert.equal(loadIntegrationConfig({ METERLESS_RUNTIME_TOKEN: KEY, METERLESS_MODEL: MODEL }).meterless.status, "missing_config");
  assert.throws(() => new MeterlessClient({ ...meterless, token: "rt-local" }));
});

test("model discovery uses authenticated /v1/models and preserves unknown meterless IDs", async () => {
  const client = new MeterlessClient(meterless, fakeFetch((url, init) => {
    assert.equal(url, `${meterless.baseUrl}/models`);
    assert.equal(new Headers(init.headers).get("meterless-app"), "recallops");
    return json({ object: "list", data: [{ id: "meterless/auto" }, { id: "meterless/future-mode" }] });
  }));
  const result = await client.listModels();
  assert.equal(result.runtimeStatus, "online");
  assert.ok(result.modelIds.includes("meterless/future-mode"));
});

test("routing alias is never treated as underlying Nemotron evidence", async () => {
  let requests = 0;
  const client = new MeterlessClient(meterless, fakeFetch(() => {
    requests++;
    if (requests % 2 === 1) return json({ model: MODEL, choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}' } }] } }] });
    return json({ model: MODEL, choices: [{ message: { content: "RECALLOPS_SMOKE_OK_3" } }] });
  }));
  assert.equal((await client.smokeToolRoundTrip()).nemotronAttribution.status, "not_established");
  await assert.rejects(client.smokeToolRoundTrip({ requireNemotronEvidence: true }), { code: "NEMOTRON_NOT_ESTABLISHED" });
});

test("requested or echoed Nemotron model never overrides missing, non-Nemotron or mixed actual route metadata", async () => {
  for (const routes of [
    [undefined, undefined],
    ["openai/gpt-4.1", "openai/gpt-4.1"],
    [REPORTED_MODEL, "openai/gpt-4.1"],
  ]) {
    let requests = 0;
    const captured: unknown[] = [];
    const client = new MeterlessClient({...meterless, model: REPORTED_MODEL}, fakeFetch(() => {
      const route = routes[requests % 2]; requests++;
      const message = requests % 2 === 1
        ? {tool_calls: [{id: "call-1", type: "function", function: {name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}'}}]}
        : {content: "RECALLOPS_SMOKE_OK_3"};
      return json({model: REPORTED_MODEL, ...(route ? {meterless: {provider_model: "meterless/auto", routed_model: route}} : {}), choices: [{message}]});
    }));
    await assert.rejects(client.smokeToolRoundTrip({requireNemotronEvidence: true, onCallEvidence: entry => captured.push(entry)}), {code: "NEMOTRON_NOT_ESTABLISHED"});
    assert.equal(captured.length, routes[0] === REPORTED_MODEL ? 2 : 1, "Retain observed evidence, and do not send a second request after an unverified first route");
  }
});

test("actual route metadata must be coherent, model-bearing and safe to retain", () => {
  const check = (meterless: unknown) => extractMeterlessAttribution({model: REPORTED_MODEL, meterless}, KEY);
  assert.equal(check({routed_model: REPORTED_MODEL, winning_route: {model: "openai/gpt-4.1"}}).status, "conflicting_route_metadata");
  assert.equal(check({routed_model: REPORTED_MODEL, winning_route: {model: "nvidia/nemotron-other"}}).status, "conflicting_route_metadata");
  assert.equal(check({winning_route: "nemotron-lane"}).status, "missing_route_metadata");
  assert.equal(check({provider_model: "meterless/nemotron"}).status, "missing_route_metadata");
  assert.equal(check({provider_model: REPORTED_MODEL}).status, "missing_route_metadata", "Official provider_model is a routing ID even if someone names it Nemotron");
  assert.equal(check({routed_model: "not-nemotron"}).status, "non_nemotron_route");
  assert.equal(check({provider_model: {model: REPORTED_MODEL}}).status, "invalid_route_metadata");
  const secret = check({provider_model: `${REPORTED_MODEL}/${KEY}`});
  assert.equal(secret.status, "invalid_route_metadata");
  assert.ok(!JSON.stringify(secret).includes(KEY));
  assert.equal(check({winning_route: {provider: "openrouter", model: `openrouter/${REPORTED_MODEL}:free`}}).status, "response_reports_nemotron");
  assert.equal(check({provider_model: "meterless/auto", routed_model: "nvidia/nemotron-3.5-lightning-30b-a3b"}).status, "response_reports_nemotron");
});

test("HTTP200 error flags cannot pass a smoke with otherwise valid choices and attribution", async () => {
  for (const failure of [{error: {message: "private upstream failure"}}, {success: false}, {status: "failed"}]) {
    const client = new MeterlessClient(meterless, fakeFetch(() => json({...failure, model: MODEL, meterless: {routed_model: REPORTED_MODEL}, choices: [{message: {tool_calls: [{id: "call-1", type: "function", function: {name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}'}}]}}]})));
    await assert.rejects(client.smokeToolRoundTrip({requireNemotronEvidence: true}), {code: "MODEL_RESPONSE_ERROR"});
  }
});

test("failed second smoke turn retains first-call usage and never claims tool-result success", async () => {
  let requests = 0;
  const captured: unknown[] = [];
  const client = new MeterlessClient(meterless, fakeFetch(() => {
    requests++;
    if (requests === 1) return json({ model: MODEL, choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect_smoke_fixture", arguments: '{"label":"recallops-smoke"}' } }] } }], usage: { total_tokens: 17 } });
    return json({ error: `provider failure ${KEY}` }, 503);
  }));
  await assert.rejects(client.smokeToolRoundTrip({ onCallEvidence: (entry) => captured.push(entry) }), { code: "HTTP_ERROR" });
  assert.equal(captured.length, 1);
  assert.match(JSON.stringify(captured), /17/);
  assert.ok(!JSON.stringify(captured).includes(KEY));
});
