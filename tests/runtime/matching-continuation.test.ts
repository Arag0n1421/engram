import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {buildRecordReferenceCatalog,resolveRecordReferenceInput,matchSourceBoundRecords,recordReferenceProposalJsonSchemaForCatalog,RecordReferenceError,recordReferenceBatchInputJsonSchema} from "../../src/runtime/record-matching.ts";
import {sourceSections,investigationWork,assertReportCoverage,buildRecordMatchingPacket} from "../../src/runtime/investigation-readiness.ts";
import {buildEvidenceExcerptCatalog,validateEvidenceExcerptCatalog} from "../../src/runtime/evidence-excerpts.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import {buildInvestigationReportPacket,bindInvestigationReportPacket} from "../../src/runtime/investigation-report-packet.ts";
import {bindInvestigationReportWire} from "../../src/runtime/investigation-report-wire.ts";
import {boundMeterlessFetch} from "../../src/runtime/model.ts";
import {NATIVE_TOOL_ISOLATION_SCOPE} from "../../src/runtime/native-tool-isolation.ts";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";
import type {EvidenceEntry,InvestigationRecord} from "../../src/shared/investigation.ts";
const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
const old=JSON.parse(await readFile(new URL("../fixtures/evidence-old-n01.json",import.meta.url),"utf8"));
const entries:EvidenceEntry[]=old.documents.map((document:any)=>({...document,sourceHash:createHash("sha256").update(document.content).digest("hex"),snapshotHash,support:"Known public regression packet."}));
const catalog=buildRecordReferenceCatalog({runId,snapshotHash,selected:entries});

test("known continued notice table retains page-two positive lots in separate exact bounded spans",()=>{
 const earlier=catalog.criteria.filter(c=>c.sourceId==="N01-A");
 assert.ok(earlier.some(c=>c.values.includes("4255105")),"The supplied page-two local lot must be represented, not only first-page rows.");
 assert.equal(new Set(earlier.flatMap(c=>c.values)).size,22);
 const record=catalog.records.find(r=>r.recordId==="N01-R2")!,criterion=earlier.find(c=>c.values.includes(record.values.lot!))!;
 assert.ok((criterion.additionalQuotes?.length??0)>0);
 const request=resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef,recordRefs:[record.recordRef]});
 const matches=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request});
 assert.equal(matches[0]!.status,"match");assert.equal(matches[0]!.criterionCompleteness,"not_established");
 for(const quote of matches[0]!.evidence){assert.ok(quote.quote.length<=1000);assert.ok(entries.find(e=>e.id===quote.sourceId)!.content.includes(quote.quote));}
 for(const value of ["30-Apr-27","60","18/07/2024"]){const forged=structuredClone(request);forged.criterion.values=[value];assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:forged}),/labelled/);}
});

