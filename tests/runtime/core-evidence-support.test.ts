import test from "node:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {buildEvidenceExcerptCatalog,evidenceFocusTerms,validateEvidenceExcerptCatalog} from "../../src/runtime/evidence-excerpts.ts";
import {bindInvestigationReportWire} from "../../src/runtime/investigation-report-wire.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import {projectInvestigationContext} from "../../src/runtime/investigation-projection.ts";
import {explicitDate,matchSourceBoundRecords} from "../../src/runtime/record-matching.ts";
import type {EvidenceEntry,InvestigationReportInput} from "../../src/shared/investigation.ts";
const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
const source=(id:string,content:string,kind:"notice"|"record"="notice"):EvidenceEntry=>({id,title:id,kind,content,sourceHash:createHash("sha256").update(content).digest("hex"),snapshotHash,sourceURL:`urn:synthetic:${id}`,version:1,retrievedAt:"2026-10-26T00:00:00Z",refs:[id],authority:"fictional-record",support:"Synthetic test evidence."});
const quote=(entry:EvidenceEntry,text=entry.content)=>({sourceId:entry.id,sourceHash:entry.sourceHash,quote:text});
const report=(summary:string,evidence:ReturnType<typeof quote>[]):InvestigationReportInput=>({disposition:"answered",summary,findings:[{id:"finding",kind:"observation",summary,evidence}]});

test("complete risk sentence survives an old chunk boundary and cannot support a checked risk escalation",()=>{
  const risk="This condition presents a potential risk\nof high severity infection after use.";
  const padding="Background information is unchanged. ".repeat(27);
  const entries=[source("BEFORE",padding+risk),source("AFTER",padding+risk)];
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:20_000});
  const spans=catalog.entries.filter(entry=>entry.text.includes("potential risk"));
  assert.equal(spans.length,2);
  assert.ok(spans.every(span=>span.text.includes(risk)),"The qualifier and consequence must remain in one source unit.");
  assert.equal(catalog.entries.some(entry=>entry.text.trim().endsWith("potential risk")),false);
  const before=quote(entries[0]!,spans.find(span=>span.sourceId==="BEFORE")!.text),after=quote(entries[1]!,spans.find(span=>span.sourceId==="AFTER")!.text);
  const invalid=report("The update introduces a new higher risk.",[before,after]);
  invalid.findings[0]!.comparisons=[{before,after,relation:"same_text"}];
  const result=validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),invalid,{question:"Compare the risk in the prior and updated notice."});
  assert.equal(result.valid,false);assert.ok(result.codes.includes("unchanged_evidence_cannot_support_change"));assert.ok(result.codes.includes("unsupported_material_risk_change"));
  const valid=report("The quoted risk statement is unchanged.",[before,after]);valid.findings[0]!.comparisons=[{before,after,relation:"same_text"}];
  assert.equal(validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),valid,{question:"Compare the risk notices."}).valid,true);
});

test("unsupported summary identifiers are reported as exact bounded machine tokens",()=>{
 const entry=source("NOTICE-TOKEN","The notice asks the recipient to review the supplied item.");
 const input:InvestigationReportInput={disposition:"answered",summary:"The notice preserves the existing action on 2027-05-04.",findings:[{id:"finding-token",kind:"observation",summary:"The notice adds code ZX-99173 and date 2026-04-02.",evidence:[quote(entry,"The notice asks the recipient to review the supplied item.")]}]};
 const issueSink:import("../../src/shared/investigation.ts").InvestigationValidationIssue[]=[];
 const result=validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input,{issueSink});
 assert.equal(result.valid,false);assert.ok(result.codes.includes("unsupported_identifier_or_date"));
 assert.deepEqual(issueSink.find(issue=>issue.findingIndex===0&&issue.code==="unsupported_identifier_or_date")?.unsupportedTokens,["ZX-99173","2026-04-02"]);
 assert.deepEqual(issueSink.find(issue=>issue.findingIndex===undefined&&issue.code==="unsupported_identifier_or_date")?.unsupportedTokens,["2027-05-04"]);
});

