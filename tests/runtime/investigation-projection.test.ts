import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type { EvidenceEntry, EvidenceRegistry, InvestigationRecord, InvestigationReportInput } from "../../src/shared/investigation.ts";
import type {BoundOperationalRead} from "../../src/shared/workspace.ts";
import {DOCUMENTARY_PHASE_TASK} from "../../src/runtime/investigation-prompt.ts";
import { projectInvestigationContext } from "../../src/runtime/investigation-projection.ts";
import type { investigationWork } from "../../src/runtime/investigation-readiness.ts";

const RUN = "run-projection-1";
const SNAPSHOT = "snapshot-projection-1";

function entry(id: string, content: string): EvidenceEntry {
  return {
    id, title: `Title ${id}`, kind: "notice", authority: "fictional-record",
    sourceURL: `urn:test:${id}`, version: 3, retrievedAt: "2026-10-23T00:00:00.000Z",
    content, refs: [`alias:${id}`], sourceHash: `hash:${id}`, snapshotHash: SNAPSHOT,
    support: `Stored record ${id}`,
  };
}

function report(summary: string): InvestigationReportInput {
  return { disposition: "answered", summary, findings: [] };
}

function operationalRead(key: BoundOperationalRead["key"], result: unknown): BoundOperationalRead {
  const encoded = JSON.stringify(result);
  if (encoded === undefined) throw new Error("Fixture result must be JSON serializable.");
  const tool = key === "constraints" ? "fetch_constraints" : "investigate_stock";
  const args: BoundOperationalRead["args"] = key === "constraints" ? {} : {siteId:key === "stock:all" ? null : key.slice("stock:".length) as "A" | "B" | "C"};
  return {key, tool, runId:RUN, snapshotHash:SNAPSHOT, args, at:"2026-10-23T00:00:00.000Z", bytes:Buffer.byteLength(encoded), resultHash:createHash("sha256").update(encoded).digest("hex"), result};
}

function setup(entries: EvidenceEntry[], changes: Partial<InvestigationRecord> = {}) {
  const investigation: InvestigationRecord = {
    runId: RUN, snapshotHash: SNAPSHOT,
    selections: [{ sourceId: "DOC-1", sourceHash: "hash:DOC-1", reason: "Read this notice", at: "2026-10-23T00:00:00.000Z" }],
    findings: [], reportAttempts: [], feedback: [], disposition: null, summary: "", ...changes,
  };
  const registry: EvidenceRegistry = { snapshotHash: SNAPSHOT, entries };
  return { investigation, registry };
}

test("projection binds exact question, run and snapshot and includes only selected canonical source bodies", () => {
  const source = entry("DOC-1", "The selected document records shipment status as pending.");
  const unselected = entry("DOC-2", "UNSELECTED_PRIVATE_BODY: expected conflict answer must not leak.");
  const operational = entry("ROW-1", "UNSELECTED_OPERATIONAL_BODY: exact quantity and status.");
  const { registry, investigation } = setup([source, unselected, operational]);
  const input = {
    runId: RUN, question: "What does the inspected notice say?", snapshotHash: SNAPSHOT,
    registry, investigation, operationalRecordIds: ["ROW-1"], requestsUsed: 1, reportOnly: false,
  };
  const before = JSON.stringify(input);
  const projection = projectInvestigationContext(input);
  assert.deepEqual(projectInvestigationContext(input), projection);
  assert.equal(JSON.stringify(input), before);
  assert.equal(projection.context.runId, RUN);
  assert.equal(projection.context.question, input.question);
  assert.equal(projection.context.phaseTask,DOCUMENTARY_PHASE_TASK);
  assert.equal("targetIdentity" in projection.context,false,"Pure projection fixtures without pinned metadata must not invent identity fields.");
  assert.equal(projection.context.snapshotHash, SNAPSHOT);
  assert.deepEqual(projection.context.selected, [source]);
  assert.equal(projection.context.indexComplete, true);
  assert.equal(projection.context.inspectionRequired, false);
  assert.equal(projection.context.sourceIndex.some((item) => item.id === "DOC-2"), true);
  assert.deepEqual(projection.context.operationalRecords.map((item) => item.id), ["ROW-1"]);
  assert.equal(projection.context.operationalRecordsAvailable, true);
  assert.equal(projection.context.operationalRecordCount, 1);
  assert.equal("content" in projection.context.sourceIndex[0]!, false);
  const serialized = JSON.stringify(projection.context);
  assert.equal(serialized.includes("UNSELECTED_PRIVATE_BODY"), false);
  assert.equal(serialized.includes("UNSELECTED_OPERATIONAL_BODY"), false);
  assert.match(projection.instruction, /Never invent a quote for an unread operational row/);assert.match(projection.instruction,/Keep context.question as the exact user task/);assert.match(projection.instruction,/nonmatching lot is only not listed in this recall, not generally safe/);assert.match(projection.instruction,/cannot establish current QA/);assert.match(projection.instruction,/Historical memory and tool observations are advisory/);
});