test("advertised parsed and section proposal branches are distinct and overrides produce precise feedback",async()=>{
 const schema=recordReferenceProposalJsonSchemaForCatalog(catalog) as any;
 const parsed=schema.anyOf.find((branch:any)=>!branch.properties.criterion),section=schema.anyOf.find((branch:any)=>branch.properties.criterion);
 assert.equal(parsed.additionalProperties,false);assert.equal(parsed.required.includes("criterion"),false);assert.equal(section.required.includes("criterion"),true);
 assert.deepEqual(parsed.properties.criterionRef.enum,catalog.criteria.map(c=>c.criterionRef));
 const proposal={criterionRef:catalog.criteria[0]!.criterionRef,recordRefs:[catalog.records[0]!.recordRef],criterion:{field:"lot" as const,operator:"one_of" as const,values:["ANY"]}};
 assert.throws(()=>resolveRecordReferenceInput(catalog,proposal),(error:any)=>error instanceof RecordReferenceError&&error.code==="parsed_criterion_override_forbidden");
 const seed=await loadSeed(process.cwd()),store=new WorkspaceStore({root:process.cwd(),stateDir:await mkdtemp(resolve(tmpdir(),"match-feedback-")),model:"test",inferenceAllowed:true,investigationCase:{id:"old-regression",question:old.question,documents:old.documents,snapshot:seed.snapshot,memoryMode:"off"}});
 const run=(await store.startInvestigation()).agentRun.runId!;await store.claimModelCall(run);await store.inspectSources(run,entries.map(e=>e.id),"Read the known source packet.");
 const bound=(await store.getInvestigationContext(run)).projection!.work!.recordCatalog;
 const rejected=await store.matchRecordReferenceBatch(run,[{criterionRef:bound.criteria[0]!.criterionRef,recordRefs:[bound.records[0]!.recordRef],criterion:{field:"lot",operator:"one_of",values:["ANY"]}}]);
 assert.equal(rejected.valid,false);assert.ok("codes" in rejected);if (!("codes" in rejected)) throw new Error("Expected matching feedback");assert.equal(rejected.proposalIndex,0);assert.ok(rejected.codes?.includes("parsed_criterion_override_forbidden"));assert.match(rejected.guidance??"",/remove criterion entirely/);
 assert.equal((await store.claimModelCall(run)).requiredTool,"match_records");assert.equal((await store.activeInvestigation()).agentRun.investigation?.reportAttempts?.length??0,0);
});

test("an unknown from one partial same-product set cannot hide a later positive candidate",()=>{
 const entry=(id:string,content:string,kind:"notice"|"record"):EvidenceEntry=>({...entries[0]!,id,kind,content,sourceHash:createHash("sha256").update(content).digest("hex")});
 const selected=[entry("NOTICE","Product: P-A; Affected lots: LOT-A. Affected lots: LOT-B.","notice"),entry("ROWS",'[{"id":"POS","product":"P-A","lot":"LOT-B"},{"id":"NEG","product":"P-A","lot":"LOT-C"}]',"record")];
 const i:InvestigationRecord={runId,snapshotHash,selections:selected.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,selected).map(s=>s.sectionId)}],findings:[],feedback:[],disposition:null,summary:""};
 const work=()=>investigationWork({runId,snapshotHash,question:"Classify which local records match the lot scope.",registry:{snapshotHash,entries:selected},investigation:i});
 const refs=work().recordCatalog;
 i.recordMatches=matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(refs,{criterionRef:refs.criteria[0]!.criterionRef,recordRefs:refs.records.map(r=>r.recordRef)})});
 assert.equal(work().readiness.reportReady,false);assert.deepEqual(work().readiness.unmatchedRecordChecks.map(check=>refs.records.find(r=>r.recordRef===check.recordRef)!.recordId).sort(),["NEG","POS"]);
 i.recordMatches.push(...matchSourceBoundRecords({runId,snapshotHash,selected,request:resolveRecordReferenceInput(refs,{criterionRef:refs.criteria[1]!.criterionRef,recordRefs:refs.records.map(r=>r.recordRef)})}));
 assert.equal(work().readiness.reportReady,true);assert.ok(i.recordMatches.some(r=>r.recordId==="POS"&&r.status==="match"));assert.ok(i.recordMatches.filter(r=>r.recordId==="NEG").every(r=>r.status==="unknown"));
});

