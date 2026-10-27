import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";
import {buildRecordReferenceCatalog,resolveRecordReferenceInput,matchSourceBoundRecords,automaticRecordReferenceProposals} from "../../src/runtime/record-matching.ts";
import {investigationWork,sourceSections,buildRecordMatchingPacket} from "../../src/runtime/investigation-readiness.ts";
import type {EvidenceEntry,InvestigationRecord} from "../../src/shared/investigation.ts";
const runId="11111111-1111-4111-8111-111111111111",snapshotHash="a".repeat(64);
const entry=(id:string,content:string,kind:"notice"|"record"="notice"):EvidenceEntry=>({id,content,kind,title:id,sourceURL:"https://example.test/"+id,version:1,retrievedAt:"2026-10-26",authority:kind==="record"?"fictional-record":"public-source-excerpt",refs:[],support:"test",snapshotHash,sourceHash:createHash("sha256").update(content).digest("hex")});
function readyInput(entries:EvidenceEntry[],question="Classify which local records match the recall scope in the supplied notices."){
 const investigation:InvestigationRecord={runId,snapshotHash,selections:entries.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,entries).map(s=>s.sectionId)}],findings:[],feedback:[],disposition:null,summary:""};
 return {runId,snapshotHash,question,registry:{snapshotHash,entries},investigation};
}
test("model identifiers bind exact source product identity and complete raw local fields remain visible",()=>{
 const raw='[{"id":"R1","product":"Generic device","model":"PX-42","udi":"01234567890123","lot":"AA12","ring_condition":"broken","reservoir_lock":false}]';
 const entries=[entry("N","Product: PX-42; Affected lots: AA12."),entry("R",raw,"record")],input=readyInput(entries),work=investigationWork(input),packet=buildRecordMatchingPacket({question:input.question,...work});
 assert.ok(packet.context.localRecords[0]!.identities.includes("PX-42"));assert.ok(packet.context.localRecords[0]!.identities.includes("01234567890123"));assert.ok(packet.context.localRecords[0]!.quote.includes('"ring_condition":"broken"'));assert.ok(packet.context.localRecords[0]!.quote.includes('"reservoir_lock":false'));
 const proposal=automaticRecordReferenceProposals(work.recordCatalog,work.readiness.unmatchedRecordChecks)[0]!;
 const results=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(work.recordCatalog,proposal,work.readiness.unmatchedRecordChecks)});
 assert.equal(results[0]!.status,"match");assert.equal(results[0]!.productIdentity,"exact_quoted_identifier");assert.equal(results[0]!.scopeStatus,"not_a_recall_scope_determination");
});
test("an unlabelled literal identifier remains an unknown instead of a fabricated typed match",()=>{
 const entries=[entry("N","The NovaAlpha device needs inspection before further use."),entry("R",'[{"id":"R1","product":"NovaAlpha"}]',"record")],catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected:entries}),criterion=catalog.criteria.find(c=>c.field==="product")!;
 assert.ok(criterion);const request=resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef});
 const result=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request})[0]!;assert.equal(result.status,"unknown");assert.equal(result.reason,"criterion_field_not_explicit");
 assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{...request,criterion:{...request.criterion,values:["InventedBeta"]}}}),/literal quoted/);
});
test("a continued lot catalog checks every observed fragment before completing a nonlisted unknown",()=>{
 const rows=Array.from({length:65},(_,i)=>`L${String(i+1).padStart(3,"0")}             Widget`),entries=[entry("N","Product: PX-42\nLot Number       Description\n"+rows.join("\n")),entry("R",'[{"id":"HIT","product":"PX-42","lot":"L062"},{"id":"OTHER","product":"PX-42","lot":"L999"}]',"record")],input=readyInput(entries);
 let work=investigationWork(input);assert.ok(work.recordCatalog.criteria.length>=3);const proposals=automaticRecordReferenceProposals(work.recordCatalog,work.readiness.unmatchedRecordChecks);assert.ok(proposals.length<=2);
 const results=proposals.flatMap(proposal=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(work.recordCatalog,proposal,work.readiness.unmatchedRecordChecks)}));
 assert.equal(results.length,2);assert.equal(results.find(r=>r.recordId==="HIT")!.status,"match");assert.equal(results.find(r=>r.recordId==="OTHER")!.status,"unknown");assert.equal(results.find(r=>r.recordId==="OTHER")!.reason,"incomplete_lot_set");
 input.investigation.recordMatches=results;work=investigationWork(input);assert.equal(work.readiness.reportReady,false);
 let rounds=0;while(!work.readiness.reportReady&&rounds++<8){
  const pending=automaticRecordReferenceProposals(work.recordCatalog,work.readiness.unmatchedRecordChecks);
  assert.ok(pending.length,"remaining observed fragments must be schedulable");
  input.investigation.recordMatches.push(...pending.flatMap(proposal=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(work.recordCatalog,proposal,work.readiness.unmatchedRecordChecks)})));
  work=investigationWork(input);
 }
 assert.equal(work.readiness.reportReady,true);
 const other=input.investigation.recordMatches.filter(result=>result.recordId==="OTHER");
 assert.equal(other.length,work.recordCatalog.criteria.length);assert.ok(other.every(result=>result.status==="unknown"));
});
test("an applicable model criterion cannot hide an explicit lot condition",()=>{
 const entries=[entry("N","Model Number    Description\nPX-42           Widget\n\nLot Number       Description\nAA12             Widget"),entry("R",'[{"id":"R1","product":"Generic device","model":"PX-42","lot":"AA12"}]',"record")],input=readyInput(entries),work=investigationWork(input);
 assert.deepEqual(new Set(work.readiness.unmatchedRecordChecks.map(check=>check.field)),new Set(["product","lot"]));
});
test("automatic matching stops explicitly at global proof capacity instead of retrying an empty batch",async()=>{
 const seed=await loadSeed(process.cwd()),rows=Array.from({length:12},(_,i)=>({id:`ROW-${i}`,product:"PX-42",lot:"AA12"}));
 const entries=[...Array.from({length:3},(_,i)=>entry(`N${i}`,"Product: PX-42; Affected lots: AA12.")),entry("R",JSON.stringify(rows),"record")];
 const documents=entries.map(({sourceHash:_hash,snapshotHash:_snapshot,support:_support,...document})=>document);
 const store=new WorkspaceStore({root:process.cwd(),stateDir:await mkdtemp(resolve(tmpdir(),"f7-capacity-")),model:"nvidia/test",inferenceAllowed:true,investigationCase:{id:"capacity",question:"Which local records match the recall lot scope?",snapshot:seed.snapshot,documents,memoryMode:"off"}});
 const run=(await store.startInvestigation()).agentRun.runId!;for(let at=0;at<entries.length;at+=3)await store.inspectSources(run,entries.slice(at,at+3).map(e=>e.id),"Read the supplied short sources.");
 const result=await store.matchPendingRecordReferences(run);assert.equal(result.valid,false);assert.deepEqual(result.codes,["record_match_capacity_exceeded"]);
 const state=await store.getWorkspace();assert.equal(state.agentRun.status,"failed");assert.equal(state.agentRun.investigation?.recordMatches?.length,24);assert.equal(state.agentRun.investigation?.disposition,null);assert.equal(state.agentRun.investigation?.reportAttempts?.length??0,0);
 assert.ok(state.agentRun.events.some(e=>e.tool==="investigation.capacity.rejected"));
});
