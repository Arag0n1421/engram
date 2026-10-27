import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";
import {investigationWork,sourceSections,assertReportCoverage} from "../../src/runtime/investigation-readiness.ts";
import {buildRecordReferenceCatalog,resolveRecordReferenceInput,matchSourceBoundRecords} from "../../src/runtime/record-matching.ts";
import {buildEvidenceExcerptCatalog,validateEvidenceExcerptCatalog} from "../../src/runtime/evidence-excerpts.ts";
import type {EvidenceEntry,InvestigationRecord} from "../../src/shared/investigation.ts";
const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
const source=(id:string,content:string,kind:"notice"|"record"="notice"):EvidenceEntry=>({id,title:id,kind,content,sourceHash:createHash("sha256").update(content).digest("hex"),snapshotHash,sourceURL:`urn:synthetic:${id}`,version:1,retrievedAt:"2026-10-26T00:00:00Z",refs:[id],authority:"fictional-record",support:"Synthetic evidence."});
const notices=[source("PRIOR","Product: P-ALPHA; Manufacture date range: from 2023-01-01 to 2024-01-01 inclusive.\n\nReview and acknowledge this notice."),source("CURRENT","Product: P-ALPHA; Manufacture date range: from 2023-01-01 to 2025-01-01 inclusive.\n\nA new response is required even if a prior response was submitted.")];
const local=source("LOCAL",'Records: [{"id":"REC-A","product":"P-ALPHA","manufacture_date":"2024-06-01"},{"id":"REC-B","product":"P-ALPHA","manufacture_date":null,"expiry":"2027-01-01"}]',"record");
const entries=[...notices,local],question="Compare both notices and classify which local records are within the manufacture date range.";
const investigation=():InvestigationRecord=>({runId,snapshotHash,selections:entries.map(entry=>({sourceId:entry.id,sourceHash:entry.sourceHash,reason:"Read supplied source.",at:"now"})),findings:[],feedback:[],disposition:null,summary:""});
const work=(i:InvestigationRecord)=>investigationWork({runId,snapshotHash,question,registry:{snapshotHash,entries},investigation:i});
function receipt(i:InvestigationRecord){i.retrievalReceipts=[{runId,snapshotHash,sectionIds:sourceSections(runId,snapshotHash,entries).map(s=>s.sectionId),at:"now"}];}

test("readiness requires actual complete retrieval and matching for each record and both notice versions",()=>{
 const i=investigation();assert.equal(work(i).readiness.stage,"retrieve");receipt(i);
 const first=work(i);assert.equal(first.readiness.stage,"match");assert.equal(first.readiness.unmatchedRecordChecks.length,4);
 const catalog=first.recordCatalog,recordRefs=catalog.records.map(r=>r.recordRef);
 const prior=catalog.criteria.find(c=>c.sourceId==="PRIOR")!;
 i.recordMatches=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:prior.criterionRef,recordRefs})});
 assert.equal(work(i).readiness.reportReady,false);assert.ok(work(i).readiness.unmatchedRecordChecks.every(c=>c.noticeSourceId==="CURRENT"));
 const current=catalog.criteria.find(c=>c.sourceId==="CURRENT")!;
 i.recordMatches.push(...matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:current.criterionRef,recordRefs})}));
 const ready=work(i);assert.equal(ready.readiness.reportReady,true);
 const full=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:80_000,coalesce:true});
 assert.doesNotThrow(()=>assertReportCoverage(ready.sections,ready.readiness,full));
 const dropped=structuredClone(full);dropped.entries=dropped.entries.filter(entry=>entry.sourceId!=="CURRENT");
 assert.throws(()=>assertReportCoverage(ready.sections,ready.readiness,dropped),/coverage/);
});

test("reference matching preserves exact JSON entity/product strings and missing manufacture dates",()=>{
 const catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected:entries});assert.equal(catalog.records[0]!.product,"P-ALPHA");
 const request=resolveRecordReferenceInput(catalog,{criterionRef:catalog.criteria.find(c=>c.sourceId==="CURRENT")!.criterionRef,recordRefs:catalog.records.map(r=>r.recordRef)});
 assert.ok(local.content.includes(request.records[0]!.quote));assert.equal(request.records[0]!.quote.includes("REC-B"),false);
 const matches=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request});assert.deepEqual(matches.map(r=>r.status),["match","unknown"]);
 assert.equal(matches[1]!.normalizedRecordValue,null);
 const stale={...catalog,criteria:catalog.criteria.filter(c=>c.sourceId!=="CURRENT")};assert.throws(()=>resolveRecordReferenceInput(stale,{criterionRef:catalog.criteria.find(c=>c.sourceId==="CURRENT")!.criterionRef,recordRefs:[catalog.records[0]!.recordRef]}));
});

