import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { boundMeterlessFetch } from "../../src/runtime/model.ts";
import { encodeClaimWire, claimResponseWireJsonSchema } from "../../src/domain/claims.ts";
import { enterPlanningPhase, readPlanningEvidence } from "./planning-phase-fixture.ts";

const actualModel = "openrouter/nvidia/nemotron-3.5-lightning:free";
const config = {token: "test-only", model: "meterless/auto", baseUrl: "http://127.0.0.1:1/v1"};
const tools = ["solve_plan", "validate_plan", "prepare_actions"].map(name => ({type: "function", function: {name, parameters: {type: "object"}}}));
const completion = (content: string | null, toolName?: string, args = "{}") => ({
  id: "checkpoint-fixture", model: "meterless/auto",
  meterless: {provider_model: "meterless/auto", routed_model: actualModel, winning_route: {model: actualModel, provider: "openrouter", kind: "api", tier: "free"}},
  choices: [{finish_reason: toolName ? "tool_calls" : "stop", message: {content, ...(toolName ? {tool_calls: [{id: `call-${toolName}`, type: "function", function: {name: toolName, arguments: args}}]} : {})}}],
});
const structuredCompletion = (content:string) => ({...completion(content),choices:[{finish_reason:"stop",message:{role:"assistant",content}}]});
async function activate(scenario?: "qa_missing") {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE; process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-checkpoint-"));
  const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
  if (scenario) await store.changeScenario(scenario);
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Bind the checkpoint protocol fixture to a real stored source before exercising workflow checkpoints.");
  return {store, runId, restore: () => {if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE; else process.env.RECALLOPS_ALLOW_INFERENCE = previous;}};
}

test("native workflow choices bind solve, validate, prepare, then structured terminal claims", async () => {
  const {store, runId, restore} = await activate();
  try {
    await enterPlanningPhase(store,runId);await readPlanningEvidence(store,runId);
    const seen: Array<{toolChoice: unknown; maxTokens: number; toolNames: string[] | undefined; responseFormat: unknown}> = [];
    const guarded = boundMeterlessFetch(runId, config, store, (async (_input, init) => {
      const body = JSON.parse(String(init?.body)); seen.push({toolChoice: body.tool_choice, maxTokens: body.max_tokens,toolNames:Array.isArray(body.tools)?body.tools.map((tool:any)=>tool.function.name):undefined,responseFormat:body.response_format});
      const required = (body.tool_choice as {function?: {name?: string}} | undefined)?.function?.name;
      if(body.response_format?.json_schema?.name==="report_claims"){
        const claims=encodeClaimWire((await store.getPreparedTerminalProjection(runId)).claimTemplate);
        return Response.json(structuredCompletion(JSON.stringify(claims)));
      }
      return Response.json(completion(required ? null : "Checked terminal explanation.", required));
    }) as typeof fetch);
    const request = async () => {const result = await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools, messages: []})}); await result.text();};

    await request(); // Required solve_plan tool call.
    await store.calculatePlan(runId); await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await request(); // Required validate_plan tool call.
    await store.recordWorkflowCheckpoint(runId, "validate_plan");
    await request(); // Required prepare_actions tool call.
    await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    await request(); // Output-format receipt; no operational tool is exposed.

    assert.deepEqual(seen.slice(0,3), [
      {toolChoice: {type: "function", function: {name: "solve_plan"}}, maxTokens: 4096,toolNames:["solve_plan","validate_plan","prepare_actions"],responseFormat:undefined},
      {toolChoice: {type: "function", function: {name: "validate_plan"}}, maxTokens: 4096,toolNames:["solve_plan","validate_plan","prepare_actions"],responseFormat:undefined},
      {toolChoice: {type: "function", function: {name: "prepare_actions"}}, maxTokens: 4096,toolNames:["solve_plan","validate_plan","prepare_actions"],responseFormat:undefined},
    ]);
    assert.equal(seen[3]!.toolChoice,undefined);
    assert.equal(seen[3]!.maxTokens,4096);
    assert.equal(seen[3]!.toolNames,undefined);
    assert.deepEqual(seen[3]!.responseFormat,{type:"json_schema",json_schema:{name:"report_claims",strict:true,schema:claimResponseWireJsonSchema}});
    assert.equal((await store.activeInvestigation()).agentRun.events.filter(e => e.tool === "model.response.nemotron").length, 4);
  } finally {restore();}
});

test("required tool must be exposed and returned before SDK access", async () => {
  const {store, runId, restore} = await activate();
  try {
    await enterPlanningPhase(store,runId);await readPlanningEvidence(store,runId);
    const calls: unknown[] = [];
    const guarded = boundMeterlessFetch(runId, config, store, (async (_input, init) => {calls.push(init); return Response.json(completion("prose only"));}) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools: []})}), {code: "WORKFLOW_TOOL_UNAVAILABLE"});
    assert.equal(calls.length, 0, "Unavailable required tool fails before network access");

    // The attempt budget is consumed by the rejected request; start a fresh run for the response check.
    await store.cancelInvestigation(runId);
    const nextRun = (await store.startInvestigation()).agentRun.runId!;
    await enterPlanningPhase(store,nextRun);await readPlanningEvidence(store,nextRun);
    const responseGuard = boundMeterlessFetch(nextRun, config, store, (async () => Response.json(completion("premature prose"))) as typeof fetch);
    await assert.rejects(responseGuard("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools})}), {code: "WORKFLOW_TOOL_CHOICE_REJECTED"});
    const events = (await store.activeInvestigation()).agentRun.events;
    assert.equal(events.filter(e => e.tool === "model.workflow.rejected").length, 1);
    assert.equal(events.filter(e => e.tool === "model.response.nemotron").length, 0);
    assert.ok(!JSON.stringify(events).includes("solve_plan"), "Public diagnostics do not reveal returned tool names");
  } finally {restore();}
});