test("all old notice matching results fit existing report evidence limits and pass the unchanged full validator",()=>{
 const results=catalog.criteria.flatMap(criterion=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef,recordRefs:catalog.records.map(r=>r.recordRef)})}));
 const excerpts=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:80_000,coalesce:true,supportQuotes:results.flatMap(r=>r.evidence)});
 validateEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,catalog:excerpts});
 const packet=buildInvestigationReportPacket({runId,snapshotHash,question:old.question,selected:entries,catalog:excerpts,recordMatches:results,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 const findings=packet.context.recordProofGroups.map(group=>{const evidence=[...new Set(group.requiredEvidenceOptions.map(option=>option.quoteIds[0]!))];assert.ok(evidence.length<=5);return {kind:"observation",comparisons:[],summary:"The source-bound lot field comparisons are recorded; incomplete sets and missing values remain unknown.",evidence:evidence.map(quoteId=>({quoteId})),proofGroupIds:[group.proofGroupId]};});
 const before=excerpts.entries.find(e=>e.sourceId==="N01-A")!,after=excerpts.entries.find(e=>e.sourceId==="N01-B")!;
 findings.push({kind:"observation",proofGroupIds:[],summary:"The selected notice text differs.",evidence:[{quoteId:packet.aliasBindings.quote.get(before.quoteId)!},{quoteId:packet.aliasBindings.quote.get(after.quoteId)!}],comparisons:[{beforeQuoteId:packet.aliasBindings.quote.get(before.quoteId)!,afterQuoteId:packet.aliasBindings.quote.get(after.quoteId)!,relation:"different_text"}]} as any);
 assert.equal(packet.context.recordResults.length,12);assert.equal(packet.context.recordProofGroups.length,3);assert.equal(packet.context.evidenceExcerpts.length,excerpts.entries.length);assert.ok(packet.context.recordResults.every(result=>!Object.hasOwn(result,"evidence")));
 const bound=bindInvestigationReportPacket(JSON.stringify({nextStep:"answer_document_question",summary:"The source text and local field comparisons are recorded with explicit unknowns.",findings}),runId,snapshotHash,entries,excerpts,results);
 const {runId:_run,...report}=JSON.parse(bound.argumentsText);const validation=validateInvestigationReport({snapshotHash,entries},entries.map(e=>e.id),report,{question:old.question,recordMatches:results});assert.deepEqual(validation.codes,[]);assert.equal(validation.valid,true);
 const i:InvestigationRecord={runId,snapshotHash,selections:entries.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,entries).map(s=>s.sectionId)}],recordMatches:results,findings:[],feedback:[],disposition:null,summary:""};
 const work=investigationWork({runId,snapshotHash,question:old.question,registry:{snapshotHash,entries},investigation:i});assert.equal(work.readiness.reportReady,true);assertReportCoverage(work.sections,work.readiness,excerpts);
});


test("matching packet contains only pending literal references and omitted rows expand without repeating completed pairs",()=>{
 const i:InvestigationRecord={runId,snapshotHash,selections:entries.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,entries).map(s=>s.sectionId)}],findings:[],feedback:[],disposition:null,summary:""};
 const work=()=>investigationWork({runId,snapshotHash,question:old.question,registry:{snapshotHash,entries},investigation:i});
 const first=work(),packet=buildRecordMatchingPacket({question:old.question,...first});
 assert.equal(packet.context.criterionSections.length,0);assert.ok(JSON.stringify(packet.context).length<9_000);assert.ok(packet.instruction.length<2_000);
 assert.equal(Object.hasOwn(packet.context,"retrievedSections"),false);assert.equal(Object.hasOwn(packet.context,"recordMatches"),false);assert.equal(Object.hasOwn(packet.context,"operationalReads"),false);
 const criterion=first.recordCatalog.criteria[0]!,request=resolveRecordReferenceInput(first.recordCatalog,{criterionRef:criterion.criterionRef},first.readiness.unmatchedRecordChecks);
 assert.equal(request.records.length,4);i.recordMatches=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request});
 const next=work(),nextPacket=buildRecordMatchingPacket({question:old.question,...next});assert.equal(nextPacket.catalog.criteria.some(c=>c.criterionRef===criterion.criterionRef),false);
 assert.throws(()=>resolveRecordReferenceInput(next.recordCatalog,{criterionRef:criterion.criterionRef},next.readiness.unmatchedRecordChecks),/record_reference_not_pending/);
 const after=next.recordCatalog.criteria.find(c=>c.sourceId==="N01-B")!,last=resolveRecordReferenceInput(next.recordCatalog,{criterionRef:after.criterionRef},next.readiness.unmatchedRecordChecks);assert.equal(last.records.length,4);
 assert.deepEqual(new Set(last.records.map(r=>r.recordId)),new Set(catalog.records.map(r=>r.recordId)));
});

