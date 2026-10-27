import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {resolve} from "node:path";
import {tmpdir} from "node:os";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {boundMeterlessFetch} from "../../src/runtime/model.ts";
import {NATIVE_TOOL_ISOLATION_SCOPE,type NativeToolIsolationVerifier} from "../../src/runtime/native-tool-isolation.ts";
import {READY_REPORT_REQUEST_REASON,requestInvestigationReportWithReason} from "../../agent/tools/request_investigation_report.ts";
const config={token:"test-only",model:"meterless/auto",baseUrl:"http://127.0.0.1:1/v1"};
const actual="openrouter/nvidia/nemotron-3.5-lightning:free";
const verifiedIsolation:NativeToolIsolationVerifier=async({baseUrl})=>({contract:"nightshift-m1m4-web-v1",scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"2026-10-23T00:00:00.000Z",origin:new URL(baseUrl).origin,health:{httpStatus:200,status:"ok",engine:"meterless",build:"m1-m4",served:"app",engineReady:true},toolsEndpoint:{httpStatus:501,errorCode:"not_available_in_web"},universalRuntimeToolCountClaim:false});
const boundTestFetch=(runId:string,configValue:typeof config,store:WorkspaceStore,fetchImpl:typeof fetch=fetch)=>boundMeterlessFetch(runId,configValue,store,fetchImpl,verifiedIsolation);
const reportForRequest=(body:Record<string,any>)=>{const context=JSON.parse(body.messages[1].content),schema=body.response_format.json_schema.schema;return JSON.stringify({packetId:schema.properties.packetId.enum[0],nextStep:"answer_document_question",summary:"A bounded report for the request-budget test.",documentFindings:[{kind:"observation",summary:"The selected source is represented.",evidence:[{quoteId:context.evidenceExcerpts[0].quoteId}],comparisons:[],recordCheckRefs:[]}]});};
const inspectionParameters={type:"object",properties:{runId:{type:"string"},sourceIds:{type:"array",items:{type:"string"},minItems:1,maxItems:3},reason:{type:"string",minLength:1,maxLength:300}},required:["runId","sourceIds","reason"],additionalProperties:false};
const testTools=(names:string[])=>names.map(name=>({type:"function",function:{name,parameters:name==="inspect_evidence"?structuredClone(inspectionParameters):{type:"object"}}}));

