import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {EvidenceEntry} from "../../src/shared/investigation.ts";
import {buildRecordReferenceCatalog,matchSourceBoundRecords,resolveRecordReferenceInput} from "../../src/runtime/record-matching.ts";
import {buildEvidenceExcerptCatalog} from "../../src/runtime/evidence-excerpts.ts";
import {buildInvestigationReportPacket,bindInvestigationReportPacket} from "../../src/runtime/investigation-report-packet.ts";
import {validateInvestigationReport} from "../../src/runtime/evidence.ts";

const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
const makeEntry=(id:string,kind:"notice"|"record",content:string):EvidenceEntry=>({id,title:id,kind,authority:"fictional-record",sourceURL:`urn:test:${id}`,version:1,retrievedAt:"2026-10-26T00:00:00.000Z",content,refs:[],sourceHash:createHash("sha256").update(content).digest("hex"),snapshotHash,support:"test fixture"});
const setup=(recordLot="LOT-1")=>{
 const selected=[makeEntry("NOTICE","notice","Product: P-A\nAffected lots: LOT-1."),makeEntry("ROWS","record",JSON.stringify([{id:"ROW-1",product:"P-A",lot:recordLot}]))];
 const sourceCatalog=buildRecordReferenceCatalog({runId,snapshotHash,selected});
 const criterion=sourceCatalog.criteria[0]!;
 const request=resolveRecordReferenceInput(sourceCatalog,{criterionRef:criterion.criterionRef});
 const results=matchSourceBoundRecords({runId,snapshotHash,selected,request});
 const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected,maxBytes:80_000,coalesce:true,supportQuotes:results.flatMap(result=>result.evidence)});
 const packet=buildInvestigationReportPacket({runId,snapshotHash,question:"Which local lot matches?",selected,catalog,recordMatches:results,comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 const group=packet.context.recordProofGroups[0]!;
 const quoteIds=[...new Set(group.requiredEvidenceOptions.map(option=>option.quoteIds[0]!))];
 const finding={kind:"observation",summary:"The selected local field comparison is recorded.",comparisons:[],proofGroupIds:[group.proofGroupId],evidence:quoteIds.map(quoteId=>({quoteId}))};
 const base={nextStep:"answer_document_question",summary:"The checked source-bound field result is recorded.",findings:[finding]};
 return {selected,results,catalog,packet,group,quoteIds,base};
};

test("selected proof group expands only to exact currently bound result triples and records provenance",()=>{
 const value=setup();
 assert.ok(value.packet.schema.properties.findings.items.properties.proofGroupIds.items.enum.includes(value.group.proofGroupId));
 assert.equal("recordChecks" in value.packet.schema.properties.findings.items.properties,false);
 const bound=bindInvestigationReportPacket(JSON.stringify(value.base),runId,snapshotHash,value.selected,value.catalog,value.results);
 const normalized=JSON.parse(bound.argumentsText);
 assert.deepEqual(normalized.findings[0].recordChecks,value.results.map(({resultId,field,status})=>({resultId,field,status})));
 const {runId:_run,...report}=normalized;
 const checked=validateInvestigationReport({snapshotHash,entries:value.selected},value.selected.map(entry=>entry.id),report,{question:"Which local lot matches?",recordMatches:value.results});
 assert.equal(checked.valid,true,checked.codes.join(","));
 assert.deepEqual(bound.audit.proofGroupBindings,[{findingIndex:0,proofGroupId:value.packet.aliasBindings.checkToFull.get(value.group.proofGroupId),resultIds:value.group.resultIds.map((id:string)=>value.packet.aliasBindings.resultToFull.get(id))}]);
 assert.match(bound.audit.proofGroupCatalogSha256!,/^[a-f0-9]{64}$/);
 assert.equal(bound.audit.wireSchemaVersion,"investigation-report-proof-groups-v1");
 assert.equal(bound.audit.provenance,"model-selected-proof-group-and-source-excerpt-reference-resolved-by-server");
});

test("unknown, stale, mixed, and unsupported proof-group selections fail closed",()=>{
 const value=setup();
 const bind=(findings:unknown)=>bindInvestigationReportPacket(JSON.stringify({...value.base,findings}),runId,snapshotHash,value.selected,value.catalog,value.results);
 assert.throws(()=>bind([{...value.base.findings[0],proofGroupIds:["0".repeat(64)]}]),/Unknown report check alias/);
 const stale=structuredClone(value.results);stale[0]!.resultId="0".repeat(64);
 assert.throws(()=>bindInvestigationReportPacket(JSON.stringify(value.base),runId,snapshotHash,value.selected,value.catalog,stale),/binding is invalid or stale/);
 assert.throws(()=>bind([{...value.base.findings[0],recordChecks:[]}]),/cannot mix/);
 assert.throws(()=>bind([{...value.base.findings[0],evidence:[{quoteId:value.quoteIds[0]}],proofGroupIds:[value.group.proofGroupId]}]),/Selected report checks require their exact source and record citations/);
 const changed=setup("LOT-OTHER");
 assert.notEqual(changed.group.proofGroupId,value.group.proofGroupId);
 assert.throws(()=>bindInvestigationReportPacket(JSON.stringify(value.base),runId,snapshotHash,changed.selected,changed.catalog,changed.results),/Unknown report quote alias/);
});

test("proof groups are never assigned implicitly when the model selects none",()=>{
 const value=setup(),finding={...value.base.findings[0],proofGroupIds:[]};
 const bound=bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[finding]}),runId,snapshotHash,value.selected,value.catalog,value.results);
 assert.deepEqual(JSON.parse(bound.argumentsText).findings[0].recordChecks,[]);
 assert.deepEqual(bound.audit.proofGroupBindings,[]);
});