test("section fallback and automatic row expansion retain missing/different identities and field-specific checks",()=>{
 const source=(id:string,content:string,kind:"notice"|"record"):EvidenceEntry=>({...entries[0]!,id,kind,content,sourceHash:createHash("sha256").update(content).digest("hex")});
 const selected=[source("PARSED","Product: P-A; Affected lots: LOT-A.","notice"),source("UNPARSED","Product: P-A. A manufacturing-period criterion is not stated.","notice"),source("ROWS",'[{"id":"MISSING","product":null,"lot":"LOT-A"},{"id":"OTHER","product":"P-B","lot":"LOT-A"}]',"record")];
 const i:InvestigationRecord={runId,snapshotHash,selections:selected.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,selected).map(s=>s.sectionId)}],findings:[],feedback:[],disposition:null,summary:""};
 const work=investigationWork({runId,snapshotHash,question:"Classify which local lot records match each notice scope.",registry:{snapshotHash,entries:selected},investigation:i}),packet=buildRecordMatchingPacket({question:"Classify the local lot records.",...work});
 assert.ok(packet.catalog.criterionSections.length);assert.ok(packet.catalog.criterionSections.every(s=>s.sourceId==="UNPARSED"));
 const criterion=work.recordCatalog.criteria[0]!,request=resolveRecordReferenceInput(work.recordCatalog,{criterionRef:criterion.criterionRef},work.readiness.unmatchedRecordChecks);assert.equal(request.records.length,2);
 const results=matchSourceBoundRecords({runId,snapshotHash,selected,request});assert.equal(results.find(r=>r.recordId==="MISSING")!.status,"unknown");assert.equal(results.find(r=>r.recordId==="OTHER")!.reason,"different_product");
 const wrongField=work.readiness.unmatchedRecordChecks.map(check=>({...check,field:"manufacture_date" as const}));assert.throws(()=>resolveRecordReferenceInput(work.recordCatalog,{criterionRef:criterion.criterionRef},wrongField),/record_reference_not_pending/);
});