test("report attempt prose stays private while bounded audit metadata and feedback remain visible", () => {
  const { registry, investigation } = setup([entry("DOC-1", "Exact selected source body.")], {
    reportAttempts: [report("oldest"), report("rejected attempt with fabricated quote"), report("latest attempt")],
    feedback: [
      { at: "2026-10-20T00:00:00.000Z", codes: ["old_feedback"] },
      { at: "2026-10-21T00:00:00.000Z", codes: ["quote_not_found"] },
      { at: "2026-10-22T00:00:00.000Z", codes: ["stale_hash"] },
    ],
  });
  const projection = projectInvestigationContext({
    runId: RUN, question: "Read this source.", snapshotHash: SNAPSHOT,
    registry, investigation, requestsUsed: 4, reportOnly: true,
  });
  assert.deepEqual(projection.context.reportAttempts?.map((attempt) => attempt.attemptIndex), [2, 3]);
  assert.deepEqual(projection.context.reportAttempts?.map((attempt) => attempt.disposition), ["answered", "answered"]);
  assert.deepEqual(projection.context.reportAttempts?.map((attempt) => attempt.findingCount), [0, 0]);
  assert.ok(projection.context.reportAttempts?.every((attempt) => /^[a-f0-9]{64}$/.test(attempt.sha256) && attempt.bytes > 0 && attempt.provenance === "legacy_report"));
  assert.deepEqual(projection.context.feedback.map((item) => item.codes[0]), ["quote_not_found", "stale_hash"]);
  assert.equal(projection.context.reportAttemptsAreAuditOnly, true);
  assert.equal(JSON.stringify(projection.context).includes("rejected attempt with fabricated quote"),false);
  assert.equal(JSON.stringify(projection.context).includes("FABRICATED_TEXT_NOT_IN_SOURCE"),false);
  assert.equal(projection.context.feedbackAreAuditOnly, true);
  assert.equal("findings" in projection.context, false);
  assert.match(projection.instruction, /Prior attempts and feedback are audit data/);
  assert.match(projection.instruction, /DOCUMENTARY REPORT/);
});

test("only the latest rejected report is exposed privately for alias-bound correction",()=>{
 const source=entry("DOC-1","The selected document states that the shipment remains on hold.");
 const prior:InvestigationReportInput={disposition:"answered",summary:"REJECTED SUMMARY MUST NOT ENTER PRELIMINARY CONTEXT.",findings:[{id:"finding-old",kind:"observation",summary:"REJECTED FINDING MUST REMAIN UNTRUSTED.",evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:"The selected document states that the shipment remains on hold."}]}]};
 const {registry,investigation}=setup([source],{reportAttempts:[{...prior,summary:"OLDER ATTEMPT MUST NOT BE USED."},prior],feedback:[{at:"2026-10-27T00:00:00.000Z",codes:["unsupported_identifier_or_date"]}]});
 const projection=projectInvestigationContext({runId:RUN,question:"Review the selected document.",snapshotHash:SNAPSHOT,registry,investigation,requestsUsed:4,reportOnly:true});
 assert.deepEqual(projection.privateRejectedReportDraft?.report,prior);assert.equal(projection.privateRejectedReportDraft?.omissionReason,undefined);
 const modelContext=JSON.stringify(projection.context);assert.equal(modelContext.includes("REJECTED SUMMARY MUST NOT ENTER PRELIMINARY CONTEXT"),false);assert.equal(modelContext.includes("REJECTED FINDING MUST REMAIN UNTRUSTED"),false);assert.equal(modelContext.includes("OLDER ATTEMPT MUST NOT BE USED"),false);
 const first=projectInvestigationContext({runId:RUN,question:"Review the selected document.",snapshotHash:SNAPSHOT,registry,investigation:{...investigation,feedback:[]},requestsUsed:4,reportOnly:true});assert.equal(first.privateRejectedReportDraft,undefined);
 const huge:InvestigationReportInput={...prior,summary:"x".repeat(130_000)};
 const omitted=projectInvestigationContext({runId:RUN,question:"Review the selected document.",snapshotHash:SNAPSHOT,registry,investigation:{...investigation,reportAttempts:[huge]},requestsUsed:4,reportOnly:true});
 assert.deepEqual(omitted.privateRejectedReportDraft,{canonicalAttemptNumber:1,omissionReason:"over_16kb"});assert.equal(JSON.stringify(omitted.context).includes("x".repeat(100)),false);assert.equal(omitted.context.selected[0]!.content,source.content);
});

test("private correction feedback excludes raw-format events and binds only the latest canonical attempt",()=>{
 const source=entry("DOC-1","The selected document remains fully available.");
 const raw="PRIVATE_RAW_REPORT_BODY_XYZ";
 const formatFailure={runId:RUN,snapshotHash:SNAPSHOT,requestNumber:5,reportRequestNumber:2,at:"format-2",codes:["REPORT_documentFindings_1_evidence_MAX_8"],rawContent:raw,rawContentHash:createHash("sha256").update(raw,"utf8").digest("hex"),rawContentBytes:Buffer.byteLength(raw),rawContentRetainedBytes:Buffer.byteLength(raw),rawContentTruncated:false};
 const {registry,investigation}=setup([source],{
  reportAttempts:[report("canonical one"),report("canonical two")],
  feedback:[{at:"domain-1",codes:["quote_not_found"]},{at:"domain-2",codes:["record_match_field_claim_mismatch"],findingIssues:[{findingIndex:1,code:"record_match_field_claim_mismatch"}]},{at:"format-2",codes:formatFailure.codes}],
  formatFailures:[formatFailure],
 });
 const projection=projectInvestigationContext({runId:RUN,question:"Review this source.",snapshotHash:SNAPSHOT,registry,investigation,requestsUsed:5,reportOnly:true});
 assert.equal(projection.privateRejectedReportDraft?.canonicalAttemptNumber,2);
 assert.deepEqual(projection.privateLatestCanonicalReportFeedback,{at:"domain-2",codes:["record_match_field_claim_mismatch"],findingIssues:[{findingIndex:1,code:"record_match_field_claim_mismatch"}]});
 assert.equal(JSON.stringify(projection).includes(raw),false);
});

