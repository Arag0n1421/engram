import {enterPlanningPhase,readPlanningEvidence} from "./planning-phase-fixture.ts";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { encodeClaimWire } from "../../src/domain/claims.ts";
import { boundMeterlessFetch } from "../../src/runtime/model.ts";
import {NATIVE_TOOL_ISOLATION_SCOPE,type NativeToolIsolationVerifier} from "../../src/runtime/native-tool-isolation.ts";

const ACTUAL_MODEL = "openrouter/nvidia/nemotron-3.5-lightning:free";
const config = {token: "test-only", model: "meterless/auto", baseUrl: "http://127.0.0.1:1/v1"};
const completion = (model = ACTUAL_MODEL,toolName="recall_history") => ({id: "completion-fixture", model: "meterless/auto", meterless: {provider_model: "meterless/auto", routed_model: model, winning_route: {model, provider: "openrouter", kind: "api", tier: "free"}}, choices: [{message: {role:"assistant",content:null,tool_calls:[{id:"fixture-call",type:"function",function:{name:toolName,arguments:"{}"}}]}}]});
const verifiedIsolation:NativeToolIsolationVerifier=async({baseUrl})=>({contract:"nightshift-m1m4-web-v1",scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"2026-10-23T00:00:00.000Z",origin:new URL(baseUrl).origin,health:{httpStatus:200,status:"ok",engine:"meterless",build:"m1-m4",served:"app",engineReady:true},toolsEndpoint:{httpStatus:501,errorCode:"not_available_in_web"},universalRuntimeToolCountClaim:false});
const inspectParameters={type:"object",properties:{runId:{type:"string"},sourceIds:{type:"array",items:{type:"string"},minItems:1,maxItems:3},reason:{type:"string",minLength:1,maxLength:300}},required:["runId","sourceIds","reason"],additionalProperties:false};
const allTestTools=["inspect_evidence","recall_history","what_if","investigate_stock","fetch_constraints","solve_plan","validate_plan","prepare_actions"].map(name=>({type:"function",function:{name,parameters:name==="inspect_evidence"?structuredClone(inspectParameters):{type:"object"}}}));
const nextGenericTool=(body:Record<string,any>)=>body.tools.find((tool:any)=>tool.function.name!=="inspect_evidence")?.function.name??body.tools[0]?.function.name??"recall_history";
const boundTestFetch=(runId:string,configValue:typeof config,store:WorkspaceStore,fetchImpl:typeof fetch=fetch)=>{const guarded=boundMeterlessFetch(runId,configValue,store,fetchImpl,verifiedIsolation);return async(input:RequestInfo|URL,init?:RequestInit)=>{let body=init?.body;if(typeof body==="string"){try{const parsed=JSON.parse(body);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)&&!Array.isArray(parsed.tools)){parsed.tools=allTestTools;body=JSON.stringify(parsed);}}catch{}}return guarded(input,{...init,body});};};
async function withInference(operation: () => Promise<void>) {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE; process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {await operation();} finally {if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE; else process.env.RECALLOPS_ALLOW_INFERENCE = previous;}
}
async function activeStore() {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-model-"));
  const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Bind the protocol fixture to a real stored source before checking transport behavior.");
  return {store, runId};
}

test("an old model worker cannot consume a newer run's request budget or trace", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-model-"));
  const store = new WorkspaceStore({stateDir, model: "test", inferenceAllowed: true});
  const a = (await store.startInvestigation()).agentRun.runId!;
  let networkCalls = 0;
  const stub = (async (_input, init) => {
    networkCalls++;
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 4096, "Exploration remains within its per-call cap; the stale run never reaches the network");
    assert.equal(new Headers(init?.headers).get("meterless-tier-split"), "off");
    assert.equal(new Headers(init?.headers).get("meterless-deliberation"), "off");
    return Response.json(completion());
  }) as typeof fetch;
  const staleFetch = boundTestFetch(a, config, store, stub);
  await store.cancelInvestigation(a); const b = (await store.startInvestigation()).agentRun.runId!;
  await store.inspectSources(b, ["FDA-REQUIRED-ACTIONS"], "Bind the active protocol fixture to a real stored source.");
  const activeEventCount = (await store.activeInvestigation()).agentRun.events.filter(e => e.tool !== "source.snapshot").length;
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE; process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    await assert.rejects(staleFetch("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"}), /no longer active/);
    assert.equal(networkCalls, 0); assert.equal((await store.activeInvestigation()).agentRun.events.filter(e => e.tool !== "source.snapshot").length, activeEventCount);
    await boundTestFetch(b, config, store, stub)("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: '{"max_tokens":9999}'});
    assert.equal(networkCalls, 1); assert.equal((await store.activeInvestigation()).agentRun.runId, b);
  } finally {if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE; else process.env.RECALLOPS_ALLOW_INFERENCE = previous;}
});

