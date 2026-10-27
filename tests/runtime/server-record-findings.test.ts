import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {matchSourceBoundRecords,type BoundRecordMatch} from "../../src/runtime/record-matching.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import {buildServerRecordFindings} from "../../src/runtime/server-record-findings.ts";
import {INVESTIGATION_DOMAIN_FEEDBACK_CODES,type EvidenceEntry,type InvestigationReportInput} from "../../src/shared/investigation.ts";

const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64),sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const makeEntry=(id:string,kind:"notice"|"record",content:string,title=id):EvidenceEntry=>({id,kind,content,title,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:"2026-01-01T00:00:00.000Z",sourceHash:sha(content),snapshotHash,refs:[id],authority:kind==="notice"?"public-source-excerpt":"fictional-record",support:"Synthetic server-record-findings fixture."});
const quote=(entry:EvidenceEntry,text=entry.content)=>({sourceId:entry.id,sourceHash:entry.sourceHash,quote:text});

const noticeA=makeEntry("A","notice","Product: DEVICE-41\nAffected lots: LOT-41, LOT-42.\nStop use pending review.","Safety notice A");
const noticeB=makeEntry("B","notice","The latest notice names LOT-43 and links the earlier notice.\nStop use pending review.","Safety notice B");
const rowTexts={
 "ROW-41":JSON.stringify({recordId:"ROW-41",product:"DEVICE-41",lot:"LOT-41"}),
 "ROW-42":JSON.stringify({recordId:"ROW-42",product:"DEVICE-41",lot:"LOT-99"}),
 "ROW-43":JSON.stringify({recordId:"ROW-43",product:"DEVICE-41",lot:null}),
};
const rows=makeEntry("ROWS","record",Object.values(rowTexts).join("\n"),"Local record table");
const entries=[noticeA,noticeB,rows];
const ids=Object.keys(rowTexts) as Array<keyof typeof rowTexts>;
const criterion=(field:"product"|"lot",values:string[])=>({sourceId:"A",quote:noticeA.content,field,operator:"one_of" as const,values,product:"DEVICE-41",productQuote:"Product: DEVICE-41"});
const productResults=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:criterion("product",["DEVICE-41"]),records:ids.map(id=>({sourceId:"ROWS",quote:rowTexts[id],recordId:id,value:"DEVICE-41"}))}});
const lotValues:Record<string,string|null>={"ROW-41":"LOT-41","ROW-42":"LOT-99","ROW-43":null};
const lotResults=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:criterion("lot",["LOT-41","LOT-42"]),records:ids.map(id=>({sourceId:"ROWS",quote:rowTexts[id],recordId:id,value:lotValues[id]!,product:"DEVICE-41",productQuote:rowTexts[id]}))}});
const results:BoundRecordMatch[]=[...productResults,...lotResults];
const byRecordField=(recordId:string,field:string)=>results.find(result=>result.recordId===recordId&&result.field===field)!;

test("fixture produces match, no_match and unknown receipts", () => {
 assert.equal(byRecordField("ROW-41","lot").status,"match");
 assert.equal(byRecordField("ROW-42","lot").status,"no_match");
 assert.equal(byRecordField("ROW-43","lot").status,"unknown");
});

test("server record findings group receipts by record and use only stored proof quotes", () => {
 const findings=buildServerRecordFindings(results,entries);
 assert.equal(findings.length,ids.length);
 const storedProofs=new Set(results.flatMap(result=>result.evidence.map(proof=>JSON.stringify([proof.sourceId,proof.sourceHash,proof.quote]))));
 findings.forEach((finding,index)=>{
  const recordId=ids[index]!,own=results.filter(result=>result.recordId===recordId);
  assert.equal(finding.id,`backend-record-${index+1}`);
  assert.equal(finding.kind,"observation");
  assert.equal(finding.origin,"backend_record_check");
  assert.ok(finding.summary.startsWith(`Record ${recordId}:`),finding.summary);
  assert.ok(finding.summary.length<=1000);
  assert.deepEqual(finding.recordChecks,own.map(result=>({resultId:result.resultId,field:result.field,status:result.status})));
  assert.equal(own.length,2);
  const ownProofs=new Set(own.flatMap(result=>result.evidence.map(proof=>JSON.stringify([proof.sourceId,proof.sourceHash,proof.quote]))));
  assert.ok((finding.evidence?.length??0)>0&&(finding.evidence?.length??0)<=8);
  for(const proof of finding.evidence??[]){const key=JSON.stringify([proof.sourceId,proof.sourceHash,proof.quote]);assert.ok(storedProofs.has(key));assert.ok(ownProofs.has(key),`${recordId} cites a proof not stored on its own receipts`);}
  assert.equal(new Set((finding.evidence??[]).map(proof=>JSON.stringify(proof))).size,finding.evidence?.length,"proofs are de-duplicated");
 });
 assert.match(findings[0]!.summary,/needs human review/);
 assert.match(findings[2]!.summary,/could not be determined/);
 assert.match(findings[2]!.summary,/needs human review/);
});

