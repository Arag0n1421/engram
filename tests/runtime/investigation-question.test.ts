import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {concreteOperatorQuestion} from "../../src/runtime/investigation-question.ts";
import {DOCUMENTARY_PHASE_TASK,INVESTIGATION_REPORT_CONTRACT} from "../../src/runtime/investigation-prompt.ts";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";
import type {InvestigationReportInput} from "../../src/shared/investigation.ts";
const task="Review whether the target supply is usable.";
const input:InvestigationReportInput={disposition:"needs_evidence",summary:"Missing independent label evidence.",question:task,findings:[{id:"missing",kind:"missing_evidence",summary:"The source does not establish the physical identifier.",question:"Which signed QA release record applies to PRODUCT-XYZ?",evidence:[{sourceId:"S",sourceHash:"a".repeat(64),quote:"QA absent"}]}]};
test("operator question derives from a concrete identifier-bound missing finding rather than the echoed task",()=>{assert.deepEqual(concreteOperatorQuestion(input,task,["PRODUCT-XYZ"]),{question:input.findings[0]!.question,origin:"missing_evidence_finding"});});
test("operator questions reject broad task echoes, artifact-free requests and missing identifiers",()=>{for(const question of [task,"What should be done next?","Which signed QA release record applies to this product?"]){const report=structuredClone(input);report.findings[0]!.question=question;report.question=question;assert.equal(concreteOperatorQuestion(report,task,["PRODUCT-XYZ"]).origin,"none");}});
test("two-character IDs bind only as exact trusted record IDs, never by prefix or source ID",()=>{
 const report=structuredClone(input);report.findings[0]!.question="Which signed QA record applies to S1?";
 assert.deepEqual(concreteOperatorQuestion(report,task,["S1"],["S1"]),{question:report.findings[0]!.question,origin:"missing_evidence_finding"});
 for(const question of ["Which signed QA record applies to S10?","Which signed QA record applies to S2?","Which signed QA record applies to S1-X?","Which signed QA record applies to S1_extra?","Which signed QA record applies to S1:other?","Which signed QA record applies to S1.other?","Which signed QA record applies to S1/other?","Which signed QA record applies to S1Á?","Which signed QA record applies to S1２?"]){report.findings[0]!.question=question;assert.equal(concreteOperatorQuestion(report,task,["S1"],["S1"]).origin,"none",question);}
 for(const question of ["Which signed QA record applies to (S1)?","Which signed QA record applies to S1, S2?"]){report.findings[0]!.question=question;assert.deepEqual(concreteOperatorQuestion(report,task,["S1","S2"],["S1","S2"]),{question,origin:"missing_evidence_finding"});}
 report.findings[0]!.question="Which signed QA record applies to S1?";
 assert.equal(concreteOperatorQuestion(report,task,["S1"],[]).origin,"none","a source ID alone cannot authorize a short record identifier");
});
test("store does not accept a source-only S1 as a canonical record identifier",async()=>{
 const seed=await loadSeed(process.cwd()),stateDir=await mkdtemp(resolve(tmpdir(),"engram-short-question-id-"));
 const content="This notice identifies a product but gives no signed completion record.";
 const store=new WorkspaceStore({root:process.cwd(),stateDir,model:"nvidia/test",inferenceAllowed:true,investigationCase:{id:"source-only-short-id",question:task,snapshot:seed.snapshot,documents:[{id:"S1",title:"Synthetic notice",kind:"notice",sourceURL:"urn:test:S1",version:1,retrievedAt:"2026-10-27T00:00:00Z",content,refs:[],authority:"fictional-record"}],memoryMode:"off"}});
 const runId=(await store.startInvestigation(task)).agentRun.runId!;await store.claimModelCall(runId);await store.inspectSources(runId,["S1"],"Inspect the selected synthetic notice.");
 const result=await store.submitInvestigationReport(runId,{disposition:"needs_evidence",summary:"The notice does not contain a signed completion record.",question:task,findings:[{id:"missing-signed-record",kind:"missing_evidence",summary:"The record is unavailable in the selected notice.",question:"Which signed completion record identifies S1?",evidence:[{sourceId:"S1",sourceHash:(await store.getWorkspace()).investigationEvidence!.entries[0]!.sourceHash,quote:content}]}]});
 assert.equal(result.valid,false);assert.ok(result.codes.includes("concrete_operator_question_required"));assert.equal(result.operatorQuestion,null);
});
test("report contract keeps direct evidence answers, concrete missing artifacts and bounded checked-calculation handoff without seed answers",()=>{
  for(const term of ["answer_document_question","ask_operator_for_new_evidence","continue_to_checked_calculation","readiness","matching","12 model requests","three report attempts","unread supplied evidence","do not certify arbitrary interpretation"]){assert.ok(INVESTIGATION_REPORT_CONTRACT.includes(term),term);}
  assert.equal(INVESTIGATION_REPORT_CONTRACT.includes("After three requests"),false);
  assert.match(DOCUMENTARY_PHASE_TASK,/Use the user's original question and selected documentary evidence/);
  assert.match(DOCUMENTARY_PHASE_TASK,/choose whether to answer a document question, request genuinely missing evidence, or hand off to checked calculation/);
  assert.match(DOCUMENTARY_PHASE_TASK,/does not calculate quantities or assert feasibility/);
  assert.equal(/23IJA103|23JJA103|SYNTH-MED|18:00|16:00/.test(INVESTIGATION_REPORT_CONTRACT+DOCUMENTARY_PHASE_TASK),false);
});
