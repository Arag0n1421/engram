import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {INVESTIGATION_DOMAIN_FEEDBACK_CODES,type EvidenceEntry} from "../../src/shared/investigation.ts";
import {buildEvidenceExcerptCatalog} from "../../src/runtime/evidence-excerpts.ts";
import {buildInvestigationReceiptPacket,bindInvestigationReceiptPacket,MAX_EXPANDED_RECEIPT_ARGUMENT_BYTES} from "../../src/runtime/investigation-report-receipts.ts";
import {buildInvestigationReportPacket} from "../../src/runtime/investigation-report-packet.ts";
import {ReportFormatDiagnosticError,reportFormatDiagnosticCodes} from "../../src/runtime/report-format-diagnostics.ts";
import type {BoundRecordMatch} from "../../src/runtime/record-matching.ts";

const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64),sha=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
const noticeText="Earlier notice: LOT-A remains on hold.\n\nUpdated notice: LOT-A remains on hold.";
const updatedNoticeText="Updated notice: LOT-A remains on hold.";
const recordText="The exact local record rows identify LOT-A and retain the source receipt acknowledgement.\n\nLocal record ROW-01 has LOT-A recorded.\n\nLocal record ROW-02 has LOT-A recorded.\n\nLocal record ROW-03 has LOT-A recorded.";
const entry=(id:string,kind:"notice"|"record",content:string):EvidenceEntry=>({id,title:kind==="notice"?"Safety notice":"Local record table",kind,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:"2026-01-01T00:00:00.000Z",content,sourceHash:sha(content),snapshotHash,refs:[],support:"Synthetic receipt-packet fixture.",authority:kind==="notice"?"public-source-excerpt":"fictional-record"});
const selected=[entry("NOTICE","notice",noticeText),entry("NOTICE-UPDATED","notice",updatedNoticeText),entry("ROWS","record",recordText)];
const prior="Earlier notice: LOT-A remains on hold.",recordQuote="The exact local record rows identify LOT-A and retain the source receipt acknowledgement.";
const rowQuote=(recordId:string)=>`Local record ${recordId} has LOT-A recorded.`;
function result(recordId:string):BoundRecordMatch{
 const bound={runId,snapshotHash,recordId,field:"lot" as const,status:"match" as const,reason:"exact_lot_comparison" as const,criterionCompleteness:"complete_explicit_list" as const,productIdentity:"exact_quoted_identifier" as const,scopeStatus:"not_a_recall_scope_determination" as const,normalizedCriterion:["LOT-A"],normalizedRecordValue:"LOT-A",evidence:[{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior},{sourceId:"ROWS",sourceHash:selected[2]!.sourceHash,quote:recordQuote},{sourceId:"ROWS",sourceHash:selected[2]!.sourceHash,quote:rowQuote(recordId)}],verificationScope:"explicit_source_bound_field_comparison_only" as const};
 return {resultId:sha(JSON.stringify(bound)),...bound};
}
const matches=Array.from({length:3},(_,i)=>result(`ROW-${String(i+1).padStart(2,"0")}`));
const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected,maxBytes:80_000,coalesce:true,supportQuotes:matches.flatMap(match=>match.evidence)});
const feedbackDraft={disposition:"answered" as const,summary:"Prior report for feedback-binding tests.",findings:[{id:"feedback-draft",kind:"observation" as const,summary:"A selected source passage remains available.",evidence:[{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior}],comparisons:[],recordChecks:[]}]};
const packet=()=>buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
const aliases=(p:ReturnType<typeof packet>)=>({quote:(text:string)=>{const excerpts=(p.context as any).evidenceExcerpts,excerpt=excerpts.find((item:any)=>item.text===text)??excerpts.find((item:any)=>item.text.includes(text));assert.ok(excerpt);return excerpt.quoteId as string;},result:(index:number)=>[...p.privateBinding.aliasMaps.resultOrdinalToProvider.keys()][index]!});
const validWire=(p:ReturnType<typeof packet>)=>{const a=aliases(p);return {packetId:p.packetId,nextStep:"answer_document_question",summary:"The notices preserve the same explicit hold action; the checked local records are attached separately.",documentFindings:[{kind:"observation",summary:"The earlier and updated notice passages both state that LOT-A remains on hold, and the selected record receipt identifies that lot.",evidence:[{quoteId:a.quote(prior)},{quoteId:a.quote("Updated notice: LOT-A remains on hold.")},{quoteId:a.quote(recordQuote)}],comparisons:[{beforeQuoteId:a.quote(prior),afterQuoteId:a.quote("Updated notice: LOT-A remains on hold.")}],recordCheckRefs:[a.result(0)]}]};};

test("packet presents current E and R references, attaches all checked results globally, and expands only explicitly selected results",()=>{
 const p=packet(),wire=validWire(p),raw=JSON.stringify(wire),bound=bindInvestigationReceiptPacket(raw,p,runId,snapshotHash,selected,catalog,matches),normalized=JSON.parse(bound.argumentsText);
 assert.equal(p.privateBinding.aliasMaps.quoteOrdinalToProvider.size,catalog.entries.length);assert.equal(p.privateBinding.aliasMaps.resultOrdinalToProvider.size,matches.length);
 assert.equal((p.context as any).recordReceipts.length,matches.length);assert.equal((p.context as any).recordReceipts[0].resultId,"R1");
 assert.deepEqual((p.context as any).evidenceExcerpts.map((item:any)=>item.sourceKind),[...((p.context as any).evidenceExcerpts as any[])].map((item:any)=>item.sourceKind).sort((a:string,b:string)=>(a==="notice"?0:1)-(b==="notice"?0:1)));assert.deepEqual((p.context as any).recordReceipts.map((item:any)=>item.recordId),[...matches].map(match=>match.recordId).sort());assert.equal((p.context as any).evidenceExcerpts.length,catalog.entries.length);assert.deepEqual(new Set((p.context as any).evidenceExcerpts.map((item:any)=>item.quoteId)),new Set([...p.privateBinding.aliasMaps.quoteOrdinalToProvider.keys()]));
 const receipt=(p.context as any).recordReceipts[0];assert.equal(receipt.proofSources.length,2);assert.equal(Object.hasOwn(receipt,"suggestedEvidenceQuoteIds"),false);assert.equal(Object.hasOwn(receipt,"sourceProofOptions"),false);
 assert.deepEqual((p.context as any).selectedSources.map((source:any)=>source.sourceRef),["SRC1","SRC2","SRC3"]);assert.ok((p.context as any).evidenceExcerpts.every((excerpt:any)=>["SRC1","SRC2","SRC3"].includes(excerpt.sourceRef)));assert.deepEqual(receipt.proofSources,[{sourceRef:"SRC1",sourceKind:"notice"},{sourceRef:"SRC3",sourceKind:"record"}]);
 const requiredProofs=(p.context as any).requiredProofs;assert.equal(Object.hasOwn(requiredProofs,"requiredLocalRecordReviews"),false);assert.equal(Object.hasOwn(requiredProofs,"missingRecordReviews"),false);assert.equal(Object.hasOwn(requiredProofs,"missingRecordReviewsDraftSha256"),false);
 assert.equal(JSON.stringify(p.context).includes("requiredLocalRecordReviews"),false);assert.equal(JSON.stringify(p.context).includes("requiredRecordQuoteRefs"),false);
 assert.match(p.instruction,/Local record findings are rendered by the server, not by you/);assert.match(p.instruction,/set recordCheckRefs to \[\]/);assert.match(p.instruction,/Set recordCheckRefs to \[\] in every finding; record findings are server-rendered/);assert.doesNotMatch(p.instruction,/row-allocation checklist/);assert.doesNotMatch(p.instruction,/requiredLocalRecordReviews/);assert.doesNotMatch(p.instruction,/Use recordCheckRefs only when a documentary finding makes a claim about a local record/);
 const providerRefs=((p.providerSchema as any).properties.documentFindings.items.anyOf as any[]).map(branch=>branch.properties.recordCheckRefs);assert.ok(providerRefs.length>0);assert.ok(providerRefs.every(schema=>schema.maxItems===0));
 assert.equal(JSON.stringify(p.context).includes("NOTICE"),false);assert.equal(JSON.stringify(p.context).includes("ROWS"),false);
 assert.equal(p.context && (p.context as any).expectedReportSchema.properties.packetId.enum[0],p.packetId);assert.equal(JSON.stringify(p.providerSchema).includes("uniqueItems"),false);assert.deepEqual(p.providerControls,{tool_choice:"none",temperature:0,reasoning_effort:"low",max_tokens:16384});assert.equal(JSON.stringify(p.providerSchema).includes("recordCitationMode"),false);
 const findingBranches=(p.providerSchema as any).properties.documentFindings.items.anyOf as any[];assert.equal(findingBranches.length,2);
 const missingEvidenceBranch=findingBranches.find(branch=>branch.properties.kind.enum[0]==="missing_evidence");const ordinaryBranch=findingBranches.find(branch=>branch.properties.kind.enum.includes("observation"));
 assert.ok(missingEvidenceBranch.required.includes("question"));assert.ok(!ordinaryBranch.required.includes("question"));assert.deepEqual(ordinaryBranch.properties.kind.enum,["conflict","observation"]);
 assert.match(p.instruction,/two different presented notice sources/);assert.match(p.instruction,/Do not copy the user's question into the top-level question field; omit that field when answering/);assert.match(p.instruction,/requests for missing artifacts or verification only in the existing question field/);assert.match(p.instruction,/summary should state what is unavailable as a fact, not make a request or use an imperative/);assert.match(p.instruction,/For documentary-only findings, set recordCheckRefs to \[\]/);assert.match(p.instruction,/Each source claim must be directly supported by the selected exact E quote/);
 assert.deepEqual(normalized.recordReceiptIds,matches.map(match=>match.resultId));assert.equal(normalized.recordCitationMode,"atomic_receipts_v1");assert.equal(normalized.findings.length,1);assert.equal(normalized.findings[0].recordChecks.length,1);assert.equal(normalized.findings[0].recordChecks[0].resultId,matches[0]!.resultId);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.comparisonQuoteIds,[aliases(p).quote(prior),aliases(p).quote("Updated notice: LOT-A remains on hold.")]);
 assert.equal(bound.audit.wireSchemaVersion,"investigation-report-receipt-selection-v7");assert.equal(bound.audit.provenance,"model-selected-atomic-record-receipts-and-documentary-quotes");
 assert.equal(bound.audit.rawWireSha256,sha(raw));assert.equal(bound.audit.rawWireBytes,new TextEncoder().encode(raw).byteLength);assert.match(bound.audit.receiptExpandedWireSha256??"",/^[a-f0-9]{64}$/);assert.equal(bound.audit.fullIdWireSha256,bound.audit.receiptExpandedWireSha256);
 assert.deepEqual(bound.receiptAudit.serverAttachedResultIds,matches.map(match=>match.resultId));assert.deepEqual(bound.receiptAudit.modelSelectedRecordReferences,[{findingIndex:0,resultIds:[matches[0]!.resultId]}]);assert.deepEqual(bound.receiptAudit.serverResolvedProofAssets,[{resultId:matches[0]!.resultId,proofs:matches[0]!.evidence}]);
 assert.ok(new TextEncoder().encode(bound.argumentsText).byteLength<=MAX_EXPANDED_RECEIPT_ARGUMENT_BYTES);
});

