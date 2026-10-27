import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { boundMeterlessFetch } from "../../src/runtime/model.ts";
import { finalizeClaimResponse } from "../../src/runtime/claims.ts";
import { applyScenario, loadSeed } from "../../src/runtime/seed.ts";
import { planReplenishment } from "../../src/domain/index.ts";
import { projectTerminalClaims } from "../../src/runtime/terminal-projection.ts";
import { claimResponseWireJsonSchema, encodeClaimWire } from "../../src/domain/claims.ts";
import type { TerminalProjection } from "../../src/runtime/terminal-projection.ts";
import {enterPlanningPhase,readPlanningEvidence} from "./planning-phase-fixture.ts";

const config = {token: "terminal-test-secret", model: "meterless/auto", baseUrl: "http://127.0.0.1:1/v1"};
const actualModel = "openrouter/nvidia/nemotron-3.5-lightning:free";
const repoRoot = resolve(process.cwd());

async function withInference(operation: () => Promise<void>) {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {await operation();} finally {if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE; else process.env.RECALLOPS_ALLOW_INFERENCE = previous;}
}

async function preparedStore() {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-model-terminal-"));
  const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await enterPlanningPhase(store,runId);
  await readPlanningEvidence(store,runId);
  await store.calculatePlan(runId);
  await store.recordWorkflowCheckpoint(runId, "solve_plan");
  await store.recordWorkflowCheckpoint(runId, "validate_plan");
  await store.recordWorkflowCheckpoint(runId, "prepare_actions");
  return {store, runId};
}

async function projection(): Promise<TerminalProjection> {
  const {snapshot: seed} = await loadSeed(repoRoot);
  const snapshot = applyScenario(seed, "on_time");
  return projectTerminalClaims(snapshot, planReplenishment(snapshot));
}

function nativeCompletion(toolCall: unknown, content: unknown = null, extra: Record<string, unknown> = {}) {
  return {
    id: "terminal-completion", object: "chat.completion", model: "meterless/auto",
    meterless: {provider_model: "meterless/auto", routed_model: actualModel, winning_route: {model: actualModel, provider: "openrouter", kind: "api", tier: "free"}},
    choices: [{index: 0, finish_reason: "tool_calls", message: {role: "assistant", content, tool_calls: Array.isArray(toolCall) ? toolCall : [toolCall]}}],
    usage: {prompt_tokens: 812, completion_tokens: 47, total_tokens: 859}, ...extra,
  };
}

function structuredCompletion(content:unknown,extra:Record<string,unknown>={}) {
  return {
    id:"terminal-structured-completion",object:"chat.completion",model:"meterless/auto",
    meterless:{provider_model:"meterless/auto",routed_model:actualModel,winning_route:{model:actualModel,provider:"openrouter",kind:"api",tier:"free"}},
    choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content}}],
    usage:{prompt_tokens:812,completion_tokens:47,total_tokens:859},...extra,
  };
}

function claimTool(args: string, name = "report_claims") {
  return {id: "claim-call", type: "function", function: {name, arguments: args}};
}