test("unsafe literal reflection never weakens unsupported-token validation",()=>{
 const entry=source("NOTICE-OVERLONG","The notice asks the recipient to review the supplied item."),overlong=`CODE-${"A".repeat(110)}9`,input:InvestigationReportInput={disposition:"answered",summary:"The notice preserves its action.",findings:[{id:"finding-overlong",kind:"observation",summary:`The notice identifies ${overlong}.`,evidence:[quote(entry,"The notice asks the recipient to review the supplied item.")]}]};
 const withoutSink=validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input),issueSink:import("../../src/shared/investigation.ts").InvestigationValidationIssue[]=[],withSink=validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input,{issueSink});
 assert.deepEqual(withSink,withoutSink);assert.ok(withSink.codes.includes("unsupported_identifier_or_date"));
 const issue=issueSink.find(item=>item.findingIndex===0&&item.code==="unsupported_identifier_or_date");assert.ok(issue);assert.equal(issue.unsupportedTokens,undefined);
});

test("long indivisible sentences are omitted explicitly and later short evidence still fits",()=>{
  const long="An indivisible sentence "+"x".repeat(1500)+".";
  const entry=source("LONG",long+"\n\nComplete later statement.");
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[entry],maxBytes:2000});
  assert.deepEqual(catalog.entries.map(row=>row.text),["Complete later statement."]);
  assert.ok(catalog.omissions[0]!.omittedRanges.some(range=>range.start===0&&range.end===long.length));
  assert.ok(catalog.bytes<=2000);assert.equal(validateEvidenceExcerptCatalog({runId,snapshotHash,selected:[entry],catalog}).size,1);
});

test("exact supplied identifier retrieves a late appendix row with its table header, not only first-N text",()=>{
  const rows=Array.from({length:140},(_,index)=>`ITEM-${index} | LOT-${index} | included`);
  rows.push("TARGET-X | ZX-88491 | repeat acknowledgement required");
  const entry=source("APPENDIX","Item | Lot | Instruction\n"+rows.join("\n"));
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[entry],maxBytes:2400,focusTerms:evidenceFocusTerms("Check lot ZX-88491.")});
  assert.ok(catalog.entries.some(row=>row.text==="Item | Lot | Instruction"));
  assert.ok(catalog.entries.some(row=>row.text.includes("ZX-88491")&&row.text.includes("repeat acknowledgement required")));
  assert.ok(catalog.omissions.length);assert.ok(catalog.bytes<=2400);
});

test("a local record cannot substitute for the updated notice in a documentary comparison",()=>{
  const before=source("ORIGINAL","A response is required once."),after=source("UPDATE","Repeat acknowledgement is required even after an earlier response."),local=source("LOCAL","Local record: a response was sent.","record");
  const entries=[before,after,local];
  const input=report("The notices have different response instructions.",[quote(before),quote(local)]);
  input.findings[0]!.comparisons=[{before:quote(before),after:quote(local),relation:"different_text"}];
  const invalid=validateInvestigationReport({snapshotHash,entries},[before.id,local.id],input,{question:"Compare the original and updated notices."});
  assert.ok(invalid.codes.includes("comparison_requires_two_cited_notices"));assert.ok(invalid.codes.includes("notice_comparison_coverage_required"));
  input.findings[0]!.evidence=[quote(before),quote(after)];input.findings[0]!.comparisons=[{before:quote(before),after:quote(after),relation:"different_text"}];
  assert.equal(validateInvestigationReport({snapshotHash,entries},[before.id,after.id],input,{question:"Compare the original and updated notices."}).valid,true);
});

test("prior communication and delegated instructions do not establish new harm or incompatible authority",()=>{
  const old=source("PRIOR","The hazard can cause injury."),updated=source("CURRENT","The hazard was previously communicated and can cause injury."),relay=source("RELAY","Follow the manufacturer instructions in the original notice.");
  const entries=[old,updated,relay];
  const input=report("A new hazard is introduced.",[quote(old),quote(updated)]);input.findings[0]!.comparisons=[{before:quote(old),after:quote(updated),relation:"different_text"}];
  assert.ok(validateInvestigationReport({snapshotHash,entries},entries.map(row=>row.id),input).codes.includes("unsupported_material_risk_change"));
  const conflict=report("The authorities conflict.",[quote(old),quote(relay)]);conflict.findings[0]!.kind="conflict";
  assert.ok(validateInvestigationReport({snapshotHash,entries},entries.map(row=>row.id),conflict).codes.includes("delegation_does_not_establish_conflict"));
});