test("section references remove quote recopy while keeping exact criterion/product validation",()=>{
 const catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected:entries});const section=catalog.criterionSections.find(s=>s.sourceId==="CURRENT")!;
 const request=resolveRecordReferenceInput(catalog,{criterionRef:section.criterionRef,criterion:{field:"manufacture_date",operator:"between_inclusive",values:["2023-01-01","2025-01-01"],product:"P-ALPHA",productSectionRef:section.criterionRef},recordRefs:[catalog.records[0]!.recordRef]});
 assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected:entries,request})[0]!.status,"match");
 const forged=structuredClone(request);forged.criterion.values[1]="2026-01-01";assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:forged}),/labelled/);
 const other=catalog.criterionSections.find(s=>s.sourceId==="PRIOR")!;assert.throws(()=>resolveRecordReferenceInput(catalog,{criterionRef:section.criterionRef,criterion:{field:"lot",operator:"one_of",values:["ANY"],productSectionRef:other.criterionRef},recordRefs:[catalog.records[0]!.recordRef]}),/cross_source_product_reference/);
});

test("GTIN batch table references yield a positive match without collapsing complete product names",()=>{
 const notice=source("TABLE","GTIN: 12345678901234\n\nAFFECTED LOTS\nBatch No.        Expiry Date\nLOT-A            2027-01-01\nLOT-B            2027-01-02");
 const records=source("ROWS",'Records: [{"id":"A","product":"Product Clear 1mL","GTIN":"12345678901234","lot":"LOT-A"},{"id":"B","product":"Product Clear 3mL","GTIN":null,"lot":"LOT-A"},{"id":"C","product":"Product Clear 1mL","GTIN":"12345678901234","lot":null}]',"record");
 const selected=[notice,records],catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected});
 assert.deepEqual(catalog.records.map(r=>r.values.product),["Product Clear 1mL","Product Clear 3mL","Product Clear 1mL"]);
 const matches=matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(catalog,{criterionRef:catalog.criteria[0]!.criterionRef,recordRefs:catalog.records.map(r=>r.recordRef)})});
 assert.equal(matches[0]!.status,"match");assert.equal(matches[1]!.productIdentity,"different_quoted_identifier");assert.equal(matches[2]!.status,"unknown");
});

test("an unrelated product criterion cannot close a record-notice pair when a matching explicit criterion exists",()=>{
 const a=source("N","Product: P-A; Affected lots: LOT-A.\nProduct: P-B; Affected lots: LOT-B."),r=source("R",'[{"id":"ROW","product":"P-B","lot":"LOT-B"}]',"record");
 const selected=[a,r],i=investigation();i.selections=selected.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,reason:"Read.",at:"now"}));i.retrievalReceipts=[{runId,snapshotHash,sectionIds:sourceSections(runId,snapshotHash,selected).map(s=>s.sectionId),at:"now"}];
 const get=()=>investigationWork({runId,snapshotHash,question:"Classify which local records match the lot scope.",registry:{snapshotHash,entries:selected},investigation:i});
 const catalog=get().recordCatalog;const wrong=catalog.criteria.find(c=>c.product==="P-A")!;
 i.recordMatches=matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(catalog,{criterionRef:wrong.criterionRef,recordRefs:[catalog.records[0]!.recordRef]})});
 assert.equal(get().readiness.stage,"match");assert.equal(get().readiness.unmatchedRecordChecks.length,1);
});

test("backend never forces a report at request four and invalid matching stays in matching",async()=>{
 const seed=await loadSeed(process.cwd()),stateDir=await mkdtemp(resolve(tmpdir(),"engram-ready-stage-"));
 const store=new WorkspaceStore({root:process.cwd(),stateDir,model:"nvidia/test",inferenceAllowed:true,investigationCase:{id:"stage-regression",question,snapshot:seed.snapshot,documents:entries.map(({sourceHash:_hash,snapshotHash:_snapshot,support:_support,...entry})=>entry),memoryMode:"off"}});
 const run=(await store.startInvestigation(question)).agentRun.runId!;
 assert.equal((await store.claimModelCall(run)).requiredTool,"inspect_evidence");await store.inspectSources(run,entries.map(e=>e.id),"Inspect both required notices and the local records.");
 await assert.rejects(store.requestInvestigationReport(run,"Premature report."),/unfinished/);
 assert.equal((await store.claimModelCall(run)).requiredTool,"match_records");
 const bad=await store.matchRecordReferences(run,{criterionRef:"0".repeat(64),recordRefs:["1".repeat(64)]});assert.equal(bad.valid,false);
 assert.equal((await store.claimModelCall(run)).requiredTool,"match_records");assert.equal((await store.claimModelCall(run)).requiredTool,"match_records");
 const context=(await store.getInvestigationContext(run)).projection!.context;assert.equal(context.work!.readiness.stage,"match");
 const catalog=(await store.getInvestigationContext(run)).projection!.work!.recordCatalog;
 const valid=await store.matchRecordReferenceBatch(run,catalog.criteria.map(c=>({criterionRef:c.criterionRef,recordRefs:catalog.records.map(r=>r.recordRef)})));assert.equal(valid.valid,true);
 await store.requestInvestigationReport(run,"All required source and matching work is complete.");
 assert.equal((await store.claimModelCall(run)).requiredTool,"report_investigation");
 assert.equal((await store.activeInvestigation()).agentRun.investigation!.reportAttempts?.length??0,0);
});