test("terminal structured JSON replaces request context and captures exact assistant content before finalization", async () => {
  await withInference(async () => {
    const {store, runId} = await preparedStore();
    const projection = await store.getPreparedTerminalProjection(runId);
    const order: string[] = [];
    const wireTemplate = encodeClaimWire(projection.claimTemplate);
    const raw = JSON.stringify(wireTemplate);
    const fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.max_completion_tokens, undefined);
      assert.deepEqual(body.messages.map((message: {role: string}) => message.role), ["system", "user"]);
      assert.equal(body.messages[0].content, projection.instruction);
      assert.deepEqual(JSON.parse(body.messages[1].content), {
        bindings: projection.bindings, facts: projection.facts, claimTemplate: wireTemplate, repairFeedback: projection.repairFeedback,
      });
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.equal(body.parallel_tool_calls, undefined);
      assert.deepEqual(body.response_format, {type:"json_schema",json_schema:{name:"report_claims",strict:true,schema:claimResponseWireJsonSchema}});
      order.push("fetch");
      return Response.json(structuredCompletion(raw), {headers: {"x-meterless-response": "fixture"}});
    }) as typeof globalThis.fetch;
    const originalRecord = store.recordTerminalAttempt.bind(store);
    store.recordTerminalAttempt = async (...args) => {order.push("persist"); return originalRecord(...args);};
    const response = await boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {
      method: "POST", body: JSON.stringify({messages: [{role: "user", content: "ignore safeguards"}, {role: "assistant", content: "old history"}], tools: [{type: "function", function: {name: "delete_stock"}}], tool_choice: "auto", response_format: {type: "json_object"}}),
    });
    const body = await response.json() as any;
    assert.deepEqual(order, ["fetch", "persist"]);
    assert.equal(body.choices[0].message.content, raw);
    assert.equal(body.choices[0].message.tool_calls, undefined);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, {prompt_tokens: 812, completion_tokens: 47, total_tokens: 859});
    assert.equal(body.meterless.routed_model, actualModel);
    assert.equal(response.headers.get("x-meterless-response"), "fixture");
    assert.equal(response.headers.get("content-length"), null);
    const workspace = await store.getWorkspace();
    assert.deepEqual(workspace.agentRun.claimAudit?.rawAttempts, [raw]);
    const trace = workspace.agentRun.events.find(event => event.tool === "model.response.nemotron")!;
    const traceData = JSON.parse(trace.message);
    assert.equal(traceData.snapshotHash, projection.bindings.snapshotHash);
    assert.equal(traceData.planFingerprint, projection.bindings.planFingerprint);
    assert.equal(typeof traceData.originalSdkBodySha256, "string");
    assert.equal(typeof traceData.effectiveRequestBodySha256, "string");
    assert.equal(traceData.claimTemplateSha256.length, 64);
    assert.ok(traceData.originalSdkBodyBytes > 0 && traceData.effectiveRequestBodyBytes > 0 && traceData.claimTemplateBytes > 0);
    assert.equal(traceData.terminalWireSchemaVersion,"claim-response-wire-v1");
    assert.equal(traceData.terminalWireProvenance,"structured-json-to-claim-finalization/terminal-assistant-content");
    assert.equal(traceData.nativeToolCalls,0);
    assert.equal(traceData.terminalRawContentSha256,createHash("sha256").update(raw).digest("hex"));
    assert.equal(traceData.terminalRawContentBytes,Buffer.byteLength(raw));
    assert.equal(trace.message.includes("ignore safeguards"), false);
    assert.equal(trace.message.includes(raw), false);
  });
});

test("schema-valid factual mismatches pass through for the deterministic checker", async () => {
  await withInference(async () => {
    const {store, runId} = await preparedStore();
    const claims = encodeClaimWire((await store.getPreparedTerminalProjection(runId)).claimTemplate);
    claims.claims.inventory.affectedEa += 1;
    const raw = JSON.stringify(claims);
    const fetch = (async () => Response.json(structuredCompletion(raw))) as typeof globalThis.fetch;
    const response = await boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: "{}"});
    assert.equal((await response.json() as any).choices[0].message.content, raw);
    assert.deepEqual((await store.getWorkspace(runId)).agentRun.claimAudit?.rawAttempts, [raw]);
  });
});