test("source-bound manufacture-date criteria classify inclusive range and keep missing date unknown",()=>{
  const criterion=source("SCOPE","Product: P-ALPHA; Manufacture date range: from 2023-02-09 to 2025-04-20 inclusive.");
  const local=source("RECORDS","Record C-A; Product: P-ALPHA; Manufacture date: 2024-06-01.\nRecord C-B; Product: P-ALPHA; Manufacture date: 2025-05-01.\nRecord C-C; Product: P-ALPHA; Manufacture date: null; Expiry: 2027-08-31.","record");
  const request={criterion:{sourceId:criterion.id,quote:criterion.content,field:"manufacture_date" as const,operator:"between_inclusive" as const,values:["2023-02-09","2025-04-20"],product:"P-ALPHA"},records:[
    {sourceId:local.id,quote:"Record C-A; Product: P-ALPHA; Manufacture date: 2024-06-01.",recordId:"C-A",product:"P-ALPHA",value:"2024-06-01"},
    {sourceId:local.id,quote:"Record C-B; Product: P-ALPHA; Manufacture date: 2025-05-01.",recordId:"C-B",product:"P-ALPHA",value:"2025-05-01"},
    {sourceId:local.id,quote:"Record C-C; Product: P-ALPHA; Manufacture date: null; Expiry: 2027-08-31.",recordId:"C-C",product:"P-ALPHA",value:null},
  ]};
  const selected=[criterion,local],matches=matchSourceBoundRecords({runId,snapshotHash,selected,request});
  assert.deepEqual(matches.map(row=>row.status),["match","no_match","unknown"]);
  assert.equal(matches[2]!.normalizedRecordValue,null);
  const expirySubstitution=structuredClone(request);expirySubstitution.records[2]!.value="2027-08-31";
  assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected,request:expirySubstitution})[2]!.status,"unknown");
  assert.equal(explicitDate("05/01/2025"),null);assert.equal(explicitDate("2025-02-30"),null);assert.equal(explicitDate("9 February 2023"),"2023-02-09");
  const accepted=report("The explicit records have checked classifications.",[quote(criterion),quote(local)]);
  accepted.findings[0]!.recordChecks=matches.map(({resultId,field,status})=>({resultId,field,status}));
  assert.equal(validateInvestigationReport({snapshotHash,entries:selected},selected.map(row=>row.id),accepted,{recordMatches:matches}).valid,true);
  accepted.findings[0]!.recordChecks![1]!.status="match";
  assert.ok(validateInvestigationReport({snapshotHash,entries:selected},selected.map(row=>row.id),accepted,{recordMatches:matches}).codes.includes("record_match_mismatch"));
  accepted.findings[0]!.recordChecks=matches.map(({resultId,field,status})=>({resultId,field,status}));accepted.summary="The field checks do not establish safe status.";accepted.findings[0]!.summary="The record is not safe or cleared by these field checks.";
  assert.equal(validateInvestigationReport({snapshotHash,entries:selected},selected.map(row=>row.id),accepted,{recordMatches:matches}).valid,true);
  assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash:"c".repeat(64),selected,request}),/selected canonical/);
  const guessed=structuredClone(request);guessed.records[0]!.recordId="GUESSED";assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected,request:guessed}),/literal quoted/);
});

test("strict report binder preserves model-selected before/after checks without choosing relevance",()=>{
  const entries=[source("BEFORE","The instruction is unchanged."),source("AFTER","The instruction is unchanged.")];
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:entries,maxBytes:5000});
  const [before,after]=catalog.entries;
  const raw=JSON.stringify({nextStep:"answer_document_question",summary:"The instruction text is unchanged.",findings:[{kind:"observation",summary:"The instruction text is unchanged.",evidence:[{quoteId:before!.quoteId},{quoteId:after!.quoteId}],comparisons:[{beforeQuoteId:before!.quoteId,afterQuoteId:after!.quoteId,relation:"same_text"}]}]});
  const bound=bindInvestigationReportWire(raw,runId,snapshotHash,entries,catalog),internal=JSON.parse(bound.argumentsText);
  assert.equal(internal.findings[0].comparisons[0].before.quote,entries[0]!.content);
  assert.equal(bound.audit.rawWireSha256,createHash("sha256").update(raw).digest("hex"));
  assert.equal(validateInvestigationReport({snapshotHash,entries},entries.map(row=>row.id),internal,{question:"Compare the notices."}).valid,true);
});


