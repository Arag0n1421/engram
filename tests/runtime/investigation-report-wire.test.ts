import test from "node:test";
import {generateText,stepCountIs} from "ai";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { EvidenceEntry } from "../../src/shared/investigation.ts";
import { bindInvestigationReportWire, compactReportWireJsonSchema, compactReportWireJsonSchemaForQuotes } from "../../src/runtime/investigation-report-wire.ts";
import { buildEvidenceExcerptCatalog, type EvidenceExcerptCatalog } from "../../src/runtime/evidence-excerpts.ts";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { boundMeterlessFetch,boundMeterlessModel } from "../../src/runtime/model.ts";
import {NATIVE_TOOL_ISOLATION_SCOPE,type NativeToolIsolationVerifier} from "../../src/runtime/native-tool-isolation.ts";
import reportInvestigationTool from "../../agent/tools/report_investigation.ts";
import reportFormatFeedbackTool from "../../agent/tools/investigation_report_format_feedback.ts";

const selected: EvidenceEntry = {
  id: "NOTICE-A",
  title: "Selected notice",
  kind: "notice",
  sourceURL: "urn:test:notice-a",
  version: 1,
  retrievedAt: "2026-10-23T00:00:00.000Z",
  content: "Exact selected quotation. A second sentence.",
  refs: ["NOTICE-A", "NOTICE-ALIAS"],
  authority: "fictional-record",
  sourceHash: createHash("sha256").update("Exact selected quotation. A second sentence.").digest("hex"),
  snapshotHash: "b".repeat(64),
  support: "Fixture evidence.",
};
const trustedRunId = "4a0d8d25-5caf-4fa3-8ecb-a2646209320d";
const selectedSnapshotHash = "b".repeat(64);
const catalog = buildEvidenceExcerptCatalog({runId:trustedRunId,snapshotHash:selectedSnapshotHash,selected:[selected],maxBytes:12_000});
const excerpt = catalog.entries[0]!;

const wire = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  nextStep: "answer_document_question",
  summary: "The answer preserves the model's wording.",
  findings: [{
    kind: "observation",
    summary: "A selected source states the relevant fact.",
    evidence: [{ quoteId: excerpt.quoteId }],
  }],
  ...overrides,
});