test("per-row requirement checklists are not offered when record findings are server-rendered, while row receipts keep distinct source-bound proofs",()=>{
 const repeated="Shared product proof states LOT-A; this text contains no local row identifier.",rowText=(id:string)=>`Local record ${id} lists LOT-A.`;
 const rowA=entry("ROW-SOURCE-A","record",`${repeated}\n${rowText("ROW-A")}`),rowB=entry("ROW-SOURCE-B","record",`${repeated}\n${rowText("ROW-B")}`),scopedSelected=[rowA,rowB];
 const makeScoped=(base:BoundRecordMatch,recordId:string,source:EvidenceEntry):BoundRecordMatch=>{
  const body={...base,recordId,evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:repeated},{sourceId:source.id,sourceHash:source.sourceHash,quote:rowText(recordId)}]};delete (body as any).resultId;return {...body,resultId:sha(JSON.stringify(body))};
 };
 const scopedMatches=[makeScoped(matches[0]!,"ROW-A",rowA),makeScoped(matches[1]!,"ROW-B",rowB)];
 const scopedCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:scopedSelected,maxBytes:80_000,coalesce:true,supportQuotes:scopedMatches.flatMap(match=>match.evidence)});
 const scoped=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the two local rows.",selected:scopedSelected,catalog:scopedCatalog,recordMatches:scopedMatches,comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 const scopedContext=scoped.context as any;assert.equal(Object.hasOwn(scopedContext.requiredProofs,"requiredLocalRecordReviews"),false);assert.equal(Object.hasOwn(scopedContext.requiredProofs,"missingRecordReviews"),false);
 assert.match(scoped.instruction,/Local record findings are rendered by the server, not by you/);assert.doesNotMatch(scoped.instruction,/row-allocation checklist/);
 assert.deepEqual(scopedContext.recordReceipts.map((receipt:any)=>receipt.recordId),["ROW-A","ROW-B"]);
 const [receiptA,receiptB]=scopedContext.recordReceipts;assert.equal(receiptA.proofSources.length,1);assert.equal(receiptB.proofSources.length,1);assert.notEqual(receiptA.proofSources[0].sourceRef,receiptB.proofSources[0].sourceRef);assert.ok(receiptA.proofSources.every((proof:any)=>proof.sourceKind==="record"));
 for(const id of ["ROW-A","ROW-B"])assert.equal(scopedContext.evidenceExcerpts.filter((excerpt:any)=>excerpt.text.includes(rowText(id))).length,1);
 const noProofMatches=scopedMatches.map(match=>{const body={...match,evidence:[]};delete (body as any).resultId;return {...body,resultId:sha(JSON.stringify(body))};});
 const noProofCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:scopedSelected,maxBytes:80_000,coalesce:true});
 const noOptions=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the two local rows.",selected:scopedSelected,catalog:noProofCatalog,recordMatches:noProofMatches,comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 assert.equal(Object.hasOwn((noOptions.context as any).requiredProofs,"requiredLocalRecordReviews"),false);assert.match(noOptions.instruction,/Local record findings are rendered by the server, not by you/);
});

test("expanded internal receipt arguments have a UTF-8 byte cap after alias and receipt expansion",()=>{
 const hugeExcerpt=Array.from({length:8},(_,index)=>`${"\u0000".repeat(950)}END-${index}`).join("\n\n"),largeNotice=entry("LARGE-NOTICE","notice",hugeExcerpt),largeSelected=[largeNotice],largeCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:largeSelected,maxBytes:80_000,coalesce:true}),largePacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Summarize the selected source excerpt.",selected:largeSelected,catalog:largeCatalog,recordMatches:[],comparisonRequirements:{noticeComparison:false,recordMatching:false}});
 const quoteIds:string[]=(largePacket.context as any).evidenceExcerpts.map((excerpt:any)=>excerpt.quoteId as string);assert.equal(quoteIds.length,8);
 const wire={packetId:largePacket.packetId,nextStep:"answer_document_question",summary:"The exact selected source contains the repeated excerpts.",documentFindings:Array.from({length:6},()=>({kind:"observation",summary:"The selected source excerpts are retained exactly.",evidence:quoteIds.map(quoteId=>({quoteId})),comparisons:[],recordCheckRefs:[]}))};
 const raw=JSON.stringify(wire);assert.ok(new TextEncoder().encode(raw).byteLength<48_000);
 assert.throws(()=>bindInvestigationReceiptPacket(raw,largePacket,runId,snapshotHash,largeSelected,largeCatalog,[]),/Expanded receipt report arguments exceed the 128KB internal limit/);
});