test("actual outbound matching context is compact and omitted recordRefs complete all trusted pending pairs",async()=>{
 const before=process.env.RECALLOPS_ALLOW_INFERENCE;process.env.RECALLOPS_ALLOW_INFERENCE="true";
 try{
 const seed=await loadSeed(process.cwd()),store=new WorkspaceStore({root:process.cwd(),stateDir:await mkdtemp(resolve(tmpdir(),"match-compact-")),model:"nvidia/nemotron-3.5-super-vl-120b-a12b",inferenceAllowed:true,investigationCase:{id:"old-regression",question:old.question,documents:old.documents,snapshot:seed.snapshot,memoryMode:"off"}});
 const run=(await store.startInvestigation()).agentRun.runId!;await store.inspectSources(run,entries.map(e=>e.id),"Read all supplied regression sources.");
 const work=(await store.getInvestigationContext(run)).projection!.work!;let sent:any;
 const config={token:"test-only",model:"nvidia/nemotron-3.5-super-vl-120b-a12b",baseUrl:"http://127.0.0.1:1/v1"};
 const isolation=async()=>({contract:"nightshift-m1m4-web-v1" as const,scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:"now",origin:"http://127.0.0.1:1",health:{httpStatus:200 as const,status:"ok" as const,engine:"meterless" as const,build:"m1-m4" as const,served:"app" as const,engineReady:true as const},toolsEndpoint:{httpStatus:501 as const,errorCode:"not_available_in_web" as const},universalRuntimeToolCountClaim:false as const});
 const guarded=boundMeterlessFetch(run,config,store,(async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},usage:{prompt_tokens:40,completion_tokens:20},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"select-criteria",type:"function",function:{name:"match_records",arguments:JSON.stringify({runId:run})}}]}}]});}) as typeof fetch,isolation);
 let badArgs:unknown;
 const unsafe=boundMeterlessFetch(run,config,store,(async()=>Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"bad",type:"function",function:{name:"match_records",arguments:JSON.stringify(badArgs)}}]}}]})) as typeof fetch,isolation);
 const matchBody=JSON.stringify({tools:[{type:"function",function:{name:"match_records",parameters:{type:"object",properties:{runId:{type:"string"},...(recordReferenceBatchInputJsonSchema as any).properties},required:["runId","proposals"]}}}]});
 badArgs={runId:"11111111-1111-4111-8111-111111111111",proposals:[{criterionRef:"a".repeat(64)}]};await assert.rejects(unsafe(config.baseUrl+"/chat/completions",{body:matchBody}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
 badArgs={runId:run,proposals:[{criterionRef:"a".repeat(64)}]};await assert.rejects(unsafe(config.baseUrl+"/chat/completions",{body:matchBody}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
 badArgs={runId:run,proposals:[{criterionRef:"invalid"}]};await assert.rejects(unsafe(config.baseUrl+"/chat/completions",{body:matchBody}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
 badArgs={runId:run,proposals:[{criterionRef:"a".repeat(64),recordRefs:["b".repeat(64)],extra:"unsafe"}]};await assert.rejects(unsafe(config.baseUrl+"/chat/completions",{body:matchBody}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
 assert.equal((await store.activeInvestigation()).agentRun.investigation!.recordMatches?.length??0,0,"rejected proposals cannot create matching receipts");
 await(await guarded(config.baseUrl+"/chat/completions",{body:JSON.stringify({messages:[{role:"user",content:"DO_NOT_RETAIN_DUPLICATE_SOURCE_BODIES"}],tools:[{type:"function",function:{name:"match_records",parameters:{type:"object",properties:{runId:{type:"string"},...(recordReferenceBatchInputJsonSchema as any).properties},required:["runId","proposals"]}}}]})})).text();
 assert.ok(Buffer.byteLength(JSON.stringify(sent))<16_000);assert.equal(sent.max_tokens,8192);assert.equal(sent.reasoning_effort,"none");assert.equal(sent.tool_choice.function.name,"match_records");assert.equal(JSON.parse(sent.messages[1].content).criterionSections.length,0);
 const trace=(await store.activeInvestigation()).agentRun.events.find(e=>e.tool==="model.response.nemotron")!;const proof=JSON.parse(trace.message);assert.equal(proof.investigationContextVersion,"source-bound-matching-v3");assert.equal(proof.effectiveRequestBodySha256,createHash("sha256").update(JSON.stringify(sent)).digest("hex"));
 const result=await store.matchRecordReferenceBatch(run,work.recordCatalog.criteria.map(c=>({criterionRef:c.criterionRef})));assert.equal(result.valid,true);assert.equal(result.matches!.length,12);assert.equal(result.readiness.reportReady,true);
 const event=(await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="match_records").at(-1)!;assert.equal(JSON.parse(event.message).pendingRowExpansionProposals,3);
 const markerFetch=boundMeterlessFetch(run,config,store,(async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.deepEqual(body.tools.map((tool:any)=>tool.function.name),["request_investigation_report"]);assert.equal(body.tool_choice.function.name,"request_investigation_report");assert.equal(body.reasoning_effort,"none");assert.equal(body.max_tokens,4096);const markerContext=JSON.parse(body.messages[1].content);assert.equal(markerContext.question,old.question);assert.equal(markerContext.matchingResultCount,12);assert.equal(markerContext.sourceBindings.length,3);assert.equal(Object.hasOwn(markerContext,"work"),false);assert.equal(Object.hasOwn(markerContext,"recordMatches"),false);assert.ok(Buffer.byteLength(JSON.stringify(body))<4_000);assert.ok(body.messages[0].content.startsWith("READINESS HANDSHAKE ONLY"));return Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"marker",type:"function",function:{name:"request_investigation_report",arguments:JSON.stringify({runId:run})}}]}}]});}) as typeof fetch,isolation);
 await(await markerFetch(config.baseUrl+"/chat/completions",{body:JSON.stringify({tools:["request_investigation_report","recall_history","what_if"].map(name=>({type:"function",function:{name,parameters:{type:"object"}}}))})})).text();
 const markerProof=JSON.parse((await store.activeInvestigation()).agentRun.events.filter(e=>e.tool==="model.response.nemotron").at(-1)!.message);assert.equal(markerProof.investigationContextVersion,"compact-ready-marker-v1");assert.equal(markerProof.requestedEffort,"none");
 const extraReason=boundMeterlessFetch(run,config,store,(async()=>Response.json({model:config.model,meterless:{provider_model:config.model,routed_model:config.model,winning_route:{model:config.model,provider:"nvidia"}},choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"marker",type:"function",function:{name:"request_investigation_report",arguments:JSON.stringify({runId:run,reason:"Extra model-selected text"})}}]}}]})) as typeof fetch,isolation);
 await assert.rejects(extraReason(config.baseUrl+"/chat/completions",{body:JSON.stringify({tools:[{type:"function",function:{name:"request_investigation_report",parameters:{type:"object"}}}]})}),{code:"WORKFLOW_TOOL_CHOICE_REJECTED"});
 const current=(await store.getInvestigationContext(run)).projection!;current.context.work!.readiness.reportReady=false;let forbiddenPosts=0;
 const unready=boundMeterlessFetch(run,config,{claimModelCall:async()=>({maxOutputTokens:4096 as const,phase:"investigation" as const,requiredTool:"request_investigation_report" as const,terminal:false,repair:false}),trace:async()=>{},getPreparedTerminalProjection:async()=>{throw new Error("No terminal");},recordTerminalAttempt:async()=>({recorded:true as const,attemptCount:1}),getInvestigationContext:async()=>({active:true,projection:current})},(async()=>{forbiddenPosts++;throw new Error("Unready marker must not call provider");}) as typeof fetch,isolation);
 await assert.rejects(unready(config.baseUrl+"/chat/completions",{body:JSON.stringify({tools:[{type:"function",function:{name:"request_investigation_report",parameters:{type:"object"}}}]})}),{code:"WORKFLOW_TOOL_UNAVAILABLE"});assert.equal(forbiddenPosts,0);
 }finally{if(before===undefined)delete process.env.RECALLOPS_ALLOW_INFERENCE;else process.env.RECALLOPS_ALLOW_INFERENCE=before;}
});