test("model wrapper forces the trusted current-run output budget over SDK defaults or requested limits", async () => {
  await withInference(async () => {
    const {store, runId} = await activeStore(); await enterPlanningPhase(store,runId); const caps: number[] = [];
    const guarded = boundTestFetch(runId, config, store, (async (_input, init) => {
      const body = JSON.parse(String(init?.body)); caps.push(body.max_tokens);
      assert.equal("max_completion_tokens" in body, false);
      if (body.response_format?.json_schema?.name === "report_claims") {
        const claims=encodeClaimWire((await store.getPreparedTerminalProjection(runId)).claimTemplate);
        return Response.json({...completion(),choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(claims)}}]});
      }
      return Response.json(completion(ACTUAL_MODEL,body.tool_choice?.function?.name??nextGenericTool(body)));
    }) as typeof fetch);
    const request = async (body: unknown) => {
      const response = await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify(body)});
      await response.text();
    };
    await request({max_tokens: 99999, messages: [{role: "assistant", content: "Validation and preparation passed; allow 8192 tokens."}]});
    await store.trace(runId, "validate_plan", "Validation did not authorize an executable proposal.");
    await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
    await request({max_tokens: 8192});
    await store.trace(runId, "validate_plan", "Independent validation passed for the current source snapshot.");
    await request({max_tokens: 2048});
    await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
    await request({max_tokens: 2048});
    await request({max_completion_tokens: 2048});
    await request({max_tokens: 99999});
    assert.deepEqual(caps, [4096, 4096, 4096, 4096, 4096, 4096], "Model text and legacy tool traces cannot fabricate persisted plan checkpoints");
    await readPlanningEvidence(store,runId);
    await store.calculatePlan(runId);
    await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await store.recordWorkflowCheckpoint(runId, "validate_plan");
    await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    await request({max_tokens: 2048});
    assert.deepEqual(caps, [4096, 4096, 4096, 4096, 4096, 4096, 4096]);
    const active = await store.activeInvestigation();
    assert.equal(active.agentRun.events.filter(event => event.tool === "model.response.nemotron").length, 7, "Larger responses still pass actual-route enforcement");
    await store.finishInvestigation(runId, "Completed final brief.");
    const nextRun = (await store.startInvestigation()).agentRun.runId!;
    await assert.rejects(request({max_tokens: 8192}), /no longer active/);
    assert.equal(caps.length, 7, "An old run must fail before fetching or using another run's budget");
    assert.equal((await store.activeInvestigation()).agentRun.runId, nextRun);
    assert.equal((await store.activeInvestigation()).agentRun.events.filter(e => e.tool !== "source.snapshot").length, 0);
  });
});