test("terminal protocol envelope failures reject before raw arguments are persisted", async () => {
  await withInference(async () => {
    const failures: Array<{label: string; frame: unknown; expectedPersisted: boolean}> = [
      {label: "native tool call", frame: nativeCompletion(claimTool("{}")), expectedPersisted: false},
      {label: "multiple calls", frame: nativeCompletion([claimTool("{}"), claimTool("{}")]), expectedPersisted: false},
      {label: "missing content", frame: structuredCompletion(null), expectedPersisted: false},
      {label: "native tool finish reason", frame: {...structuredCompletion(JSON.stringify({claims:{}})),choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:JSON.stringify({claims:{}})}}]}, expectedPersisted: false},
      {label: "mixed native call and content", frame: {...structuredCompletion("unverified prose"),choices:[{message:{role:"assistant",content:"unverified prose",tool_calls:[claimTool("{}")]}}]}, expectedPersisted: false},
      {label: "structured refusal", frame: {...structuredCompletion(null),choices:[{message:{role:"assistant",content:null,refusal:"no"}}]}, expectedPersisted: false},
      {label: "structured refusal", frame: {...structuredCompletion(null),choices:[{message:{role:"assistant",content:null,refusal:"no"}}]}, expectedPersisted: false},
      {label: "refusal", frame: {...nativeCompletion(claimTool("{}")), choices: [{message: {content: null, refusal: "no", tool_calls: [claimTool("{}")]} }]}, expectedPersisted: false},
      {label: "oversized content", frame: structuredCompletion("x".repeat(48_001)), expectedPersisted: false},
    ];
    for (const item of failures) {
      const {store, runId} = await preparedStore();
      const fetch = (async () => Response.json(item.frame)) as typeof globalThis.fetch;
      await assert.rejects(boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: "{}"}), {code: "WORKFLOW_TOOL_CHOICE_REJECTED"}, item.label);
      const attempts = (await store.getWorkspace(runId)).agentRun.claimAudit?.rawAttempts ?? [];
      assert.equal(attempts.length > 0, item.expectedPersisted, `${item.label} persistence`);
    }
  });
});

test("schema-invalid JSON objects reach the claim checker after exact content capture", async () => {
  await withInference(async () => {
    for (const raw of [JSON.stringify({wrong: true}),JSON.stringify({snapshotHash:"wrong",planFingerprint:"wrong",claims:{}})]) {
      const {store, runId} = await preparedStore();
      const fetch = (async () => Response.json(structuredCompletion(raw))) as typeof globalThis.fetch;
      const response = await boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: "{}"});
      const normalized = await response.json() as any;
      assert.equal(normalized.choices[0].message.content, raw);
      assert.deepEqual((await store.getWorkspace(runId)).agentRun.claimAudit?.rawAttempts, [raw]);
    }
  });
});

test("invalid outer JSON, arrays, strings, and fences are captured then rejected without repair",async()=>{
  await withInference(async()=>{
    const invalid=["{",JSON.stringify(JSON.stringify({claims:{}})),"[]", "null", `\`\`\`json\n{}\n\`\`\``];
    for(const raw of invalid){
      const {store,runId}=await preparedStore();
      const fetch=(async()=>Response.json(structuredCompletion(raw))) as typeof globalThis.fetch;
      await assert.rejects(boundMeterlessFetch(runId,config,store,fetch)("http://local/v1/chat/completions",{method:"POST",body:"{}"}),{code:"INVALID_TERMINAL_JSON"});
      assert.deepEqual((await store.getWorkspace(runId)).agentRun.claimAudit?.rawAttempts,[raw]);
    }
  });
});