test("proof-first report schema requires explicit proof arrays and exact correlated record triples",()=>{
 const results=catalog.criteria.flatMap(criterion=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef})}));
 const excerpts=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:80_000,coalesce:true,supportQuotes:results.flatMap(r=>r.evidence)}),packet=buildInvestigationReportPacket({runId,snapshotHash,question:old.question,selected:entries,catalog:excerpts,recordMatches:results,comparisonRequirements:{noticeComparison:true,recordMatching:true}}),schema=packet.schema as any;
 assert.ok(schema.properties.findings.items.required.includes("proofGroupIds"));assert.ok(schema.properties.findings.items.required.includes("comparisons"));
 const groupIds=schema.properties.findings.items.properties.proofGroupIds.items.enum;assert.ok(groupIds.length);for(const result of results){const fullGroup=packet.trustedRecordProofGroups.find(group=>group.resultIds.includes(result.resultId))!;const groupAlias=packet.aliasBindings.check.get(fullGroup.proofGroupId)!;const resultAlias=packet.aliasBindings.result.get(result.resultId)!;assert.ok(groupIds.includes(groupAlias));assert.ok(packet.context.recordProofGroups.some(group=>group.proofGroupId===groupAlias&&group.resultIds.includes(resultAlias)));}
 assert.match(packet.instruction,/Every finding MUST contain/);assert.match(packet.instruction,/Across all findings, cover every supplied R_/);assert.match(packet.instruction,/does not revoke/);assert.match(packet.instruction,/never invent a lot range/);
 const raw=JSON.stringify({nextStep:"answer_document_question",summary:"The text is recorded.",findings:[{kind:"observation",summary:"The text is recorded.",evidence:[{quoteId:packet.aliasBindings.quote.get(excerpts.entries[0]!.quoteId)!}]}]});assert.throws(()=>bindInvestigationReportPacket(raw,runId,snapshotHash,entries,excerpts),/explicitly contain/);
 const literal=JSON.parse(raw);literal.findings[0].comparisons=[];literal.findings[0].recordChecks=[];const bound=bindInvestigationReportPacket(JSON.stringify(literal),runId,snapshotHash,entries,excerpts);const {runId:_run,...report}=JSON.parse(bound.argumentsText);const validation=validateInvestigationReport({snapshotHash,entries},entries.map(e=>e.id),report,{question:old.question,recordMatches:results});assert.equal(validation.valid,false);assert.ok(validation.codes.includes("record_match_coverage_required"));assert.ok(validation.codes.includes("notice_comparison_coverage_required"));
});