test("selected proof groups return current C/E repair codes and still require an explicit quote citation",()=>{
 const value=setup(),finding={...value.base.findings[0],evidence:[{quoteId:value.quoteIds[0]!}]};
 let failure:unknown;
 try{bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[finding]}),runId,snapshotHash,value.selected,value.catalog,value.results);}catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const diagnosticCodes=(failure as any).diagnosticCodes as string[];
 assert.ok(diagnosticCodes.length>0);
 assert.ok(diagnosticCodes.every(code=>/^REPORT_findings_0_check_C_[a-f0-9]{24}_needs_E_[a-f0-9]{24}$/.test(code)));
 assert.throws(()=>bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[finding]}),runId,snapshotHash,value.selected,value.catalog,value.results),/Selected report checks require their exact source and record citations/);
 const suggested=diagnosticCodes.map(code=>code.match(/_needs_(E_[a-f0-9]{24})$/)![1]);
 const explicit={...finding,evidence:[...new Set([...finding.evidence.map(citation=>citation.quoteId),...suggested])].map(quoteId=>({quoteId}))};
 const bound=bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[explicit]}),runId,snapshotHash,value.selected,value.catalog,value.results);
 assert.equal(JSON.parse(bound.argumentsText).findings[0].recordChecks.length,value.results.length);
});

test("fifteen shared-option results split into selectable groups and both bind under the unchanged finding cap",()=>{
 const value=setup(),base=value.results[0]!;
 const results=Array.from({length:15},(_,index)=>{
  const {resultId:_old,...bound}=base;
  bound.recordId=`ROW-${index+1}`;
  return {resultId:createHash("sha256").update(JSON.stringify(bound),"utf8").digest("hex"),...bound};
 });
 const packet=buildInvestigationReportPacket({runId,snapshotHash,question:"Which local lot matches?",selected:value.selected,catalog:value.catalog,recordMatches:results,comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 assert.equal(packet.context.recordProofGroups.length,2);
 assert.deepEqual(packet.context.recordProofGroups.map(group=>group.resultIds.length),[12,3]);
 const findings=packet.context.recordProofGroups.map(group=>({kind:"observation",summary:"The selected field checks are recorded with their exact source citations.",comparisons:[],proofGroupIds:[group.proofGroupId],evidence:[...new Set(group.requiredEvidenceOptions.flatMap(option=>option.quoteIds.slice(0,1)))].map(quoteId=>({quoteId}))}));
 const bound=bindInvestigationReportPacket(JSON.stringify({nextStep:"answer_document_question",summary:"The source-bound field checks are recorded.",findings}),runId,snapshotHash,value.selected,value.catalog,results);
 const normalized=JSON.parse(bound.argumentsText),checks=normalized.findings.flatMap((finding:any)=>finding.recordChecks);
 assert.equal(checks.length,15);
 const {runId:_run,...report}=normalized;
 const validation=validateInvestigationReport({snapshotHash,entries:value.selected},value.selected.map(entry=>entry.id),report,{question:"Which local lot matches?",recordMatches:results});
 assert.equal(validation.valid,true,validation.codes.join(","));
});

test("model-facing packet exposes only current typed aliases and rejects cross-kind and stale aliases",()=>{
 const value=setup(),otherRun="5a0d8d25-5caf-4fa3-8ecb-a2646209320d";
 const quote=value.packet.context.evidenceExcerpts[0]!.quoteId as string;
 const check=value.group.proofGroupId as string;
 const result=value.packet.context.requiredProofs.allRecordResultIds[0] as string;
 assert.match(quote,/^E_[a-f0-9]{24}$/);assert.match(check,/^C_[a-f0-9]{24}$/);assert.match(result,/^R_[a-f0-9]{24}$/);
 assert.doesNotMatch(JSON.stringify(value.packet.context),/[a-f0-9]{64}/);
 assert.ok(value.packet.schema.properties.findings.items.properties.proofGroupIds.items.enum.includes(check));
 const bind=(finding:any)=>bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[finding]}),runId,snapshotHash,value.selected,value.catalog,value.results);
 assert.throws(()=>bind({...value.base.findings[0],proofGroupIds:[quote]}),/Unknown report check alias/);
 assert.throws(()=>bind({...value.base.findings[0],evidence:[{quoteId:check}]}),/Unknown report quote alias/);
 assert.throws(()=>bind({...value.base.findings[0],recordChecks:[{resultId:check,field:value.results[0]!.field,status:value.results[0]!.status}]}),/Unknown report result alias/);
 const otherCatalog=buildEvidenceExcerptCatalog({runId:otherRun,snapshotHash,selected:value.selected,maxBytes:80_000,coalesce:true,supportQuotes:value.results.flatMap(result=>result.evidence)});
 const other=buildInvestigationReportPacket({runId:otherRun,snapshotHash,question:"Which local lot matches?",selected:value.selected,catalog:otherCatalog,recordMatches:[],comparisonRequirements:{noticeComparison:false,recordMatching:false}});
 const otherQuoteAlias=other.context.evidenceExcerpts[0]!.quoteId as string;
 assert.notEqual(otherQuoteAlias,quote);
 assert.throws(()=>bindInvestigationReportPacket(JSON.stringify({...value.base,findings:[{...value.base.findings[0],evidence:[{quoteId:otherQuoteAlias}]}]}),runId,snapshotHash,value.selected,value.catalog,value.results),/Unknown report quote alias/);
});