test("large rejected report attempts project to compact metadata without truncating current evidence", () => {
  const source=entry("DOC-1","The exact current selected source remains fully available after report-attempt compaction.");
  const largeAttempt=(label:string):InvestigationReportInput=>({disposition:"answered",summary:`${label} ${"S".repeat(9_000)}`,findings:Array.from({length:6},(_,index)=>({id:`${label}-${index}`,kind:"observation" as const,summary:`${"F".repeat(2_000)}`,evidence:[{sourceId:source.id,sourceHash:source.sourceHash,quote:`${label}-PRIVATE-QUOTE-${index}-${"Q".repeat(4_000)}`}]}))});
  const attempts=[largeAttempt("ATTEMPT-A"),largeAttempt("ATTEMPT-B")],attemptBytes=attempts.reduce((sum,attempt)=>sum+Buffer.byteLength(JSON.stringify(attempt)),0);
  assert.ok(attemptBytes>79_000);
  const {registry,investigation}=setup([source],{reportAttempts:attempts});
  const projection=projectInvestigationContext({runId:RUN,question:"Check the selected source.",snapshotHash:SNAPSHOT,registry,investigation,requestsUsed:4,reportOnly:true});
  const contextText=JSON.stringify(projection.context);
  assert.ok(Buffer.byteLength(contextText,"utf8")<80_000);
  assert.equal(projection.context.selected[0]!.content,source.content);
  assert.deepEqual(projection.context.reportAttempts?.map(attempt=>attempt.bytes),attempts.map(attempt=>Buffer.byteLength(JSON.stringify(attempt))));
  assert.deepEqual(projection.context.reportAttempts?.map(attempt=>attempt.findingCount),[6,6]);
  assert.equal(contextText.includes("ATTEMPT-A-PRIVATE-QUOTE"),false);
  assert.equal(contextText.includes("ATTEMPT-B-PRIVATE-QUOTE"),false);
  assert.equal(projection.context.reportAttemptsAreAuditOnly,true);
});

test("complete index avoids rediscovery and still requires a real evidence inspection before reporting", () => {
  const entries = Array.from({ length: 61 }, (_, index) => entry(`DOC-${index + 1}`, `Source body ${index + 1}.`));
  const { registry, investigation } = setup(entries, { selections: [] });
  const listResult = {
    query: "notice scope", snapshotHash: SNAPSHOT,
    entries: [{ id: "DOC-1", title: "Title DOC-1", kind: "notice", authority: "fictional-record", alreadyInspected: false }],
    quotedDataOnly: true,
  };
  const listObservation = { tool: "list_evidence", at: "2026-10-23T00:00:00.000Z", snapshotHash: SNAPSHOT, bytes: new TextEncoder().encode(JSON.stringify(listResult)).byteLength, result: listResult };
  const complete = projectInvestigationContext({
    runId: RUN, question: "What does the document say?", snapshotHash: SNAPSHOT,
    registry: { ...registry, entries: entries.slice(0, 60) }, investigation, observations: [listObservation], requestsUsed: 1, reportOnly: false,
  });
  assert.equal(complete.context.indexComplete, true);
  assert.equal(complete.context.indexOmittedCount, 0);
  assert.equal(complete.context.inspectionRequired, true);
  assert.deepEqual(complete.context.observations[0]!.result, listResult);
  assert.match(complete.instruction, /complete metadata index is already supplied/);
  assert.match(complete.instruction, /do not call list_evidence to rediscover it/);
  assert.match(complete.instruction, /Call inspect_evidence with an actual source ID and reason before any report/);

  const partial = projectInvestigationContext({
    runId: RUN, question: "What does the document say?", snapshotHash: SNAPSHOT,
    registry, investigation, requestsUsed: 1, reportOnly: false,
  });
  assert.equal(partial.context.indexComplete, false);
  assert.equal(partial.context.indexOmittedCount, 1);
  assert.equal(partial.context.inspectionRequired, true);
  assert.match(partial.instruction, /metadata index is partial/);
  assert.match(partial.instruction, /bounded list_evidence query/);
});

test("an inspected selection with a mismatched bound hash is unresolved, never substituted", () => {
  const { registry, investigation } = setup([entry("DOC-1", "Current-version body.")], {
    selections: [{ sourceId: "DOC-1", sourceHash: "older-hash", reason: "Earlier version", at: "2026-10-23T00:00:00.000Z" }],
  });
  const projection = projectInvestigationContext({
    runId: RUN, question: "Question", snapshotHash: SNAPSHOT, registry, investigation, requestsUsed: 0, reportOnly: false,
  });
  assert.deepEqual(projection.context.selected, []);
  assert.deepEqual(projection.context.unresolvedSelections, [{ sourceId: "DOC-1", sourceHash: "older-hash", reason: "bound_source_unavailable" }]);
});