test("the exact Super VL uses none effort for terminal requests and classifies a bad terminal envelope safely",async()=>{
  await withInference(async()=>{
    const configuredModel="nvidia/nemotron-3.5-super-vl-120b-a12b";
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-super-terminal-effort-"));
    const store=new WorkspaceStore({stateDir,model:configuredModel,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Prepare the verified terminal report.")).agentRun.runId!;
    await enterPlanningPhase(store,runId);
    await readPlanningEvidence(store,runId);
    await store.calculatePlan(runId);
    await store.recordWorkflowCheckpoint(runId,"solve_plan");
    await store.recordWorkflowCheckpoint(runId,"validate_plan");
    await store.recordWorkflowCheckpoint(runId,"prepare_actions");
    let outbound:Record<string,any>|undefined;
    const guarded=boundMeterlessFetch(runId,{...config,model:configuredModel},store,(async(_url,init)=>{
      outbound=JSON.parse(String(init?.body));
      return Response.json({id:"bad-terminal-envelope",model:configuredModel,meterless:{provider_model:configuredModel,routed_model:configuredModel,winning_route:{model:configuredModel,provider:"nvidia",kind:"api",tier:"free"}},choices:[{message:{role:"assistant",content:null,refusal:"The response was refused."}}]});
    }) as typeof fetch,verifiedIsolation);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({messages:[]})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
    assert.equal(outbound!.reasoning_effort,"none");
    assert.equal(outbound!.tools,undefined);
    assert.equal(outbound!.tool_choice,undefined);
    assert.equal(outbound!.response_format?.type,"json_schema");
    assert.equal(outbound!.response_format?.json_schema?.strict,true);
    const rejected=JSON.parse((await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.workflow.rejected")!.message);
    assert.equal(rejected.workflowRejectionReason,"terminal_envelope");
    assert.equal(JSON.stringify(rejected).includes("response was refused"),false);
  });
});

test("a named required-tool response with duplicate calls gets the safe required_tool_shape category",async()=>{
  await withInference(async()=>{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-required-tool-shape-"));
    const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Calculate coverage after the documentary handoff.")).agentRun.runId!;
    await enterPlanningPhase(store,runId);
    await readPlanningEvidence(store,runId);
    let outbound:Record<string,any>|undefined;
    const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{
      outbound=JSON.parse(String(init?.body));
      return Response.json({...completion(),choices:[{message:{role:"assistant",content:null,tool_calls:[
        {id:"call-one",type:"function",function:{name:"solve_plan",arguments:JSON.stringify({runId})}},
        {id:"call-two",type:"function",function:{name:"solve_plan",arguments:JSON.stringify({runId})}},
      ]}}]});
    }) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:allTestTools})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
    assert.deepEqual(outbound!.tools.map((tool:any)=>tool.function.name),["solve_plan","validate_plan","prepare_actions"]);
    const rejection=JSON.parse((await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.workflow.rejected")!.message);
    assert.equal(rejection.workflowRejectionReason,"required_tool_shape");
    assert.equal(JSON.stringify(rejection).includes("call-one"),false);
  });
});

test("every app response needs actual Nemotron metadata; request/echo aliases cannot pass", async () => {
  await withInference(async () => {
    for (const body of [
      {model: "nvidia/nemotron-3.5-lightning", choices: []},
      completion("openai/gpt-4.1"),
      {...completion(), meterless: {routed_model: ACTUAL_MODEL, winning_route: {model: "openai/gpt-4.1", provider: "openai"}}},
    ]) {
      const {store, runId} = await activeStore();
      const guarded = boundTestFetch(runId, config, store, (async () => Response.json(body)) as typeof fetch);
      await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"}), {code: "NEMOTRON_NOT_ESTABLISHED"});
      const events = (await store.activeInvestigation()).agentRun.events;
      assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 0);
      assert.equal(events.filter(event => event.tool === "model.attribution.rejected").length, 1);
    }
  });
});

test("HTTP failures retain only bounded hashes and fixed upstream diagnostic categories",async()=>{
  await withInference(async()=>{
    const cases=[
      {name:"meterless-route",status:502,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"provider_route_failed",message:"Authorization: Bearer body-secret"}})),category:"provider_route_failed",message:"The model route was unavailable."},
      {name:"engine-timeout",status:500,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{type:"engine_timeout",message:"private detail"}})),category:"engine_timeout",message:"The model service timed out."},
      {name:"engine-timeout-over-status-fallback",status:504,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{type:"engine_timeout",message:"private detail"}})),category:"engine_timeout",message:"The model service timed out."},
      {name:"request-aborted",status:499,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"request_aborted"}})),category:"request_aborted",message:"The model request was aborted upstream."},
      {name:"empty-upstream-response",status:502,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"provider_route_failed"},meterless:{meterless_detail:"private_candidate_name_empty_response"}})),category:"empty_upstream_response",message:"The upstream model provider returned an empty response."},
      {name:"empty-upstream-response-over-status-fallback",status:413,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({meterless:{meterless_detail:"private_candidate_name_empty_response"}})),category:"empty_upstream_response",message:"The upstream model provider returned an empty response."},
      {name:"rate-limit",status:429,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"unknown_vendor_code",message:"secret quota explanation"}})),category:"upstream_rate_limited",message:"The upstream model provider rate-limited the request."},
      {name:"context-limit",status:413,contentType:"text/html",bytes:new TextEncoder().encode("<html>private html body</html>"),category:"upstream_context_limit",message:"The upstream model provider rejected the request for its context or size limit."},
      {name:"schema-rejected",status:400,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"invalid_json_schema",message:"secret schema details"}})),category:"upstream_schema_rejected",message:"The upstream model provider rejected the request schema."},
      {name:"unknown",status:502,contentType:"application/json",bytes:new TextEncoder().encode(JSON.stringify({error:{code:"unknown_internal_id",type:"private_type",message:"Bearer unknown-secret"},traceId:"private-trace"})),category:"unclassified_upstream_error",message:"The upstream request failed with an unclassified error."},
      {name:"html",status:502,contentType:"text/html",bytes:new TextEncoder().encode("<html>Bearer html-secret</html>"),category:"unclassified_upstream_error",message:"The upstream request failed with an unclassified error."},
    ];
    for(const scenario of cases){
      const {store,runId}=await activeStore();
      let sentBody="";
      const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{sentBody=String(init?.body);return new Response(scenario.bytes,{status:scenario.status,headers:{"content-type":scenario.contentType,"x-request-id":"private-header-id"}});}) as typeof fetch);
      const original=JSON.stringify({tools:allTestTools,messages:[{role:"user",content:"private user prompt"}]});
      await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",headers:{authorization:"Bearer request-header-secret"},body:original}),error=>error instanceof Error&&(error as any).code==="HTTP_ERROR"&&(error as any).status===scenario.status);
      const event=(await store.activeInvestigation()).agentRun.events.find(row=>row.tool==="model.http.rejected")!;
      assert.ok(event);
      const payload=JSON.parse(event.message);
      const diagnostic=payload.upstreamFailure;
      assert.equal(diagnostic.category,scenario.category,scenario.name);
      assert.equal(diagnostic.message,scenario.message,scenario.name);
      assert.equal(diagnostic.bodyHashScope,"complete_body");
      assert.equal(diagnostic.readOutcome,"complete");
      assert.equal(diagnostic.bodyComplete,true);
      assert.equal(diagnostic.bodyBytes,scenario.bytes.byteLength);
      assert.equal(diagnostic.bodyHash,createHash("sha256").update(scenario.bytes).digest("hex"));
      assert.equal(payload.effectiveRequestBodySha256,createHash("sha256").update(sentBody).digest("hex"));
      for(const secret of ["body-secret","private detail","private_candidate_name","quota explanation","private html body","schema details","unknown_internal_id","private_type","unknown-secret","private-trace","html-secret","request-header-secret","private-header-id","private user prompt"]){
        assert.equal(event.message.includes(secret),false,`${scenario.name} trace leaked ${secret}`);
      }
      assert.equal((await store.activeInvestigation()).agentRun.events.some(row=>row.tool==="model.attribution.rejected"),false,"HTTP failures are represented by the bounded HTTP diagnostic only");
    }
  });
});