test("complete late action spans stay in the final catalog under the shared bounded packet ceiling",()=>{
 const body=Array.from({length:70},(_,i)=>`Paragraph ${i}. Full ordinary instruction remains available.`).join("\n\n")+"\n\nA fresh acknowledgement is required even after an earlier response.";
 const selected=[source("LONG-NOTICE",body)],sections=sourceSections(runId,snapshotHash,selected);
 assert.ok(sections.length<71);assert.ok(sections.every(s=>s.text.length<=1000));
 const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected,maxBytes:80_000,coalesce:true});assert.equal(catalog.omissions.length,0);
 assert.ok(catalog.entries.some(e=>e.text.includes("fresh acknowledgement")));
});


test("structured JSON report preserves strict source binding and rejects truncation",async()=>{
 const {boundMeterlessFetch}=await import("../../src/runtime/model.ts");
 const {projectInvestigationContext}=await import("../../src/runtime/investigation-projection.ts");
 const {NATIVE_TOOL_ISOLATION_SCOPE}=await import("../../src/runtime/native-tool-isolation.ts");
 const before=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
 try{
  const selected=source("ONE","A complete exact documentary statement.");const i=investigation();i.selections=[{sourceId:selected.id,sourceHash:selected.sourceHash,reason:"Read.",at:"now"}];
  const projection=projectInvestigationContext({runId,snapshotHash,question:"What does this statement say?",registry:{snapshotHash,entries:[selected]},investigation:i,requestsUsed:2,reportOnly:true});
  const config={token:"test-token",model:"nvidia/nemotron-3.5-super-vl-120b-a12b",baseUrl:"http://127.0.0.1:1/v1"};
  const events:Array<{tool:string;payload:any}>=[];
  const store={claimModelCall:async()=>({maxOutputTokens:8192 as const,phase:"investigation_report" as const,requiredTool:"report_investigation" as const,terminal:false,repair:false}),trace:async(_run:string,tool:string,text:string)=>{events.push({tool,payload:JSON.parse(text)});},getPreparedTerminalProjection:async()=>{throw new Error("No terminal.");},recordTerminalAttempt:async()=>({recorded:true as const,attemptCount:1}),getInvestigationContext:async()=>({active:true,projection})};
  const isolation=async()=>({contract:"nightshift-m1m4-web-v1" as const,scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"now",origin:"http://127.0.0.1:1",health:{httpStatus:200 as const,status:"ok" as const,engine:"meterless" as const,build:"m1-m4" as const,served:"app" as const,engineReady:true as const},toolsEndpoint:{httpStatus:501 as const,errorCode:"not_available_in_web" as const},universalRuntimeToolCountClaim:false as const});
  let finish="stop";
  const guarded=boundMeterlessFetch(runId,config,store,(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.equal(body.response_format.type,"json_schema");assert.equal(body.response_format.json_schema.name,"engram_documentary_report");assert.equal(body.tool_choice,"none");assert.equal(body.temperature,0);assert.equal(body.tools,undefined);assert.equal(body.parallel_tool_calls,undefined);
   const context=JSON.parse(body.messages[1].content),quoteId=context.evidenceExcerpts[0].quoteId,packetId=body.response_format.json_schema.schema.properties.packetId.enum[0];
   const args=JSON.stringify({packetId,nextStep:"answer_document_question",summary:"The statement is recorded.",documentFindings:[{kind:"observation",summary:"The statement is recorded.",evidence:[{quoteId}],comparisons:[],recordCheckRefs:[]}]});
   return Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30},choices:[{finish_reason:finish,message:{role:"assistant",content:args}}]});
  }) as typeof fetch,isolation);
  const result=await guarded(config.baseUrl+"/chat/completions",{body:JSON.stringify({messages:[],tools:[]})});const body=await result.json() as any;
  const args=JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);assert.equal(args.findings[0].evidence[0].quote,selected.content);assert.equal(body.choices[0].message.content,null);
  const proof=events.find(e=>e.tool==="model.response.nemotron")!.payload;
  assert.equal(proof.responseShape.toolCalls,0);assert.equal(proof.investigationReportWire.transport,"structured-json-receipt-report-to-bound-handler");
  finish="length";await assert.rejects(guarded(config.baseUrl+"/chat/completions",{body:JSON.stringify({messages:[],tools:[]})}),/report|workflow/i);
 }finally{if(before===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=before;}
});