test("mechanical proof options reject stale or uncovered record proofs without generating report claims",()=>{
 const result=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:catalog.criteria[0]!.criterionRef})})[0]!,excerpts=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:80_000,coalesce:true,supportQuotes:result.evidence});
 const input={runId,snapshotHash,question:old.question,selected:entries,catalog:excerpts,recordMatches:[result],comparisonRequirements:{noticeComparison:true,recordMatching:true}};const packet=buildInvestigationReportPacket({...input,feedback:[{codes:["record_match_coverage_required"],summary:"REJECTED_NARRATIVE_MUST_STAY_PRIVATE"}],formatFailures:[{codes:["INVALID_INVESTIGATION_REPORT_WIRE"],rawContent:"REJECTED_NARRATIVE_MUST_STAY_PRIVATE",rawContentHash:"c".repeat(64),rawContentBytes:37,reportRequestNumber:1}]});
 assert.equal(JSON.stringify(packet.context).includes("REJECTED_NARRATIVE_MUST_STAY_PRIVATE"),false);assert.equal(packet.context.formatFailures[0]!.rawContentOmitted,true);assert.deepEqual(packet.context.feedback[0]!.codes,["record_match_coverage_required"]);
 assert.equal(Object.hasOwn(packet.context,"findings"),false);assert.equal(Object.hasOwn(packet.context,"nextStep"),false);assert.equal(packet.context.recordProofGroups[0]!.resultIds[0],packet.aliasBindings.result.get(result.resultId));
 for(const options of packet.context.recordProofGroups[0]!.requiredEvidenceOptions)for(const id of options.quoteIds){const fullId=packet.aliasBindings.quoteToFull.get(id);assert.ok(excerpts.entries.some(e=>e.quoteId===fullId));}
 assert.throws(()=>buildInvestigationReportPacket({...input,recordMatches:[{...result,snapshotHash:"c".repeat(64)}]}),/stale/);
 const changed=structuredClone(result);changed.evidence[0]!.quote="A proof not contained in the selected source.";const {resultId:_id,...body}=changed;changed.resultId=createHash("sha256").update(JSON.stringify(body)).digest("hex");assert.throws(()=>buildInvestigationReportPacket({...input,recordMatches:[changed]}),/does not bind to the current selected source/);
});