test("atomic receipt packet validates canonical record proofs without duplicating every proof into E while legacy remains strict",()=>{
 const baseCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected,maxBytes:80_000,coalesce:false,supportQuotes:matches.flatMap(match=>match.evidence)});
 const entries=baseCatalog.entries.filter(item=>!(item.sourceId==="NOTICE"&&item.text.includes(prior)));
 assert.ok(entries.some(item=>item.sourceId==="NOTICE-UPDATED"));assert.ok(entries.some(item=>item.sourceId==="ROWS"));
 const catalogWithoutNoticeProof={...baseCatalog,entries};catalogWithoutNoticeProof.bytes=new TextEncoder().encode(JSON.stringify({entries:catalogWithoutNoticeProof.entries,omissions:catalogWithoutNoticeProof.omissions})).byteLength;
 assert.equal(entries.some(item=>item.sourceId==="NOTICE"&&item.text.includes(prior)),false);
 const input={runId,snapshotHash,question:"Compare the notice and check current records.",selected,catalog:catalogWithoutNoticeProof,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true}};
 assert.throws(()=>buildInvestigationReportPacket(input),/no exact presented catalog coverage/);
 const atomic=buildInvestigationReceiptPacket(input);
 assert.equal((atomic.context as any).recordReceipts.length,matches.length);
 assert.equal((atomic.context as any).evidenceExcerpts.length,entries.length);
 assert.equal((atomic.context as any).recordReceipts[0].proofSources.length,2);
 const forgedBody={...matches[0]!,evidence:matches[0]!.evidence.map((proof,index)=>index===0?{...proof,quote:"A fabricated proof absent from the selected source."}:proof)};delete (forgedBody as any).resultId;
 const forged={...forgedBody,resultId:sha(JSON.stringify(forgedBody))} as BoundRecordMatch;
 assert.throws(()=>buildInvestigationReceiptPacket({...input,recordMatches:[forged,...matches.slice(1)]}),/current selected source/);
 const forgedHashBody={...matches[0]!,evidence:matches[0]!.evidence.map((proof,index)=>index===0?{...proof,sourceHash:"c".repeat(64)}:proof)};delete (forgedHashBody as any).resultId;
 const forgedHash={...forgedHashBody,resultId:sha(JSON.stringify(forgedHashBody))} as BoundRecordMatch;
 assert.throws(()=>buildInvestigationReceiptPacket({...input,recordMatches:[forgedHash,...matches.slice(1)]}),/current selected source/);
});

test("comparison repair names the exact finding and rejects non-notice or same-source endpoints",()=>{
 const secondNotice=entry("NOTICE-2","notice","Later notice: LOT-A remains on hold.");
 const selectedWithSecond=[selected[0]!,selected[1]!,secondNotice,selected[2]!],catalogWithSecond=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:selectedWithSecond,maxBytes:80_000,coalesce:false,supportQuotes:matches.flatMap(match=>match.evidence)});
 const p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the two selected notices.",selected:selectedWithSecond,catalog:catalogWithSecond,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 const excerpt=(text:string)=>{const value=(p.context as any).evidenceExcerpts.find((item:any)=>item.text===text);assert.ok(value);return value.quoteId as string;};
 const priorAlias=excerpt(prior),laterAlias=excerpt(secondNotice.content),recordAlias=excerpt(rowQuote(matches[0]!.recordId));
 const finding=(evidence:string[],comparisons:Array<{beforeQuoteId:string;afterQuoteId:string}>)=>({kind:"observation",summary:"The selected notice excerpts state their exact actions.",evidence:evidence.map(quoteId=>({quoteId})),comparisons,recordCheckRefs:[]});
 const makeWire=(findings:any[])=>JSON.stringify({packetId:p.packetId,nextStep:"answer_document_question",summary:"The selected notices contain the compared actions.",documentFindings:findings});
 const positive=makeWire([finding([priorAlias,laterAlias],[{beforeQuoteId:priorAlias,afterQuoteId:laterAlias}])]);
 assert.doesNotThrow(()=>bindInvestigationReceiptPacket(positive,p,runId,snapshotHash,selectedWithSecond,catalogWithSecond,matches));
 const sameSourceAlias=excerpt("Updated notice: LOT-A remains on hold.");const sameSource=makeWire([finding([priorAlias,sameSourceAlias],[{beforeQuoteId:priorAlias,afterQuoteId:sameSourceAlias}])]);
 let sameError:unknown;try{bindInvestigationReceiptPacket(sameSource,p,runId,snapshotHash,selectedWithSecond,catalogWithSecond,matches);}catch(error){sameError=error;}
 assert.ok(sameError instanceof ReportFormatDiagnosticError);assert.deepEqual(reportFormatDiagnosticCodes(sameError),["REPORT_documentFindings_0_comparisons_0_REQUIRES_DISTINCT_NOTICE_SOURCES"]);
 const six=Array.from({length:6},()=>finding([priorAlias,laterAlias,recordAlias],[]));six[5]!.comparisons=[{beforeQuoteId:priorAlias,afterQuoteId:laterAlias},{beforeQuoteId:recordAlias,afterQuoteId:priorAlias}];
 let indexedError:unknown;try{bindInvestigationReceiptPacket(makeWire(six),p,runId,snapshotHash,selectedWithSecond,catalogWithSecond,matches);}catch(error){indexedError=error;}
 assert.ok(indexedError instanceof ReportFormatDiagnosticError);assert.deepEqual(reportFormatDiagnosticCodes(indexedError),["REPORT_documentFindings_5_comparisons_1_REQUIRES_DISTINCT_NOTICE_SOURCES"]);
});

test("retry packet retains only bounded fixed validation feedback and exact finding indices",()=>{
 const feedback=[{codes:["record_match_field_claim_mismatch","PRIVATE_REJECTED_CODE"],findingIssues:[{findingIndex:2,code:"record_match_field_claim_mismatch"},{findingIndex:2,code:"record_match_field_claim_mismatch"},{findingIndex:9,code:"invalid_finding"},{findingIndex:1,code:"PRIVATE_PATH_INJECTION"}],reportIssues:["scope_reduction_requires_explicit_prior_scope_withdrawal","PRIVATE_REPORT_CODE"],findingIssuesOmittedCount:3,reportIssuesOmittedCount:1,summary:"REJECTED MODEL PROSE",proofIssues:[{findingIndex:0,code:"invalid_finding",resultId:"PRIVATE_RESULT",missingProofHashes:["PRIVATE_HASH"]}]}];
 const p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Check the current selected evidence.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback});
 assert.deepEqual((p.context as any).feedback,[{codes:["record_match_field_claim_mismatch"],guidance:["Limit each local-record statement to the exact checked field and status. A field match does not establish product configuration, recall scope, clearance, or safety."],findingIssues:[{findingIndex:2,code:"record_match_field_claim_mismatch"}],reportIssues:["scope_reduction_requires_explicit_prior_scope_withdrawal"],findingIssuesOmittedCount:3,reportIssuesOmittedCount:1}]);
 for(const secret of ["PRIVATE_REJECTED_CODE","PRIVATE_PATH_INJECTION","PRIVATE_REPORT_CODE","REJECTED MODEL PROSE","PRIVATE_RESULT","PRIVATE_HASH"])assert.equal(JSON.stringify(p.context).includes(secret),false);
});