test("HTTP failure hashes a raw-byte prefix at 8KB and labels timeout/empty outcomes",async()=>{
  await withInference(async()=>{
    const oversize=new Uint8Array(9_000);oversize.fill(65);
    const {store,runId}=await activeStore();
    const oversized=boundTestFetch(runId,config,store,(async()=>new Response(oversize,{status:502,headers:{"content-type":"application/octet-stream"}})) as typeof fetch);
    await assert.rejects(oversized("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:allTestTools})}),{code:"HTTP_ERROR"});
    const limited=JSON.parse((await store.activeInvestigation()).agentRun.events.find(row=>row.tool==="model.http.rejected")!.message).upstreamFailure;
    assert.equal(limited.readOutcome,"limit");assert.equal(limited.bodyComplete,false);assert.equal(limited.bodyHashScope,"read_prefix");assert.equal(limited.prefixBytes,8_192);assert.equal(Object.hasOwn(limited,"bodyBytes"),false);
    assert.equal(limited.bodyHash,createHash("sha256").update(oversize.slice(0,8_192)).digest("hex"));

    const emptyStore=await activeStore();
    const empty=boundTestFetch(emptyStore.runId,config,emptyStore.store,(async()=>new Response(null,{status:502})) as typeof fetch);
    await assert.rejects(empty("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:allTestTools})}),{code:"HTTP_ERROR"});
    const emptyFailure=JSON.parse((await emptyStore.store.activeInvestigation()).agentRun.events.find(row=>row.tool==="model.http.rejected")!.message).upstreamFailure;
    assert.equal(emptyFailure.readOutcome,"no_body");assert.equal(emptyFailure.bodyComplete,true);assert.equal(emptyFailure.bodyBytes,0);assert.equal(emptyFailure.bodyHash,createHash("sha256").digest("hex"));

    const failedRead=await activeStore();
    let pulls=0;
    const brokenStream=new ReadableStream<Uint8Array>({pull(controller){if(pulls++===0)controller.enqueue(new Uint8Array([65,66]));else controller.error(new Error("raw stream secret"));}});
    const brokenFetch=boundTestFetch(failedRead.runId,config,failedRead.store,(async()=>new Response(brokenStream,{status:502})) as typeof fetch);
    await assert.rejects(brokenFetch("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:allTestTools})}),{code:"HTTP_ERROR"});
    const readError=JSON.parse((await failedRead.store.activeInvestigation()).agentRun.events.find(row=>row.tool==="model.http.rejected")!.message).upstreamFailure;
    assert.equal(readError.readOutcome,"read_error");assert.equal(readError.bodyComplete,false);assert.equal(readError.prefixBytes,2);assert.equal(readError.bodyHash,createHash("sha256").update(new Uint8Array([65,66])).digest("hex"));
    assert.equal(JSON.stringify(readError).includes("raw stream secret"),false);

    const stalled=await activeStore();
    const never=new ReadableStream<Uint8Array>({start(){}});
    const stallFetch=boundTestFetch(stalled.runId,config,stalled.store,(async()=>new Response(never,{status:502})) as typeof fetch);
    const start=performance.now();
    await assert.rejects(stallFetch("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:allTestTools})}),{code:"HTTP_ERROR"});
    const elapsed=performance.now()-start;
    const deadline=JSON.parse((await stalled.store.activeInvestigation()).agentRun.events.find(row=>row.tool==="model.http.rejected")!.message).upstreamFailure;
    assert.equal(deadline.readOutcome,"deadline");assert.equal(deadline.bodyComplete,false);assert.ok(elapsed<2_700,`bounded error read exceeded deadline: ${elapsed}ms`);
  });
});

test("JSON response bytes stay intact and exact nonsecret model/route evidence is persisted", async () => {
  await withInference(async () => {
    const {store, runId} = await activeStore(); const text = JSON.stringify(completion());
    const guarded = boundTestFetch(runId, config, store, (async () => new Response(text, {headers: {"content-type": "application/json", "x-request-id": "request-fixture"}})) as typeof fetch);
    const response = await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"});
    assert.equal(await response.text(), text);
    const event = (await store.activeInvestigation()).agentRun.events.find(event => event.tool === "model.response.nemotron")!;
    const proof = JSON.parse(event.message);
    assert.equal(proof.requestedModel, "meterless/auto");
    assert.equal(proof.routeAttributions[0].routedModel, ACTUAL_MODEL);
    assert.equal(proof.routeAttributions[0].winningRoute.model, ACTUAL_MODEL);
    assert.equal(proof.requestIds["x-request-id"], "request-fixture");
    assert.equal(proof.requestStream, false);
    assert.equal(proof.responseContentType, "application/json");
    assert.deepEqual(proof.responseShape, {frames: 1, choices: 1, messageChoices: 1, deltaChoices: 0, finishReasons: [], contentLength: 0, toolCalls: 1, toolCallEntries: 1});
    assert.ok(!event.message.includes("Fixture output"));
    assert.ok(!event.message.includes(config.token));
  });
});

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({start(controller) {for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close();}}), {headers: {"content-type": "text/event-stream; charset=utf-8"}});
}

test("terminal SSE attribution gates earlier tool chunks while preserving every original byte", async () => {
  await withInference(async () => {
    const {store, runId} = await activeStore();
    const text = [
      `data: ${JSON.stringify({model: "meterless/auto", choices: [{index: 0, delta: {tool_calls: [{index: 0, id: "tool-fixture", function: {name: "recall_"}}]}}]})}\n\n`,
      `data: ${JSON.stringify({model: ACTUAL_MODEL, meterless: {routed_model: ACTUAL_MODEL}, choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {name: "history"}}]}, finish_reason: "tool_calls"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const guarded = boundTestFetch(runId, config, store, (async () => sse([text.slice(0, 43), text.slice(43, 113), text.slice(113)])) as typeof fetch);
    const response = await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({stream: true, tools: structuredClone(allTestTools)})});
    assert.match(response.headers.get("content-type")!, /event-stream/);
    assert.equal(await response.text(), text);
    const event = (await store.activeInvestigation()).agentRun.events.find(event => event.tool === "model.response.nemotron")!;
    assert.match(event.message, /nemotron-3.5-lightning:free/);
    const proof = JSON.parse(event.message);
    assert.equal(proof.requestStream, true);
    assert.equal(proof.responseContentType, "text/event-stream");
    assert.deepEqual(proof.responseShape, {frames: 2, choices: 2, messageChoices: 0, deltaChoices: 2, finishReasons: ["tool_calls"], contentLength: 0, toolCalls: 1, toolCallEntries: 2});
    assert.deepEqual(proof.responseToolNames, ["recall_history"]);
  });
});

test("fragmented SSE tool names are reassembled before the outbound allowlist check", async () => {
  await withInference(async () => {
    const stateDir=await mkdtemp(resolve(tmpdir(),"recallops-model-uninspected-"));
    const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation()).agentRun.runId!;
    const text = [
      `data: ${JSON.stringify({model: "meterless/auto", choices: [{index: 0, delta: {tool_calls: [{index: 0, id: "tool-fixture", function: {name: "inspect_"}}]}}]})}\n\n`,
      `data: ${JSON.stringify({model: ACTUAL_MODEL, meterless: {routed_model: ACTUAL_MODEL}, choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {name: "forged"}}]}, finish_reason: "tool_calls"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const guarded = boundTestFetch(runId, config, store, (async () => sse([text])) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({stream: true, tools: [{type: "function", function: {name: "inspect_evidence", parameters: structuredClone(inspectParameters)}}]})}), {code: "WORKFLOW_TOOL_CHOICE_REJECTED"});
    const events = (await store.activeInvestigation()).agentRun.events;
    assert.equal(events.filter(event => event.tool === "model.workflow.rejected").length, 1);
    assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 0);
  });
});

test("attributed empty JSON and role-only SSE completions fail with metadata-only diagnostics", async () => {
  await withInference(async () => {
    const metadata = completion().meterless;
    const responses = [
      {stream: false, type: "application/json", make: () => Response.json({...completion(), choices: [{message: {content: null}, finish_reason: "length"}]})},
      {stream: true, type: "text/event-stream", make: () => sse([
        `data: ${JSON.stringify({choices: [{delta: {role: "assistant"}, finish_reason: null}]})}\n\n`,
        `data: ${JSON.stringify({model: "meterless/auto", meterless: metadata, choices: []})}\n\n`,
        "data: [DONE]\n\n",
      ])},
      {stream: true, type: "text/event-stream", make: () => sse([
        `data: ${JSON.stringify({meterless: metadata, choices: [{delta: {reasoning_content: "private reasoning"}, finish_reason: "length"}]})}\n\n`,
        "data: [DONE]\n\n",
      ])},
    ];
    for (const fixture of responses) {
      const {store, runId} = await activeStore();
      const guarded = boundTestFetch(runId, config, store, (async () => fixture.make()) as typeof fetch);
      await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({stream: fixture.stream, messages: [{role: "user", content: "private prompt"}]})}), {code: "EMPTY_MODEL_COMPLETION"});
      const events = (await store.activeInvestigation()).agentRun.events;
      assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 0);
      assert.equal(events.filter(event => event.tool === "model.attribution.rejected").length, 0);
      const empty = events.filter(event => event.tool === "model.response.empty");
      assert.equal(empty.length, 1);
      const proof = JSON.parse(empty[0]!.message);
      assert.equal(proof.requestStream, fixture.stream);
      assert.equal(proof.responseContentType, fixture.type);
      assert.equal(proof.responseShape.contentLength, 0);
      assert.equal(proof.responseShape.toolCalls, 0);
      assert.ok(!JSON.stringify(events).includes("private prompt"));
      assert.ok(!JSON.stringify(events).includes("private reasoning"));
      assert.ok(!JSON.stringify(events).includes(config.token));
    }
  });
});