test("generic required tool choice rejects a text-only preliminary response and fails closed when filtering removes all tools",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-generic-required-zero-")),store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("What does the inspected source establish?")).agentRun.runId!;
    await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Read the canonical source before continuing.");
    let posted=0;let outbound:Record<string,any>|undefined;
    const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{posted++;outbound=JSON.parse(String(init?.body));return Response.json({id:"text-only",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{message:{role:"assistant",content:"A text-only answer must not end this investigation turn."}}]});}) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence","what_if"])})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
    assert.equal(posted,1);assert.equal(outbound!.tool_choice,"required");
    const verifiedTrace=(await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.native_tool_isolation.verified")!;
    assert.equal(JSON.parse(verifiedTrace.message).scope,NATIVE_TOOL_ISOLATION_SCOPE);
    assert.equal(JSON.parse(verifiedTrace.message).universalRuntimeToolCountClaim,false);
    const rejectedWorkflow=(await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.workflow.rejected")!;
    assert.equal(JSON.parse(rejectedWorkflow.message).nativeToolIsolationProofScope,NATIVE_TOOL_ISOLATION_SCOPE);
    assert.equal(JSON.parse(rejectedWorkflow.message).workflowRejectionReason,"zero_tool_calls");
    const noTools=boundTestFetch(runId,config,store,(async()=>{throw new Error("Provider must not be called when no allowed tools remain.");}) as typeof fetch);
    await assert.rejects(noTools("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:[{type:"function",function:{name:"report_investigation",parameters:{type:"object"}}}]})}),{code:"WORKFLOW_TOOL_UNAVAILABLE"});

    const blockedStateDir=await mkdtemp(resolve(tmpdir(),"engram-isolation-preflight-failure-")),blockedStore=new WorkspaceStore({stateDir:blockedStateDir,model:config.model,inferenceAllowed:true});
    const blockedRunId=(await blockedStore.startInvestigation("Inspect a source first.")).agentRun.runId!;
    await blockedStore.inspectSources(blockedRunId);
    let providerPosts=0;
    const blocked=boundMeterlessFetch(blockedRunId,config,blockedStore,(async()=>{providerPosts++;return Response.json({});}) as typeof fetch,async()=>{throw Object.assign(new Error("isolation unverified"),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});});
    await assert.rejects(blocked("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["what_if"])})}),/isolation unverified/);
    assert.equal(providerPosts,0);
    const blockedEvents=(await blockedStore.activeInvestigation()).agentRun.events;
    assert.equal(blockedEvents.filter(event=>event.tool==="model.native_tool_isolation.rejected").length,1);
    assert.equal(JSON.parse(blockedEvents.find(event=>event.tool==="model.native_tool_isolation.rejected")!.message).providerRequestSent,false);
    assert.equal(blockedEvents.some(event=>event.tool==="model.attribution.rejected"),false);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("bound follow-up operational reads require one missing read and request none effort on exact Super VL",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const configuredModel="nvidia/nemotron-3.5-super-vl-120b-a12b",stateDir=await mkdtemp(resolve(tmpdir(),"engram-read-effort-none-"));
    const store=new WorkspaceStore({stateDir,model:configuredModel,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Can current stock cover the demand?")).agentRun.runId!;
    const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Inspect the source before planning.")).entries[0]!;
    if(!("content" in source))throw new Error("Expected an inspected source body.");
    assert.equal((await store.submitInvestigationReport(runId,{disposition:"plan",summary:"The operator requested a checked coverage calculation.",findings:[{id:"scope",kind:"observation",summary:"The source scope is recorded.",evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:source.content}]}]})).valid,true);
    let outbound:Record<string,any>|undefined;
    const guarded=boundTestFetch(runId,{...config,model:configuredModel},store,(async(_url,init)=>{outbound=JSON.parse(String(init?.body));return Response.json({id:"bound-stock-read",model:configuredModel,meterless:{provider_model:configuredModel,routed_model:configuredModel,winning_route:{model:configuredModel,provider:"nvidia",kind:"api",tier:"free"}},choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"stock-read",type:"function",function:{name:"investigate_stock",arguments:JSON.stringify({runId})}}]}}]});}) as typeof fetch);
    await(await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:["investigate_stock","fetch_constraints","solve_plan","validate_plan","prepare_actions"].map(name=>({type:"function",function:{name,parameters:{type:"object"}}}))})})).text();
    assert.deepEqual(outbound!.tools.map((tool:any)=>tool.function.name),["investigate_stock","fetch_constraints"]);
    assert.equal(outbound!.tool_choice,"required");assert.equal(outbound!.max_tokens,4096);assert.equal(outbound!.reasoning_effort,"none");
    const event=(await store.activeInvestigation()).agentRun.events.find(item=>item.tool==="model.response.nemotron")!;
    assert.equal(JSON.parse(event.message).requestedEffort,"none");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("operational reads unlock only after documentary inspection and survive the accepted-plan handoff", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const stateDir = await mkdtemp(resolve(tmpdir(), "engram-investigation-model-"));
    const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
    const runId = (await store.startInvestigation("Can we cover demand? ")).agentRun.runId!;
    const seen: Record<string, any>[] = [];
    const guarded = boundTestFetch(runId, config, store, (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      const required = body.tool_choice?.function?.name;
      const toolName = body.tool_choice === "required" ? body.tools.find((tool: any) => tool.function.name !== "inspect_evidence")?.function.name : required === "inspect_evidence" ? "inspect_evidence" : required === "solve_plan" ? "solve_plan" : null;
      const args = {runId};
      return Response.json({
        id: `request-${seen.length}`, model: config.model,
        meterless: {provider_model: config.model, routed_model: actual, winning_route: {model: actual, provider: "openrouter", kind: "api", tier: "free"}},
        choices: [{message: toolName
          ? {content: null, tool_calls: [{id: `call-${seen.length}`, type: "function", function: {name: toolName, arguments: JSON.stringify(args)}}]}
          : {content: "Fixture response"}}],
      });
    }) as typeof fetch);
    const names = ["list_evidence", "inspect_evidence", "report_investigation", "what_if", "solve_plan", "investigate_stock", "fetch_constraints", "validate_plan", "prepare_actions"];
    const request = () => guarded("http://127.0.0.1:1/v1/chat/completions", {method: "POST", body: JSON.stringify({tools: testTools(names), messages: [{role: "user", content: "RAW_DOCUMENT_INJECTION_DO_NOT_RETAIN"}]})});
    const toolNames = (body: Record<string, any>) => body.tools.map((tool: any) => tool.function.name);

    await (await request()).text();
    assert.deepEqual(toolNames(seen[0]!), ["inspect_evidence"]);
    assert.deepEqual(seen[0]!.tool_choice, {type: "function", function: {name: "inspect_evidence"}});

    const source = (await store.inspectSources(runId)).entries[0]!;
    if (!("content" in source)) throw new Error("Selected source body was not returned.");
    await (await request()).text();
    assert.equal(JSON.stringify(seen[1]!.messages).includes("RAW_DOCUMENT_INJECTION_DO_NOT_RETAIN"), false);
    assert.ok(toolNames(seen[1]!).includes("investigate_stock"));
    assert.ok(toolNames(seen[1]!).includes("fetch_constraints"));
    assert.equal(toolNames(seen[1]!).some((name: string) => ["solve_plan", "validate_plan", "prepare_actions"].includes(name)), false);

    const stock = await store.readStockEvidence(runId);
    const constraints = await store.readConstraintEvidence(runId);
    assert.equal((await store.submitInvestigationReport(runId, {
      disposition: "plan", summary: "The requested coverage calculation follows the documentary review.",
      findings: [{id: "scope", kind: "observation", summary: "The source action was inspected.", evidence: [{sourceId: source.id, sourceHash: source.sourceHash, quote: source.content}]}],
    })).valid, true);

    await (await request()).text();
    assert.deepEqual(seen[2]!.tool_choice, {type: "function", function: {name: "solve_plan"}});
    assert.equal(toolNames(seen[2]!).includes("investigate_stock"), false, "A completed stock:all read must not be repeated after handoff.");
    assert.equal(toolNames(seen[2]!).includes("fetch_constraints"), false, "A completed constraints read must not be repeated after handoff.");
    assert.ok(toolNames(seen[2]!).includes("solve_plan"));
    const operations = JSON.parse(seen[2]!.messages[1].content);
    assert.deepEqual(operations.operationalReads.map((read: any) => read.result), JSON.parse(JSON.stringify([stock, constraints])));
    assert.deepEqual(operations.readTools, ["investigate_stock", "fetch_constraints"]);
    assert.deepEqual(operations.requiredReadKeys, ["stock:all", "constraints"]);
    assert.deepEqual(operations.missingReadKeys, []);
    assert.match(seen[2]!.messages[0].content, /requiredReadKeys.*missingReadKeys/);
    assert.match(seen[2]!.messages[0].content, /stock:all.*investigate_stock.*omit siteId.*A, B, or C do not satisfy stock:all/);

    const events = (await store.activeInvestigation()).agentRun.events.filter(event => event.tool === "model.response.nemotron").map(event => JSON.parse(event.message));
    assert.equal(events.length, 3);
    assert.match(events[0].originalSdkBodySha256, /^[a-f0-9]{64}$/);
    assert.match(events[2].effectiveRequestBodySha256, /^[a-f0-9]{64}$/);
    assert.notEqual(events[2].originalSdkBodySha256, events[2].effectiveRequestBodySha256);
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("a filtered site stock receipt does not satisfy the post-plan stock:all requirement", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    const stateDir = await mkdtemp(resolve(tmpdir(), "engram-filtered-stock-handoff-"));
    const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
    const runId = (await store.startInvestigation("Can the target demand be covered?")).agentRun.runId!;
    const source = (await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Inspect the source scope.")).entries[0]!;
    if (!("content" in source)) throw new Error("Selected source body was not returned.");
    await store.claimModelCall(runId);
    const siteStock = await store.readStockEvidence(runId, "A");
    const constraints = await store.readConstraintEvidence(runId);
    assert.equal((await store.submitInvestigationReport(runId, {
      disposition: "plan", summary: "The source was reviewed; deterministic coverage calculation is requested.",
      findings: [{id: "scope", kind: "observation", summary: "The source action was inspected.", evidence: [{sourceId: source.id, sourceHash: source.sourceHash, quote: source.content}]}],
    })).valid, true);

    let outbound: Record<string, any> | undefined;
    const guarded = boundTestFetch(runId, config, store, (async (_url, init) => {
      outbound = JSON.parse(String(init?.body));
      return Response.json({
        id: "filtered-stock-response", model: config.model,
        meterless: {provider_model: config.model, routed_model: actual, winning_route: {model: actual, provider: "openrouter", kind: "api", tier: "free"}},
      choices: [{message: {content: null, tool_calls: [{id:"read-stock",type:"function",function:{name:"investigate_stock",arguments:JSON.stringify({runId})}}]}}],
      });
    }) as typeof fetch);
    await (await guarded("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({tools: testTools(["investigate_stock", "fetch_constraints", "solve_plan", "validate_plan", "prepare_actions"])}),
    })).text();

    assert.ok(outbound);
    assert.deepEqual(outbound!.tools.map((tool: any) => tool.function.name), ["investigate_stock"]);
    assert.equal(outbound!.tool_choice, "required", "Only the missing full stock read is available until its receipt is bound.");
    const operations = JSON.parse(outbound!.messages[1].content);
    assert.deepEqual(operations.readTools, ["fetch_constraints"]);
    assert.deepEqual(operations.requiredReadKeys, ["stock:all", "constraints"]);
    assert.deepEqual(operations.missingReadKeys, ["stock:all"]);
    assert.deepEqual(operations.operationalReads.map((read: any) => read.result), JSON.parse(JSON.stringify([siteStock, constraints])));
    assert.match(outbound!.messages[0].content, /stock:all.*investigate_stock.*omit siteId.*A, B, or C do not satisfy stock:all/);
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("report transport starts after typed readiness and follows the bounded marker helper",async()=>{
 const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
 try{const store=new WorkspaceStore({stateDir:await mkdtemp(resolve(tmpdir(),"engram-preliminary-ready-")),model:config.model,inferenceAllowed:true});
 const runId=(await store.startInvestigation("Read the selected source.")).agentRun.runId!;
 for(let i=0;i<4;i++)assert.equal((await store.claimModelCall(runId)).requiredTool,"inspect_evidence");
 await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Read the exact source.");
 let body:Record<string,any>|undefined,requests=0;const reportBodies:Record<string,any>[]=[];
 const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{body=JSON.parse(String(init?.body));requests++;const frame={model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}}};if(body!.tools?.some((tool:any)=>tool.function.name==="request_investigation_report"))return Response.json({...frame,choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"ready-marker",type:"function",function:{name:"request_investigation_report",arguments:JSON.stringify({runId})}}]}}]});reportBodies.push(body!);return Response.json({...frame,choices:[{finish_reason:"stop",message:{role:"assistant",content:reportForRequest(body!)}}]});}) as typeof fetch);
 const readyMarkerResponse=await guarded(config.baseUrl+"/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["request_investigation_report"])})});
 const markerCall=(await readyMarkerResponse.json() as any).choices[0].message.tool_calls[0];
 assert.equal(markerCall.function.name,"request_investigation_report");assert.deepEqual(JSON.parse(markerCall.function.arguments),{runId});
 const marker=body!.tools.find((tool:any)=>tool.function.name==="request_investigation_report");
 assert.deepEqual(marker.function.parameters,{type:"object"});
 const request=await requestInvestigationReportWithReason(store,runId);
 assert.equal(request.reason,READY_REPORT_REQUEST_REASON);
 await(await guarded(config.baseUrl+"/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["report_investigation"])})})).text();
 assert.equal(body!.tool_choice,"none");assert.equal(body!.temperature,0);assert.equal(body!.reasoning_effort,"low");assert.equal(body!.max_tokens,16384);assert.equal(body!.tools,undefined);assert.equal(body!.parallel_tool_calls,undefined);assert.equal(body!.response_format.type,"json_schema");assert.equal(body!.response_format.json_schema.name,"engram_documentary_report");
 const current=await store.getInvestigationContext(runId);assert.ok(current.projection);await store.recordInvestigationReportFormatFailure(runId,{snapshotHash:current.projection!.context.snapshotHash,rawContent:"invalid controlled fixture",codes:["invalid_report_shape"]});
 await(await guarded(config.baseUrl+"/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["report_investigation"])})})).text();
 assert.equal(reportBodies[1]!.reasoning_effort,"low");assert.equal(reportBodies[1]!.max_tokens,16384);assert.equal(reportBodies[1]!.tool_choice,"none");
 const packetId=(requestBody:Record<string,any>)=>JSON.parse(requestBody.messages[1].content).expectedReportSchema.properties.packetId.enum[0];assert.notEqual(packetId(reportBodies[0]!),packetId(reportBodies[1]!));
 const reportEvents=(await store.activeInvestigation()).agentRun.events.filter(event=>event.tool==="model.response.nemotron");assert.equal(JSON.parse(reportEvents.at(-1)!.message).requestedEffort,"low");
 assert.equal(requests,3);assert.equal((await store.activeInvestigation()).agentRun.events.filter(event=>event.tool==="model.request.started").length,7);
 }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("run-ID-only report marker requires current readiness and explicit reasons stay bounded",async()=>{
 const store=new WorkspaceStore({stateDir:await mkdtemp(resolve(tmpdir(),"engram-ready-marker-guard-")),model:config.model,inferenceAllowed:true});
 const runId=(await store.startInvestigation("Wait for evidence readiness.")).agentRun.runId!;
 await assert.rejects(requestInvestigationReportWithReason(store,runId),/current report readiness/);
 await assert.rejects(requestInvestigationReportWithReason(store,runId,"x".repeat(301)),/1 to 300 characters/);
 assert.equal((await store.activeInvestigation()).agentRun.events.some(event=>event.tool==="investigation.report.requested"),false);
});
test("accepted source-backed handoff after five preliminary calls retains seven global request slots",async()=>{const stateDir=await mkdtemp(resolve(tmpdir(),"engram-reserved-handoff-"));const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});const runId=(await store.startInvestigation()).agentRun.runId!;for(let index=0;index<5;index++)await store.claimModelCall(runId);const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Read source scope before the planning handoff.")).entries[0]!;if(!("content" in source))throw new Error();assert.equal((await store.submitInvestigationReport(runId,{disposition:"plan",summary:"Source scope was read; the operational tools must now calculate coverage.",findings:[{id:"handoff",kind:"observation",summary:"The source action is recorded.",evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:source.content}]}]})).valid,true);for(let index=0;index<7;index++)await store.claimModelCall(runId);await assert.rejects(store.claimModelCall(runId),/12-request/);});

test("inspection rejection records only a safe category when the model returns an excluded alias",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const stateDir=await mkdtemp(resolve(tmpdir(),"engram-invalid-inspection-"));
    const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Inspect a canonical source.")).agentRun.runId!;
    const alias="FDA-REQUIRED-ACTIONS:QA";
    const guarded=boundTestFetch(runId,config,store,(async()=>Response.json({id:"invalid-inspection",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{message:{content:null,tool_calls:[{id:"private-call",type:"function",function:{name:"inspect_evidence",arguments:JSON.stringify({runId,sourceIds:[alias],reason:"Try an alias rather than a canonical source."})}}]}}]})) as typeof fetch);
    await assert.rejects(guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence","what_if"])})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
    const event=(await store.activeInvestigation()).agentRun.events.find(item=>item.tool==="model.workflow.rejected")!;
    const payload=JSON.parse(event.message);
    assert.equal(payload.workflowRejectionReason,"invalid_inspection_arguments");
    assert.equal(event.message.includes(alias),false);
    assert.equal(event.message.includes("Try an alias"),false);
    assert.equal(event.message.includes("private-call"),false);
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});
test("accepted advertised tool names are traced without copying tool arguments or unknown names",async()=>{const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";try{const stateDir=await mkdtemp(resolve(tmpdir(),"engram-tool-diagnostics-"));const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});const runId=(await store.startInvestigation()).agentRun.runId!;await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Bind this diagnostic to a real selected source.");const guarded=boundTestFetch(runId,config,store,(async()=>Response.json({id:"diagnostic-response",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{message:{content:null,tool_calls:[{id:"private-call-id",type:"function",function:{name:"recall_history",arguments:JSON.stringify({private:"do-not-log-arguments"})}}]}}]})) as typeof fetch);await(await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence","recall_history"])})})).text();const event=(await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.response.nemotron")!;assert.deepEqual(JSON.parse(event.message).responseToolNames,["recall_history"]);assert.equal(event.message.includes("do-not-log-arguments"),false);assert.equal(event.message.includes("private-call-id"),false);}finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}});