test("risk support rejects negated escalation but allows an explicitly stated later increase",()=>{
 const before=source("BASE","Risk was communicated earlier.");
 for(const text of ["No higher risk is present.","Risk has not increased.","There is no evidence of increased risk."]){
  const after=source("UPDATED",text),input=report("The risk has increased.",[quote(before),quote(after)]);input.findings[0]!.comparisons=[{before:quote(before),after:quote(after),relation:"different_text"}];
  assert.ok(validateInvestigationReport({snapshotHash,entries:[before,after]},[before.id,after.id],input).codes.includes("unsupported_material_risk_change"),text);
 }
 const after=source("UPDATED","The issue was previously communicated; risk has now increased.");
 const input=report("The risk has increased.",[quote(before),quote(after)]);input.findings[0]!.comparisons=[{before:quote(before),after:quote(after),relation:"different_text"}];
 assert.equal(validateInvestigationReport({snapshotHash,entries:[before,after]},[before.id,after.id],input).valid,true);
});

test("record matching binds line-wrapped criteria, product identity, complete lot set and the same record entity",()=>{
 const criterion=source("DATE","Product: P-ALPHA. Devices\nmanufactured\nbetween\n2023-02-09 through\n2025-04-20.");
 const local=source("ROWS","Record A-1; Product: P-ALPHA; Manufacture date: unknown. Record B-2; Product: P-ALPHA; Manufacture date: 2024-06-01.","record");
 const base={criterion:{sourceId:criterion.id,quote:criterion.content,product:"P-ALPHA",field:"manufacture_date" as const,operator:"between_inclusive" as const,values:["2023-02-09","2025-04-20"]},records:[{sourceId:local.id,quote:local.content,recordId:"A-1",product:"P-ALPHA",value:"2024-06-01"}]};
 assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request:base})[0]!.status,"unknown","A value in a later entity cannot be attributed to A-1.");
 base.records[0]!.recordId="B-2";
 assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request:base})[0]!.status,"match");
 const lots=source("LOTS","Product: P-ALPHA; Affected lots: LOT-001, LOT-002, LOT-003.");
 const records=source("LOT-ROWS","Record L-1; Product: P-BETA; Lot: LOT-001. Record L-2; Product: P-ALPHA; Lot: LOT-002.","record");
 const request={criterion:{sourceId:lots.id,quote:lots.content,product:"P-ALPHA",field:"lot" as const,operator:"one_of" as const,values:["LOT-001"]},records:[{sourceId:records.id,quote:records.content,recordId:"L-1",product:"P-BETA",value:"LOT-001"},{sourceId:records.id,quote:records.content,recordId:"L-2",product:"P-ALPHA",value:"LOT-002"}]};
 const result=matchSourceBoundRecords({runId,snapshotHash,selected:[lots,records],request});
 assert.equal(result[0]!.status,"no_match");assert.equal(result[0]!.reason,"different_product");
 assert.equal(result[1]!.status,"unknown");assert.equal(result[1]!.reason,"incomplete_lot_set");
 request.criterion.values=["LOT-001","LOT-002","LOT-003"];
 const complete=matchSourceBoundRecords({runId,snapshotHash,selected:[lots,records],request});
 assert.equal(complete[1]!.status,"match");assert.equal(complete[1]!.criterionCompleteness,"complete_explicit_list");
});


