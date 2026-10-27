import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { boundMeterlessFetch } from "../../src/runtime/model.ts";
import { NATIVE_TOOL_ISOLATION_SCOPE, type NativeToolIsolationVerifier } from "../../src/runtime/native-tool-isolation.ts";

test("an invalid structured report persists feedback diagnostics and excludes rejected prose from the next request", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const model = "nvidia/nemotron-3.5-super-vl-120b-a12b";
    const store = new WorkspaceStore({ stateDir: await mkdtemp(resolve(tmpdir(), "engram-format-repair-")), model, inferenceAllowed: true });
    const runId = (await store.startInvestigation("Read the selected source.")).agentRun.runId!;
    await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Read the exact source.");
    await store.requestInvestigationReport(runId, "Required source work is complete.");
    const isolation: NativeToolIsolationVerifier = async ({baseUrl}) => ({ contract: "nightshift-m1m4-web-v1", scope: NATIVE_TOOL_ISOLATION_SCOPE, checkedAt: "2026-10-26T00:00:00Z", origin: new URL(baseUrl).origin, health: { httpStatus: 200, status: "ok", engine: "meterless", build: "m1-m4", served: "app", engineReady: true }, toolsEndpoint: { httpStatus: 501, errorCode: "not_available_in_web" }, universalRuntimeToolCountClaim: false });
    const requests: Record<string, any>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const context = JSON.parse(body.messages[1].content);
      const first = requests.length === 1;
      const packetId=body.response_format.json_schema.schema.properties.packetId.enum[0];
      const documentFindings=first?[{kind:"observation",summary:"REJECTED_PROSE_MUST_NOT_GUIDE_REPAIR",evidence:Array.from({length:6},()=>({quoteId:context.evidenceExcerpts[0].quoteId})),comparisons:[],recordCheckRefs:[]}]:[{kind:"observation",summary:"The source text is recorded.",evidence:[{quoteId:context.evidenceExcerpts[0].quoteId}],comparisons:[],recordCheckRefs:[]}];
      const content=JSON.stringify({packetId,nextStep:"answer_document_question",summary:"A source-bound report.",documentFindings});
      return Response.json({ model, meterless: { provider_model: model, routed_model: model, winning_route: { model, provider: "nvidia", kind: "api", tier: "free" } }, choices: [{finish_reason: "stop", message: { role: "assistant", content }}] });
    };
    const guarded = boundMeterlessFetch(runId, {token: "test-only", model, baseUrl: "http://127.0.0.1:1/v1"}, store, fetchImpl, isolation);
    const call = () => guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools: [{type: "function", function: {name: "report_investigation", parameters: {type: "object"}}}]})});
    const rejected = await (await call()).json() as any;
    assert.equal(rejected.choices[0].message.tool_calls[0].function.name, "investigation_report_format_feedback");
    const state = await store.activeInvestigation();
    assert.ok(state.agentRun.investigation!.formatFailures![0].codes.includes("INVALID_INVESTIGATION_REPORT_WIRE"));
    assert.equal(state.agentRun.investigation!.findings.length, 0);
    const repaired = await (await call()).json() as any;
    assert.equal(repaired.choices[0].message.tool_calls[0].function.name, "report_investigation");
    assert.equal(JSON.stringify(requests[1].messages).includes("REJECTED_PROSE_MUST_NOT_GUIDE_REPAIR"),false);
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});