test("server record findings state field comparisons only and never claim clearance", () => {
 const noMatch=results.filter(result=>result.recordId==="ROW-42"&&result.field==="lot");
 const findings=[...buildServerRecordFindings(results,entries),...buildServerRecordFindings(noMatch,entries)];
 assert.equal(findings.length,ids.length+1);
 for(const finding of findings){assert.doesNotMatch(finding.summary,/\b(cleared|clear|safe|not affected|unaffected)\b/i,finding.summary);}
 const only=findings[findings.length-1]!;
 assert.match(only.summary,/does not match/);
 assert.match(only.summary,/not a clearance/);
 assert.match(only.summary,/Safety notice A/,"notice titles come from the supplied entries");
 assert.deepEqual(buildServerRecordFindings([],entries),[]);
});

test("record_findings_are_server_generated is an allowlisted domain feedback code", () => {
 assert.ok((INVESTIGATION_DOMAIN_FEEDBACK_CODES as readonly string[]).includes("record_findings_are_server_generated"));
});

const question="Classify the local lot records against the affected notices.";
const documentary=():InvestigationReportInput=>({disposition:"answered",summary:"The notices state which lots and actions a reviewer must check against the local records.",recordCitationMode:"atomic_receipts_v1",recordReceiptIds:results.map(result=>result.resultId),findings:[{id:"doc-1",kind:"observation",summary:"The two notices contain different quoted statements.",evidence:[quote(noticeA),quote(noticeB)],comparisons:[{before:quote(noticeA),after:quote(noticeB),relation:"different_text"}],recordChecks:[]}]});
const validate=(input:InvestigationReportInput,serverRecordFindings:boolean|undefined)=>validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),input,{runId,question,recordMatches:results,...(serverRecordFindings===undefined?{}:{serverRecordFindings})});

test("documentary-only atomic report is valid without per-finding record coverage when server findings are on", () => {
 const withServer=validate(documentary(),true);
 assert.equal(withServer.codes.includes("record_match_coverage_required"),false,JSON.stringify(withServer));
 assert.equal(withServer.codes.includes("record_findings_are_server_generated"),false);
 assert.deepEqual(withServer,{valid:true,codes:[]});
 assert.ok(validate(documentary(),undefined).codes.includes("record_match_coverage_required"),"without the option, per-finding record coverage is still required");
});

test("a model finding that names a known record id is flagged as server-generated", () => {
 const named=documentary();named.findings[0]!.summary="Local record ROW-41 has LOT-41 recorded.";
 const result=validate(named,true);
 assert.equal(result.valid,false);assert.ok(result.codes.includes("record_findings_are_server_generated"),JSON.stringify(result));
 assert.equal(result.codes.includes("record_match_coverage_required"),false);
 assert.equal(validate(named,undefined).codes.includes("record_findings_are_server_generated"),false,"code is only raised when the option is on");
});