test("long selected canonical bodies remain private while focused late evidence reaches the bounded projection",()=>{
 const rows=Array.from({length:1500},(_,index)=>`ITEM-${index} | LOT-${index} | response required`);
 rows.push("TARGET-X | ZX-88491 | repeat acknowledgement required");
 const entry=source("LONG-APPENDIX","Item | Lot | Instruction\n"+rows.join("\n"));
 const investigation={runId,snapshotHash,selections:[{sourceId:entry.id,sourceHash:entry.sourceHash,reason:"Inspect supplied identifier",at:"2026-10-26T00:00:00Z"}],findings:[],feedback:[],disposition:null,summary:""};
 const projection=projectInvestigationContext({runId,snapshotHash,question:"Check lot ZX-88491.",registry:{snapshotHash,entries:[entry]},investigation,requestsUsed:1,reportOnly:false});
 assert.equal(projection.canonicalSelected?.[0]?.content,entry.content);
 assert.deepEqual(projection.context.selected,[]);
 assert.ok(projection.context.selectedSourceExcerpts[0]!.catalog.entries.some(excerpt=>excerpt.text.includes("ZX-88491")));
 assert.ok(Buffer.byteLength(JSON.stringify(projection.context))<=40_000);
 const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:projection.canonicalSelected!,maxBytes:2400,focusTerms:evidenceFocusTerms(projection.context.question)});
 const chosen=catalog.entries.find(excerpt=>excerpt.text.includes("ZX-88491"))!;
 const bound=bindInvestigationReportWire(JSON.stringify({nextStep:"answer_document_question",summary:"The record requires repeat acknowledgement.",findings:[{kind:"observation",summary:"The record requires repeat acknowledgement.",evidence:[{quoteId:chosen.quoteId}]}]}),runId,snapshotHash,projection.canonicalSelected!,catalog);
 assert.equal(JSON.parse(bound.argumentsText).findings[0].evidence[0].sourceHash,entry.sourceHash);
});

test("lot identifiers remain case-sensitive and a field result cannot confer recall or QA clearance",()=>{
 const criterion=source("CASE-SCOPE","Product: P-ALPHA; Affected lots: AbC-123.");
 const local=source("CASE-ROW","Record CASE-1; Product: P-ALPHA; Lot: ABC-123.","record");
 const selected=[criterion,local];
 const matches=matchSourceBoundRecords({runId,snapshotHash,selected,request:{criterion:{sourceId:criterion.id,quote:criterion.content,product:"P-ALPHA",field:"lot",operator:"one_of",values:["AbC-123"]},records:[{sourceId:local.id,quote:local.content,recordId:"CASE-1",product:"P-ALPHA",value:"ABC-123"}]}});
 assert.equal(matches[0]!.status,"no_match");
 const input=report("The record is safe and not recalled.",[quote(criterion),quote(local)]);input.findings[0]!.recordChecks=matches.map(({resultId,field,status})=>({resultId,field,status}));
 assert.ok(validateInvestigationReport({snapshotHash,entries:selected},selected.map(entry=>entry.id),input,{recordMatches:matches}).codes.includes("field_match_does_not_establish_clearance"));
});


test("identifier prefixes cannot bind lot or product values",()=>{
 const criterion=source("PREFIX-SCOPE","Product: P-10; Affected lots: LOT-10.");
 const local=source("PREFIX-ROW","Record R-10; Product: P-10; Lot: LOT-10.","record");
 const request={criterion:{sourceId:criterion.id,quote:criterion.content,product:"P-10",field:"lot" as const,operator:"one_of" as const,values:["LOT-10"]},records:[{sourceId:local.id,quote:local.content,recordId:"R-10",product:"P-10",value:"LOT-10"}]};
 assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request})[0]!.status,"match");
 const shortLot=structuredClone(request);shortLot.criterion.values=["LOT-1"];
 assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request:shortLot}),/Criterion values/);
 const shortProduct=structuredClone(request);shortProduct.criterion.product="P-1";shortProduct.records[0]!.product="P-1";
 assert.equal(matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request:shortProduct})[0]!.status,"unknown");
});