test("provider comparison alternatives bind distinct notice E endpoints by alias and fixed retry guidance",()=>{
 const p=packet(),findingBranches=(p.providerSchema as any).properties.documentFindings.items.anyOf as any[],ordinary=findingBranches.find(branch=>branch.properties.kind.enum.includes("observation")),schema=ordinary.properties.comparisons;
 const alternatives=schema.items.anyOf as any[];assert.ok(alternatives.length>0);
 const excerpt=(text:string)=>aliases(p).quote(text),priorId=excerpt(prior),laterId=excerpt("Updated notice: LOT-A remains on hold.");
 assert.ok(alternatives.some(option=>option.properties.beforeQuoteId.enum.includes(priorId)&&option.properties.afterQuoteId.enum.includes(laterId)));
 const sourceByAlias=new Map(((p.context as any).evidenceExcerpts as Array<{quoteId:string;sourceRef:string}>).map(item=>[item.quoteId,item.sourceRef]));assert.ok(alternatives.every(option=>option.properties.beforeQuoteId.enum.every((before:string)=>option.properties.afterQuoteId.enum.every((after:string)=>sourceByAlias.get(before)!==sourceByAlias.get(after)))));
 const onlyOneNotice=entry("ONE-NOTICE","notice","One notice only."),oneCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[onlyOneNotice],maxBytes:80_000,coalesce:false});
 const onePacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Read this notice.",selected:[onlyOneNotice],catalog:oneCatalog,recordMatches:[],comparisonRequirements:{noticeComparison:false,recordMatching:false}});
 const oneBranches=(onePacket.providerSchema as any).properties.documentFindings.items.anyOf as any[],oneOrdinary=oneBranches.find(branch=>branch.properties.kind.enum.includes("observation"));assert.equal(oneOrdinary.properties.comparisons.maxItems,0);
 const noticeContent=(prefix:string)=>Array.from({length:22},(_,index)=>`${prefix} exact source passage ${index+1} for the controlled schema-size check.`).join("\n\n"),largeA=entry("LARGE-A","notice",noticeContent("Earlier")),largeB=entry("LARGE-B","notice",noticeContent("Updated")),largeSelected=[largeA,largeB],largeCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:largeSelected,maxBytes:80_000,coalesce:false}),largePacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the selected notices.",selected:largeSelected,catalog:largeCatalog,recordMatches:[],comparisonRequirements:{noticeComparison:true,recordMatching:false}}),largeBranches=(largePacket.providerSchema as any).properties.documentFindings.items.anyOf as any[],largeOrdinary=largeBranches.find(branch=>branch.properties.kind.enum.includes("observation")),largeComparisons=largeOrdinary.properties.comparisons;
 assert.ok(largeCatalog.entries.length>=40);assert.equal(largeComparisons.items.anyOf.length,2);assert.ok(largeComparisons.items.anyOf.length<10);assert.ok(largeComparisons.items.anyOf.every((option:any)=>option.properties.beforeQuoteId.enum.length>=20&&option.properties.afterQuoteId.enum.length>=20));
 const retry=buildInvestigationReceiptPacket({...{runId,snapshotHash,question:"Compare notices.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true}},formatFailures:[{codes:["REPORT_documentFindings_0_comparisons_0_REQUIRES_DISTINCT_NOTICE_SOURCES"],rawContent:"UNTRUSTED"}]});
 const failure=(retry.context as any).formatFailures[0];assert.equal(failure.rawContentOmitted,true);assert.equal(failure.category,"report_format_rejection");assert.equal(failure.appliesToShownDraft,false);assert.ok(failure.guidance.some((text:string)=>text.includes("prior raw report response")));assert.equal(JSON.stringify(retry.context).includes("UNTRUSTED"),false);assert.equal(JSON.stringify(retry.context).includes("REQUIRES_DISTINCT_NOTICE_SOURCES"),false);
});

test("E/R ordinals follow presented order and bind only explicitly selected full references",()=>{
 const reversedSelected=[selected[2]!,selected[0]!,selected[1]!],reversedMatches=[matches[2]!,matches[0]!,matches[1]!];
 const reversedCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:reversedSelected,maxBytes:80_000,coalesce:true,supportQuotes:reversedMatches.flatMap(match=>match.evidence)});
 const p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the notices and check selected local records.",selected:reversedSelected,catalog:reversedCatalog,recordMatches:reversedMatches,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 const shownExcerpts=(p.context as any).evidenceExcerpts as Array<{quoteId:string;text:string;sourceKind:string}>;
 const shownReceipts=(p.context as any).recordReceipts as Array<{resultId:string;recordId:string}>;
 assert.deepEqual(shownExcerpts.map(item=>item.quoteId),shownExcerpts.map((_item,index)=>`E${index+1}`));
 assert.deepEqual(shownReceipts.map(item=>item.resultId),shownReceipts.map((_item,index)=>`R${index+1}`));
 assert.equal(shownExcerpts[0]!.sourceKind,"notice");
 assert.deepEqual(shownReceipts.map(item=>item.recordId),["ROW-01","ROW-02","ROW-03"]);
 for(const excerpt of shownExcerpts)assert.equal(p.privateBinding.aliasMaps.quoteOrdinalToFull.get(excerpt.quoteId),reversedCatalog.entries.find(item=>item.text===excerpt.text)?.quoteId);
 for(const receipt of shownReceipts)assert.equal(p.privateBinding.aliasMaps.resultOrdinalToFull.get(receipt.resultId),reversedMatches.find(item=>item.recordId===receipt.recordId)?.resultId);

 const selectedExcerpt=shownExcerpts[0]!,selectedReceipt=shownReceipts[0]!;
 const raw=JSON.stringify({packetId:p.packetId,nextStep:"answer_document_question",summary:"The selected source excerpt supports the stated observation.",documentFindings:[{kind:"observation",summary:"The selected notice states that LOT-A remains on hold.",evidence:[{quoteId:selectedExcerpt.quoteId}],comparisons:[],recordCheckRefs:[selectedReceipt.resultId]}]});
 const bound=bindInvestigationReceiptPacket(raw,p,runId,snapshotHash,reversedSelected,reversedCatalog,reversedMatches),normalized=JSON.parse(bound.argumentsText);
 const excerptSource=reversedSelected.find(source=>source.kind==="notice")!;
 assert.deepEqual(normalized.findings[0].evidence,[{sourceId:excerptSource.id,sourceHash:excerptSource.sourceHash,quote:selectedExcerpt.text}]);
 assert.deepEqual(normalized.findings[0].recordChecks.map((item:any)=>item.resultId),[p.privateBinding.aliasMaps.resultOrdinalToFull.get(selectedReceipt.resultId)]);
 assert.equal(normalized.findings[0].evidence.length,1);assert.equal(normalized.findings[0].recordChecks.length,1);
});

test("selected atomic receipts bind without copying their proofs and unknown or cross-kind aliases still fail",()=>{
 const p=packet(),wire=validWire(p),bind=(value:unknown)=>bindInvestigationReceiptPacket(JSON.stringify(value),p,runId,snapshotHash,selected,catalog,matches);
 const atomic=structuredClone(wire);atomic.documentFindings[0]!.evidence=[{quoteId:aliases(p).quote("Earlier notice: LOT-A remains on hold.")}];atomic.documentFindings[0]!.comparisons=[];const bound=bind(atomic);const normalized=JSON.parse(bound.argumentsText);assert.equal(normalized.findings[0].evidence.length,1);assert.equal(normalized.findings[0].recordChecks.length,1);assert.equal(bound.receiptAudit.serverResolvedProofAssets[0]!.proofs.length,3);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.quoteIds,[aliases(p).quote("Earlier notice: LOT-A remains on hold.")]);
 const unknown=structuredClone(wire);unknown.documentFindings[0]!.recordCheckRefs=["R999"];assert.throws(()=>bind(unknown));
 const wrongKind=structuredClone(wire);wrongKind.documentFindings[0]!.recordCheckRefs=[aliases(p).quote(prior)];assert.throws(()=>bind(wrongKind));
 const duplicate=structuredClone(wire);duplicate.documentFindings[0]!.recordCheckRefs.push(duplicate.documentFindings[0]!.recordCheckRefs[0]!);assert.throws(()=>bind(duplicate));
 const stale=structuredClone(wire);stale.packetId="P_000000000000000000000000";assert.throws(()=>bind(stale));
});

test("comparison endpoints are explicit documentary citations without redundant evidence-array copies",()=>{
 const p=packet(),wire=validWire(p),bind=(value:unknown)=>bindInvestigationReceiptPacket(JSON.stringify(value),p,runId,snapshotHash,selected,catalog,matches);
 const comparisonOnly=structuredClone(wire);comparisonOnly.documentFindings[0]!.evidence=[];comparisonOnly.documentFindings[0]!.comparisons=[{beforeQuoteId:aliases(p).quote(prior),afterQuoteId:aliases(p).quote("Updated notice: LOT-A remains on hold.")}];
 const bound=bind(comparisonOnly),normalized=JSON.parse(bound.argumentsText),expected=[aliases(p).quote(prior),aliases(p).quote("Updated notice: LOT-A remains on hold.")];
 assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.quoteIds,[]);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.comparisonQuoteIds,expected);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.selectedQuoteIds,expected);
 assert.equal(normalized.findings[0].evidence.length,2);for(let index=0;index<expected.length;index++){const full=p.privateBinding.aliasMaps.quoteOrdinalToFull.get(expected[index]!),entry=catalog.entries.find(item=>item.quoteId===full);assert.ok(entry);assert.deepEqual(normalized.findings[0].evidence[index],{sourceId:entry.sourceId,sourceHash:entry.sourceHash,quote:entry.text});}
 const unrelated=structuredClone(comparisonOnly);unrelated.documentFindings[0]!.evidence=[{quoteId:aliases(p).quote(recordQuote)}];const unrelatedBound=bind(unrelated),unrelatedNormalized=JSON.parse(unrelatedBound.argumentsText),selectedQuotes=unrelatedNormalized.findings[0].evidence.map((item:any)=>item.quote);
 assert.equal(selectedQuotes.length,3);assert.ok(selectedQuotes.some((text:string)=>text.includes(recordQuote)));assert.equal(unrelatedBound.receiptAudit.modelSelectedDocumentaryCitations[0]!.quoteIds[0],aliases(p).quote(recordQuote));assert.deepEqual(unrelatedBound.receiptAudit.modelSelectedDocumentaryCitations[0]!.comparisonQuoteIds,expected);assert.deepEqual(unrelatedBound.receiptAudit.modelSelectedDocumentaryCitations[0]!.selectedQuoteIds,[aliases(p).quote(recordQuote),...expected]);
 const noCitation=structuredClone(wire);noCitation.documentFindings[0]!.evidence=[];noCitation.documentFindings[0]!.comparisons=[];let error:unknown;try{bind(noCitation);}catch(caught){error=caught;}assert.ok(error instanceof ReportFormatDiagnosticError);assert.ok(reportFormatDiagnosticCodes(error).includes("REPORT_documentFindings_0_evidence_MIN_1"));
});