test("source bodies are never clipped to meet the total context budget", () => {
  const oversized = entry("DOC-1", "EXACT_BODY_START" + "x".repeat(50_000) + "EXACT_BODY_END");
  const { registry, investigation } = setup([oversized]);
  const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
  oversized.sourceHash=createHash("sha256").update(oversized.content).digest("hex");oversized.snapshotHash=snapshotHash;
  registry.snapshotHash=snapshotHash;investigation.runId=runId;investigation.snapshotHash=snapshotHash;investigation.selections[0]!.sourceHash=oversized.sourceHash;
  const projection = projectInvestigationContext({
    runId, question: "Question", snapshotHash, registry, investigation, requestsUsed: 0, reportOnly: false,
  });
  assert.deepEqual(projection.context.selected, []);
  assert.equal(projection.canonicalSelected?.[0]?.content,oversized.content);
  assert.deepEqual(projection.context.selectedSourceExcerpts,[]);
  assert.deepEqual(projection.context.omittedSelected, [{ sourceId: "DOC-1", sourceHash: oversized.sourceHash, reason: "context_budget" }]);
  assert.equal(JSON.stringify(projection.context).includes("EXACT_BODY_START"), false);
  assert.ok(new TextEncoder().encode(JSON.stringify(projection.context)).byteLength <= 40_000);
  assert.match(projection.instruction, /ask_operator_for_new_evidence requests a genuinely unavailable artifact\/status/);
  assert.doesNotMatch(projection.instruction, /inspect them again before quoting/);
});

test("large trusted retrieval and catalog stay server-side while model metadata stays bounded", () => {
  const {registry,investigation}=setup([entry("DOC-1","Selected source.")]);
  const sections=Array.from({length:100},(_,index)=>({sectionId:`section-${index}`,sourceId:"DOC-1",sourceHash:"a".repeat(64),start:index*1000,end:(index+1)*1000,text:`EXACT_SECTION_${index}_`+"x".repeat(980)}));
  const readiness={stage:"retrieve",reportReady:false,requiredSourceIds:["DOC-1"],pendingSourceIds:[],pendingSectionIds:sections.map(section=>section.sectionId),requiredSectionIds:sections.map(section=>section.sectionId),unavailableSections:[],unmatchedRecordRefs:[],unmatchedRecordChecks:[],unsupportedRecordChecks:[],matchingRequired:false,matchingSupport:"not_requested",incompleteWorkIsNotMissingEvidence:true} as const;
  const recordCatalog={runId:RUN,snapshotHash:SNAPSHOT,criteria:[],criterionSections:[],records:[{recordRef:"record-ref",quote:"RAW_RECORD_QUOTE_"+"z".repeat(90_000)}]} as any;
  const work={readiness,sections,recordCatalog} as unknown as ReturnType<typeof investigationWork>;
  const projection=projectInvestigationContext({runId:RUN,question:"Compare all retrieved sections.",snapshotHash:SNAPSHOT,registry,investigation,work,requestsUsed:2,reportOnly:false});
  const contextText=JSON.stringify(projection.context);
  assert.ok(Buffer.byteLength(contextText,"utf8")<80_000);
  assert.equal(contextText.includes("EXACT_SECTION_0_"),false);
  assert.equal(contextText.includes("RAW_RECORD_QUOTE_"),false);
  assert.equal(projection.work?.sections.length,100);
  assert.equal(projection.work?.sections[0]?.text,sections[0]?.text);
  assert.equal(projection.work?.recordCatalog.records[0]?.quote,recordCatalog.records[0].quote);
  assert.equal(projection.context.work?.pendingSections.length,100);
  assert.equal("retrievedSections" in projection.context.work!,false);
  assert.equal("recordCatalog" in projection.context.work!,false);
});

test("history is advisory and absent history gets a neutral default; binding mismatches fail closed", () => {
  const { registry, investigation } = setup([entry("DOC-1", "Exact source.")]);
  const projection = projectInvestigationContext({
    runId: RUN, question: "Question", snapshotHash: SNAPSHOT, registry, investigation, requestsUsed: 0, reportOnly: false,
  });
  assert.deepEqual(projection.context.history, {
    decisions: [], nextInvestigationQuestion: "No applicable prior resolution; inspect current sources.",
    advisoryOnly: true, omittedDecisionCount: 0,
  });
  assert.throws(() => projectInvestigationContext({
    runId: RUN, question: "Question", snapshotHash: "wrong-snapshot", registry, investigation, requestsUsed: 0, reportOnly: false,
  }), /bindings must match exactly/);
});

test("last two run-only what-if and memory observations preserve exact results as advisory data", () => {
  const { registry, investigation } = setup([entry("DOC-1", "Exact source body.")]);
  const whatIfResult = { label: "HYPOTHETICAL", baseline: { shortfallEa: 10 }, hypothesis: { shortfallEa: 0 }, cannotApprove: true };
  const memoryResult = { nextInvestigationQuestion: "Read the current physical label.", decisions: [{ status: "applied", reason: "Reviewed the stored document." }] };
  const observations = [
    { tool: "old_tool", at: "2026-10-21T00:00:00.000Z", snapshotHash: SNAPSHOT, bytes: 3, result: { old: true } },
    { tool: "what_if", at: "2026-10-22T00:00:00.000Z", snapshotHash: SNAPSHOT, bytes: new TextEncoder().encode(JSON.stringify(whatIfResult)).byteLength, result: whatIfResult },
    { tool: "recall_history", at: "2026-10-23T00:00:00.000Z", snapshotHash: SNAPSHOT, bytes: new TextEncoder().encode(JSON.stringify(memoryResult)).byteLength, result: memoryResult },
  ];
  const projection = projectInvestigationContext({
    runId: RUN, question: "Compare current evidence with the saved memory.", snapshotHash: SNAPSHOT,
    registry, investigation, observations, observationOmittedCount: 4, requestsUsed: 1, reportOnly: false,
  });
  assert.deepEqual(projection.context.observations, observations.slice(1).map(observation=>({...observation,resultHash:createHash("sha256").update(JSON.stringify(observation.result),"utf8").digest("hex")})));
  assert.equal(projection.context.observationOmittedCount, 5);
  assert.equal(projection.context.observationsAreAdvisory, true);
  assert.match(projection.instruction, /HYPOTHETICAL what-if result cannot approve or reserve anything/);
  assert.match(projection.instruction, /not current authority/);
});