test("compact investigation wire binds only trusted IDs and selected hashes without changing model-authored text", () => {
  const raw = wire({
    summary: "  exact summary text  ",
    findings: [{
      kind: "missing_evidence",
      summary: "  exact finding text  ",
      question: "  Which signed label applies?  ",
      evidence: [{ quoteId: excerpt.quoteId }],
    }],
    question: "  Which source is still missing?  ",
  });
  const bound = bindInvestigationReportWire(raw, trustedRunId, selectedSnapshotHash, [selected], catalog);
  const normalized = JSON.parse(bound.argumentsText);
  assert.deepEqual(normalized, {
    runId: trustedRunId,
    disposition: "answered",
    summary: "  exact summary text  ",
    findings: [{
      id: "finding-1",
      kind: "missing_evidence",
      summary: "  exact finding text  ",
      question: "  Which signed label applies?  ",
      evidence: [{ sourceId: "NOTICE-A", sourceHash: selected.sourceHash, quote: excerpt.text }],
    }],
    question: "  Which source is still missing?  ",
  });
  assert.equal(bound.audit.wireSchemaVersion, "investigation-report-excerpt-v4");
  assert.equal(bound.audit.wireNextStep, "answer_document_question");
  assert.equal(bound.audit.mappedDisposition, "answered");
  assert.equal(bound.audit.provenance,"model-selected-source-excerpt-reference-resolved-by-server");
  assert.equal(bound.audit.quoteBindings[0]!.quoteId,excerpt.quoteId);
  assert.equal(bound.audit.quoteBindings[0]!.start,excerpt.start);
  assert.equal(bound.audit.quoteBindings[0]!.end,excerpt.end);
  assert.equal(bound.audit.rawWireBytes, Buffer.byteLength(raw));
  assert.equal(bound.audit.rawWireSha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(bound.audit.normalizedArgumentsSha256, createHash("sha256").update(bound.argumentsText).digest("hex"));
  const schema = JSON.stringify(compactReportWireJsonSchema);
  for (const forbidden of ["runId", "sourceHash", "id"]) assert.equal(schema.includes(`\"${forbidden}\"`), false);
});

test("per-request JSON schema enumerates only actually presented excerpt IDs without mutating the base",()=>{
  const schema=compactReportWireJsonSchemaForQuotes([excerpt.quoteId]);
  const quoteField=(value:any):any=>{if(!value||typeof value!=="object")return undefined;if(value.properties?.quoteId)return value.properties.quoteId;for(const child of Object.values(value)){const found=quoteField(child);if(found)return found;}return undefined;};
  assert.deepEqual(quoteField(schema).enum,[excerpt.quoteId]);
  assert.equal(quoteField(compactReportWireJsonSchema).enum,undefined);
  assert.throws(()=>compactReportWireJsonSchemaForQuotes([]),/unique presented/);
  assert.throws(()=>compactReportWireJsonSchemaForQuotes([excerpt.quoteId,excerpt.quoteId]),/unique presented/);
});

test("compact report binding rejects unknown, unselected, aliased, stale and unpresented excerpt IDs", () => {
  for (const quoteId of ["0".repeat(64), "NOTICE-ALIAS"]) {
    assert.throws(() => bindInvestigationReportWire(wire({findings: [{kind:"observation",summary:"Observed.",evidence:[{quoteId}]}]}), trustedRunId, selectedSnapshotHash, [selected], catalog));
  }
  assert.throws(() => bindInvestigationReportWire(wire(), trustedRunId, selectedSnapshotHash, [], catalog), /unselected/);
  assert.throws(() => bindInvestigationReportWire(wire(), trustedRunId, selectedSnapshotHash, [selected, {...selected}], catalog), /unique/);
  assert.throws(() => bindInvestigationReportWire(wire(), trustedRunId, "c".repeat(64), [selected], catalog), /stale/);
  const staleCatalog:EvidenceExcerptCatalog={...catalog,entries:catalog.entries.map(row=>({...row,text:"forged"}))};
  assert.throws(() => bindInvestigationReportWire(wire(),trustedRunId,selectedSnapshotHash,[selected],staleCatalog),/exact source range/);
});

test("compact report wire is strict and bounded with an explicit next-step enum", () => {
  assert.throws(() => bindInvestigationReportWire(wire({runId:"model-run-id"}), trustedRunId, selectedSnapshotHash, [selected], catalog));
  assert.throws(() => bindInvestigationReportWire(wire({findings: [{kind:"observation",summary:"Observed.",evidence:[{quoteId:excerpt.quoteId}],id:"model-finding"}]}), trustedRunId, selectedSnapshotHash, [selected], catalog));
  assert.throws(() => bindInvestigationReportWire("{".repeat(48_001), trustedRunId, selectedSnapshotHash, [selected], catalog), /48KB/);
  assert.throws(() => bindInvestigationReportWire(wire({findings: []}), trustedRunId, selectedSnapshotHash, [selected], catalog));
  assert.throws(() => bindInvestigationReportWire(wire({question:"no"}), trustedRunId, selectedSnapshotHash, [selected], catalog));
  assert.throws(() => bindInvestigationReportWire(wire({nextStep:"plan"}), trustedRunId, selectedSnapshotHash, [selected], catalog));
});

test("wire next steps map bijectively to the unchanged internal dispositions and audit both values", () => {
  const cases = [
    ["answer_document_question", "answered"],
    ["ask_operator_for_new_evidence", "needs_evidence"],
    ["continue_to_checked_calculation", "plan"],
  ] as const;
  for (const [wireNextStep, mappedDisposition] of cases) {
    const bound = bindInvestigationReportWire(wire({nextStep: wireNextStep}), trustedRunId, selectedSnapshotHash, [selected], catalog);
    assert.equal(JSON.parse(bound.argumentsText).disposition, mappedDisposition);
    assert.equal(bound.audit.wireNextStep, wireNextStep);
    assert.equal(bound.audit.mappedDisposition, mappedDisposition);
    assert.equal(bound.audit.wireSchemaVersion, "investigation-report-excerpt-v4");
  }
});

const model = { token: "test-only", model: "meterless/auto", baseUrl: "http://127.0.0.1:1/v1" };
const actualModel = "openrouter/nvidia/nemotron-3.5-lightning:free";
const verifiedIsolation:NativeToolIsolationVerifier=async({baseUrl})=>({contract:"nightshift-m1m4-web-v1",scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"2026-10-23T00:00:00.000Z",origin:new URL(baseUrl).origin,health:{httpStatus:200,status:"ok",engine:"meterless",build:"m1-m4",served:"app",engineReady:true},toolsEndpoint:{httpStatus:501,errorCode:"not_available_in_web"},universalRuntimeToolCountClaim:false});
const boundTestFetch=(runId:string,configValue:typeof model,store:WorkspaceStore,fetchImpl:typeof fetch=fetch)=>boundMeterlessFetch(runId,configValue,store,fetchImpl,verifiedIsolation);
const boundTestModel=(runId:string,configValue:typeof model,store:WorkspaceStore,fetchImpl:typeof fetch=fetch)=>boundMeterlessModel(runId,configValue,store,fetchImpl,verifiedIsolation);
const reportTools = () => ["inspect_evidence", "request_investigation_report", "report_investigation", "investigation_report_format_feedback", "what_if"].map((name) => ({
  type: "function",
  function: { name, description: "Original full report handler schema.", parameters: { type: "object", properties: { runId: { type: "string" }, sourceHash: { type: "string" }, sourceIds:{type:"array",items:{type:"string"},minItems:1,maxItems:3},reason:{type:"string",minLength:1,maxLength:300} } } },
}));
const providerReply = (id: string, args?: string, content: unknown = null) => Response.json({
  id,
  model: model.model,
  meterless: { provider_model: model.model, routed_model: actualModel, winning_route: { model: actualModel, provider: "openrouter", kind: "api", tier: "free" } },
  choices: [{ message: args === undefined ? { content: "Exploratory response" } : { content, tool_calls: [{ id: "call-id", type: "function", function: { name: "report_investigation", arguments: args } }] } }],
});
const providerToolReply = (id: string, toolName: string, argumentsText="{}") => Response.json({
  id, model: model.model,
  meterless: {provider_model: model.model, routed_model: actualModel, winning_route: {model: actualModel, provider: "openrouter", kind: "api", tier: "free"}},
  choices: [{message: {role: "assistant", content: null, tool_calls: [{id: `call-${id}`, type: "function", function: {name: toolName, arguments: argumentsText}}]}}],
});
const structuredReportReply = (id:string,content:string,usage={prompt_tokens:12,completion_tokens:8,total_tokens:20})=>Response.json({id,model:model.model,meterless:{provider_model:model.model,routed_model:actualModel,winning_route:{model:actualModel,provider:"openrouter",kind:"api",tier:"free"}},usage,choices:[{finish_reason:"stop",message:{role:"assistant",content}}]});
const reportForRequest=(body:Record<string,any>,overrides:Record<string,any>={})=>{
  const context=JSON.parse(body.messages[1].content);
  const schema=body.response_format.json_schema.schema;
  const packetId=schema.properties.packetId.enum[0];
  const quoteId=context.evidenceExcerpts[0].quoteId;
  return JSON.stringify({packetId,nextStep:"answer_document_question",summary:"The inspected evidence supports this bounded report.",documentFindings:[{kind:"observation",summary:"A source fact is stated.",evidence:[{quoteId}],comparisons:[],recordCheckRefs:[]}],...overrides});
};

test("forced reference inspection uses none and discretionary exploration uses low only for exact Super VL", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const cases = [
      {configuredModel:"nvidia/nemotron-3.5-super-vl-120b-a12b",routeModel:"nvidia/nemotron-3.5-super-vl-120b-a12b",expected:"low"},
      {configuredModel:model.model,routeModel:actualModel,expected:null},
    ];
    for (const scenario of cases) {
      const stateDir = await mkdtemp(resolve(tmpdir(), "engram-reasoning-effort-"));
      const store = new WorkspaceStore({stateDir, model:scenario.configuredModel, inferenceAllowed:true});
      const runId = (await store.startInvestigation("Read a source before reporting.")).agentRun.runId!;
      const sdkBody = JSON.stringify({messages:[{role:"user",content:"Read the source."}],tools:reportTools(),temperature:0.25,top_p:0.7});
      const outbounds:Record<string,any>[]=[];
      let calls=0;
      const provider = scenario.routeModel.startsWith("nvidia/") ? "nvidia" : "openrouter";
      const guarded = boundTestFetch(runId, {...model,model:scenario.configuredModel}, store, (async (_url, init) => {
        const outbound = JSON.parse(String(init?.body));
        outbounds.push(outbound);calls++;
        const name=calls===1?"inspect_evidence":outbound.tool_choice?.function?.name??"what_if";
        const reportParameters=outbound.tools.find((tool:any)=>tool.function.name===name)?.function?.parameters;
        const args=calls===1||name==="request_investigation_report"&&reportParameters?.required?.length===1?{runId}:name==="request_investigation_report"?{runId,reason:"Continue the active documentary investigation."}:{};
        return Response.json({
          id:"effort-request",model:scenario.configuredModel,
          meterless:{provider_model:scenario.configuredModel,routed_model:scenario.routeModel,winning_route:{model:scenario.routeModel,provider,kind:"api",tier:"free"}},
          choices:[{message:{content:null,tool_calls:[{id:`effort-${calls}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]}}],
        });
      }) as typeof fetch);
      await (await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:sdkBody})).text();
      await store.inspectSources(runId);
      await (await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:sdkBody})).text();
      assert.equal(outbounds.length,2);
      for(const [index,outbound] of outbounds.entries()){
        assert.equal(outbound.reasoning_effort,scenario.expected===null?undefined:index===0?"none":"low");
        assert.equal(outbound.temperature,0.25);
        assert.equal(outbound.top_p,0.7);
      }
      assert.deepEqual(outbounds[0]!.tool_choice,{type:"function",function:{name:"inspect_evidence"}});
      assert.equal(outbounds[1]!.tool_choice,"required");
      const events = (await store.activeInvestigation()).agentRun.events.filter((item)=>item.tool==="model.response.nemotron");
      assert.equal(events.length,2);
      assert.equal(JSON.parse(events[0]!.message).requestedEffort,scenario.expected===null?null:"none");
      assert.equal(JSON.parse(events[1]!.message).requestedEffort,scenario.expected===null?null:"low");
      assert.equal(JSON.parse(events[0]!.message).originalSdkBodySha256,createHash("sha256").update(sdkBody).digest("hex"));
      for(let index=0;index<outbounds.length;index++){
        assert.equal(JSON.parse(events[index]!.message).effectiveRequestBodySha256,createHash("sha256").update(JSON.stringify(outbounds[index])).digest("hex"),"trace hash binds the actual serialized outbound body");
      }
    }
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("documentary report-only requests bind low effort and a 16384-token Super report budget",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const configuredModel="nvidia/nemotron-3.5-super-vl-120b-a12b",stateDir=await mkdtemp(resolve(tmpdir(),"engram-report-none-"));
    const store=new WorkspaceStore({stateDir,model:configuredModel,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the source establish?")).agentRun.runId!;
    const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.")).entries[0]!;
    if(!("content" in source))throw new Error("Expected source body.");
    await store.requestInvestigationReport(runId,"Report the inspected source facts.");
    let outbound:Record<string,any>|undefined;
    let outboundWire="";
    const guarded=boundTestFetch(runId,{...model,model:configuredModel},store,(async(_url,init)=>{
      outboundWire=String(init?.body);
      const body=JSON.parse(outboundWire) as Record<string,any>;
      outbound=body;
      const content=reportForRequest(body);
      return Response.json({id:"report-none",model:configuredModel,meterless:{provider_model:configuredModel,routed_model:configuredModel,winning_route:{model:configuredModel,provider:"nvidia",kind:"api",tier:"free"}},usage:{prompt_tokens:20,completion_tokens:12,total_tokens:32},choices:[{finish_reason:"stop",message:{role:"assistant",content}}]});
    }) as typeof fetch);
    await (await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]} )})).text();
    assert.equal(outbound!.reasoning_effort,"low");assert.equal(outbound!.max_tokens,16384);
    assert.equal(outbound!.tools,undefined);assert.equal(outbound!.tool_choice,"none");assert.equal(outbound!.temperature,0);assert.equal(outbound!.parallel_tool_calls,undefined);assert.equal(outbound!.response_format.type,"json_schema");assert.equal(outbound!.response_format.json_schema.name,"engram_documentary_report");
    const event=JSON.parse((await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="model.response.nemotron").at(-1)!.message);
    assert.equal(event.requestedEffort,"low");
    assert.equal(event.effectiveRequestBodySha256,createHash("sha256").update(outboundWire).digest("hex"));
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("a provider-declared empty report response gets one separately budgeted retry with bound controls",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const configuredModel="nvidia/nemotron-3.5-super-vl-120b-a12b",stateDir=await mkdtemp(resolve(tmpdir(),"engram-empty-report-retry-"));
    const store=new WorkspaceStore({stateDir,model:configuredModel,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the source establish?" )).agentRun.runId!;
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
    await store.requestInvestigationReport(runId,"Report the inspected source facts.");
    const outbounds:Record<string,any>[]=[];let calls=0;
    const guarded=boundTestFetch(runId,{...model,model:configuredModel},store,(async(_url,init)=>{
      calls++;const body=JSON.parse(String(init?.body));outbounds.push(body);
      if(calls===1)return Response.json({error:{code:"provider_route_failed"},meterless:{meterless_detail:"private_candidate_empty_response"}},{status:502,headers:{"x-meterless-route":"nightshift-primary"}});
      const content=reportForRequest(body);
      return Response.json({id:"retry-success",model:configuredModel,meterless:{provider_model:configuredModel,routed_model:configuredModel,winning_route:{model:configuredModel,provider:"nvidia",kind:"api",tier:"paid"}},choices:[{finish_reason:"stop",message:{role:"assistant",content}}]},{headers:{"content-type":"application/json","x-meterless-route":"nightshift-primary"}});
    }) as typeof fetch);
    const response=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
    assert.equal(response.status,200);assert.equal(calls,2);
    assert.equal(outbounds[0]!.reasoning_effort,"low");assert.equal(outbounds[1]!.reasoning_effort,"low");
    assert.equal(outbounds[0]!.tool_choice,"none");assert.equal(outbounds[1]!.tool_choice,"none");
    assert.deepEqual(outbounds[1],outbounds[0],"the packet-bound request body and provider controls stay identical across retry");
    const active=await store.activeInvestigation();
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.request.started").length,2,"retry consumes a second model request budget");
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.request.started").length,1,"transport retry does not consume a second report draft");
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.retry.request.started").length,1);
    const retry=JSON.parse(active.agentRun.events.find(event=>event.tool==="model.http.retry.started")!.message);
    assert.equal(retry.attemptCount,2);assert.equal(retry.retryReason,"provider_declared_empty_upstream_response");
    assert.equal(retry.firstRouteMetadata["x-meterless-route"],"nightshift-primary");
    const success=JSON.parse(active.agentRun.events.find(event=>event.tool==="model.response.nemotron")!.message);
    assert.equal(success.retry.retryReasoningEffort,"low");assert.equal(success.requestIds["x-meterless-route"],"nightshift-primary");
    assert.equal(active.agentRun.events.some(event=>event.tool==="model.http.rejected"),false);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("empty-response retry is restricted to exact provider classification and honors cancellation",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const run=async(errorBody:Record<string,unknown>,signal?:AbortSignal,preclaimedReports=0,status=502)=>{
      const stateDir=await mkdtemp(resolve(tmpdir(),"engram-empty-report-no-retry-"));
      const store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
      const runId=(await store.startInvestigation("What does the source establish?" )).agentRun.runId!;
      await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
      await store.requestInvestigationReport(runId,"Report the inspected source facts.");
      for(let i=0;i<preclaimedReports;i++)await store.claimModelCall(runId);
      let calls=0;
      const guarded=boundTestFetch(runId,model,store,(async()=>{calls++;return Response.json(errorBody,{status});}) as typeof fetch);
      const request=guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",signal,body:JSON.stringify({tools:reportTools(),messages:[]})});
      await assert.rejects(request,{code:"HTTP_ERROR"});
      const active=await store.activeInvestigation();
      return {calls,active};
    };
    const ordinary=await run({error:{code:"provider_route_failed"}});
    assert.equal(ordinary.calls,1);assert.equal(ordinary.active.agentRun.events.filter(event=>event.tool==="model.request.started").length,1);
    assert.equal(ordinary.active.agentRun.events.some(event=>event.tool==="model.http.retry.started"),false);
    const rateLimited=await run({meterless:{meterless_detail:"private_candidate_empty_response"}},undefined,0,429);
    assert.equal(rateLimited.calls,1,"an empty marker on a rate-limit status is not retried");
    assert.equal(rateLimited.active.agentRun.events.some(event=>event.tool==="model.http.retry.started"),false);
    const cancelled=new AbortController();cancelled.abort();
    const empty=await run({meterless:{meterless_detail:"private_candidate_empty_response"}},cancelled.signal);
    assert.equal(empty.calls,1);assert.equal(empty.active.agentRun.events.filter(event=>event.tool==="model.request.started").length,1);
    assert.equal(empty.active.agentRun.events.some(event=>event.tool==="model.http.retry.started"),false);
    const exhausted=await run({meterless:{meterless_detail:"private_candidate_empty_response"}},undefined,2);
    assert.equal(exhausted.calls,2,"the third draft still receives its one transport retry");
    assert.equal(exhausted.active.agentRun.events.filter(event=>event.tool==="model.report.request.started").length,3);
    assert.equal(exhausted.active.agentRun.events.filter(event=>event.tool==="model.request.started").length,4);
    assert.equal(exhausted.active.agentRun.events.some(event=>event.tool==="model.http.retry.started"),true);
    assert.equal(exhausted.active.agentRun.events.some(event=>event.tool==="model.http.retry.budget_claiming"),true);
    const persistentStateDir=await mkdtemp(resolve(tmpdir(),"engram-empty-report-capped-retry-"));
    const persistentStore=new WorkspaceStore({stateDir:persistentStateDir,model:model.model,inferenceAllowed:true});
    const persistentRun=(await persistentStore.startInvestigation("What does the source establish?" )).agentRun.runId!;
    await persistentStore.inspectSources(persistentRun,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
    await persistentStore.requestInvestigationReport(persistentRun,"Report the inspected source facts.");
    let persistentCalls=0;
    const persistentFetch=boundTestFetch(persistentRun,model,persistentStore,(async()=>{persistentCalls++;return Response.json({meterless:{meterless_detail:"private_candidate_empty_response"}},{status:502});}) as typeof fetch);
    await assert.rejects(persistentFetch("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})}),{code:"HTTP_ERROR"});
    const persistent=await persistentStore.activeInvestigation();
    assert.equal(persistentCalls,2,"repeated empty responses stop after exactly one retry");
    assert.equal(persistent.agentRun.events.filter(event=>event.tool==="model.http.retry.started").length,1);
    const finalHttp=JSON.parse(persistent.agentRun.events.find(event=>event.tool==="model.http.rejected")!.message);
    assert.equal(finalHttp.retry.attemptCount,2);assert.equal(finalHttp.upstreamFailure.category,"empty_upstream_response");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("third report attempt can recover from an empty transport response without granting a fourth draft",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-terminal-draft-retry-"));
    const store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the source establish?")).agentRun.runId!;
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
    await store.requestInvestigationReport(runId,"Report the inspected source facts.");
    await store.claimModelCall(runId);await store.claimModelCall(runId);
    const outbounds:string[]=[];
    const guarded=boundTestFetch(runId,model,store,(async(_url,init)=>{
      const wire=String(init?.body);outbounds.push(wire);
      if(outbounds.length===1)return Response.json({meterless:{meterless_detail:"private_candidate_empty_response"}},{status:502});
      return Response.json({id:"recovered",model:actualModel,meterless:{provider_model:actualModel,routed_model:actualModel,winning_route:{model:actualModel,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"stop",message:{role:"assistant",content:reportForRequest(JSON.parse(wire))}}]},{headers:{"x-meterless-route":"nightshift-primary"}});
    }) as typeof fetch);
    const response=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
    assert.equal(response.status,200);assert.equal(outbounds.length,2);assert.equal(outbounds[0],outbounds[1]);
    const active=await store.activeInvestigation();
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.request.started").length,4);
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.request.started").length,3);
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.retry.request.started").length,1);
    await assert.rejects(store.claimModelCall(runId),/Report request budget exhausted/);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("empty report transport retry cannot exceed the overall twelve-request cap",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-global-retry-cap-"));
    const store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the source establish?")).agentRun.runId!;
    for(let i=0;i<9;i++)await store.claimModelCall(runId);
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
    await store.requestInvestigationReport(runId,"Report the inspected source facts.");
    await store.claimModelCall(runId);await store.claimModelCall(runId);
    let calls=0;const guarded=boundTestFetch(runId,model,store,(async()=>{calls++;return Response.json({meterless:{meterless_detail:"private_candidate_empty_response"}},{status:502});}) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})}),/12-request limit/);
    const active=await store.activeInvestigation();assert.equal(calls,1);
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.request.started").length,12);
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.retry.request.started").length,0);
    assert.equal(active.agentRun.status,"failed");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("interleaved report calls cannot consume another draft's retry",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-interleaved-retry-"));
    const store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the source establish?")).agentRun.runId!;
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect a documentary source.");
    await store.requestInvestigationReport(runId,"Report the inspected source facts.");
    let entered1!:()=>void,entered2!:()=>void,resolve1!:(response:Response)=>void,resolve2!:(response:Response)=>void;
    const seen1=new Promise<void>(resolve=>{entered1=resolve;}),seen2=new Promise<void>(resolve=>{entered2=resolve;});
    const pending1=new Promise<Response>(resolve=>{resolve1=resolve;}),pending2=new Promise<Response>(resolve=>{resolve2=resolve;});
    const wires:string[]=[];
    const guarded=boundTestFetch(runId,model,store,(async(_url,init)=>{
      wires.push(String(init?.body));
      if(wires.length===1){entered1();return pending1;}
      if(wires.length===2){entered2();return pending2;}
      return Response.json({id:"recovered",model:actualModel,meterless:{provider_model:actualModel,routed_model:actualModel,winning_route:{model:actualModel,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"stop",message:{role:"assistant",content:reportForRequest(JSON.parse(wires[2]!))}}]},{headers:{"x-meterless-route":"nightshift-primary"}});
    }) as typeof fetch);
    const request=()=>guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
    const first=request();await seen1;const second=request();await seen2;
    const empty=()=>Response.json({meterless:{meterless_detail:"private_candidate_empty_response"}},{status:502});
    resolve1(empty());await assert.rejects(first,/single provider-declared empty report transport retry/);
    resolve2(empty());assert.equal((await second).status,200);
    assert.equal(wires.length,3);assert.equal(wires[1],wires[2],"the second report retries only its own wire body");
    const active=await store.activeInvestigation();
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.request.started").length,2);
    assert.equal(active.agentRun.events.filter(event=>event.tool==="model.report.retry.request.started").length,1);
    assert.equal(JSON.parse(active.agentRun.events.find(event=>event.tool==="model.report.retry.request.started")!.message).reportRequestCount,2);
    await assert.rejects(store.claimModelCall(runId,{reportTransportRetry:{reportRequestNumber:2}}),/single provider-declared empty/);
    await assert.rejects(store.trace(runId,"model.report.retry.request.started","forged"),/Reserved workflow proof/);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("initial inspection exposes a runId-only backend batch, not nested report or internal feedback tools", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const stateDir = await mkdtemp(resolve(tmpdir(), "engram-report-wire-early-"));
    const store = new WorkspaceStore({ stateDir, model: model.model, inferenceAllowed: true });
    const runId = (await store.startInvestigation("What does the selected source say?")).agentRun.runId!;
    const requests: Record<string, any>[] = [];
    const guarded = boundTestFetch(runId, model, store, (async (_url, init) => {
      const body=JSON.parse(String(init?.body));requests.push(body);
      return providerToolReply("exploration","inspect_evidence",JSON.stringify({runId}));
    }) as typeof fetch);
    await (await guarded("http://127.0.0.1:1/v1/chat/completions", { method: "POST", body: JSON.stringify({ tools: reportTools(), messages: [] }) })).text();
    assert.equal(requests.length,1);
    const names=requests[0]!.tools.map((tool:any)=>tool.function.name);
    assert.ok(names.includes("inspect_evidence"));
    const inspectTool=requests[0]!.tools.find((tool:any)=>tool.function.name==="inspect_evidence");
    assert.ok(inspectTool);
    assert.deepEqual(inspectTool.function.parameters,{type:"object",properties:{runId:{type:"string",enum:[runId]}},required:["runId"],additionalProperties:false});
    assert.equal(names.includes("report_investigation"),false);
    assert.equal(names.includes("investigation_report_format_feedback"),false);
    assert.deepEqual(requests[0]!.tool_choice,{type:"function",function:{name:"inspect_evidence"}});
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("forced report-only call uses receipt-bound structured JSON and internally dispatches the report handler", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const stateDir = await mkdtemp(resolve(tmpdir(), "engram-report-wire-forced-"));
    const store = new WorkspaceStore({ stateDir, model: model.model, inferenceAllowed: true });
    const runId = (await store.startInvestigation("Inspect the source before reporting.")).agentRun.runId!;
    const source = (await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Read the selected source.")).entries[0]!;
    if (!("content" in source)) throw new Error("Expected the selected source body.");
    const requests: Record<string, any>[] = [];
    let returnedQuoteId="";
    let wireText="";
    const guarded = boundTestFetch(runId, model, store, (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if(body.response_format?.json_schema?.name==="engram_documentary_report"){const report=reportForRequest(body);wireText=report;returnedQuoteId=JSON.parse(report).documentFindings[0].evidence[0].quoteId;return structuredReportReply(`report-${requests.length}`,report);}
      return providerToolReply(`explore-${requests.length}`,body.tools.find((tool:any)=>tool.function.name==="request_investigation_report")?.function.name??body.tools[0].function.name);
    }) as typeof fetch);
    await store.requestInvestigationReport(runId,"Required source retrieval is complete.");
    let response: Response | undefined;
    for (let index = 0; index < 1; index++) response = await guarded("http://127.0.0.1:1/v1/chat/completions", { method: "POST", body: JSON.stringify({ tools: reportTools(), messages: [] }) });
    assert.ok(response);
    const forced = requests[0]!;
    assert.equal(forced.tools,undefined);assert.equal(forced.tool_choice,"none");assert.equal(forced.temperature,0);assert.equal(forced.parallel_tool_calls,undefined);
    assert.equal(forced.response_format.type,"json_schema");assert.equal(forced.response_format.json_schema.name,"engram_documentary_report");
    const quoteIdField=(value:any):any=>{if(!value||typeof value!=="object")return undefined;if(value.properties?.quoteId)return value.properties.quoteId;for(const child of Object.values(value)){const found=quoteIdField(child);if(found)return found;}return undefined;};
    const forcedContext = JSON.parse(forced.messages[1].content);
    assert.deepEqual(quoteIdField(forced.response_format.json_schema.schema).enum,forcedContext.evidenceExcerpts.map((entry:any)=>entry.quoteId));
    assert.equal(JSON.stringify(forced.response_format.json_schema.schema).includes(source.id),false);
    assert.equal(Object.hasOwn(forcedContext, "sourceIndex"), false);
    assert.equal(Object.hasOwn(forcedContext, "operationalRecords"), false);
    assert.equal(Object.hasOwn(forcedContext,"operationalReadsAllowed"),false);
    assert.equal(Object.hasOwn(forcedContext,"metadataIndexIncluded"),false);
    assert.equal(Object.hasOwn(forcedContext,"selectedSourceExcerpts"),false,"Report mode uses one presented catalog, without duplicate exploratory spans.");
    assert.ok(forcedContext.requiredProofs.selectedNoticeCount>0);
    assert.equal(Object.hasOwn(forcedContext,"selected"),false);
    assert.equal(forcedContext.selectedSources.length,1);
    assert.equal(forcedContext.selectedSources[0].sourceHash,undefined,"Full source hashes stay private in the alias-based report packet.");
    assert.equal(JSON.stringify(forcedContext).includes(source.sourceHash),false);
    assert.equal(forcedContext.selectedSources[0].content,undefined);
    assert.equal(forcedContext.evidenceExcerpts.every((entry:any)=>source.content.slice(entry.start,entry.end)===entry.text),true);
    assert.ok(Buffer.byteLength(JSON.stringify(forcedContext))<=40_000);
    assert.ok(Buffer.byteLength(JSON.stringify(forced))<=48_000);
    const normalizedResponse = await response.json() as any;
    assert.equal(normalizedResponse.choices[0].message.content, null, "Raw JSON is cleared before internal handler dispatch.");
    const args = JSON.parse(normalizedResponse.choices[0].message.tool_calls[0].function.arguments);
    assert.equal(args.runId, runId);
    assert.equal(args.findings.length,1,"Checked record results are attached globally by the server, not restated as model-authored sections.");
    assert.equal(args.findings[0].id, "finding-1");
    assert.equal(args.findings[0].evidence[0].sourceHash, source.sourceHash);
    assert.deepEqual(args.recordReceiptIds,[]);
    const boundExcerpt=forcedContext.evidenceExcerpts.find((entry:any)=>entry.quoteId===returnedQuoteId);
    assert.equal(args.findings[0].evidence[0].quote,boundExcerpt.text);
    const originalSchema=(reportInvestigationTool as unknown as {inputSchema:{parse(value:unknown):unknown}}).inputSchema;
    assert.doesNotThrow(()=>originalSchema.parse(args));
    assert.throws(()=>originalSchema.parse({...args,runId:"invalid-run-id"}));
    assert.throws(()=>originalSchema.parse({...args,findings:[{...args.findings[0],evidence:[{...args.findings[0].evidence[0],sourceHash:"bad"}]}]}));
    const quoteCheck=await store.submitInvestigationReport(runId,{...args,findings:[{...args.findings[0],evidence:[{...args.findings[0].evidence[0],quote:"not an exact quote"}]}]});
    assert.equal(quoteCheck.valid,false);
    assert.ok(quoteCheck.codes.includes("quote_not_found"));
    const trace = JSON.parse((await store.activeInvestigation()).agentRun.events.filter((event) => event.tool === "model.response.nemotron").at(-1)!.message);
    assert.equal(trace.investigationContextVersion, "receipt-backed-documentary-report-v20");
    assert.equal(trace.investigationContextBytes, Buffer.byteLength(JSON.stringify(forcedContext)));
    assert.equal(trace.investigationReportWire.provenance,"model-selected-atomic-record-receipts-and-documentary-quotes");
    assert.equal(trace.investigationReportWire.transport,"structured-json-receipt-report-to-bound-handler");
    assert.equal(trace.investigationReportWire.internalDispatchTool,"report_investigation");
    assert.equal(trace.investigationReportWire.internalDispatchIdServerGenerated,true);
    assert.match(trace.investigationReportWire.internalDispatchId,/^internal-/);
    assert.equal(trace.investigationReportWire.rawWireBytes,Buffer.byteLength(wireText));
    assert.equal(trace.investigationReportWire.rawWireSha256,createHash("sha256").update(wireText).digest("hex"));
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("invalid report JSON is durably recorded and internally dispatches feedback before a fresh budgeted report",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-report-format-retry-")),store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Answer from the inspected document.")).agentRun.runId!;
    const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect the requested source.")).entries[0]!;
    if(!("content" in source))throw new Error("Expected source body.");
    const marker=await store.requestInvestigationReport(runId,"Report the selected source content.");
    const bodies:Record<string,any>[]=[];let calls=0;
    const guarded=boundTestFetch(runId,model,store,(async(_url,init)=>{
      calls++;const body=JSON.parse(String(init?.body));bodies.push(body);
      const content=calls===1?"```json\\n{broken\\n```":reportForRequest(body);
      return structuredReportReply(`format-${calls}`,content,{prompt_tokens:20,completion_tokens:calls===1?4:10,total_tokens:calls===1?24:30});
    }) as typeof fetch);
    const first=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
    const firstJson=await first.json() as any;
    const internal=firstJson.choices[0].message.tool_calls[0];
    assert.equal(internal.function.name,"investigation_report_format_feedback");
    assert.ok(internal.id.startsWith("internal-"));
    assert.equal(firstJson.choices[0].message.content,null);
    assert.deepEqual(firstJson.usage,{prompt_tokens:20,completion_tokens:4,total_tokens:24});
    const feedbackArgs=JSON.parse(internal.function.arguments);
    assert.equal(feedbackArgs.runId,runId);assert.equal(feedbackArgs.snapshotHash,marker.snapshotHash);
    assert.equal(feedbackArgs.failureSha256,createHash("sha256").update("```json\\n{broken\\n```").digest("hex"));
    assert.doesNotThrow(()=>((reportFormatFeedbackTool as any).inputSchema.parse(feedbackArgs)));
    const ack=await store.acknowledgeInvestigationReportFormatFailure(feedbackArgs.runId,feedbackArgs.snapshotHash,feedbackArgs.failureSha256);
    assert.equal(ack.feedbackRecorded,true);
    const second=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
    const secondJson=await second.json() as any;
    assert.equal(secondJson.choices[0].message.tool_calls[0].function.name,"report_investigation");
    assert.ok(secondJson.choices[0].message.tool_calls[0].id.startsWith("internal-"));
    assert.equal(calls,2);assert.equal(bodies.length,2);
    assert.equal(bodies.every(body=>body.tools===undefined&&body.tool_choice==="none"&&body.temperature===0&&body.parallel_tool_calls===undefined&&body.response_format?.type==="json_schema"),true);
    assert.equal(JSON.stringify(bodies[1]!.messages).includes("```json\\n{broken"),false,"The invalid raw response is not recycled into the next report prompt.");
    const run=(await store.activeInvestigation()).agentRun;
    assert.equal(run.events.filter(event=>event.tool==="model.report.request.started").length,2);
    assert.equal(run.investigation?.formatFailures?.length,1);
    assert.equal(run.investigation?.formatFailures?.[0]?.rawContent,"```json\\n{broken\\n```");
    assert.equal(run.investigation?.formatFailures?.[0]?.rawContentHash,feedbackArgs.failureSha256);
    const invalidTrace=JSON.parse(run.events.find(event=>event.tool==="model.workflow.rejected")!.message);
    assert.equal(invalidTrace.investigationReportWireProvenance,"structured-json-invalid-to-internal-format-feedback");
    assert.equal(invalidTrace.responseShape.toolCalls,0);
    assert.equal(invalidTrace.internalDispatchTool,"investigation_report_format_feedback");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("the original SDK tool registry executes hidden format feedback and the report dispatch",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-report-sdk-feedback-")),store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Answer from the inspected source.")).agentRun.runId!;
    const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect the source before reporting.")).entries[0]!;
    if(!("content" in source))throw new Error("Expected selected source body.");
    await store.requestInvestigationReport(runId,"Report the inspected source.");
    const outboundNames:string[][]=[];let requests=0;
    const fetchImpl=(async(_url,init)=>{
      requests++;
      const body=JSON.parse(String(init?.body));outboundNames.push((body.tools??[]).map((item:any)=>item.function.name));
      const content=requests===1?"{malformed":reportForRequest(body);
      return structuredReportReply(`sdk-${requests}`,content,{prompt_tokens:30,completion_tokens:requests===1?5:12,total_tokens:requests===1?35:42});
    }) as typeof fetch;
    const feedbackDefinition={description:"Internal format feedback test tool.",inputSchema:(reportFormatFeedbackTool as any).inputSchema,execute:async(args:any)=>store.acknowledgeInvestigationReportFormatFailure(args.runId,args.snapshotHash,args.failureSha256)};
    const reportDefinition={description:"Internal report handler test tool.",inputSchema:(reportInvestigationTool as any).inputSchema,execute:async(args:any)=>{const{runId:boundRunId,...report}=args;return store.submitInvestigationReport(boundRunId,report);}};
    const result=await generateText({model:boundTestModel(runId,model,store,fetchImpl),prompt:"Run the bounded documentary report.",tools:{investigation_report_format_feedback:feedbackDefinition,report_investigation:reportDefinition},stopWhen:stepCountIs(2),maxRetries:0});
    assert.equal(requests,2);
    assert.equal(outboundNames.every(names=>!names.includes("investigation_report_format_feedback")),true);
    assert.equal(outboundNames.every(names=>names.length===0),true);
    assert.equal(result.usage.inputTokens,60);
    assert.equal(result.usage.outputTokens,17);
    assert.equal(result.usage.totalTokens,77);
    const run=(await store.activeInvestigation()).agentRun;
    assert.equal(run.investigation?.formatFailures?.length,1);
    assert.ok(run.investigation?.feedback.some(item=>item.codes.includes("INVALID_INVESTIGATION_REPORT_WIRE")));
    assert.equal(run.investigation?.disposition,"answered");
    assert.equal(run.investigation?.findings.length,1);
    assert.equal(run.events.filter(event=>event.tool==="model.report.request.started").length,2);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("three invalid report-only attempts consume the existing report budget",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-report-format-cap-")),store=new WorkspaceStore({stateDir,model:model.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Report the inspected source.")).agentRun.runId!;
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect one canonical source.");
    await store.requestInvestigationReport(runId,"The selected evidence is ready for reporting.");
    let calls=0;
    const guarded=boundTestFetch(runId,model,store,(async()=>{calls++;return structuredReportReply(`invalid-${calls}`,"not a JSON object");}) as typeof fetch);
    for(let attempt=0;attempt<3;attempt++){
      const response=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
      const args=JSON.parse((await response.json() as any).choices[0].message.tool_calls[0].function.arguments);
      await store.acknowledgeInvestigationReportFormatFailure(args.runId,args.snapshotHash,args.failureSha256);
    }
    assert.equal(calls,3);
    const run=(await store.activeInvestigation()).agentRun;
    assert.equal(run.events.filter(event=>event.tool==="model.report.request.started").length,3);
    assert.equal(run.investigation?.disposition,null);
    assert.equal(run.investigation?.findings.length,0);
    assert.equal(run.status,"failed");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("report-only parser rejects malformed content, native calls, refusal, batches, wrong routes, and cache replays", async (t) => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    type GuardCase = {name:string;expectedCode?:string;feedback?:boolean;formatFailure?:boolean;contentType?:string;mutate:(frame:any,unselectedId:string)=>void};
    const cases:GuardCase[] = [
      { name: "unselected source", feedback:true, mutate: (frame) => { frame.choices[0].message.content = JSON.stringify({...JSON.parse(frame.choices[0].message.content),documentFindings:[{kind:"observation",summary:"Finding.",evidence:[{quoteId:"E999999"}],comparisons:[],recordCheckRefs:[]}]}); } },
      { name: "legacy model-authored recordSections protocol", feedback:true, mutate: (frame) => { frame.choices[0].message.content = JSON.stringify({...JSON.parse(frame.choices[0].message.content),recordSections:{legacy:{kind:"observation",summary:"Old protocol must be rejected."}}}); } },
      { name: "oversized raw JSON", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].message.content = "é".repeat(24_001); } },
      { name: "complex content", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].message.content = {text:"not ordinary assistant text"}; } },
      { name: "nonempty content array", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].message.content = [{type:"text",text:"not a plain text field"}]; } },
      { name: "refusal", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].message.refusal = "Refused."; } },
      { name: "malformed JSON", feedback:true, mutate: (frame) => { frame.choices[0].message.content = "{malformed"; } },
      { name: "unsupported SSE report format", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", contentType:"text/event-stream", mutate: (frame) => { frame.choices[0].message.content = "{malformed"; } },
      { name: "unsolicited native tool call", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].finish_reason="tool_calls";frame.choices[0].message.tool_calls=[{id:"native",type:"function",function:{name:"report_investigation",arguments:"{}"}}];frame.choices[0].message.content=null; } },
      { name: "multiple choices", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices.push(structuredClone(frame.choices[0])); } },
      { name: "legacy function call", expectedCode: "WORKFLOW_TOOL_CHOICE_REJECTED", mutate: (frame) => { frame.choices[0].message.function_call = {name:"legacy",arguments:"{}"}; } },
      { name: "wrong route", expectedCode: "NEMOTRON_NOT_ESTABLISHED",formatFailure:false, mutate: (frame) => { frame.meterless.routed_model = "openai/unverified"; frame.meterless.winning_route.model = "openai/unverified"; } },
      { name: "cache replay", expectedCode: "MODEL_CACHE_REPLAY",formatFailure:false, mutate: (frame) => { frame.meterless.from_cache = true; } },
    ];
    for (const scenario of cases) await t.test(scenario.name, async () => {
      const stateDir = await mkdtemp(resolve(tmpdir(), "engram-report-wire-guard-"));
      const store = new WorkspaceStore({ stateDir, model: model.model, inferenceAllowed: true });
      const runId = (await store.startInvestigation("Read a selected source.")).agentRun.runId!;
      const registry = (await store.getWorkspace()).investigationEvidence!;
      const selectedEntry = registry.entries.find((entry) => entry.id === "FDA-REQUIRED-ACTIONS")!;
      const unselectedId = registry.entries.find((entry) => entry.id !== selectedEntry.id)!.id;
      await store.inspectSources(runId, [selectedEntry.id], "Inspect the canonical source.");
      await store.requestInvestigationReport(runId,"Report from the selected canonical source.");
      const guarded = boundTestFetch(runId, model, store, (async (_url,init) => {
        const body=JSON.parse(String(init?.body));
        const frame = {id:"guard-response",model:model.model,meterless:{provider_model:model.model,routed_model:actualModel,winning_route:{model:actualModel,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"stop",message:{role:"assistant",content:reportForRequest(body)}}]};
        scenario.mutate(frame, unselectedId);
        if(scenario.contentType==="text/event-stream")return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
        return Response.json(frame);
      }) as typeof fetch);
      const responsePromise=guarded("http://127.0.0.1:1/v1/chat/completions", {method:"POST",body:JSON.stringify({tools:reportTools(),messages:[]})});
      if(scenario.feedback){
        const response=await responsePromise,call=(await response.json() as any).choices[0].message.tool_calls[0];
        assert.equal(call.function.name,"investigation_report_format_feedback");
        assert.doesNotThrow(()=>((reportFormatFeedbackTool as any).inputSchema.parse(JSON.parse(call.function.arguments))));
      }else await assert.rejects(responsePromise, {code:scenario.expectedCode});
      const run = (await store.activeInvestigation()).agentRun;
      assert.equal(run.investigation?.disposition, null);
      assert.equal(run.investigation?.findings.length, 0);
      assert.equal(run.events.some((event) => event.tool === "model.response.nemotron"), false);
      assert.equal(run.investigation?.formatFailures?.length??0,scenario.formatFailure===false?0:1);
    });
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});