test("explicit receipt refs audit all original proofs while documentary excerpts remain model-selected",()=>{
 const p=packet(),wire=validWire(p);wire.documentFindings[0]!.evidence=[{quoteId:aliases(p).quote(prior)}];wire.documentFindings[0]!.comparisons=[];wire.documentFindings[0]!.recordCheckRefs=[aliases(p).result(0),aliases(p).result(1)];const bound=bindInvestigationReceiptPacket(JSON.stringify(wire),p,runId,snapshotHash,selected,catalog,matches);
 assert.deepEqual(bound.receiptAudit.modelSelectedRecordReferences,[{findingIndex:0,resultIds:[matches[0]!.resultId,matches[1]!.resultId]}]);assert.equal(bound.receiptAudit.serverResolvedProofAssets.length,2);assert.equal(bound.receiptAudit.serverResolvedProofAssets.reduce((total,asset)=>total+asset.proofs.length,0),6);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.quoteIds,[aliases(p).quote(prior)]);assert.equal(JSON.parse(bound.argumentsText).findings[0].evidence.length,1);
});

test("atomic receipts retain all original proofs privately without exposing provider proof recipes",()=>{
 const manySources=Array.from({length:6},(_,index)=>entry(`PROOF-${index+1}`,"record",`Exact source proof ${index+1} for this controlled fixture.`));
 const proofMatches=manySources.map((source,index)=>({sourceId:source.id,sourceHash:source.sourceHash,quote:`Exact source proof ${index+1} for this controlled fixture.`}));
 const matchBody={...matches[0]!,recordId:"ROW-WITH-SIX-PROOFS",evidence:proofMatches};delete (matchBody as any).resultId;const sixProofMatch={...matchBody,resultId:sha(JSON.stringify(matchBody))} as BoundRecordMatch;
 const proofCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:manySources,maxBytes:80_000,coalesce:true,supportQuotes:proofMatches});
 const build=()=>buildInvestigationReceiptPacket({runId,snapshotHash,question:"Check the exact local record source proofs.",selected:manySources,catalog:proofCatalog,recordMatches:[sixProofMatch],comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 const first=build(),second=build(),receipt=(first.context as any).recordReceipts[0];assert.equal(receipt.proofSources.length,6);assert.equal(Object.hasOwn(receipt,"suggestedEvidenceQuoteIds"),false);assert.equal(Object.hasOwn(receipt,"sourceProofOptions"),false);assert.equal((second.context as any).recordReceipts[0].proofSources.length,6);assert.equal(first.privateBinding.resultBodies[0]!.evidence.length,6);
});

test("packet reconstruction rejects tampered aliases, ordered mappings, receipt bodies, and changed current results",()=>{
 const p=packet(),wire=validWire(p),maps=p.privateBinding.aliasMaps,quoteOrdinal=[...maps.quoteOrdinalToProvider.keys()][0]!,originalAlias=maps.quoteOrdinalToProvider.get(quoteOrdinal)!;
 maps.quoteOrdinalToProvider.set(quoteOrdinal,"E999");assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(wire),p,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);maps.quoteOrdinalToProvider.set(quoteOrdinal,originalAlias);
 p.privateBinding.orderedMaps.quotes[0]!.fullId="f".repeat(64);assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(wire),p,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);
 p.privateBinding.orderedMaps=packet().privateBinding.orderedMaps;
 p.privateBinding.resultBodies[0]!.recordId="TAMPERED";assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(wire),p,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);
 p.privateBinding.resultBodies=packet().privateBinding.resultBodies;
 p.providerControls={tool_choice:"auto",temperature:0,reasoning_effort:"low",max_tokens:16384} as any;assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(wire),p,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);
 const changed=matches.map((match,index)=>index===0?{...match,recordId:"OTHER-ROW"}:match);assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(wire),packet(),runId,snapshotHash,selected,catalog,changed),/invalid or stale|digest or current reference maps/);
});

test("document-only output can ask for genuinely unavailable evidence and preserves the question",()=>{
 const emptyCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected,maxBytes:80_000,coalesce:true}),p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"What artifact is still needed?",selected,catalog:emptyCatalog,recordMatches:[],comparisonRequirements:{noticeComparison:false,recordMatching:false}});
 const branches=(p.providerSchema.properties as any).documentFindings.items.anyOf as any[],missingBranch=branches.find(branch=>branch.properties.kind.enum[0]==="missing_evidence"),ordinaryBranch=branches.find(branch=>branch.properties.kind.enum.includes("observation")),recordRefs=ordinaryBranch.properties.recordCheckRefs;assert.ok(missingBranch.required.includes("question"));assert.equal(ordinaryBranch.required.includes("question"),false);assert.equal(recordRefs.maxItems,0);assert.deepEqual(recordRefs.items,{type:"string"});
 const raw=JSON.stringify({packetId:p.packetId,nextStep:"ask_operator_for_new_evidence",summary:"The available source does not contain the requested receipt detail.",question:"Can the operator provide the current signed receipt?",documentFindings:[{kind:"missing_evidence",summary:"The current signed receipt is unavailable in the selected sources.",question:"Can the operator provide the current signed receipt?",evidence:[{quoteId:"E1"}],comparisons:[],recordCheckRefs:[]}]});
 const bound=bindInvestigationReceiptPacket(raw,p,runId,snapshotHash,selected,emptyCatalog,[]),normalized=JSON.parse(bound.argumentsText);assert.equal(normalized.question,"Can the operator provide the current signed receipt?");assert.deepEqual(normalized.recordReceiptIds,[]);assert.deepEqual(normalized.findings[0].recordChecks,[]);assert.equal(bound.audit.rawWireSha256,sha(raw));
 const missingFindingQuestion=JSON.parse(raw);delete missingFindingQuestion.documentFindings[0].question;let findingQuestionError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(missingFindingQuestion),p,runId,snapshotHash,selected,emptyCatalog,[]);}catch(caught){findingQuestionError=caught;}assert.ok(findingQuestionError instanceof ReportFormatDiagnosticError);assert.deepEqual(reportFormatDiagnosticCodes(findingQuestionError),["REPORT_documentFindings_0_question_INVALID"]);
 const missingQuestion=JSON.parse(raw);delete missingQuestion.question;let questionError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(missingQuestion),p,runId,snapshotHash,selected,emptyCatalog,[]);}catch(caught){questionError=caught;}assert.ok(questionError instanceof ReportFormatDiagnosticError);assert.deepEqual(reportFormatDiagnosticCodes(questionError),["REPORT_question_REQUIRED_FOR_ASK_OPERATOR"]);
 const combined=JSON.parse(raw);delete combined.question;combined.documentFindings[0].comparisons=[{beforeQuoteId:"E1",afterQuoteId:"E2"}];let combinedError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(combined),p,runId,snapshotHash,selected,emptyCatalog,[]);}catch(caught){combinedError=caught;}assert.ok(combinedError instanceof ReportFormatDiagnosticError);assert.deepEqual(reportFormatDiagnosticCodes(combinedError),["REPORT_question_REQUIRED_FOR_ASK_OPERATOR"]);
});