test("observation results that do not fit are explicitly omitted without clipping", () => {
  const source = entry("DOC-1", "SOURCE_START" + "s".repeat(33_000) + "SOURCE_END");
  const { registry, investigation } = setup([source]);
  const result = { marker: "OBSERVATION_START", detail: "o".repeat(7_500), end: "OBSERVATION_END" };
  const projection = projectInvestigationContext({
    runId: RUN, question: "Read exact source and observation.", snapshotHash: SNAPSHOT,
    registry, investigation,
    observations: [{ tool: "what_if", at: "2026-10-23T00:00:00.000Z", snapshotHash: SNAPSHOT, bytes: new TextEncoder().encode(JSON.stringify(result)).byteLength, result }],
    requestsUsed: 1, reportOnly: false,
  });
  assert.deepEqual(projection.context.selected, [source]);
  assert.deepEqual(projection.context.observations, [{
    tool: "what_if", at: "2026-10-23T00:00:00.000Z", snapshotHash: SNAPSHOT,
    bytes: new TextEncoder().encode(JSON.stringify(result)).byteLength, omitted: true, reason: "context_budget",
  }]);
  assert.equal(JSON.stringify(projection.context).includes("OBSERVATION_START"), false);
  assert.equal(JSON.stringify(projection.context).includes("OBSERVATION_END"), false);
  assert.equal(JSON.stringify(projection.context).includes("SOURCE_START"), true);
  assert.ok(new TextEncoder().encode(JSON.stringify(projection.context)).byteLength <= 40_000);
});

test("history carries an earlier omitted-decision count from bounded persisted state", () => {
  const { registry, investigation } = setup([entry("DOC-1", "Exact source.")]);
  const projection = projectInvestigationContext({
    runId: RUN, question: "Question", snapshotHash: SNAPSHOT, registry, investigation,
    history: { decisions: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], nextInvestigationQuestion: "Inspect the label.", omittedDecisionCount: 9 },
    requestsUsed: 0, reportOnly: false,
  });
  assert.equal(projection.context.history.decisions.length, 3);
  assert.equal(projection.context.history.omittedDecisionCount, 10);
});


test("operational availability is counted from current indexed metadata without exposing unread bodies", () => {
  const source = entry("DOC-1", "Bound documentary scope.");
  const operational = Array.from({length: 3}, (_, index) => entry(`OPS-${index}`, `UNREAD_OPERATIONAL_${index}`));
  const {registry, investigation} = setup([source, ...operational]);
  const projection = projectInvestigationContext({runId:RUN, question:"Calculate replenishment after reviewing the notice.", snapshotHash:SNAPSHOT, registry, investigation, operationalRecordIds:["OPS-0", "OPS-1", "OPS-2", "ABSENT"], requestsUsed:3, reportOnly:true});
  assert.equal(projection.context.operationalRecordsAvailable, true);
  assert.equal(projection.context.operationalRecordCount, 3);
  assert.equal(JSON.stringify(projection.context).includes("UNREAD_OPERATIONAL_"), false);
  assert.match(projection.instruction, /Successful phase-omitted reads are not missing evidence/);
  assert.match(projection.instruction, /Evidence-only comparison, receipt status, and eligibility do not require planning/);
  assert.match(projection.instruction, /The server binds source, hash, exact text, run, and finding ID/);
  assert.doesNotMatch(projection.instruction, /copying the exact selected sourceHash|copy.*runId/);
  const absent = projectInvestigationContext({runId:RUN, question:"Read the notice.", snapshotHash:SNAPSHOT, registry, investigation, operationalRecordIds:["ABSENT"], requestsUsed:0, reportOnly:false});
  assert.equal(absent.context.operationalRecordsAvailable, false);
  assert.equal(absent.context.operationalRecordCount, 0);
});

test("compact instructions retain every selected source body within the existing context budget", () => {
  const entries = Array.from({length:5}, (_, index) => entry(`DOC-${index+1}`, `EXACT_SELECTED_BODY_${index}: record wording.`));
  const {registry, investigation} = setup(entries, {selections:entries.map(source=>({sourceId:source.id, sourceHash:source.sourceHash, reason:"Read relevant evidence.", at:"2026-10-23T00:00:00.000Z"}))});
  const projection = projectInvestigationContext({runId:RUN, question:"Compare all inspected records.", snapshotHash:SNAPSHOT, registry, investigation, requestsUsed:3, reportOnly:true});
  assert.deepEqual(projection.context.selected, entries);
  assert.deepEqual(projection.context.omittedSelected, []);
  assert.ok(Buffer.byteLength(projection.instruction) < 5_000);
  assert.doesNotMatch(projection.instruction, /complete metadata index is already supplied|bounded list_evidence query/);
});