test("report transport uses standard whole-source excerpts plus only exact local-row support spans",async()=>{
 const previous=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
 try{
  const {boundMeterlessFetch}=await import("../../src/runtime/model.ts");
  const {projectInvestigationContext}=await import("../../src/runtime/investigation-projection.ts");
  const {NATIVE_TOOL_ISOLATION_SCOPE}=await import("../../src/runtime/native-tool-isolation.ts");
  const {buildEvidenceExcerptCatalog,evidenceFocusTerms,MAX_EVIDENCE_EXCERPT_CATALOG_BYTES}=await import("../../src/runtime/evidence-excerpts.ts");
  const selected=entries,i=investigation();i.recordMatches=[];i.selections=selected.map(entry=>({sourceId:entry.id,sourceHash:entry.sourceHash,reason:"Read supplied source.",at:"now"}));receipt(i);
  const parsed=work(i),recordRefs=parsed.recordCatalog.records.map(record=>record.recordRef);
  for(const criterion of parsed.recordCatalog.criteria){
   i.recordMatches!.push(...matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(parsed.recordCatalog,{criterionRef:criterion.criterionRef,recordRefs})}));
  }
  const ready=work(i);assert.equal(ready.readiness.reportReady,true);
  const projection=projectInvestigationContext({runId,snapshotHash,question,registry:{snapshotHash,entries:selected},investigation:i,requestsUsed:3,reportOnly:true,work:ready});
  const config={token:"test-token",model:"nvidia/nemotron-3.5-super-vl-120b-a12b",baseUrl:"http://127.0.0.1:1/v1"};let captured:any;
  const store={claimModelCall:async()=>({maxOutputTokens:8192 as const,phase:"investigation_report" as const,requiredTool:"report_investigation" as const,terminal:false,repair:false}),trace:async()=>{},getPreparedTerminalProjection:async()=>{throw new Error("No terminal.");},recordTerminalAttempt:async()=>({recorded:true as const,attemptCount:1}),getInvestigationContext:async()=>({active:true,projection})};
  const isolation=async()=>({contract:"nightshift-m1m4-web-v1" as const,scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"now",origin:"http://127.0.0.1:1",health:{httpStatus:200 as const,status:"ok" as const,engine:"meterless" as const,build:"m1-m4" as const,served:"app" as const,engineReady:true as const},toolsEndpoint:{httpStatus:501 as const,errorCode:"not_available_in_web" as const},universalRuntimeToolCountClaim:false as const});
  const guarded=boundMeterlessFetch(runId,config,store,(async(_url,init)=>{
   const body=JSON.parse(String(init?.body));captured=body;const context=JSON.parse(body.messages[1].content);
   const notices=context.evidenceExcerpts.filter((excerpt:any)=>excerpt.sourceKind==="notice"),packetId=body.response_format.json_schema.schema.properties.packetId.enum[0];
   const report={packetId,nextStep:"answer_document_question",summary:"The selected notice text is compared for this controlled fixture.",documentFindings:[{kind:"observation",summary:"The selected notices are compared as text.",evidence:[{quoteId:notices[0].quoteId},{quoteId:notices[1].quoteId}],comparisons:[{beforeQuoteId:notices[0].quoteId,afterQuoteId:notices[1].quoteId}],recordCheckRefs:[]}]};
   return Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130},choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(report)}}]});
  }) as typeof fetch,isolation);
  const response=await guarded(config.baseUrl+"/chat/completions",{method:"POST",body:JSON.stringify({tools:[],messages:[]})});assert.equal(response.status,200);
  const context=JSON.parse(captured.messages[1].content),canonicalSelected=projection.canonicalSelected??projection.context.selected,focusTerms=[...evidenceFocusTerms(question),...canonicalSelected.filter((entry:any)=>entry.kind==="record").flatMap((entry:any)=>evidenceFocusTerms(entry.content))],rowSourceIds=new Set(canonicalSelected.filter((entry:any)=>entry.kind==="record").map((entry:any)=>entry.id)),rowProofs=i.recordMatches!.flatMap(match=>match.evidence.filter(proof=>rowSourceIds.has(proof.sourceId)));
  const standard=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:canonicalSelected,maxBytes:MAX_EVIDENCE_EXCERPT_CATALOG_BYTES,focusTerms,coalesce:true,supportQuotes:rowProofs});
  const noProof=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:canonicalSelected,maxBytes:MAX_EVIDENCE_EXCERPT_CATALOG_BYTES,focusTerms,coalesce:true});
  assert.equal(standard.omissions.length,0);const bySourceSpan=(items:any[])=>items.map(item=>({sourceId:item.sourceId??canonicalSelected.find((entry:any,index:number)=>`SRC${index+1}`===item.sourceRef)?.id,start:item.start,end:item.end,text:item.text})).sort((left,right)=>left.sourceId.localeCompare(right.sourceId)||left.start-right.start||left.end-right.end);assert.deepEqual(bySourceSpan(context.evidenceExcerpts),bySourceSpan(standard.entries));
  for(const notice of canonicalSelected.filter((entry:any)=>entry.kind==="notice"))assert.deepEqual(standard.entries.filter(excerpt=>excerpt.sourceId===notice.id),noProof.entries.filter(excerpt=>excerpt.sourceId===notice.id));
  assert.ok(rowProofs.every(proof=>standard.entries.some(excerpt=>excerpt.sourceId===proof.sourceId&&excerpt.sourceHash===proof.sourceHash&&excerpt.text.includes(proof.quote))));
  const receiptsText=JSON.stringify(context.recordReceipts);assert.ok(context.recordReceipts.length>0);for(const match of i.recordMatches!)for(const proof of match.evidence)assert.equal(receiptsText.includes(proof.quote),false);assert.ok(context.recordReceipts.every((receipt:any)=>Array.isArray(receipt.proofSources)&&receipt.proofSources.every((proof:any)=>Object.keys(proof).sort().join(",")==="sourceKind,sourceRef")));
  assert.equal(captured.tool_choice,"none");assert.equal(captured.temperature,0);assert.equal(captured.tools,undefined);
 }finally{if(previous===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=previous;}
});