test("optional investigation requests reject tool calls outside the exact advertised tool set", async () => {
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = "true";
  try {
    for (const returnedName of ["solve_plan", "validate_plan", "prepare_actions"]) {
      const stateDir = await mkdtemp(resolve(tmpdir(), "engram-unadvertised-tool-"));
      const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
      const runId = (await store.startInvestigation()).agentRun.runId!;
      await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Set up an optional preliminary tool-choice check.");
      let fetchCount = 0;
      const guarded = boundTestFetch(runId, config, store, (async (_url, init) => {
        fetchCount++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.tool_choice, "required", "An active preliminary phase must choose an advertised capability.");
        assert.ok(!body.tools.some((tool: any) => tool.function.name === returnedName));
        return Response.json({
          id: "unadvertised-response",
          model: config.model,
          meterless: {provider_model: config.model, routed_model: actual, winning_route: {model: actual, provider: "openrouter", kind: "api", tier: "free"}},
          choices: [{message: {content: null, tool_calls: [{id: "untrusted-tool-call", type: "function", function: {name: returnedName, arguments: "{}"}}]}}],
        });
      }) as typeof fetch);

      await assert.rejects(
        guarded("http://127.0.0.1:1/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({tools: testTools(["inspect_evidence", "what_if", "investigate_stock", "fetch_constraints", "solve_plan", "validate_plan", "prepare_actions"])}),
        }),
        {code: "WORKFLOW_TOOL_CHOICE_REJECTED"},
        `${returnedName} must be rejected when the effective outbound request did not advertise it`,
      );
      assert.equal(fetchCount, 1);
      const events = (await store.activeInvestigation()).agentRun.events;
      assert.equal(events.filter(event => event.tool === "model.workflow.rejected").length, 1);
      assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 0);
      const rejection=JSON.parse(events.find(event=>event.tool==="model.workflow.rejected")!.message);
      assert.equal(rejection.workflowRejectionReason,"unadvertised_tool");
      assert.equal(JSON.stringify(rejection).includes(returnedName),false,"rejection telemetry must not copy unknown tool names or arguments");
    }

    const stateDir = await mkdtemp(resolve(tmpdir(), "engram-advertised-tool-"));
    const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
    const runId = (await store.startInvestigation()).agentRun.runId!;
    await store.inspectSources(runId, ["FDA-REQUIRED-ACTIONS"], "Set up an optional advertised tool-choice check.");
    const guarded = boundTestFetch(runId, config, store, (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tool_choice, "required", "An active preliminary phase must choose an advertised capability.");
      assert.ok(body.tools.some((tool: any) => tool.function.name === "what_if"));
      return Response.json({
        id: "advertised-what-if",
        model: config.model,
        meterless: {provider_model: config.model, routed_model: actual, winning_route: {model: actual, provider: "openrouter", kind: "api", tier: "free"}},
        choices: [{message: {content: null, tool_calls: [{id: "advertised-call", type: "function", function: {name: "what_if", arguments: "{}"}}]}}],
      });
    }) as typeof fetch);
    const response = await guarded("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({tools: testTools(["inspect_evidence", "what_if"])}),
    });
    assert.equal((await response.json() as any).choices[0].message.tool_calls[0].function.name, "what_if");
    const events = (await store.activeInvestigation()).agentRun.events;
    assert.equal(events.filter(event => event.tool === "model.workflow.rejected").length, 0);
    assert.equal(events.filter(event => event.tool === "model.response.nemotron").length, 1);
  } finally {
    if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE;
    else process.env.RECALLOPS_ALLOW_INFERENCE = previous;
  }
});