test("bound operational read results stay separate from selected documentary evidence", () => {
  const source = entry("DOC-1", "Exact selected documentary wording.");
  const read = operationalRead("constraints", {targetSku:"SKU-1", demands:[{id:"D-1",quantityEa:12}]});
  const {registry, investigation} = setup([source]);
  const projection = projectInvestigationContext({runId:RUN,question:"Can demand be covered?",snapshotHash:SNAPSHOT,registry,investigation,operationalReads:[read],operationalReadsAllowed:true,requestsUsed:1,reportOnly:false});
  assert.equal(projection.context.operationalReadsAllowed,true);
  assert.deepEqual(projection.context.operationalReads,[read]);
  assert.deepEqual(projection.context.operationalReadOmissions,[]);
  assert.deepEqual(projection.context.selected,[source]);
  assert.equal(projection.context.operationalReadsAreBound,true);
  assert.match(projection.instruction,/not evidence documents or citations/);
  assert.match(projection.instruction,/never repeat a completed key/);
  assert.equal(JSON.stringify(projection.context.observations).includes("SKU-1"),false);
});

test("operational read projection rejects stale or altered bindings and preserves selected sources under the context cap", () => {
  const source = entry("DOC-1", "D".repeat(27_000));
  const read = operationalRead("stock:all", {inventory:"R".repeat(12_000)});
  const {registry, investigation} = setup([source]);
  const input = {runId:RUN,question:"Compare the evidence.",snapshotHash:SNAPSHOT,registry,investigation,operationalReads:[read],operationalReadsAllowed:true,requestsUsed:1,reportOnly:false};
  const projection = projectInvestigationContext(input);
  assert.deepEqual(projection.context.selected,[source]);
  assert.deepEqual(projection.context.operationalReads,[]);
  assert.deepEqual(projection.context.operationalReadOmissions,[{key:"stock:all",tool:"investigate_stock",runId:RUN,snapshotHash:SNAPSHOT,args:{siteId:null},at:read.at,bytes:read.bytes,resultHash:read.resultHash,reason:"context_budget"}]);
  assert.equal(JSON.stringify(projection.context).includes("R".repeat(100)),false);
  assert.throws(()=>projectInvestigationContext({...input,operationalReads:[{...read,snapshotHash:"stale"}]}),/invalid or stale/);
  assert.throws(()=>projectInvestigationContext({...input,operationalReads:[{...read,resultHash:"0".repeat(64)}]}),/does not match its stored size or hash/);
  assert.throws(()=>projectInvestigationContext({...input,operationalReads:[{...read,bytes:read.bytes+1}]}),/does not match its stored size or hash/);
});

test("report-only projection phase-omits successful what-if and operational bodies but retains other observations and explicit failure omissions",()=>{
 const source=entry("DOC-1","Selected source wording.");const raw="bad report ".repeat(4_500),retained=raw.slice(0,48_000);const rawHash=createHash("sha256").update(raw,"utf8").digest("hex");
 const {registry,investigation}=setup([source],{reportRequest:{runId:RUN,snapshotHash:SNAPSHOT,reason:"Sources answer the user.",at:"2026-10-23T00:00:00.000Z"},formatFailures:[{runId:RUN,snapshotHash:SNAPSHOT,requestNumber:4,reportRequestNumber:1,at:"2026-10-23T00:00:00.000Z",codes:["invalid_report_shape"],rawContent:retained,rawContentHash:rawHash,rawContentBytes:Buffer.byteLength(raw),rawContentRetainedBytes:Buffer.byteLength(retained),rawContentTruncated:true}]});
 const reads=[operationalRead("stock:all",{inventory:[{id:"ROW-1",quantityEa:7}]}),operationalRead("constraints",{demands:[{id:"D-1",quantityEa:7}]})];
 const projection=projectInvestigationContext({runId:RUN,question:"What do the documents establish?",snapshotHash:SNAPSHOT,registry,investigation,operationalReads:reads,observations:[{tool:"what_if",at:"2026-10-23T00:00:00.000Z",snapshotHash:SNAPSHOT,bytes:20,result:{label:"HYPOTHETICAL",cannotApprove:true}},{tool:"recall_history",at:"2026-10-23T00:00:00.000Z",snapshotHash:SNAPSHOT,bytes:15,result:{advisory:"remember"}}],requestsUsed:4,reportOnly:true});
 assert.deepEqual(projection.context.selected,[source]);assert.equal(projection.context.operationalReads.length,2);assert.ok(projection.context.operationalReads.every(read=>!Object.hasOwn(read,"result")));assert.deepEqual(projection.context.operationalReadOmissions.map(x=>x.reason),["documentary_report_phase","documentary_report_phase"]);
 assert.equal(projection.context.observations[0]?.reason,"documentary_report_phase");assert.deepEqual(projection.context.observations[1]?.result,{advisory:"remember"});
 const failure=projection.context.formatFailures[0]!;assert.equal(failure.rawContentOmitted,true);assert.equal(failure.omissionReason,"context_budget");assert.equal(failure.rawContentHash,rawHash);assert.equal(failure.rawContentBytes,Buffer.byteLength(raw));assert.equal("rawContent" in failure,false);
 assert.match(projection.instruction,/Successful phase-omitted reads are not missing evidence/);assert.match(projection.instruction,/Bounded recall_history and list_evidence results remain advisory/);
 assert.match(projection.instruction,/Call the forced report_investigation function exactly once with nextStep, summary, findings, and optional report question/);
 assert.match(projection.instruction,/Each finding has kind \(conflict, missing_evidence, or observation\)/);
 assert.match(projection.instruction,/each evidence item contains only quoteId/);
 assert.match(projection.instruction,/Cite only a presented quoteId/);
 assert.match(projection.instruction,/include a missing_evidence finding and a concrete top-level question/);
 assert.match(projection.instruction,/evidenceExcerptOmissions ranges cannot be cited/);
 assert.match(projection.instruction,/Choose exactly one nextStep: answer_document_question/);
 assert.match(projection.instruction,/ask_operator_for_new_evidence names a genuinely missing artifact\/status and identifier/);
 assert.match(projection.instruction,/continue_to_checked_calculation requests deterministic math only for user-requested allocation\/replenishment/);
 assert.match(projection.instruction,/These map to answered, needs_evidence, and plan/);
 assert.match(projection.instruction,/Do not calculate quantities or feasibility here/);
 assert.match(projection.instruction,/documentary comparisons are allowed/);
 assert.equal(projection.context.question,"What do the documents establish?","The original user question remains separate from the phase task.");
 assert.equal(projection.context.phaseTask,DOCUMENTARY_PHASE_TASK);
 assert.doesNotMatch(projection.instruction,/compare quantities or state feasibility here|gold answer/);
 assert.match(projection.instruction,/Phase-omitted or unread available operational inputs are not operator gaps/);
 assert.match(projection.instruction,/Evidence-only questions use answer_document_question/);
 assert.match(projection.instruction,/include a missing_evidence finding and a concrete top-level question with exact identifier/);
 assert.doesNotMatch(projection.instruction,/gold answer/);
 assert.ok(Buffer.byteLength(JSON.stringify(projection.context))<=40_000);
});