test("retry feedback keeps the fixed receipt and semantic diagnostic vocabulary only",()=>{
 const p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback:[{codes:["record_receipt_coverage_required","record_claim_requires_checked_reference","scope_reduction_requires_explicit_prior_scope_withdrawal","numeric_count_requires_source_or_checked_calculation","invalid_record_citation_mode","atomic_record_receipts_require_global_binding","documentary_action_requires_notice_quote","REPORT_private_internal_error_EXPECTED_TYPE","made_up_code"],summary:"REJECTED NARRATIVE",proofIssues:[{resultId:"SECRET",missingProofHashes:["SECRET_HASH"]}]}]});
 const feedback=(p.context as any).feedback;assert.deepEqual(feedback,[{codes:["record_receipt_coverage_required","record_claim_requires_checked_reference","scope_reduction_requires_explicit_prior_scope_withdrawal","numeric_count_requires_source_or_checked_calculation","invalid_record_citation_mode","atomic_record_receipts_require_global_binding","documentary_action_requires_notice_quote"],guidance:["Cite the actual notice excerpt that supports the required action, or correct or narrow the action claim to match the selected source. Do not add a comparison unless comparing notices.","For a factual local-row claim, explicitly select the R reference for that same record in that finding. Global receipt coverage does not cite the row in documentary prose.","Attribute any nonaffected scope to the specific notice that states it, in that finding. Do not present notice scope as clearance of a local record."]}]);
 assert.equal(JSON.stringify(p.context).includes("REJECTED NARRATIVE"),false);assert.equal(JSON.stringify(p.context).includes("SECRET_HASH"),false);assert.equal(JSON.stringify(p.context).includes("SECRET"),false);
});

test("correction packets bind low effort for safe feedback or native format failures",()=>{
 const first=packet();
 const rejected=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback:[{codes:["record_match_field_claim_mismatch"]}]});
 const malformed=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},formatFailures:[{codes:["invalid_report_shape"],reportRequestNumber:1,rawContentBytes:48}]});
 assert.deepEqual(first.providerControls,{tool_choice:"none",temperature:0,reasoning_effort:"low",max_tokens:16384});
 for(const retry of [rejected,malformed]){
  assert.deepEqual(retry.providerControls,{tool_choice:"none",temperature:0,reasoning_effort:"low",max_tokens:16384});
  assert.notEqual(retry.packetId,first.packetId);assert.notEqual(retry.packetDigest,first.packetDigest);
  assert.equal((retry.context as any).expectedReportSchema.properties.packetId.enum[0],retry.packetId);
  const raw=JSON.stringify(validWire(retry));
  const changed=structuredClone(retry);changed.providerControls.reasoning_effort="none";
  assert.throws(()=>bindInvestigationReceiptPacket(raw,changed,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);
 }
 const untrusted=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},feedback:[{codes:["UNKNOWN_INJECTED_PROSE"]}],formatFailures:[{codes:["UNKNOWN_FORMAT_CODE"],reportRequestNumber:1,rawContentBytes:123}]});
 assert.deepEqual(untrusted.providerControls,{tool_choice:"none",temperature:0,reasoning_effort:"low",max_tokens:16384});
});

test("rejected report corrections are compacted into current E/R aliases and remain untrusted",()=>{
 const first=packet(),beforeInstruction=first.instruction;
 const rejected={disposition:"answered" as const,summary:"REJECTED SUMMARY: unsupported claim that the device was cleared.",findings:[{id:"old-finding-1",kind:"observation" as const,summary:"REJECTED FINDING prose is a correction target only.",evidence:[{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior},{sourceId:"ROWS",sourceHash:selected[2]!.sourceHash,quote:recordQuote}],comparisons:[{before:{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior},after:{sourceId:"NOTICE-UPDATED",sourceHash:selected[1]!.sourceHash,quote:"Updated notice: LOT-A remains on hold."},relation:"same_text" as const}],recordChecks:[{resultId:matches[0]!.resultId,field:"lot" as const,status:"match" as const}]}]};
 const corrected=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:rejected,previousRejectedReportAttemptNumber:1,feedback:[{codes:["record_match_field_claim_mismatch"],findingIssues:[{findingIndex:0,code:"record_match_field_claim_mismatch"}]}]});
 const context=corrected.context as any,draft=context.rejectedReportDraft,excerpts=context.evidenceExcerpts as Array<{quoteId:string;text:string}>;
 const currentAlias=(text:string)=>{const span=catalog.entries.find(item=>item.text===text);assert.ok(span);return corrected.privateBinding.aliasMaps.quoteFullToOrdinal.get(span.quoteId)!;};
 assert.ok(draft);assert.equal(draft.status,"available");assert.equal(draft.bytes,new TextEncoder().encode(JSON.stringify(draft.report)).byteLength);
 assert.equal(Object.hasOwn(context.requiredProofs,"missingRecordReviews"),false);assert.equal(Object.hasOwn(context.requiredProofs,"missingRecordReviewsDraftSha256"),false);assert.equal(Object.hasOwn(context.requiredProofs,"requiredLocalRecordReviews"),false);
 assert.match(corrected.instruction,/Correction protocol: when rejectedReportDraft.status is available/);assert.match(corrected.instruction,/record_findings_are_server_generated/);assert.match(corrected.instruction,/remove every record identifier, record citation and record classification/);assert.doesNotMatch(corrected.instruction,/missingRecordReviews/);assert.doesNotMatch(corrected.instruction,/row-allocation checklist/);
 assert.ok(draft.bytes<=16_000);assert.match(draft.sha256,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(draft.report).sort(),["documentFindings","nextStep","summary"]);assert.equal(draft.report.nextStep,"answer_document_question");
 const draftFinding=draft.report.documentFindings[0];assert.deepEqual(Object.keys(draftFinding).sort(),["comparisons","evidence","kind","recordCheckRefs","summary"]);assert.deepEqual(draftFinding.evidence,[{quoteId:currentAlias(prior)},{quoteId:currentAlias(recordQuote)}]);
 assert.deepEqual(draftFinding.comparisons,[{beforeQuoteId:currentAlias(prior),afterQuoteId:currentAlias("Updated notice: LOT-A remains on hold.")}]);
 assert.deepEqual(draftFinding.recordCheckRefs,[aliases(corrected).result(0)]);assert.equal(context.evidenceExcerpts.length,catalog.entries.length);assert.equal(context.recordReceipts.length,matches.length);assert.equal(context.rejectedNarrativeOmitted,false);
 assert.equal(JSON.stringify(context).includes(matches[0]!.resultId),false);assert.equal(JSON.stringify(context).includes('"sourceId":"NOTICE"'),false);
 assert.match(corrected.instruction,/If rejectedReportDraft is present, treat every part as untrusted and unaccepted/);assert.equal(first.instruction,beforeInstruction);assert.notEqual(corrected.instruction,first.instruction);assert.match(corrected.instruction,/treat feedback findingIndex values as indexes into that exact draft/);assert.equal(Object.hasOwn(first.context as any,"rejectedReportDraft"),false);
 assert.notEqual(corrected.packetId,first.packetId);assert.equal((corrected.context as any).expectedReportSchema.properties.packetId.enum[0],corrected.packetId);assert.deepEqual(corrected.providerControls,{tool_choice:"none",temperature:0,reasoning_effort:"low",max_tokens:16384});
 const newWire=validWire(corrected);newWire.summary="The selected notices preserve the stated hold action.";newWire.documentFindings[0]!.summary="The selected notice excerpts state the hold action; the current local receipt checks the lot field.";
 const bound=bindInvestigationReceiptPacket(JSON.stringify(newWire),corrected,runId,snapshotHash,selected,catalog,matches),normalized=JSON.parse(bound.argumentsText);
 assert.equal(normalized.summary,newWire.summary);assert.equal(normalized.findings[0].summary,newWire.documentFindings[0]!.summary);assert.notEqual(normalized.summary,rejected.summary);assert.deepEqual(normalized.findings[0].recordChecks,[{resultId:matches[0]!.resultId,field:"lot",status:"match"}]);
 const tampered=structuredClone(corrected);(tampered.context as any).rejectedReportDraft.report.summary="changed rejected prose";assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(newWire),tampered,runId,snapshotHash,selected,catalog,matches),/digest or current reference maps/);
});