test("preliminary transport replaces noisy SDK history and keeps workflow metadata compact",async()=>{const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";try{const stateDir=await mkdtemp(resolve(tmpdir(),"engram-preliminary-compact-"));const store=new WorkspaceStore({stateDir,model:config.model,inferenceAllowed:true});const question="Calculate an allocation only after inspecting the relevant source scope.";const runId=(await store.startInvestigation(question)).agentRun.runId!;await store.bindInvestigationHistory(runId,{decisions:[{status:"applied",memoryId:"manual-1",reason:"Operator reviewed source documents; physical label still needs checking."}],nextInvestigationQuestion:"What does the physical stock label show?"});const source=(await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Read the exact source action.")).entries[0]!;if(!("content" in source))throw new Error();await store.submitInvestigationReport(runId,{disposition:"answered",summary:"Rejected fixture attempt",findings:[{id:"bad",kind:"observation",summary:"Invalid quote fixture",evidence:[{sourceId:source.id,sourceHash:"a".repeat(64),quote:"FABRICATED_TEXT_NOT_IN_SOURCE"}]}]});const bodies:Record<string,any>[]=[];const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);const selectedTool=body.tool_choice==="required"?body.tools.find((tool:any)=>tool.function.name!=="inspect_evidence")?.function.name:body.tools[0].function.name;return Response.json({id:"compact-response",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{message:{content:null,tool_calls:[{id:"what-if",type:"function",function:{name:selectedTool,arguments:"{}"}}]}}]});}) as typeof fetch);await(await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({messages:[{role:"system",content:"NOISY_SDK_HISTORY"},{role:"tool",content:"UNSELECTED_RAW_TOOL_BODY"}],tools:testTools(["inspect_evidence","recall_history"])} )})).text();assert.equal(bodies[0]!.tool_choice,"required");assert.equal(bodies[0]!.messages.length,2);const compact=JSON.parse(bodies[0]!.messages[1].content);assert.equal(compact.question,question);assert.equal(compact.runId,runId);assert.equal(compact.work.readiness.stage,"ready");assert.equal("retrievedSections" in compact.work,false);assert.equal("recordCatalog" in compact.work,false);assert.ok(Buffer.byteLength(JSON.stringify(compact),"utf8")<=80_000);assert.ok(Buffer.byteLength(JSON.stringify(bodies[0]),"utf8")<=96_000);assert.ok(compact.feedback[0].codes.includes("stale_source_hash"));assert.equal(compact.reportAttempts.length,1);assert.equal(compact.reportAttempts[0].findingCount,1);assert.equal(compact.reportAttempts[0].disposition,"answered");assert.match(compact.reportAttempts[0].sha256,/^[a-f0-9]{64}$/);assert.equal("findings" in compact.reportAttempts[0],false);assert.equal("summary" in compact.reportAttempts[0],false);assert.equal(compact.reportAttemptsAreAuditOnly,true);assert.equal(compact.history.decisions[0].memoryId,"manual-1");assert.equal(JSON.stringify(bodies[0]).includes("FABRICATED_TEXT_NOT_IN_SOURCE"),false);assert.equal(JSON.stringify(bodies[0]).includes("NOISY_SDK_HISTORY"),false);assert.equal(JSON.stringify(bodies[0]).includes("UNSELECTED_RAW_TOOL_BODY"),false);const persisted=(await store.activeInvestigation()).agentRun.investigation!.reportAttempts![0]!;assert.equal(persisted.findings[0]!.evidence[0]!.quote,"FABRICATED_TEXT_NOT_IN_SOURCE");const proof=JSON.parse((await store.activeInvestigation()).agentRun.events.find(event=>event.tool==="model.response.nemotron")!.message);assert.equal(proof.investigationContextVersion,"compact-preliminary-v1");assert.match(proof.investigationContextSha256,/^[a-f0-9]{64}$/);assert.notEqual(proof.originalSdkBodySha256,proof.effectiveRequestBodySha256);}finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;} });