test("pinned target identity is explicit non-citable metadata and preserves all exact-SKU mappings without quantities",()=>{
 const source=entry("DOC-1","A selected documentary source.");const {registry,investigation}=setup([source]);
 const targetIdentity={runId:RUN,snapshotHash:SNAPSHOT,targetSku:"SKU-EXACT",recallId:"RECALL-EXACT",manufacturerRef:"MFR-EXACT",catalogMappings:[
  {internalSku:"SKU-EXACT",manufacturerRef:"MFR-EXACT",unit:"EA"},
  {internalSku:"SKU-EXACT",manufacturerRef:"MFR-ALTERNATE",unit:"BOX"},
 ]};
 const projection=projectInvestigationContext({runId:RUN,question:"Compare the inspected notice.",snapshotHash:SNAPSHOT,phaseTask:DOCUMENTARY_PHASE_TASK,targetIdentity,registry,investigation,requestsUsed:1,reportOnly:false});
 assert.deepEqual(projection.context.targetIdentity,{...targetIdentity,provenance:"pinned_snapshot_metadata",metadataOnly:true,citable:false});
 assert.deepEqual(projection.context.targetIdentity?.catalogMappings,targetIdentity.catalogMappings,"Distinct raw mappings for the exact target SKU remain separate and ordered.");
 const encoded=JSON.stringify(projection.context.targetIdentity);
 assert.doesNotMatch(encoded,/quantity|eligibility|sameProduct|qaStatus|recalledLots/i);
 assert.match(projection.instruction,/not an independently inspected source, citation, QA proof, or eligibility\/recall determination/);
 assert.match(projection.instruction,/may help interpret and compare raw identifiers with identifiers in selected documents/);
 assert.match(projection.instruction,/Do not cite metadata itself, create findings from metadata alone, certify mappings automatically, or merge distinct mappings/);
 assert.throws(()=>projectInvestigationContext({runId:RUN,question:"Question",snapshotHash:SNAPSHOT,registry,investigation,targetIdentity:{...targetIdentity,runId:"stale"},requestsUsed:1,reportOnly:false}),/invalid or stale/);
 assert.throws(()=>projectInvestigationContext({runId:RUN,question:"Question",snapshotHash:SNAPSHOT,registry,investigation,targetIdentity:{...targetIdentity,catalogMappings:[{...targetIdentity.catalogMappings[0]!,quantityEa:20} as any]},requestsUsed:1,reportOnly:false}),/catalog identity metadata is invalid/);
 assert.throws(()=>projectInvestigationContext({runId:RUN,question:"Question",snapshotHash:SNAPSHOT,registry,investigation,targetIdentity:{...targetIdentity,catalogMappings:[{...targetIdentity.catalogMappings[0]!,internalSku:"OTHER-SKU"}]},requestsUsed:1,reportOnly:false}),/catalog identity metadata is invalid/);
});