test("store retains bound matching proofs across projection without changing operational state or authorizing math",async()=>{
 const seed=await loadSeed(),stateDir=await mkdtemp(resolve(tmpdir(),"engram-core-match-"));
 const criterion=source("RANGE-NOTICE","Product: P-ALPHA; Manufacture date range: from 2023-02-09 to 2025-04-20 inclusive.");
 const local=source("LOCAL-APPENDIX","Record ROW-1; Product: P-ALPHA; Manufacture date: 2024-06-01.","record");
 const documents=[criterion,local].map(({sourceHash:_hash,snapshotHash:_snapshot,support:_support,...document})=>document);
 const options={root:process.cwd(),stateDir,model:"nvidia/test",inferenceAllowed:true,investigationCase:{id:"core-regression",question:"Classify the explicitly supplied manufacture-date record.",snapshot:seed.snapshot,documents,memoryMode:"off" as const}};
 const store=new WorkspaceStore(options),before=await store.startInvestigation(),id=before.agentRun.runId!;
 await store.claimModelCall(id);
 const request={criterion:{sourceId:criterion.id,quote:criterion.content,product:"P-ALPHA",field:"manufacture_date" as const,operator:"between_inclusive" as const,values:["2023-02-09","2025-04-20"]},records:[{sourceId:local.id,quote:local.content,recordId:"ROW-1",product:"P-ALPHA",value:"2024-06-01"}]};
 await assert.rejects(store.matchRecords(id,request),/selected canonical/);
 await store.inspectSources(id,[criterion.id,local.id],"Read the notice criterion and local entity before matching.");
 const result=await store.matchRecords(id,request);assert.equal(result.matches[0]!.status,"match");
 const after=await store.getWorkspace();assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(after.receipts,before.receipts);assert.equal(after.plan,null);assert.equal(after.agentRun.investigation?.disposition,null);
 await assert.rejects(store.calculatePlan(id),/accepted|handoff/i);
 const restored=new WorkspaceStore(options),projection=(await restored.getInvestigationContext(id,{reportOnly:true})).projection!;
 assert.deepEqual(projection.context.recordMatches,result.matches);
 const discovered=await restored.getEvidenceIndex(id,"2024-06-01");assert.ok(discovered.entries.some(entry=>entry.id===local.id));assert.equal("content" in discovered.entries[0]!,false);
 const canonical=projection.canonicalSelected!,evidence=canonical.map(entry=>({sourceId:entry.id,sourceHash:entry.sourceHash,quote:entry.content}));
 const input=report("The explicit manufacture-date comparison matches.",evidence);
 assert.ok((await restored.submitInvestigationReport(id,input)).codes.includes("record_match_coverage_required"));
 input.findings[0]!.recordChecks=result.matches.map(({resultId,field,status})=>({resultId,field,status}));
 assert.equal((await restored.submitInvestigationReport(id,input)).valid,true);
 const saved=await restored.getWorkspace();assert.equal(saved.agentRun.status,"complete");assert.equal(saved.plan,null);assert.deepEqual(saved.receipts,before.receipts);
});


test("explicit local field-classification answers require deterministic matching while missing evidence and unrelated questions remain distinct",()=>{
 const entries=[source("SCOPE","Manufacture date range: from 2023-02-09 to 2025-04-20."),source("ROW","Record ROW-1; Manufacture date: unknown.","record")];
 const input=report("The selected record is in scope.",entries.map(entry=>quote(entry)));
 const task="Which local records fall within the manufacture date range?";
 assert.ok(validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),input,{question:task}).codes.includes("source_bound_record_matching_required"));
 assert.equal(validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),input,{question:"What do the documents say?"}).codes.includes("source_bound_record_matching_required"),false);
 input.disposition="needs_evidence";input.question="Which manufacture date record applies to ROW-1?";input.findings[0]!.kind="missing_evidence";
 assert.equal(validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),input,{question:task}).codes.includes("source_bound_record_matching_required"),false);
});


test("notice product and criterion values must share the same explicitly delimited entity",()=>{
 const criterion=source("MULTI-PRODUCT","Product: P-A; Affected lots: LOT-A.\nProduct: P-B; Affected lots: LOT-B.");
 const local=source("PRODUCT-ROW","Record R-1; Product: P-A; Lot: LOT-B.","record");
 const request={criterion:{sourceId:criterion.id,quote:criterion.content,product:"P-A",field:"lot" as const,operator:"one_of" as const,values:["LOT-B"]},records:[{sourceId:local.id,quote:local.content,recordId:"R-1",product:"P-A",value:"LOT-B"}]};
 const result=matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request})[0]!;
 assert.equal(result.status,"unknown");assert.equal(result.productIdentity,"unknown");
 const shortRecord=structuredClone(request);shortRecord.records[0]!.recordId="R";
 assert.throws(()=>matchSourceBoundRecords({runId,snapshotHash,selected:[criterion,local],request:shortRecord}),/literal quoted/);
});