test("a later solve invalidates earlier validation and terminal finalization fails closed", async () => {
  const {store, runId, restore} = await activate();
  try {
    await enterPlanningPhase(store,runId);await readPlanningEvidence(store,runId);
    await store.calculatePlan(runId); await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await store.recordWorkflowCheckpoint(runId, "validate_plan");
    await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    assert.equal((await store.claimModelCall(runId)).phase, "terminal");
    await store.calculatePlan(runId);
    assert.equal((await store.claimModelCall(runId)).phase, "solve", "Even an identical recalculation revokes earlier validation and preparation");
    // Re-solving the current plan is still a new authoritative checkpoint and clears downstream gates.
    await store.recordWorkflowCheckpoint(runId, "solve_plan");
    assert.deepEqual(await store.claimModelCall(runId), {maxOutputTokens: 4096, phase: "validate", requiredTool: "validate_plan", terminal: false, repair: false});
    assert.equal(await store.claimFinalization(runId, "premature terminal prose"), false);
    const status = (await store.activeInvestigation()).agentRun;
    assert.equal(status.status, "failed");
    assert.equal(status.claimAudit?.status, "unverified");
    assert.deepEqual(status.claimAudit?.rawAttempts, ["premature terminal prose"]);
  } finally {restore();}
});

test("a repair request is only accepted after preparation", async () => {
  const {store, runId, restore} = await activate();
  try {
    await store.trace(runId, "claims.repair.requested", "repair");
    await assert.rejects(store.claimModelCall(runId), /only permitted after/);
  } finally {restore();}
});

test("prepared terminal responses reject operational tool calls", async () => {
  const {store, runId, restore} = await activate();
  try {
    await enterPlanningPhase(store,runId);await readPlanningEvidence(store,runId);
    await store.calculatePlan(runId); await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await store.recordWorkflowCheckpoint(runId, "validate_plan"); await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    const guarded = boundMeterlessFetch(runId, config, store, (async () => Response.json(completion(null, "solve_plan"))) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools})}), {code: "WORKFLOW_TOOL_CHOICE_REJECTED"});
    const events = (await store.activeInvestigation()).agentRun.events;
    assert.equal(events.filter(e => e.tool === "model.workflow.rejected").length, 1);
    assert.equal(events.filter(e => e.tool === "model.response.nemotron").length, 0);
  } finally {restore();}
});

test("infeasible shortfall30 advances through validation and preparation to a terminal claim receipt", async () => {
  const {store, runId, restore} = await activate("qa_missing");
  try {
    await enterPlanningPhase(store,runId);await readPlanningEvidence(store,runId);
    const choices: unknown[] = [];
    const caps: number[] = [];
    const terminalFormats: unknown[] = [];
    const guarded = boundMeterlessFetch(runId, config, store, (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      choices.push(body.tool_choice); caps.push(body.max_tokens);terminalFormats.push(body.response_format??null);
      const name = typeof body.tool_choice === "object" ? body.tool_choice.function.name : undefined;
      if(body.response_format?.json_schema?.name==="report_claims"){
        assert.equal(body.tools,undefined);
        const claims=encodeClaimWire((await store.getPreparedTerminalProjection(runId)).claimTemplate);
        return Response.json(structuredCompletion(JSON.stringify(claims)));
      }
      return Response.json(completion(name ? null : "The checked proposal is infeasible with shortfall30.", name));
    }) as typeof fetch);
    const request = async () => {await (await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools})})).text();};
    await request();
    const solved = await store.calculatePlan(runId);
    assert.equal(solved.plan?.status, "infeasible");
    assert.equal(solved.plan?.status === "infeasible" ? solved.plan.shortfallEa : null, 30);
    await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await request();
    const validation = await store.recordWorkflowCheckpoint(runId, "validate_plan");
    assert.equal(validation.valid, false, "Infeasibility denies allocation approval, but is a completed diagnostic validation");
    await request();
    await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    await request();
    assert.deepEqual(choices, [
      {type: "function", function: {name: "solve_plan"}},
      {type: "function", function: {name: "validate_plan"}},
      {type: "function", function: {name: "prepare_actions"}},
      undefined,
    ]);
    assert.deepEqual(caps, [4096, 4096, 4096, 4096]);
    assert.deepEqual(terminalFormats[3],{type:"json_schema",json_schema:{name:"report_claims",strict:true,schema:claimResponseWireJsonSchema}});
    assert.equal((await store.receiptLedger()).receipts.length, 0);
    await assert.rejects(store.reserve("unavailable", "must-not-reserve"));
    assert.equal((await store.receiptLedger()).receipts.length, 0);
  } finally {restore();}
});