test("record-kind evidence, record checks and a summary naming a record are each flagged", () => {
 const withRowEvidence=documentary();withRowEvidence.findings[0]!.evidence.push(quote(rows,rowTexts["ROW-41"]));
 assert.ok(validate(withRowEvidence,true).codes.includes("record_findings_are_server_generated"),"record-kind evidence");
 const lot=byRecordField("ROW-41","lot");
 const withChecks=documentary();withChecks.findings[0]!.recordChecks=[{resultId:lot.resultId,field:lot.field,status:lot.status}];
 assert.ok(validate(withChecks,true).codes.includes("record_findings_are_server_generated"),"non-empty recordChecks");
 const overall=documentary();overall.summary="ROW-42 was reviewed against the selected notices.";
 assert.ok(validate(overall,true).codes.includes("record_findings_are_server_generated"),"overall summary naming a record");
});

test("the server-generated rule applies only in atomic receipt mode", () => {
 const legacy=documentary();delete legacy.recordCitationMode;legacy.findings[0]!.summary="Local record ROW-41 has LOT-41 recorded.";
 assert.equal(validate(legacy,true).codes.includes("record_findings_are_server_generated"),false);
});

const withFinding=(summary:string,extra:Partial<InvestigationReportInput["findings"][number]>={})=>{const report=documentary();report.findings[0]!.summary=summary;Object.assign(report.findings[0]!,extra);return report;};
const withSummary=(summary:string)=>{const report=documentary();report.summary=summary;return report;};
const checkOf=(result:BoundRecordMatch,status:BoundRecordMatch["status"]=result.status)=>[{resultId:result.resultId,field:result.field,status}];
const SERVER="record_findings_are_server_generated";

test("every existing record-claim code on a finding also reports record_findings_are_server_generated", () => {
 const cases:Array<[string,string,InvestigationReportInput]>=[
  ["record_claim_requires_checked_reference","unreferenced local manufacture-date claim",withFinding("The local manufacture dates match the affected range.")],
  ["record_match_field_claim_mismatch","configuration claim from a record receipt",withFinding("The local host operating system matches the affected configuration.")],
  ["field_match_does_not_establish_clearance","clearance claim in a finding",withFinding("The local records are not affected and are cleared.")],
  ["record_check_status_does_not_support_classification","status contradicting the cited receipt",withFinding("The lot comparison is a match.",{recordChecks:checkOf(byRecordField("ROW-42","lot"))})],
  ["unknown_record_check_cannot_prove_classification","classification asserted from an unknown receipt",withFinding("Record ROW-43 lot is included in the affected lots.",{recordChecks:checkOf(byRecordField("ROW-43","lot"))})],
  ["record_match_mismatch","declared status differs from the stored receipt",withFinding("The lot comparison is a match.",{recordChecks:checkOf(byRecordField("ROW-41","lot"),"no_match")})],
 ];
 for(const [code,label,report] of cases){
  const on=validate(report,true),off=validate(report,false);
  assert.ok(on.codes.includes(code),`${label}: expected ${code} in ${JSON.stringify(on.codes)}`);
  assert.ok(on.codes.includes(SERVER),`${label}: expected ${SERVER} in ${JSON.stringify(on.codes)}`);
  assert.equal(off.codes.includes(SERVER),false,`${label}: ${SERVER} must be absent when the option is off`);
 }
});

test("record-claim codes raised by the overall summary also report record_findings_are_server_generated", () => {
 for(const [code,summary] of [["record_claim_requires_checked_reference","The local manufacture dates match the affected range."],["field_match_does_not_establish_clearance","The local records are cleared and safe."]] as const){
  const on=validate(withSummary(summary),true);
  assert.ok(on.codes.includes(code),`${code} in ${JSON.stringify(on.codes)}`);
  assert.ok(on.codes.includes(SERVER),`${SERVER} for summary: ${JSON.stringify(on.codes)}`);
  assert.equal(validate(withSummary(summary),false).codes.includes(SERVER),false);
 }
});

test("an attributed prior-notice description is not a scope reduction, but an asserted reduction still is", () => {
 const SCOPE="scope_reduction_requires_explicit_prior_scope_withdrawal";
 for(const report of [withFinding("The August 2025 notice limited removal to listed lots."),withSummary("The August 2025 notice limited removal to listed lots.")])
  assert.equal(validate(report,true).codes.includes(SCOPE),false,"attributed prior-notice description");
 assert.ok(validate(withFinding("The later notice narrowed the recall scope to listed lots."),true).codes.includes(SCOPE),"asserted reduction is still flagged");
});
