import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {matchSourceBoundRecords} from "../../src/runtime/record-matching.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import type {EvidenceEntry,InvestigationReportInput} from "../../src/shared/investigation.ts";
const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64),sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const makeEntry=(id:string,kind:"notice"|"record",content:string):EvidenceEntry=>({id,kind,content,title:id,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:"2026-01-01T00:00:00.000Z",sourceHash:sha(content),snapshotHash,refs:[id],authority:kind==="notice"?"public-source-excerpt":"fictional-record",support:"Synthetic source-bound receipt test."});
const entries=[makeEntry("A","notice","Product: DEVICE-41\nAffected lots: LOT-41, LOT-42.\nStop use pending review."),makeEntry("B","notice","The latest notice names LOT-43 and links the earlier notice. This notice does not impact other batches.\nStop use pending review."),makeEntry("ROWS","record",'{"recordId":"ROW-41","product":"DEVICE-41","lot":"LOT-41","retainerRingColour":null}')];
const quote=(entry:EvidenceEntry,text=entry.content)=>({sourceId:entry.id,sourceHash:entry.sourceHash,quote:text});
const matches=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:[{sourceId:"ROWS",quote:entries[2]!.content,recordId:"ROW-41",value:"DEVICE-41"}]}});
const checked=matches[0]!;
assert.equal(checked.field,"product");assert.equal(checked.status,"match");
const base=():InvestigationReportInput=>({disposition:"answered",summary:"The source statements and exact receipts are available for review.",recordReceiptIds:[checked.resultId],findings:[{id:"finding-1",kind:"observation",summary:"The two notices contain different quoted statements.",evidence:[quote(entries[0]!),quote(entries[1]!)],comparisons:[{before:quote(entries[0]!),after:quote(entries[1]!),relation:"different_text"}],recordChecks:[]}]});
const validate=(input:InvestigationReportInput,selected=entries,results=matches,expectedRun=runId)=>validateInvestigationReport({snapshotHash,entries:selected},selected.map(entry=>entry.id),input,{runId:expectedRun,question:"Compare the notices and classify the local lot records.",recordMatches:results});
test("global receipts prove complete exact stored work without generated narrative findings",()=>{
 const input=base(),result=validate(input);assert.deepEqual(result,{valid:true,codes:[]});assert.equal(input.findings.length,1);assert.equal(input.findings[0]!.recordChecks!.length,0);
});
test("global receipt admission rejects missing, duplicate, unknown, stale body, run and proof bindings",()=>{
 assert.ok(validate({...base(),recordReceiptIds:[]}).codes.includes("record_receipt_coverage_required"));
 assert.ok(validate({...base(),recordReceiptIds:[checked.resultId,checked.resultId]}).codes.includes("invalid_global_record_receipts"));
 assert.ok(validate({...base(),recordReceiptIds:["f".repeat(64)]}).codes.includes("unknown_global_record_receipt"));
 assert.ok(validate(base(),entries,[{...checked,normalizedRecordValue:"DEVICE-99"}]).codes.includes("invalid_global_record_receipt_binding"));
 assert.ok(validate(base(),entries,matches,"9a0d8d25-5caf-4fa3-8ecb-a2646209320d").codes.includes("invalid_global_record_receipt_binding"));
 const tampered={...checked,evidence:[...checked.evidence.map(proof=>({...proof,quote:"unavailable proof"}))]};const {resultId:_id,...body}=tampered;tampered.resultId=sha(JSON.stringify(body));
 assert.ok(validate({...base(),recordReceiptIds:[tampered.resultId]},entries,[tampered]).codes.includes("invalid_global_record_receipt_binding"));
});
test("global coverage does not bypass named or collective local field claim references",()=>{
 for(const summary of ["ROW-41 has a manufacture date within the affected range.","The local manufacture dates match the affected range.","The local host operating system matches the affected configuration.","The local distribution date falls within the affected range."]){
  const input=base();input.findings[0]!.summary=summary;assert.ok(validate(input).codes.includes("record_claim_requires_checked_reference"),summary);
  input.summary=summary;assert.ok(validate(input).codes.includes("record_claim_requires_checked_reference"),`overall ${summary}`);
 }
});
test("a record-matching task needs each checked row in finding prose with its own R and E reference",()=>{
 const rowTexts=[JSON.stringify({recordId:"ROW-41",product:"DEVICE-41",lot:"LOT-41"}),JSON.stringify({recordId:"ROW-42",product:"DEVICE-41",lot:"LOT-42"})];
 const rows=makeEntry("ROWS","record",rowTexts.join("\n")),sources=[entries[0]!,entries[1]!,rows];
 const results=matchSourceBoundRecords({runId,snapshotHash,selected:sources,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:rowTexts.map((text,index)=>({sourceId:"ROWS",quote:text,recordId:`ROW-${41+index}`,value:"DEVICE-41"}))}});
 const checks=results.map(({resultId,field,status})=>({resultId,field,status}));
 const input=base();input.recordCitationMode="atomic_receipts_v1";input.recordReceiptIds=results.map(result=>result.resultId);input.summary="The local record rows were reviewed against the selected criterion.";
 input.findings[0]!.summary="The two notice excerpts state the applicable source criteria.";input.findings[0]!.evidence=[quote(entries[0]!),quote(entries[1]!)];input.findings[0]!.recordChecks=[];
 const context={runId,question:"Classify the local lot records against the affected notices.",recordMatches:results};
 const validateTask=(report:InvestigationReportInput)=>validateInvestigationReport({snapshotHash,entries:sources},sources.map(item=>item.id),report,context);
 assert.ok(validateTask(input).codes.includes("record_match_coverage_required"),"global R coverage alone must not satisfy task coverage");
 const subset=structuredClone(input);subset.findings[0]!.summary="Local record ROW-41 was reviewed against the selected criterion.";subset.findings[0]!.recordChecks=[checks[0]!];subset.findings[0]!.evidence.push(quote(rows,rowTexts[0]!));
 assert.ok(validateTask(subset).codes.includes("record_match_coverage_required"),"one addressed row cannot stand for all rows");
 const noRef=structuredClone(input);noRef.findings[0]!.summary="Local records ROW-41 and ROW-42 were reviewed against the selected criterion.";noRef.findings[0]!.evidence.push(quote(rows));
 assert.ok(validateTask(noRef).codes.includes("record_match_coverage_required"),"naming rows without per-row R references is insufficient");
 assert.ok(validateTask({...noRef,recordReceiptIds:42 as any}).codes.includes("invalid_global_record_receipts"),"malformed receipt input must remain a validation result, not throw");
 const complete=structuredClone(input);complete.findings=[0,1].map(index=>({id:`row-${index}`,kind:"observation" as const,summary:`Local record ROW-${41+index} was reviewed against the selected criterion.`,evidence:[quote(rows,rowTexts[index]!)],recordChecks:[checks[index]!]}));
 assert.equal(validateTask(complete).valid,true);
 const documentOnly=structuredClone(input);assert.equal(validateInvestigationReport({snapshotHash,entries:sources},sources.map(item=>item.id),documentOnly,{runId,question:"What do the documents say?",recordMatches:results}).codes.includes("record_match_coverage_required"),false);
});
test("a shared product quote without a row identifier cannot satisfy row coverage",()=>{
 const rowTexts=[JSON.stringify({recordId:"ROW-41",product:"DEVICE-41"}),JSON.stringify({recordId:"ROW-42",product:"DEVICE-41"})];
 const shared="Product: DEVICE-41",rows=makeEntry("ROWS","record",[shared,...rowTexts].join("\n")),sources=[entries[0]!,entries[1]!,rows];
 const results=matchSourceBoundRecords({runId,snapshotHash,selected:sources,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:rowTexts.map((text,index)=>({sourceId:"ROWS",quote:text,recordId:`ROW-${41+index}`,value:"DEVICE-41",productQuote:shared}))}});
 assert.ok(results.every(result=>result.evidence.some(proof=>proof.sourceId==="ROWS"&&proof.quote===shared)));
 const input=base();input.recordCitationMode="atomic_receipts_v1";input.recordReceiptIds=results.map(result=>result.resultId);input.summary="The local records were reviewed.";
 input.findings=results.map((result,index)=>({id:`row-${index}`,kind:"observation" as const,summary:`Local record ROW-${41+index} was reviewed.`,evidence:[quote(rows,shared)],recordChecks:[{resultId:result.resultId,field:result.field,status:result.status}]}));
 const check=(report:InvestigationReportInput)=>validateInvestigationReport({snapshotHash,entries:sources},sources.map(item=>item.id),report,{runId,question:"Classify the local lot records against the affected notices.",recordMatches:results});
 assert.ok(check(input).codes.includes("record_match_coverage_required"));
 const supported=structuredClone(input);supported.findings.forEach((finding,index)=>{finding.evidence=[quote(rows,rowTexts[index]!)];});
 assert.equal(check(supported).codes.includes("record_match_coverage_required"),false);
});
test("a selected product check cannot prove manufacture, host configuration, distribution or lot matches",()=>{
 for(const summary of ["ROW-41 has a manufacture date within the affected range.","The local manufacture dates match the affected range.","The local host operating system matches the affected configuration.","ROW-41 with a clear retainer ring falls within the replacement scope.","The local distribution date falls within the affected range.","The local lot matches the affected list."]){
  const input=base();input.findings[0]!.summary=summary;input.findings[0]!.recordChecks=[{resultId:checked.resultId,field:checked.field,status:checked.status}];input.findings[0]!.evidence.push(quote(entries[2]!));
  assert.ok(validate(input).codes.includes("record_match_field_claim_mismatch"),summary);
 }
});
test("a record's missing configuration may remain unknown without becoming a positive configuration match",()=>{
 const input=base();input.findings[0]!.summary="ROW-41 retainer ring colour is unknown.";input.findings[0]!.recordChecks=[{resultId:checked.resultId,field:checked.field,status:checked.status}];input.findings[0]!.evidence.push(quote(entries[2]!));
 assert.equal(validate(input).valid,true);
});
test("summary literal support comes from original validated receipt proofs, never unattested metadata",()=>{
 const input=base(),action="Stop use pending review.";input.summary="The recorded literal identifier is LOT-41.";input.findings[0]!.summary="The quoted instructions contain the same exact text.";input.findings[0]!.evidence=[quote(entries[0]!,action),quote(entries[1]!,action)];input.findings[0]!.comparisons=[{before:quote(entries[0]!,action),after:quote(entries[1]!,action),relation:"same_text"}];
 assert.equal(validate(input).codes.includes("unsupported_identifier_or_date"),false);
 input.summary="The recorded literal identifier is LOT-99.";assert.ok(validate(input).codes.includes("unsupported_identifier_or_date"));
});
test("later omission and generic other-batches clauses cannot prove prior-scope withdrawal",()=>{
 const input=base();input.summary="The later notice narrows the recalled scope.";
 assert.ok(validate(input).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const expansion=base();expansion.summary="The later notice changes scope from limited lots to all lots.";
 assert.equal(validate(expansion).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"),false);
 const allToSubset=base();allToSubset.summary="The later notice narrows scope from ALL lots to a LIMITED SUBSET.";
 assert.ok(validate(allToSubset).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const directLimit=base();directLimit.summary="The later notice limits the recall to selected batches.";
 assert.ok(validate(directLimit).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const expansionThenNarrowing=base();expansionThenNarrowing.summary="Scope changed from limited lots to all lots, then the later notice limits the scope to selected lots.";
 assert.ok(validate(expansionThenNarrowing).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const expansionThenAllRemaining=base();expansionThenAllRemaining.summary="Scope changed from limited lots to all lots, then narrows scope to all remaining lots.";
 assert.ok(validate(expansionThenAllRemaining).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const noWithdrawal=makeEntry("B","notice","No previously recalled batches were withdrawn. The issue links the earlier notice."),negated=[entries[0]!,noWithdrawal,entries[2]!];const n=base();n.summary=input.summary;n.findings[0]!.evidence=[quote(entries[0]!),quote(noWithdrawal)];n.findings[0]!.comparisons=[{before:quote(entries[0]!),after:quote(noWithdrawal),relation:"different_text"}];assert.ok(validate(n,negated).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
 const cautious=base();cautious.summary="The available sources do not establish a scope reduction.";cautious.findings[0]!.summary="The recall scope does not narrow.";assert.equal(validate(cautious).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"),false);
});
test("unexecuted list arithmetic is rejected while literal quoted counts remain source-bound",()=>{
 const input=base();input.findings[0]!.summary="The earlier notice lists 10 batches.";assert.ok(validate(input).codes.includes("numeric_count_requires_source_or_checked_calculation"));
 const counted=makeEntry("B","notice","There are 10 batches in the described set."),selected=[entries[0]!,counted,entries[2]!];const quoted=base();quoted.findings[0]!.summary="The later notice states 10 batches.";quoted.findings[0]!.evidence=[quote(entries[0]!),quote(counted)];quoted.findings[0]!.comparisons=[{before:quote(entries[0]!),after:quote(counted),relation:"different_text"}];assert.equal(validate(quoted,selected).codes.includes("numeric_count_requires_source_or_checked_calculation"),false);
});
test("document reference numbers are not quantities, while singular lot counts remain checked",()=>{
 const attachment=base();attachment.findings[0]!.summary="The specific Attachment 1 lots are listed in the notice.";
 assert.equal(validate(attachment).codes.includes("numeric_count_requires_source_or_checked_calculation"),false);
 for(const label of ["Document", "Notice", "Source"]){const labeled=base();labeled.findings[0]!.summary=`${label} 1 lot check is unknown.`;assert.equal(validate(labeled).codes.includes("numeric_count_requires_source_or_checked_calculation"),false,label);labeled.findings[0]!.summary=`${label} 2 lots.`;assert.ok(validate(labeled).codes.includes("numeric_count_requires_source_or_checked_calculation"),label);labeled.findings[0]!.summary=`${label} 1 contains 2 lots.`;assert.ok(validate(labeled).codes.includes("numeric_count_requires_source_or_checked_calculation"),label);}
 const matchedLabel=base();matchedLabel.findings[0]!.summary="The record matches a Document 1 lot.";assert.equal(validate(matchedLabel).codes.includes("numeric_count_requires_source_or_checked_calculation"),false);
 for(const summary of ["ROW-1 lot matches.","ROW_1 lot matches.","ROW:1 lot matches.","ROW1 lot matches.","ROWa1 lot matches."]){const identifier=base();identifier.findings[0]!.summary=summary;assert.equal(validate(identifier).codes.includes("numeric_count_requires_source_or_checked_calculation"),false,summary);}
 const singular=base();singular.findings[0]!.summary="The notice identifies 1 affected lot.";
 assert.ok(validate(singular).codes.includes("numeric_count_requires_source_or_checked_calculation"));
 const exactCount=makeEntry("COUNT","notice","The notice identifies 1 affected lot."),selected=[entries[0]!,exactCount,entries[2]!];
 const quoted=base();quoted.findings[0]!.summary="The notice identifies 1 affected lot.";quoted.findings[0]!.evidence=[quote(exactCount)];quoted.findings[0]!.comparisons=[];
 assert.equal(validate(quoted,selected).codes.includes("numeric_count_requires_source_or_checked_calculation"),false);
});
test("mixed checked statuses cannot be grouped into a positive product match and faithful statuses remain usable",()=>{
 for(const value of [null,"DEVICE-99"]){
  const rowTexts=[JSON.stringify({recordId:"ROW-41",product:"DEVICE-41"}),JSON.stringify({recordId:"ROW-42",product:value})];
  const records=makeEntry("ROWS","record",rowTexts.join("\n")),selected=[entries[0]!,entries[1]!,records];
  const results=matchSourceBoundRecords({runId,snapshotHash,selected,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:rowTexts.map((text,index)=>({sourceId:"ROWS",quote:text,recordId:`ROW-${41+index}`,value:index===0?"DEVICE-41":value}))}});
  assert.deepEqual(results.map(result=>result.status),["match","unknown"]);
  const checks=results.map(({resultId,field,status})=>({resultId,field,status}));
  const proofs=[...new Map(results.flatMap(result=>result.evidence).map(proof=>[JSON.stringify(proof),proof])).values()];
  const input=base();input.recordReceiptIds=results.map(result=>result.resultId);input.findings[0]!.recordChecks=checks;input.findings[0]!.evidence=proofs;
  for(const location of ["finding","summary"]){
   const rejected=structuredClone(input);
   if(location==="finding")rejected.findings[0]!.summary="The local records ROW-41 and ROW-42 product matches.";
   else rejected.summary="The local records ROW-41 and ROW-42 product matches.";
   assert.equal(validate(rejected,selected,results).valid,false,`${location}: ${value}`);
  }
  input.findings[0]!.recordChecks=[checks[1]!];input.findings[0]!.evidence=results[1]!.evidence;
  input.findings[0]!.summary="Local record ROW-42 has product match status unknown.";
  input.findings[0]!.comparisons=[];
  assert.equal(validate(input,selected,results).codes.includes("record_check_status_does_not_support_classification"),false);
  assert.equal(validate(input,selected,results).codes.includes("unknown_record_check_cannot_prove_classification"),false);
 }
});
test("a conditional procedure stop cannot support a shared immediate stop-use requirement",()=>{
 const validateActions=(beforeText:string,afterText:string,claim:string)=>{
  const before=makeEntry("A","notice",beforeText),after=makeEntry("B","notice",afterText),proofs=[quote(before),quote(after)];
  return validateInvestigationReport({snapshotHash,entries:[before,after]},["A","B"],{disposition:"answered",recordReceiptIds:[],summary:claim,findings:[{id:"actions",kind:"observation",summary:claim,evidence:proofs,comparisons:[{before:proofs[0]!,after:proofs[1]!,relation:beforeText===afterText?"same_text":"different_text"}],recordChecks:[]}]},{runId,recordMatches:[]});
 };
 const conditional="If resistance occurs, stop use immediately.",blanket="Immediately cease all use of the affected devices.";
 assert.ok(validateActions(conditional,blanket,"Both notices require immediate cessation of use.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"));
 assert.ok(validateActions("Quarantine identified devices.",blanket,"The updated notice retains immediate cessation of use.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"));
 assert.equal(validateActions(blanket,blanket,"Both notices require immediate cessation of use.").valid,true);
 assert.equal(validateActions(conditional,conditional,"Both notices do not require immediate cessation of use.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"),false);
 assert.ok(validateActions("Immediate cessation of use is not required.",blanket,"Both notices require immediate cessation of use.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"));
 assert.equal(validateActions(conditional,blanket,"The earlier stop is conditional on resistance; the later source instructs immediate cessation of use.").valid,true);
 assert.equal(validateActions(blanket,"The later notice requires continued review.","The earlier notice requires immediate cessation of use, while the later notice requires continued review.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"),false);
 assert.ok(validateActions(conditional,blanket,"Both notices retain immediate cessation of use while contact details differ.").codes.includes("shared_immediate_stop_use_requires_both_notice_quotes"));
});
