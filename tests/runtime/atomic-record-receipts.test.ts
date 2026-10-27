import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {matchSourceBoundRecords} from "../../src/runtime/record-matching.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import type {EvidenceEntry,InvestigationReportInput} from "../../src/shared/investigation.ts";
const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64),sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const entry=(id:string,kind:"notice"|"record",content:string):EvidenceEntry=>({id,kind,content,title:id,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:"2026-01-01T00:00:00.000Z",sourceHash:sha(content),snapshotHash,refs:[id],authority:kind==="notice"?"public-source-excerpt":"fictional-record",support:"Synthetic atomic receipt test."});
const entries=[entry("A","notice","Product: DEVICE-41\nAffected lots: LOT-41, LOT-42.\nInstruction: check the device."),entry("B","notice","Product: DEVICE-41\nContinue checking the device. The later source is dated 2026-01-09."),entry("ROWS","record",'{"recordId":"ROW-41","product":"DEVICE-41","lot":"LOT-41","retainerRingColour":null}')];
const q=(e:EvidenceEntry,text=e.content)=>({sourceId:e.id,sourceHash:e.sourceHash,quote:text});
const results=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:[{sourceId:"ROWS",quote:entries[2]!.content,recordId:"ROW-41",value:"DEVICE-41"}]}}),r=results[0]!;
const base=():InvestigationReportInput=>({recordCitationMode:"atomic_receipts_v1",recordReceiptIds:[r.resultId],disposition:"answered",summary:"The cited local record has product match status match.",findings:[{id:"local",kind:"observation",summary:"Local record ROW-41 has product match status match.",evidence:[q(entries[2]!)],recordChecks:[{resultId:r.resultId,field:r.field,status:r.status}]}]});
const validate=(input:InvestigationReportInput,rs=results,source=entries)=>validateInvestigationReport({snapshotHash,entries:source},source.map(e=>e.id),input,{runId,recordMatches:rs});
test("explicit atomic check cites exact receipt without adding its proof quotes to documentary citations",()=>{
 const input=base(),before=JSON.stringify(input);assert.deepEqual(validate(input),{valid:true,codes:[]});assert.equal(JSON.stringify(input),before);assert.equal(input.findings[0]!.evidence.length,1);
 const legacy=structuredClone(input);delete legacy.recordCitationMode;assert.ok(validate(legacy).codes.includes("record_match_requires_criterion_and_record_quotes"));
});
test("atomic mode requires valid complete current globally bound receipts",()=>{
 const noBinding=base();delete noBinding.recordReceiptIds;assert.ok(validate(noBinding).codes.includes("atomic_record_receipts_require_global_binding"));
 assert.ok(validate({...base(),recordReceiptIds:[]}).codes.includes("record_receipt_coverage_required"));
 assert.ok(validate({...base(),recordCitationMode:"unknown" as any}).codes.includes("invalid_record_citation_mode"));
 for(const change of [{runId:"other-run"},{snapshotHash:"c".repeat(64)},{normalizedRecordValue:"DEVICE-99"}])assert.ok(validate(base(),[{...r,...change}]).codes.includes("invalid_global_record_receipt_binding"));
 const tampered={...r,evidence:r.evidence.map(proof=>({...proof,quote:"Absent proof text."}))};const {resultId:_id,...body}=tampered;tampered.resultId=sha(JSON.stringify(body));assert.ok(validate({...base(),recordReceiptIds:[tampered.resultId]},[tampered]).codes.includes("invalid_global_record_receipt_binding"));
 const changed=structuredClone(entries);changed[0]!.content+=" Changed without rehash.";assert.ok(validate(base(),results,changed).codes.includes("invalid_global_record_receipt_binding"));
});
test("atomic mode retains explicit local record, typed field, unknown, and clearance guards",()=>{
 const noRef=base();noRef.findings[0]!.recordChecks=[];assert.ok(validate(noRef).codes.includes("record_claim_requires_checked_reference"));
 for(const summary of ["ROW-41 has a manufacture date within the affected range.","ROW-41 clear retainer ring falls within the replacement scope.","The local lot matches the affected list."]){const input=base();input.findings[0]!.summary=summary;assert.ok(validate(input).codes.includes("record_match_field_claim_mismatch"),summary);}
 const clearance=base();clearance.summary="ROW-41 is safe to use and cleared.";assert.ok(validate(clearance).codes.includes("field_match_does_not_establish_clearance"));
 const forged=base();forged.findings[0]!.recordChecks![0]!.status="no_match";assert.ok(validate(forged).codes.includes("record_match_mismatch"));
});
test("global atomic receipt text cannot silently support summary identifiers or documentary comparison endpoints",()=>{
 const input=base();input.findings[0]!.evidence=[q(entries[2]!)];input.summary="The documentary instruction concerns LOT-42.";assert.ok(validate(input).codes.includes("unsupported_identifier_or_date"));
 input.findings[0]!.comparisons=[{before:q(entries[0]!),after:q(entries[1]!),relation:"different_text"}];assert.ok(validate(input).codes.includes("comparison_requires_two_cited_notices"));
 input.findings[0]!.comparisons=[];input.summary="The later notice introduces a higher risk.";assert.ok(validate(input).codes.includes("unsupported_material_risk_change"));
 input.summary="The later notice narrows the recalled scope.";assert.ok(validate(input).codes.includes("scope_reduction_requires_explicit_prior_scope_withdrawal"));
});
test("atomic receipts do not waive the documentary quote cap",()=>{
 const input=base();input.findings[0]!.evidence=Array.from({length:9},()=>q(entries[2]!));assert.ok(validate(input).codes.includes("invalid_finding"));
});

