import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {boundMeterlessFetch} from "../../src/runtime/model.ts";
import {NATIVE_TOOL_ISOLATION_SCOPE,type NativeToolIsolationVerifier} from "../../src/runtime/native-tool-isolation.ts";
import {READY_REPORT_REQUEST_REASON,requestInvestigationReportWithReason} from "../../agent/tools/request_investigation_report.ts";
import {loadSeed} from "../../src/runtime/seed.ts";

const config={token:"test-only",model:"nvidia/nemotron-3.5-super-vl-120b-a12b",baseUrl:"http://127.0.0.1:1/v1"};
const isolation:NativeToolIsolationVerifier=async({baseUrl})=>({contract:"nightshift-m1m4-web-v1",scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"2026-10-23T00:00:00.000Z",origin:new URL(baseUrl).origin,health:{httpStatus:200,status:"ok",engine:"meterless",build:"m1-m4",served:"app",engineReady:true},toolsEndpoint:{httpStatus:501,errorCode:"not_available_in_web"},universalRuntimeToolCountClaim:false});

test("ready marker advertises only runId after real matching work and uses a fixed bounded reason",async()=>{
 const prior=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
 try{
  const old=JSON.parse(await readFile(new URL("../fixtures/evidence-old-n01.json",import.meta.url),"utf8"));
  const seed=await loadSeed(process.cwd());
  const store=new WorkspaceStore({root:process.cwd(),stateDir:await mkdtemp(resolve(tmpdir(),"f11-ready-marker-")),model:config.model,inferenceAllowed:true,investigationCase:{id:"f11-synthetic-match",question:old.question,documents:old.documents,snapshot:seed.snapshot,memoryMode:"off"}});
  const runId=(await store.startInvestigation()).agentRun.runId!;
  await store.inspectSources(runId,old.documents.map((entry:any)=>entry.id),"Read the selected synthetic notice and local records.");
  const work=(await store.getInvestigationContext(runId)).projection!.work!;
  assert.equal(work.readiness.stage,"match");
  assert.equal((await store.claimModelCall(runId)).requiredTool,"match_records");
  const matched=await store.matchRecordReferenceBatch(runId,work.recordCatalog.criteria.map(criterion=>({criterionRef:criterion.criterionRef})));
  assert.equal(matched.valid,true);
  assert.equal(matched.readiness.reportReady,true);
  let outbound:Record<string,any>|undefined;
  const guarded=boundMeterlessFetch(runId,config,store,(async(_url,init)=>{
   outbound=JSON.parse(String(init?.body));
   assert.equal(outbound!.tool_choice.function.name,"request_investigation_report");
   return Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"ready-marker",type:"function",function:{name:"request_investigation_report",arguments:JSON.stringify({runId})}}]}}]});
  }) as typeof fetch,isolation);
  await(await guarded(config.baseUrl+"/chat/completions",{method:"POST",body:JSON.stringify({tools:["request_investigation_report","recall_history","what_if"].map(name=>({type:"function",function:{name,parameters:{type:"object"}}}))})})).text();
  const marker=outbound!.tools.find((item:any)=>item.function.name==="request_investigation_report").function.parameters;
  assert.deepEqual(marker,{type:"object",properties:{runId:{type:"string",enum:[runId]}},required:["runId"],additionalProperties:false});

  const requested=await requestInvestigationReportWithReason(store,runId);
  assert.equal(requested.reason,READY_REPORT_REQUEST_REASON);
  assert.ok(requested.reason.length<=300);
  assert.equal((await store.claimModelCall(runId)).requiredTool,"report_investigation");
  await assert.rejects(requestInvestigationReportWithReason(store,runId,"x".repeat(301)),/1 to 300 characters/);
 }finally{if(prior===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=prior;}
});