test("correction feedback is associated only with its latest canonical draft and raw format failures stay separate",()=>{
 const rejected={disposition:"answered" as const,summary:"A rejected summary retained for correction.",findings:[{id:"old-finding-1",kind:"observation" as const,summary:"The earlier report has a source-backed observation.",evidence:[{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior}],comparisons:[],recordChecks:[]}]};
 const malformedPath="REPORT_documentFindings_1_evidence_MAX_8";
 const current=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the current notices and records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:rejected,previousRejectedReportAttemptNumber:2,feedback:[
  {at:"canonical-1",codes:["unsupported_identifier_or_date"],findingIssues:[{findingIndex:0,code:"unsupported_identifier_or_date",unsupportedTokens:["OLD-2024"]}]},
  {at:"canonical-2",codes:["record_match_field_claim_mismatch"],findingIssues:[{findingIndex:1,code:"record_match_field_claim_mismatch"}]},
 ],formatFailures:[{at:"raw-format-3",codes:[malformedPath],reportRequestNumber:3,rawContentBytes:321,rawContent:"UNTRUSTED RAW RESPONSE"}]});
 const context=current.context as any;
 assert.deepEqual(context.feedback,[{codes:["record_match_field_claim_mismatch"],guidance:["Limit each local-record statement to the exact checked field and status. A field match does not establish product configuration, recall scope, clearance, or safety."],findingIssues:[{findingIndex:1,code:"record_match_field_claim_mismatch"}]}]);
 assert.deepEqual(context.feedbackTarget,{draftSha256:context.rejectedReportDraft.sha256,canonicalAttemptNumber:2,source:"latest_canonical_report_attempt"});
 assert.equal(context.formatFailures.length,1);assert.equal(context.formatFailures[0].category,"report_format_rejection");assert.equal(context.formatFailures[0].appliesToShownDraft,false);assert.equal(context.formatFailures[0].reportRequestNumber,3);assert.equal(context.formatFailures[0].rawContentBytes,321);
 const serialized=JSON.stringify(context);for(const privateValue of ["canonical-1","canonical-2","raw-format-3","OLD-2024",malformedPath,"UNTRUSTED RAW RESPONSE"])assert.equal(serialized.includes(privateValue),false);
 assert.equal(context.evidenceExcerpts.length,catalog.entries.length);assert.equal(context.recordReceipts.length,matches.length);assert.equal(current.providerControls.reasoning_effort,"low");
});

test("stale rejected references and oversized projection drafts are omitted without trimming current evidence",()=>{
 const stale={disposition:"answered" as const,summary:"Rejected stale draft.",findings:[{id:"stale-finding",kind:"observation" as const,summary:"Old quote cannot be mapped.",evidence:[{sourceId:"NOTICE",sourceHash:"c".repeat(64),quote:prior}],comparisons:[],recordChecks:[]}]};
 const stalePacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the current sources.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:stale});
 assert.deepEqual((stalePacket.context as any).rejectedReportDraft,{status:"omitted",reason:"stale_or_unbound_reference"});assert.equal((stalePacket.context as any).evidenceExcerpts.length,catalog.entries.length);assert.equal((stalePacket.context as any).recordReceipts.length,matches.length);assert.equal((stalePacket.context as any).rejectedNarrativeOmitted,true);
 const partial={...stale,findings:[{...stale.findings[0]!,evidence:[{sourceId:"ROWS",sourceHash:selected[2]!.sourceHash,quote:recordQuote.slice(0,24)}]}]};
 const partialPacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the current sources.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:partial});
 assert.deepEqual((partialPacket.context as any).rejectedReportDraft,{status:"omitted",reason:"stale_or_unbound_reference"});
 const oversize=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the current sources.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},rejectedReportDraftOmissionReason:"over_16kb"});
 assert.deepEqual((oversize.context as any).rejectedReportDraft,{status:"omitted",reason:"over_16kb"});assert.equal((oversize.context as any).evidenceExcerpts.length,catalog.entries.length);assert.equal((oversize.context as any).recordReceipts.length,matches.length);
 assert.equal(JSON.stringify(oversize.context).includes("REJECTED stale draft"),false);
});

test("optional correction draft yields to the complete evidence context budget",()=>{
 const rejected={disposition:"answered" as const,summary:"Prior correction draft retained only if it fits.",findings:[{id:"prior-finding",kind:"observation" as const,summary:"The rejected draft is not evidence.",evidence:[{sourceId:"NOTICE",sourceHash:selected[0]!.sourceHash,quote:prior}],comparisons:[],recordChecks:[{resultId:matches[0]!.resultId,field:"lot" as const,status:"match" as const}]}]};
 let candidate:ReturnType<typeof packet>|undefined,phaseTask="";
 for(let bytes=60_000;bytes<=80_000;bytes+=250){const task="P".repeat(bytes);const built=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the current sources.",phaseTask:task,selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:rejected,previousRejectedReportAttemptNumber:1});if((built.context as any).rejectedReportDraft?.reason==="context_budget"){candidate=built;phaseTask=task;break;}}
 assert.ok(candidate,"a context size should be found where the optional draft, but not the evidence packet, exceeds the cap");
 const contextBytes=new TextEncoder().encode(JSON.stringify(candidate.context)).byteLength;assert.ok(contextBytes<=80_000);assert.equal((candidate.context as any).rejectedReportDraft.reason,"context_budget");assert.equal(candidate.providerControls.reasoning_effort,"low");assert.deepEqual((candidate.context as any).feedback,[]);assert.equal(Object.hasOwn(candidate.context as any,"feedbackTarget"),false);assert.match(candidate.instruction,/Local record findings are rendered by the server, not by you/);assert.doesNotMatch(candidate.instruction,/If the draft is omitted, do not infer its contents or indexed feedback/);
 const withoutDraft=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the current sources.",phaseTask,selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 assert.ok(new TextEncoder().encode(JSON.stringify(withoutDraft.context)).byteLength<=80_000);assert.equal((candidate.context as any).evidenceExcerpts.length,catalog.entries.length);assert.equal((candidate.context as any).recordReceipts.length,matches.length);assert.equal(Object.hasOwn((candidate.context as any).requiredProofs,"requiredLocalRecordReviews"),false);assert.equal(Object.hasOwn((withoutDraft.context as any).requiredProofs,"requiredLocalRecordReviews"),false);assert.deepEqual((candidate.context as any).requiredProofs,(withoutDraft.context as any).requiredProofs);
});

test("unsupported literal feedback preserves only bounded digit-bearing identifier tokens",()=>{
 const tokens=Array.from({length:15},(_,index)=>`LOT-${String(index+1).padStart(3,"0")}`),p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the source statements.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback:[{codes:["unsupported_identifier_or_date"],findingIssues:[{findingIndex:2,code:"unsupported_identifier_or_date",unsupportedTokens:[...tokens,"rejected prose about unsupported details","NO-DIGIT-TOKEN","LONG-"+"9".repeat(110)]}],reportIssues:["unsupported_identifier_or_date"],unsupportedSummaryTokens:["2027-05-04","summary prose without a literal"]}]});
 const feedback=(p.context as any).feedback[0];assert.deepEqual(feedback.findingIssues,[{findingIndex:2,code:"unsupported_identifier_or_date",unsupportedTokens:tokens.slice(0,12)}]);assert.deepEqual(feedback.unsupportedSummaryTokens,["2027-05-04"]);
 for(const secret of ["rejected prose about unsupported details","NO-DIGIT-TOKEN","summary prose without a literal","LONG-"])assert.equal(JSON.stringify(p.context).includes(secret),false);
});

test("sanitized feedback allowlists the complete current domain-code vocabulary only",()=>{
 const codes=[...INVESTIGATION_DOMAIN_FEEDBACK_CODES];
 const chunks=Array.from({length:Math.ceil(codes.length/20)},(_,index)=>codes.slice(index*20,(index+1)*20));
 const packets=chunks.map(codes=>buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare the documentary notices and check the explicit lot records.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback:[{codes}]}));
 const feedback=packets.map(p=>(p.context as any).feedback as Array<{codes:string[];guidance?:string[]}>);assert.deepEqual(feedback.map(items=>items[0]?.codes),chunks);assert.ok(feedback.some(items=>items.some(item=>item.codes.includes("documentary_action_requires_notice_quote")&&item.guidance?.[0]?.includes("actual notice excerpt"))));
});