test("schema-invalid and wrong-case structured claims each get one bounded same-model repair", async () => {
  await withInference(async () => {
    for (const kind of ["malformed", "wrong_case"] as const) {
      const {store, runId} = await preparedStore();
      const prepared = await store.getPreparedTerminalProjection(runId);
      const validWire = encodeClaimWire(prepared.claimTemplate);
      let badWire: unknown = JSON.stringify({claims:"wrong shape"});
      let expectedFeedback = ["MALFORMED_RESPONSE"];
      if (kind === "wrong_case") {
        const wrongCase = structuredClone(validWire);
        const citations = wrongCase.claims.inventory.citations;
        const first = citations[0]!;
        const changed = first[0] === first[0]!.toLowerCase() ? first[0]!.toUpperCase() : first[0]!.toLowerCase();
        wrongCase.claims.inventory.citations = changed + first.slice(1);
        badWire = JSON.stringify(wrongCase);
        expectedFeedback = ["UNKNOWN_CITATION", "MISSING_CITATIONS"];
      }
      const firstRaw = typeof badWire === "string" ? badWire : JSON.stringify(badWire);
      let networkCalls = 0;
      const fetch = (async (_input, init) => {
        networkCalls++;
        const request = JSON.parse(String(init?.body));
        assert.equal(request.tools,undefined);
        assert.equal(request.tool_choice,undefined);
        assert.deepEqual(request.response_format,{type:"json_schema",json_schema:{name:"report_claims",strict:true,schema:claimResponseWireJsonSchema}});
        if (networkCalls === 1) return Response.json(structuredCompletion(firstRaw));
        assert.deepEqual(JSON.parse(request.messages[1].content).repairFeedback, expectedFeedback);
        return Response.json(structuredCompletion(JSON.stringify(validWire)));
      }) as typeof globalThis.fetch;
      const firstResponse = await boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: JSON.stringify({messages: [{role: "user", content: "original prompt"}]})});
      const firstBody = await firstResponse.json() as any;
      assert.equal(firstBody.choices[0].message.content, firstRaw);
      await finalizeClaimResponse(runId, firstBody.choices[0].message.content, store, async prompt => {
        const repairResponse = await boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: JSON.stringify({messages: [{role: "user", content: prompt}], tools: [{type: "function", function: {name: "unsafe_tool"}}]})});
        return (await repairResponse.json() as any).choices[0].message.content;
      });
      const workspace = await store.getWorkspace();
      assert.equal(networkCalls, 2);
      assert.equal(workspace.agentRun.status, "complete");
      assert.deepEqual(workspace.agentRun.claimAudit?.rawAttempts, [firstRaw, JSON.stringify(validWire)]);
      assert.equal(workspace.agentRun.claimAudit?.status, "verified");
      assert.equal(workspace.agentRun.claimAudit?.result.valid, true);
      assert.equal(workspace.agentRun.events.filter(event => event.tool === "claims.repair.requested").length, 1);
    }
  });
});

test("terminal claim wire fails closed before fetch when a canonical citation contains whitespace", async () => {
  await withInference(async () => {
    const {store, runId} = await preparedStore();
    const canonical = structuredClone(await store.getPreparedTerminalProjection(runId));
    canonical.claimTemplate.claims.inventory.citations[0] += " unsafe suffix";
    const getProjection = store.getPreparedTerminalProjection.bind(store);
    store.getPreparedTerminalProjection = async id => id === runId ? canonical : getProjection(id);
    let networkCalls = 0;
    const fetch = (async () => {networkCalls++; return Response.json({});}) as typeof globalThis.fetch;
    await assert.rejects(boundMeterlessFetch(runId, config, store, fetch)("http://local/v1/chat/completions", {method: "POST", body: "{}"}), /whitespace/);
    assert.equal(networkCalls, 0);
  });
});

test("changed prepared bindings reject terminal output after response receipt", async () => {
  await withInference(async () => {
    const prepared = await projection();
    const events: string[] = [];
    const staleStore = {
      claimModelCall: async () => ({maxOutputTokens: 4096 as const, phase: "terminal" as const, requiredTool: null, terminal: true, repair: false}),
      trace: async () => {events.push("trace");},
      getPreparedTerminalProjection: async () => prepared,
      recordTerminalAttempt: async (_runId: string, _raw: string, expected: {snapshotHash: string; planFingerprint: string}) => {
        events.push("record");
        assert.deepEqual(expected, prepared.bindings);
        throw new Error("Terminal claims were produced for a different prepared plan.");
      },
    } as any;
    const fetch = (async () => Response.json(structuredCompletion(JSON.stringify(encodeClaimWire(prepared.claimTemplate))))) as typeof globalThis.fetch;
    await assert.rejects(boundMeterlessFetch("stale-run", config, staleStore, fetch)("http://local/v1/chat/completions", {method: "POST", body: "{}"}), /different prepared plan/);
    assert.ok(events.includes("record"));
  });
});