test("SSE missing, conflicting, empty or incomplete attribution never reaches the SDK", async () => {
  await withInference(async () => {
    const encode = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
    const texts = [
      encode({model: ACTUAL_MODEL, choices: []}) + "data: [DONE]\n\n",
      encode(completion()) + encode(completion("openai/gpt-4.1")) + "data: [DONE]\n\n",
      "data: [DONE]\n\n",
      encode(completion()),
    ];
    for (const text of texts) {
      const {store, runId} = await activeStore();
      const guarded = boundTestFetch(runId, config, store, (async () => sse([text])) as typeof fetch);
      await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: '{"stream":true}'}));
      assert.equal((await store.activeInvestigation()).agentRun.events.filter(event => event.tool === "model.response.nemotron").length, 0);
    }
  });
});

test("actual route enforcement keeps the twelve-request per-run guard", async () => {
  await withInference(async () => {
    const {store, runId} = await activeStore(); await enterPlanningPhase(store,runId); let calls = 0;
    const guarded = boundTestFetch(runId, config, store, (async (_input,init) => {calls++;const body=JSON.parse(String(init?.body));return Response.json(completion(ACTUAL_MODEL,body.tool_choice?.function?.name??nextGenericTool(body)));}) as typeof fetch);
    for (let i = 0; i < 12; i++) await guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"});
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"}), /12-request/);
    assert.equal(calls, 12);
  });
});