test("finding diagnostics preserve more than 24 safe finding locators through both packet sanitizers",()=>{
 const codes=[...INVESTIGATION_DOMAIN_FEEDBACK_CODES].slice(0,6),findingIssues=Array.from({length:6},(_,findingIndex)=>codes.map(code=>({findingIndex,code}))).flat();assert.ok(findingIssues.length>30);
 const p=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Review the findings.",selected,catalog,recordMatches:matches,comparisonRequirements:{noticeComparison:true,recordMatching:true},previousRejectedReport:feedbackDraft,previousRejectedReportAttemptNumber:1,feedback:[{codes:[],findingIssues}]});
 const preserved=(p.context as any).feedback[0].findingIssues;assert.equal(preserved.length,findingIssues.length);assert.deepEqual(preserved,findingIssues);
});

test("model cannot supply backend receipt provenance and unselected results never become finding refs",()=>{
 const p=packet(),wire=validWire(p);assert.equal(wire.documentFindings[0]!.recordCheckRefs.length,1);assert.equal(wire.documentFindings[0]!.recordCheckRefs[0],aliases(p).result(0));
 const tampered={...wire,recordCitationMode:"atomic_receipts_v1"};assert.throws(()=>bindInvestigationReceiptPacket(JSON.stringify(tampered),p,runId,snapshotHash,selected,catalog,matches));
 const noRefs=structuredClone(wire);noRefs.documentFindings[0]!.recordCheckRefs=[];const bound=bindInvestigationReceiptPacket(JSON.stringify(noRefs),p,runId,snapshotHash,selected,catalog,matches);const normalized=JSON.parse(bound.argumentsText);assert.deepEqual(normalized.recordReceiptIds,matches.map(match=>match.resultId));assert.deepEqual(normalized.findings[0].recordChecks,[]);assert.deepEqual(bound.receiptAudit.serverResolvedProofAssets,[]);assert.deepEqual(bound.receiptAudit.modelSelectedDocumentaryCitations[0]!.quoteIds,[...new Set(noRefs.documentFindings[0]!.evidence.map((item:any)=>item.quoteId))]);
});

test("cross-run, changed-source, and hard-cap inputs fail before they can bind",()=>{
 const p=packet(),wire=validWire(p),raw=JSON.stringify(wire);
 assert.throws(()=>bindInvestigationReceiptPacket(raw,p,"5b1e9e36-7a4c-4e2e-941c-a389470f3c63",snapshotHash,selected,catalog,matches),/stale for this run/);
 assert.throws(()=>bindInvestigationReceiptPacket(raw,p,runId,"c".repeat(64),selected,catalog,matches),/stale for this run/);
 const changedSources=structuredClone(selected);changedSources[0]!.content+=" Added text.";
 assert.throws(()=>bindInvestigationReceiptPacket(raw,p,runId,snapshotHash,changedSources,catalog,matches));
 assert.throws(()=>bindInvestigationReceiptPacket(" ".repeat(48_001),p,runId,snapshotHash,selected,catalog,matches),/48KB wire limit/);

 const manyContent=Array.from({length:10},(_,index)=>`Exact distinct source sentence ${index+1} for a bounded test.`).join("\n\n");
 const manySource=entry("MANY","record",manyContent),manyCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[manySource],maxBytes:80_000,coalesce:false});
 assert.ok(manyCatalog.entries.length>=9);
 const proofText=manyCatalog.entries[0]!.text;
 const manyMatches=Array.from({length:24},(_,index)=>{const body={...matches[0]!,recordId:`ROW-${index+1}`,evidence:[{sourceId:manySource.id,sourceHash:manySource.sourceHash,quote:proofText}]};delete (body as any).resultId;return {...body,resultId:sha(JSON.stringify(body))} as BoundRecordMatch;});
 const manyPacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Summarize these exact excerpts.",selected:[manySource],catalog:manyCatalog,recordMatches:manyMatches,comparisonRequirements:{noticeComparison:false,recordMatching:true}});
 const manyIds=[...manyPacket.privateBinding.aliasMaps.quoteOrdinalToProvider.keys()],manyR=[...manyPacket.privateBinding.aliasMaps.resultOrdinalToProvider.keys()];
 const atCaps={packetId:manyPacket.packetId,nextStep:"answer_document_question",summary:"The selected source states the cited facts.",documentFindings:[{kind:"observation",summary:"The selected source states the cited facts.",evidence:manyIds.slice(0,8).map(quoteId=>({quoteId})),comparisons:[],recordCheckRefs:manyR}]};
 const atCapBound=bindInvestigationReceiptPacket(JSON.stringify(atCaps),manyPacket,runId,snapshotHash,[manySource],manyCatalog,manyMatches);assert.equal(JSON.parse(atCapBound.argumentsText).findings[0].evidence.length,8);assert.equal(JSON.parse(atCapBound.argumentsText).findings[0].recordChecks.length,24);
 const mixedSelected=[selected[0]!,selected[1]!,manySource],mixedCatalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:mixedSelected,maxBytes:80_000,coalesce:false,supportQuotes:manyMatches.flatMap(match=>match.evidence)}),mixedPacket=buildInvestigationReceiptPacket({runId,snapshotHash,question:"Compare notices and check the local records.",selected:mixedSelected,catalog:mixedCatalog,recordMatches:manyMatches,comparisonRequirements:{noticeComparison:true,recordMatching:true}});
 const mixedExcerpts=(mixedPacket.context as any).evidenceExcerpts as Array<{quoteId:string;text:string;sourceRef:string}>;const mixedNotices=[mixedExcerpts.find(item=>item.sourceRef==="SRC1")!,mixedExcerpts.find(item=>item.sourceRef==="SRC2")!],mixedRows=mixedExcerpts.filter(item=>item.sourceRef==="SRC3");
 const mixedWire={packetId:mixedPacket.packetId,nextStep:"answer_document_question",summary:"The selected notices and checked rows are recorded.",documentFindings:[{kind:"observation",summary:"The quoted records and notices support this bounded comparison.",evidence:[...mixedRows.slice(0,5),...mixedNotices.slice(0,2)].map(item=>({quoteId:item.quoteId})),comparisons:[{beforeQuoteId:mixedNotices[0]!.quoteId,afterQuoteId:mixedNotices[1]!.quoteId}],recordCheckRefs:[...mixedPacket.privateBinding.aliasMaps.resultOrdinalToProvider.keys()]}]};
 const mixedBound=bindInvestigationReceiptPacket(JSON.stringify(mixedWire),mixedPacket,runId,snapshotHash,mixedSelected,mixedCatalog,manyMatches);assert.equal(JSON.parse(mixedBound.argumentsText).findings[0].evidence.length,7);assert.equal(JSON.parse(mixedBound.argumentsText).findings[0].recordChecks.length,24);
 const overUnion={...mixedWire,documentFindings:[{...mixedWire.documentFindings[0]!,evidence:mixedRows.slice(0,7).map(item=>({quoteId:item.quoteId})),comparisons:[{beforeQuoteId:mixedNotices[0]!.quoteId,afterQuoteId:mixedNotices[1]!.quoteId}],recordCheckRefs:[]}]};
 let unionError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(overUnion),mixedPacket,runId,snapshotHash,mixedSelected,mixedCatalog,manyMatches);}catch(error){unionError=error;}assert.ok(unionError instanceof ReportFormatDiagnosticError);assert.ok(reportFormatDiagnosticCodes(unionError).includes("REPORT_documentFindings_0_evidence_MAX_8"));
 const overQuotes=structuredClone(atCaps);overQuotes.documentFindings[0].evidence.push({quoteId:manyIds[8]!});
 let quoteError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(overQuotes),manyPacket,runId,snapshotHash,[manySource],manyCatalog,manyMatches);}catch(error){quoteError=error;}
 assert.ok(quoteError instanceof ReportFormatDiagnosticError);assert.ok(reportFormatDiagnosticCodes(quoteError).includes("REPORT_documentFindings_0_evidence_MAX_8"));
 const overResults=structuredClone(wire);overResults.documentFindings[0]!.recordCheckRefs=Array.from({length:25},()=>aliases(p).result(0));
 let resultError:unknown;try{bindInvestigationReceiptPacket(JSON.stringify(overResults),p,runId,snapshotHash,selected,catalog,matches);}catch(error){resultError=error;}
 assert.ok(resultError instanceof ReportFormatDiagnosticError);assert.ok(reportFormatDiagnosticCodes(resultError).includes("REPORT_documentFindings_0_recordCheckRefs_MAX_24"));
});