test("required-source inspection exposes only runId and the backend schedules the pending canonical batch",async()=>{
  const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
  try{
    const store=new WorkspaceStore({stateDir:await mkdtemp(resolve(tmpdir(),"engram-inspection-required-batch-")),model:config.model,inferenceAllowed:true});
    const runId=(await store.startInvestigation("Compare all required source evidence.")).agentRun.runId!;
    const before=(await store.getInvestigationContext(runId)).projection!,pending=[...before.context.work!.readiness.pendingSourceIds];
    assert.ok(pending.length>3,"Fixture must require multiple source batches.");
    let outbound:Record<string,any>|undefined;
    const guarded=boundTestFetch(runId,config,store,(async(_url,init)=>{
      outbound=JSON.parse(String(init?.body));
      return Response.json({id:"inspection-required-batch",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"inspection-call",type:"function",function:{name:"inspect_evidence",arguments:JSON.stringify({runId})}}]}}]});
    }) as typeof fetch);
    const result=await guarded("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence","what_if"])})});
    assert.deepEqual(outbound!.tool_choice,{type:"function",function:{name:"inspect_evidence"}});
    const tool=outbound!.tools.find((item:any)=>item.function.name==="inspect_evidence");
    assert.deepEqual(tool.function.parameters,{type:"object",properties:{runId:{type:"string",enum:[runId]}},required:["runId"],additionalProperties:false});
    assert.equal(JSON.parse(outbound!.messages[1].content).execution,"backend_required_source_batch");
    await result.text();
    const inspected=await store.inspectSources(runId);
    const event=JSON.parse((await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="inspect_evidence").at(-1)!.message);
    assert.equal(event.execution,"backend_required_source_batch");
    assert.ok(event.sourceIds.length<=3);
    assert.deepEqual(event.sourceIds,pending.slice(0,3));
    assert.ok(inspected.readiness.pendingSourceIds.length<pending.length);
    assert.ok(inspected.readiness.pendingSourceIds.length>0);
    assert.equal(inspected.readiness.reportReady,false,"A partial backend batch cannot unlock the report.");

    const wrongRun=boundTestFetch(runId,config,store,(async()=>Response.json({id:"wrong-run",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"bad",type:"function",function:{name:"inspect_evidence",arguments:JSON.stringify({runId:"00000000-0000-4000-8000-000000000000"})}}]}}]})) as typeof fetch);
    const beforeWrongRun=(await store.activeInvestigation()).agentRun.investigation!.selections.length;
    const rebound:any=await (await wrongRun("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence"])})})).json();
    assert.deepEqual(JSON.parse(rebound.choices[0].message.tool_calls[0].function.arguments),{runId});
    const binding=JSON.parse((await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="model.response.nemotron").at(-1)!.message).scheduledRunBinding;
    assert.equal(binding.source,"trusted-channel-run-id");assert.equal(binding.modelRunIdReplaced,true);assert.match(binding.originalArgumentsSha256,/^[a-f0-9]{64}$/);
    assert.equal((await store.activeInvestigation()).agentRun.investigation!.selections.length,beforeWrongRun,"rebinding cannot create source receipts");
    const extraField=boundTestFetch(runId,config,store,(async()=>Response.json({id:"extra-field",model:config.model,meterless:{provider_model:config.model,routed_model:actual,winning_route:{model:actual,provider:"openrouter",kind:"api",tier:"free"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"bad",type:"function",function:{name:"inspect_evidence",arguments:JSON.stringify({runId,sourceIds:["not-selected"]})}}]}}]})) as typeof fetch);
    await assert.rejects(extraField("http://127.0.0.1:1/v1/chat/completions",{method:"POST",body:JSON.stringify({tools:testTools(["inspect_evidence"])})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});

    while((await store.getInvestigationContext(runId)).projection!.context.work!.readiness.pendingSourceIds.length){
      const current=(await store.getInvestigationContext(runId)).projection!.context.work!.readiness.pendingSourceIds;
      const batch=await store.inspectSources(runId);
      const last=JSON.parse((await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="inspect_evidence").at(-1)!.message);
      assert.ok(last.sourceIds.length<=3);assert.deepEqual(last.sourceIds,current.slice(0,3));assert.ok(batch.readiness.pendingSourceIds.length<current.length);
    }
    const inspectedIds=(await store.activeInvestigation()).agentRun.investigation!.selections.map(s=>s.sourceId);
    assert.equal(new Set(inspectedIds).size,inspectedIds.length,"Batches cannot repeat selected sources.");
    assert.ok(pending.every(id=>inspectedIds.includes(id)),"Every required canonical source receives a real selection.");
  }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});