test("operational capabilities separate source-family presence, receipt state, and current versus post-handoff permission",()=>{
 const entries=Array.from({length:62},(_,index)=>entry(`DOC-${index+1}`,`Document ${index+1}.`));
 const selected=entries[0]!;const {registry,investigation}=setup(entries,{selections:[{sourceId:selected.id,sourceHash:selected.sourceHash,reason:"Read selected source",at:"2026-10-23T00:00:00.000Z"}]});
 const listResult={query:"DOC-61",result:{entries:[{id:"DOC-61",title:"Title DOC-61",kind:"notice",authority:"fictional-record",alreadyInspected:false}]}};
 const listObservation={tool:"list_evidence",at:"2026-10-23T00:00:00.000Z",snapshotHash:SNAPSHOT,bytes:Buffer.byteLength(JSON.stringify(listResult)),result:listResult};
 const staleResult={query:"DOC-62",result:{entries:[{id:"DOC-62",title:"Title DOC-62",kind:"notice",authority:"fictional-record",alreadyInspected:false}]}};
 const staleObservation={...listObservation,snapshotHash:"stale-snapshot",bytes:Buffer.byteLength(JSON.stringify(staleResult)),result:staleResult};
 const families={inventoryLots:false,shipments:true,siteDemands:true,routes:false,catalogItems:true};
 const reportOnly=projectInvestigationContext({runId:RUN,question:"Calculate coverage only if requested.",snapshotHash:SNAPSHOT,registry,investigation,operationalRecordIds:["INV-1"],operationalRecordFamilies:families,observations:[listObservation,staleObservation],operationalReadsAllowed:true,requestsUsed:4,reportOnly:true});
 assert.deepEqual(reportOnly.context.operationalCapabilities,{runId:RUN,snapshotHash:SNAPSHOT,scope:"pinned_snapshot_read_capability_metadata",citable:false,recordFamiliesMeaning:"raw_nonempty_row_presence_only",entries:[
  {key:"stock:all",tool:"investigate_stock",recordFamilies:{inventoryLots:false,shipments:true},receiptState:"not_captured",executableNow:false,retrievableAfterAcceptedHandoff:true},
  {key:"constraints",tool:"fetch_constraints",recordFamilies:{siteDemands:true,routes:false,catalogItems:true},receiptState:"not_captured",executableNow:false,retrievableAfterAcceptedHandoff:true},
 ]});
 assert.equal(reportOnly.context.operationalReadsAllowed,false);
 assert.deepEqual(reportOnly.context.operationalReads,[]);
 assert.deepEqual(reportOnly.context.newInspectionSourceIds,[...entries.slice(1,60).map(item=>item.id),"DOC-61"]);
 assert.equal(reportOnly.context.newInspectionSourceIds.includes("DOC-62"),false,"Stale discovery results cannot introduce source IDs into the current run's inspection choices.");
 assert.equal(reportOnly.context.newInspectionSourceIds.includes("alias:DOC-1"),false);
 assert.match(reportOnly.instruction,/false may be a valid empty family/);
 assert.match(reportOnly.instruction,/A missing receipt is not absent snapshot data/);

 const reads=[operationalRead("stock:all",{inventory:[],shipments:[]}),operationalRead("constraints",{demands:[],routes:[],catalog:[]})];
 const captured=projectInvestigationContext({runId:RUN,question:"Question",snapshotHash:SNAPSHOT,registry,investigation,operationalRecordFamilies:families,operationalReads:reads,operationalReadsAllowed:true,requestsUsed:4,reportOnly:true});
 assert.deepEqual(captured.context.operationalCapabilities.entries.map(item=>[item.receiptState,item.executableNow,item.retrievableAfterAcceptedHandoff]),[["captured",false,true],["captured",false,true]]);
 assert.deepEqual(captured.context.operationalCapabilities.entries[0]?.recordFamilies,{inventoryLots:false,shipments:true},"Empty snapshot families stay empty independently of whether a receipt was captured.");
 assert.equal(captured.context.operationalCapabilities.runId,RUN);assert.equal(captured.context.operationalCapabilities.snapshotHash,SNAPSHOT);
 assert.throws(()=>projectInvestigationContext({runId:RUN,question:"Question",snapshotHash:SNAPSHOT,registry,investigation,operationalRecordFamilies:{...families,unknown:true} as any,requestsUsed:1,reportOnly:false}),/complete boolean map/);
});

test("inspection choices include only presented discovery IDs and preserve canonical-ID precedence over selected aliases",()=>{
 const selected=entry("ROW-1","Selected row.");selected.refs=["ROW-1","QA-CANONICAL","QA-ALIAS"];
 const canonicalAlias=entry("QA-CANONICAL","Independent canonical document.");
 const registry:EvidenceRegistry={snapshotHash:SNAPSHOT,entries:[selected,canonicalAlias]};
 const investigation:InvestigationRecord={runId:RUN,snapshotHash:SNAPSHOT,selections:[{sourceId:selected.id,sourceHash:selected.sourceHash,reason:"Inspect row",at:"2026-10-23T00:00:00.000Z"}],findings:[],reportAttempts:[],feedback:[],disposition:null,summary:""};
 const projection=projectInvestigationContext({runId:RUN,question:"Inspect distinct evidence.",snapshotHash:SNAPSHOT,registry,investigation,requestsUsed:1,reportOnly:false});
 assert.deepEqual(projection.context.newInspectionSourceIds,["QA-CANONICAL"],"A canonical ID wins over another selected entry's alias; a bare alias is never offered as a canonical choice.");

 const largeRegistry:EvidenceRegistry={snapshotHash:SNAPSHOT,entries:[...Array.from({length:60},(_,index)=>entry(`IDX-${index}`,`Indexed ${index}.`)),entry("DISCOVERED-ONLY","Present only through discovery.")]};
 const {investigation:emptyInvestigation}=setup(largeRegistry.entries,{selections:[]});
 const largeResult={query:"DISCOVERED-ONLY",result:{entries:[{id:"DISCOVERED-ONLY",title:"Discovery result",kind:"record",authority:"fictional-record",alreadyInspected:false}],extra:"x".repeat(9_000)}};
 const omitted=projectInvestigationContext({runId:RUN,question:"Find the discovered source.",snapshotHash:SNAPSHOT,registry:largeRegistry,investigation:emptyInvestigation,observations:[{tool:"list_evidence",at:"2026-10-23T00:00:00.000Z",snapshotHash:SNAPSHOT,bytes:Buffer.byteLength(JSON.stringify(largeResult)),result:largeResult}],requestsUsed:1,reportOnly:false});
 assert.equal(omitted.context.observations[0]?.reason,"result_limit");assert.equal(omitted.context.newInspectionSourceIds.includes("DISCOVERED-ONLY"),false,"An ID from an omitted discovery result is not authorized for inspection.");
});