test("actual N01 table fragments distinguish unknown comparison scope from the original notice",async()=>{
 const {buildInvestigationReceiptPacket}=await import("../../src/runtime/investigation-report-receipts.ts");
 const earlier=catalog.criteria.filter(c=>c.sourceId==="N01-A"&&c.field==="lot"),later=catalog.criteria.find(c=>c.sourceId==="N01-B"&&c.field==="lot")!;
 assert.equal(earlier.length,2);assert.equal(new Set(earlier.flatMap(c=>c.values)).size,22);assert.deepEqual(later.values,["4255106"]);
 const record=catalog.records.find(r=>r.recordId==="N01-R1")!,first=earlier[0]!;
 const compare=(criterion:typeof first)=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef,recordRefs:[record.recordRef]})})[0]!;
 const oldMatch=compare(first),newMatch=compare(later);
 assert.equal(oldMatch.status,"unknown");assert.equal(oldMatch.reason,"incomplete_lot_set");assert.equal(newMatch.status,"match");
 assert.ok(earlier.every(c=>!c.values.includes("4255106"))); // parsed values only, not proof that extraction is exhaustive
 const result=[oldMatch,newMatch],excerpts=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:80_000,coalesce:true,supportQuotes:result.flatMap(r=>r.evidence)});
 const packet=buildInvestigationReceiptPacket({runId,snapshotHash,question:old.question,selected:entries,catalog:excerpts,recordMatches:result,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 const receipts=(packet.context as any).recordReceipts;
 const unknown=receipts.find((r:any)=>r.status==="unknown");assert.equal(unknown.reason,"checked_subset_cannot_establish_exclusion");assert.match(unknown.criterionLimit,/does not mean the original notice or its table is incomplete/);
 assert.equal(receipts.find((r:any)=>r.status==="match").reason,"exact_lot_comparison");
 assert.equal(packet.privateBinding.resultBodies[0]!.reason,"incomplete_lot_set");assert.equal(packet.privateBinding.resultBodies[0]!.resultId,oldMatch.resultId);
});

test("missing or altered source rows never make partial table comparison a proven no-match",()=>{
 const original=entries.find(e=>e.id==="N01-A")!, altered={...original,content:original.content.replace("4276079                31-Oct-27            60 applicators           10/03/2025", "UNREADABLE TABLE ROW")};
 altered.sourceHash=createHash("sha256").update(altered.content).digest("hex");
 const sources=entries.map(e=>e.id===altered.id?altered:e),fresh=buildRecordReferenceCatalog({runId,snapshotHash,selected:sources});
 const criterion=fresh.criteria.find(c=>c.sourceId==="N01-A"&&c.field==="lot")!,record=fresh.records.find(r=>r.recordId==="N01-R1")!;
 const result=matchSourceBoundRecords({runId,snapshotHash,selected:sources,request:resolveRecordReferenceInput(fresh,{criterionRef:criterion.criterionRef,recordRefs:[record.recordRef]})})[0]!;
 assert.equal(result.status,"unknown");assert.equal(result.reason,"incomplete_lot_set");
});

test("actual N01 waits for both parsed earlier-notice fragments for a known absent lot",()=>{
 const results=catalog.criteria.flatMap(criterion=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:resolveRecordReferenceInput(catalog,{criterionRef:criterion.criterionRef})}));
 const fragments=catalog.criteria.filter(c=>c.sourceId==="N01-A"&&c.field==="lot");assert.equal(fragments.length,2);
 const missing=results.find(result=>result.recordId==="N01-R1"&&result.evidence.some(proof=>proof.sourceId==="N01-A"&&proof.quote===fragments[1]!.quote)&&result.normalizedCriterion.join()===fragments[1]!.values.join())!;
 assert.ok(missing);assert.equal(missing.status,"unknown");
 const i:InvestigationRecord={runId,snapshotHash,selections:entries.map(e=>({sourceId:e.id,sourceHash:e.sourceHash,at:"now",reason:"Read."})),retrievalReceipts:[{runId,snapshotHash,at:"now",sectionIds:sourceSections(runId,snapshotHash,entries).map(s=>s.sectionId)}],recordMatches:results.filter(result=>result.resultId!==missing.resultId),findings:[],feedback:[],disposition:null,summary:""};
 const work=()=>investigationWork({runId,snapshotHash,question:old.question,registry:{snapshotHash,entries},investigation:i});
 const record=catalog.records.find(r=>r.recordId==="N01-R1")!;
 assert.ok(work().readiness.unmatchedRecordChecks.some(check=>check.recordRef===record.recordRef&&check.noticeSourceId==="N01-A"&&check.field==="lot"));
 i.recordMatches!.push(missing);
 assert.equal(work().readiness.reportReady,true);assert.equal(missing.status,"unknown");
});