test("documentary field proofs cannot be promoted to manufacture-date claims and session budgets remain finite",async()=>{
 const {validateInvestigationReport}=await import("../../src/runtime/evidence.ts");
 const n=source("LOT-N","Product: P; Affected lots: LOT-A."),r=source("LOT-R",'[{"id":"ROW","product":"P","lot":"LOT-A"}]',"record");
 const selected=[n,r],catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected});
 const results=matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(catalog,{criterionRef:catalog.criteria[0]!.criterionRef,recordRefs:[catalog.records[0]!.recordRef]})});
 const result=results[0]!;
 const report={disposition:"answered" as const,summary:"The bounded field comparison is recorded.",findings:[{id:"field",kind:"observation" as const,summary:"The manufacture date matches the notice range.",evidence:result.evidence,recordChecks:[{resultId:result.resultId,field:result.field,status:result.status}]}]};
 assert.ok(validateInvestigationReport({snapshotHash,entries:selected},selected.map(e=>e.id),report,{recordMatches:results}).codes.includes("record_match_field_claim_mismatch"));
 const {readFile}=await import("node:fs/promises");const config=await readFile(new URL("../../agent/agent.ts",import.meta.url),"utf8");
 assert.match(config,/window.inputTokens >= 256_000 \|\| window.outputTokens >= 48_000/);
});


test("final catalog preserves complete-unit options covering already-bound table proof text",()=>{
 const text="Product: P-A\n\n      Batch No.        Expiry Date\n\nLOT-A            2027-01-01\nLOT-B            2027-01-02\n\nA response is required.";
 const notice=source("PROOF-TABLE",text),proof={sourceId:notice.id,sourceHash:notice.sourceHash,quote:"      Batch No.        Expiry Date\n\nLOT-A            2027-01-01\nLOT-B            2027-01-02"};
 const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[notice],maxBytes:80_000,coalesce:true,supportQuotes:[proof]});
 assert.ok(catalog.entries.some(entry=>entry.text.includes(proof.quote)));
 assert.equal(validateEvidenceExcerptCatalog({runId,snapshotHash,selected:[notice],catalog}).size,catalog.entries.length);
 assert.throws(()=>buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[notice],maxBytes:350,coalesce:true,supportQuotes:[proof]}),/coverage|byte limit/);
});