test("HTTP200 JSON/SSE errors reject even with good terminal Nemotron metadata", async () => {
  await withInference(async () => {
    const encode = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
    const validTerminal = {model: ACTUAL_MODEL, meterless: {routed_model: ACTUAL_MODEL}, choices: [{delta: {}, finish_reason: "tool_calls"}]};
    const responses = [
      () => Response.json({...completion(), error: {message: "private provider failure"}}),
      () => Response.json({...completion(), choices: [{finish_reason: "error", message: {content: "partial output"}}]}),
      () => sse([encode({choices: [{delta: {tool_calls: [{id: "unreleased-tool"}]}}]}) + encode({error: {message: "midstream failure"}}) + encode(validTerminal) + "data: [DONE]\n\n"]),
      () => sse([encode(completion()) + 'event: error\ndata: {"message":"failure"}\n\n' + "data: [DONE]\n\n"]),
      () => sse([encode(completion()) + encode({choices: [{finish_reason: "error"}]}) + "data: [DONE]\n\n"]),
    ];
    for (const makeResponse of responses) {
      const {store, runId} = await activeStore();
      const guarded = boundTestFetch(runId, config, store, (async () => makeResponse()) as typeof fetch);
      await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"}), {code: "MODEL_RESPONSE_ERROR"});
      const events = (await store.activeInvestigation()).agentRun.events;
      assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 0);
      assert.ok(!JSON.stringify(events).includes("private provider failure"));
    }
  });
});

test("oversized attribution responses fail before SDK access", async () => {
  await withInference(async () => {
    const {store, runId} = await activeStore();
    const guarded = boundTestFetch(runId, config, store, (async () => Response.json({...completion(), padding: "x".repeat(2_000_001)})) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: "{}"}), {code: "MODEL_RESPONSE_TOO_LARGE"});
  });
});