test("a product receipt and row quote cannot authorize documentary required actions",()=>{
 for(const claim of ["The notice requires quarantine of affected devices.","The manufacturer instructs customers to return the device.","Affected devices must be replaced.","The later notice retains inspection and notification instructions."]){
  const input=base();input.findings[0]!.summary=claim;input.summary=claim;assert.ok(validate(input).codes.includes("documentary_action_requires_notice_quote"),claim);
 }
 const historical=base();historical.findings[0]!.summary="The local record describes a device check.";assert.equal(validate(historical).codes.includes("documentary_action_requires_notice_quote"),false);
 const cited=base();cited.findings[0]!.summary="The notice instructs a device check.";cited.findings[0]!.evidence.push(q(entries[0]!,"Instruction: check the device."));assert.equal(validate(cited).codes.includes("documentary_action_requires_notice_quote"),false);
});

test("correct product and lot receipts can jointly support typed claims without cross-field false rejections",()=>{
 const lotResults=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"lot",operator:"one_of",values:["LOT-41","LOT-42"],product:"DEVICE-41"},records:[{sourceId:"ROWS",quote:entries[2]!.content,recordId:"ROW-41",value:"LOT-41",product:"DEVICE-41"}]}}),all=[...results,...lotResults];
 assert.equal(lotResults[0]!.status,"match");const input=base();input.recordReceiptIds=all.map(result=>result.resultId);input.findings[0]!.recordChecks=all.map(({resultId,field,status})=>({resultId,field,status}));input.findings[0]!.summary="Local record ROW-41 product matches. Its lot matches the affected list.";
 assert.deepEqual(validate(input,all),{valid:true,codes:[]});
 const missing=structuredClone(input);missing.findings[0]!.recordChecks=[{resultId:r.resultId,field:r.field,status:r.status}];assert.ok(validate(missing,all).codes.includes("record_match_field_claim_mismatch"));
});

test("five separate record rows plus two notice instructions fit the atomic report while legacy keeps its five-quote bound",()=>{
 const rowTexts=Array.from({length:5},(_,i)=>JSON.stringify({recordId:`ROW-${41+i}`,product:"DEVICE-41",lot:"LOT-41"})),recordSource=entry("ROWS","record",rowTexts.join("\n")),sources=[entries[0]!,entries[1]!,recordSource];
 const checked=matchSourceBoundRecords({runId,snapshotHash,selected:sources,request:{criterion:{sourceId:"A",quote:entries[0]!.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:rowTexts.map((text,i)=>({sourceId:"ROWS",quote:text,recordId:`ROW-${41+i}`,value:"DEVICE-41"}))}});
 const input=base();input.recordReceiptIds=checked.map(r=>r.resultId);input.findings[0]!.evidence=[q(sources[0]!),q(sources[1]!),...rowTexts.map(text=>q(recordSource,text))];input.findings[0]!.summary="The local records have product match status match.";input.findings[0]!.recordChecks=checked.map(({resultId,field,status})=>({resultId,field,status}));
 assert.equal(input.findings[0]!.evidence.length,7);assert.deepEqual(validate(input,checked,sources),{valid:true,codes:[]});
 const legacy=structuredClone(input);delete legacy.recordCitationMode;assert.ok(validate(legacy,checked,sources).codes.includes("invalid_finding"));
});

test("atomic finding can cite the entire bounded 24-result receipt set, but 25 results still fail",()=>{
 const rowTexts=Array.from({length:5},(_,i)=>JSON.stringify({recordId:`ROW-${41+i}`,product:"DEVICE-41"})),recordSource=entry("ROWS","record",rowTexts.join("\n")),notices=Array.from({length:5},(_,i)=>entry(`NOTICE-${i+1}`,"notice","Product: DEVICE-41\nInstruction: check the device.")),sources=[...notices,recordSource];
 const checked=notices.flatMap(notice=>matchSourceBoundRecords({runId,snapshotHash,selected:sources,request:{criterion:{sourceId:notice.id,quote:notice.content,field:"product",operator:"one_of",values:["DEVICE-41"]},records:rowTexts.map((text,i)=>({sourceId:"ROWS",quote:text,recordId:`ROW-${41+i}`,value:"DEVICE-41"}))}}));
 const input=base();input.recordReceiptIds=checked.slice(0,24).map(r=>r.resultId);input.findings[0]!.evidence=[q(notices[0]!),q(notices[1]!),...rowTexts.map(text=>q(recordSource,text))];input.findings[0]!.summary="The local records have product match status match.";input.findings[0]!.recordChecks=checked.slice(0,24).map(({resultId,field,status})=>({resultId,field,status}));
 assert.deepEqual(validate(input,checked.slice(0,24),sources),{valid:true,codes:[]});
 input.recordReceiptIds=checked.map(r=>r.resultId);input.findings[0]!.recordChecks=checked.map(({resultId,field,status})=>({resultId,field,status}));assert.ok(validate(input,checked,sources).codes.includes("invalid_finding"));assert.ok(validate(input,checked,sources).codes.includes("record_receipt_capacity_exceeded"));
});
