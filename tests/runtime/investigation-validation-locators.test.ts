import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {INVESTIGATION_DOMAIN_FEEDBACK_CODES,type EvidenceEntry,type InvestigationReportInput,type InvestigationValidationIssue} from "../../src/shared/investigation.ts";

const snapshotHash="b".repeat(64),content="A source fact used only for local diagnostic tests.";
const entry:EvidenceEntry={id:"NOTICE",kind:"notice",title:"Notice",content,sourceHash:createHash("sha256").update(content).digest("hex"),snapshotHash,refs:[],support:"Synthetic test",sourceURL:"https://example.test/notice",version:1,retrievedAt:"2026-01-01T00:00:00.000Z",authority:"public-source-excerpt"};
const finding=(id:string)=>({id,kind:"observation" as const,summary:"The source fact is available.",evidence:[{sourceId:entry.id,sourceHash:entry.sourceHash,quote:content}]});
const base=():InvestigationReportInput=>({disposition:"answered",summary:"The cited facts are available.",findings:[finding("first"),finding("second")]});

test("validation locates repeated codes on both findings and separates report-only issues without changing decisions",()=>{
 const input=base();input.summary="The identifier is MISSING-987.";
 input.findings[0]!.evidence[0]!.quote="REJECTED_PROSE_PRIVATE";
 input.findings[1]!.evidence[0]!.quote="REJECTED_PROSE_PRIVATE";
 input.findings[1]!.evidence[0]!.sourceHash="c".repeat(64);
 const issues:InvestigationValidationIssue[]=[];
 const plain=validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input);
 const located=validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input,{issueSink:issues});
 assert.deepEqual(located,plain);
 assert.deepEqual(issues,[{findingIndex:0,code:"quote_not_found"},{findingIndex:1,code:"stale_source_hash"},{findingIndex:1,code:"quote_not_found"},{code:"unsupported_identifier_or_date",unsupportedTokens:["MISSING-987"]}]);
 assert.doesNotMatch(JSON.stringify(issues),/REJECTED_PROSE_PRIVATE|NOTICE|sourceHash/);
});

test("invalid finding IDs and extra findings cannot enter locator paths or expand the six-finding bound",()=>{
 const input=base();input.findings=Array.from({length:80},()=>({...finding("UNTRUSTED_PATH"),evidence:[]}));
 const issues:InvestigationValidationIssue[]=[];
 validateInvestigationReport({snapshotHash,entries:[entry]},[entry.id],input,{issueSink:issues});
 assert.deepEqual(issues,[{code:"invalid_findings"},...Array.from({length:6},(_,findingIndex)=>({findingIndex,code:"invalid_finding"}))]);
 assert.ok(issues.every(issue=>INVESTIGATION_DOMAIN_FEEDBACK_CODES.includes(issue.code)));
 assert.doesNotMatch(JSON.stringify(issues),/UNTRUSTED_PATH/);
});

test("store persists bounded sanitized finding diagnostics alongside unchanged aggregate codes",async()=>{
 const stateDir=await mkdtemp(resolve(tmpdir(),"engram-validation-locators-")),store=new WorkspaceStore({root:process.cwd(),stateDir,model:"nvidia/nemotron-test",inferenceAllowed:true});
 const w=await store.startInvestigation("What does the source say?"),runId=w.agentRun.runId!,source=w.investigationEvidence!.entries.find(value=>value.kind==="notice")!;
 await store.inspectSources(runId,[source.id],"Read the exact documentary source.");
 const input:InvestigationReportInput={disposition:"answered",summary:"The cited source is under review on 2027-05-04.",findings:[0,1].map(index=>({id:`private-${index}`,kind:"observation",summary:"An untrusted proposed claim.",evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:"REJECTED_PRIVATE_QUOTATION"}]}))};
 const result=await store.submitInvestigationReport(runId,input);
 assert.equal(result.valid,false);assert.ok(result.codes.includes("quote_not_found"));
 assert.deepEqual(result.findingIssues,[{findingIndex:0,code:"quote_not_found"},{findingIndex:1,code:"quote_not_found"}]);
 const saved=JSON.parse(await readFile(resolve(stateDir,"workspace.json"),"utf8")),feedback=saved.agentRun.investigation.feedback.at(-1);
 assert.deepEqual(feedback.findingIssues,result.findingIssues);
 assert.deepEqual(feedback.unsupportedSummaryTokens,["2027-05-04"]);
 assert.ok(feedback.findingIssues.length<=72);assert.ok((feedback.reportIssues?.length??0)<=24);
 assert.doesNotMatch(JSON.stringify(feedback),/REJECTED_PRIVATE_QUOTATION|untrusted proposed|private-0|private-1/);
 assert.equal(saved.agentRun.investigation.reportAttempts.at(-1).findings[0].evidence[0].quote,"REJECTED_PRIVATE_QUOTATION");
});
