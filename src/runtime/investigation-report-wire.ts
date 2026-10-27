import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvidenceEntry, InvestigationReportInput } from "../shared/investigation.ts";
import { validateEvidenceExcerptCatalog, type EvidenceExcerptCatalog } from "./evidence-excerpts.ts";
import type { BoundRecordMatch } from "./record-matching.ts";

const citationWireSchema = z.object({
  quoteId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const findingWireSchema = z.object({
  kind: z.enum(["conflict", "missing_evidence", "observation"]).describe("Use conflict only for incompatible assertions supported by at least two distinct selected sources; observation for a source fact or constraint; missing_evidence only for a genuinely unavailable artifact or status, with its exact identifier and a concrete question ending in a question mark."),
  summary: z.string().min(1).max(1000),
  evidence: z.array(citationWireSchema).min(1).max(5),
  comparisons:z.array(z.object({beforeQuoteId:z.string().regex(/^[a-f0-9]{64}$/),afterQuoteId:z.string().regex(/^[a-f0-9]{64}$/),relation:z.enum(["same_text","different_text"])}).strict()).max(2).optional().describe("For notice changes, select complete before/after notice excerpts. Relation checks whitespace-normalized text equality only; different wording does not establish a material risk escalation."),
  recordChecks:z.array(z.object({resultId:z.string().regex(/^[a-f0-9]{64}$/),field:z.enum(["lot","manufacture_date","product"]),status:z.enum(["match","no_match","unknown"])}).strict()).max(12).optional().describe("Copy only a supplied source-bound record matching result ID and its exact deterministic status; never infer dates or substitute expiry."),
  question: z.string().min(5).max(500).optional().describe("For missing evidence, name the exact unavailable artifact/status and identifier and end with a question mark."),
}).strict();

const investigationReportWireSchema = z.object({
  nextStep: z.enum(["answer_document_question", "ask_operator_for_new_evidence", "continue_to_checked_calculation"]),
  summary: z.string().min(1).max(2000),
  findings: z.array(findingWireSchema).min(1).max(6),
  question: z.string().min(5).max(500).optional(),
}).strict();

const proofBundleFindingWireSchema=findingWireSchema.extend({proofGroupIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(12).optional()});
const proofBundleInvestigationReportWireSchema=z.object({nextStep:investigationReportWireSchema.shape.nextStep,summary:investigationReportWireSchema.shape.summary,findings:z.array(proofBundleFindingWireSchema).min(1).max(6),question:investigationReportWireSchema.shape.question}).strict();

export type InvestigationReportWire = z.infer<typeof investigationReportWireSchema>;

/** Provider-only report shape. Run/finding/source hashes are bound after the model responds. */
export const compactReportWireJsonSchema = z.toJSONSchema(investigationReportWireSchema);

/** Return a fresh provider schema limited to excerpts actually included in this request. */
export function compactReportWireJsonSchemaForQuotes(quoteIds: string[]): Record<string, unknown> {
  const ids = [...new Set(quoteIds)];
  if (ids.length === 0 || ids.length !== quoteIds.length || ids.some(id => typeof id !== "string" || !/^(?:[a-f0-9]{64}|E_[a-f0-9]{24})$/.test(id))) {
    throw new TypeError("A report schema requires unique presented quote IDs.");
  }
  const schema = structuredClone(compactReportWireJsonSchema) as Record<string, unknown>;
  let replacements = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for(const key of ["quoteId","beforeQuoteId","afterQuoteId"]){
        const quoteId=(properties as Record<string,unknown>)[key];
        if(quoteId&&typeof quoteId==="object"&&!Array.isArray(quoteId)){
          // Exact request-bound enum is authoritative for provider references.
          // Internal binding still validates the resolved full hashes.
          delete (quoteId as Record<string,unknown>).pattern;
          (quoteId as Record<string,unknown>).enum=ids;replacements++;
        }
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(schema);
  if (replacements !== 3) throw new TypeError("The compact report JSON schema did not contain all citation and before/after quoteId fields.");
  return schema;
}

export interface InvestigationReportWireAudit {
  wireSchemaVersion: "investigation-report-excerpt-v4"|"investigation-report-proof-groups-v1"|"investigation-report-receipt-bundles-v1"|"investigation-report-receipt-selection-v1"|"investigation-report-receipt-selection-v2"|"investigation-report-receipt-selection-v3"|"investigation-report-receipt-selection-v4"|"investigation-report-receipt-selection-v5"|"investigation-report-receipt-selection-v6"|"investigation-report-receipt-selection-v7";
  provenance: "model-selected-source-excerpt-reference-resolved-by-server"|"model-selected-proof-group-and-source-excerpt-reference-resolved-by-server"|"model-authored-receipt-section-and-document-citations-resolved-by-server"|"model-selected-record-references-and-documentary-citations-resolved-by-server"|"model-selected-atomic-record-receipts-and-documentary-quotes";
  transport?: "native-constrained-tool-to-bound-handler"|"structured-json-receipt-report-to-bound-handler";
  wireNextStep: InvestigationReportWire["nextStep"];
  mappedDisposition: InvestigationReportInput["disposition"];
  quoteCatalogSha256: string;
  quoteBindings: Array<{ quoteId: string; sourceId: string; sourceHash: string; start: number; end: number }>;
  internalDispatchId?: string;
  internalDispatchTool?: "report_investigation";
  internalDispatchIdServerGenerated?: true;
  rawWireSha256: string;
  rawWireBytes: number;
  normalizedArgumentsSha256: string;
  proofGroupCatalogSha256?:string;
  proofGroupBindings?:Array<{findingIndex:number;proofGroupId:string;resultIds:string[]}>;
  aliasCatalogSha256?:string;
  aliasBindings?:Array<{kind:"quote"|"check"|"result";alias:string;fullId:string}>;
  serverComputedTextComparisons?:Array<{documentFindingIndex:number;comparisonIndex:number;before:{ordinal:string;quoteId:string;sourceId:string;sourceHash:string;start:number;end:number};after:{ordinal:string;quoteId:string;sourceId:string;sourceHash:string;start:number;end:number};relation:"same_text"|"different_text";verificationScope:"NFC_whitespace_normalized_text_equality_only"}>;
  receiptPacketId?:string;
  receiptPacketDigest?:string;
  receiptExpandedWireSha256?:string;
  receiptExpandedWireBytes?:number;
  receiptBundleBindings?:Array<{findingIndex:number;bundleId:string;checkIds:string[];resultIds:string[];quoteIds:string[]}>;
  documentaryCitationBindings?:Array<{documentFindingIndex:number;quoteIds:string[];comparisonQuoteIds:string[]}>;
  fullIdWireSha256?:string;
  ignoredAssistantTextStatus?: "discarded_unverified";
  ignoredAssistantTextSha256?: string;
  ignoredAssistantTextBytes?: number;
}

export interface BoundInvestigationReportWire {
  argumentsText: string;
  audit: InvestigationReportWireAudit;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Bind only exact model-selected excerpt references from the current request catalog. */
export function bindInvestigationReportWire(
  rawArguments: string,
  runId: string,
  snapshotHash: string,
  selected: EvidenceEntry[],
  catalog: EvidenceExcerptCatalog,
  options:{requireProofFields?:boolean;atomicReceiptLimits?:boolean;recordProofGroups?:Array<{proofGroupId:string;resultIds:string[];requiredEvidenceOptions:Array<{quoteIds:string[]}>}>;recordMatches?:BoundRecordMatch[]}={},
): BoundInvestigationReportWire {
  if (!z.string().uuid().safeParse(runId).success) throw new RangeError("A trusted UUID run ID is required to bind an investigation report.");
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new RangeError("A trusted snapshot hash is required to bind an investigation report.");
  if (new TextEncoder().encode(rawArguments).byteLength > 48_000) throw new RangeError("Investigation report arguments exceed the 48KB wire limit.");
  if (catalog.snapshotHash !== snapshotHash || selected.some(entry => entry.snapshotHash !== snapshotHash)) throw new TypeError("The selected sources or quote catalog are stale for this report.");
  const excerpts = validateEvidenceExcerptCatalog({ runId, snapshotHash, selected, catalog });

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new TypeError("Investigation report arguments must be valid JSON.");
  }
  const atomicFinding=findingWireSchema.extend({evidence:z.array(citationWireSchema).min(1).max(8),recordChecks:z.array(z.object({resultId:z.string().regex(/^[a-f0-9]{64}$/),field:z.enum(["lot","manufacture_date","product"]),status:z.enum(["match","no_match","unknown"])}).strict()).max(24).optional()});
  const atomicReport=investigationReportWireSchema.extend({findings:z.array(atomicFinding).min(1).max(6)});
  const wire = options.atomicReceiptLimits?atomicReport.parse(parsed):(options.recordProofGroups?proofBundleInvestigationReportWireSchema:investigationReportWireSchema).parse(parsed);
  if(options.requireProofFields&&wire.findings.some(finding=>!Array.isArray(finding.comparisons)||(options.recordProofGroups?!Array.isArray((finding as any).proofGroupIds):!Array.isArray((finding as any).recordChecks))))throw new TypeError("Every finding must explicitly contain comparisons and its record proof selection array.");
  const disposition: InvestigationReportInput["disposition"] = wire.nextStep === "answer_document_question"
    ? "answered"
    : wire.nextStep === "ask_operator_for_new_evidence" ? "needs_evidence" : "plan";
  const quoteBindings: InvestigationReportWireAudit["quoteBindings"] = [];
  const resolveQuote=(quoteId:string)=>{
    const excerpt=excerpts.get(quoteId);
    if(!excerpt)throw new TypeError(`Investigation report quote ID is not presented in this request: ${quoteId}`);
    const matches=selected.filter(entry=>entry.id===excerpt.sourceId&&entry.sourceHash===excerpt.sourceHash&&entry.snapshotHash===catalog.snapshotHash);
    if(matches.length!==1)throw new TypeError(`Investigation report excerpt source is not uniquely selected: ${excerpt.sourceId}`);
    quoteBindings.push({quoteId:excerpt.quoteId,sourceId:excerpt.sourceId,sourceHash:excerpt.sourceHash,start:excerpt.start,end:excerpt.end});
    return {sourceId:excerpt.sourceId,sourceHash:excerpt.sourceHash,quote:excerpt.text};
  };
  const groupMap=new Map((options.recordProofGroups??[]).map(group=>[group.proofGroupId,group]));
  const resultMap=new Map((options.recordMatches??[]).map(result=>[result.resultId,result]));
  const proofGroupBindings:Array<{findingIndex:number;proofGroupId:string;resultIds:string[]}>=[];
  const findings: InvestigationReportInput["findings"] = wire.findings.map((finding,findingIndex)=>{
   const selectedQuoteIds=new Set(finding.evidence.map(citation=>citation.quoteId));
   const expandedChecks:Array<{resultId:string;field:BoundRecordMatch["field"];status:BoundRecordMatch["status"]}>=[];
   if(options.recordProofGroups){
    const groupIds=(finding as any).proofGroupIds as string[]|undefined;
    const legacy=(finding as any).recordChecks;
    if(groupIds!==undefined&&legacy!==undefined)throw new TypeError("A finding cannot mix proof group selections with legacy record checks.");
    const seen=new Set<string>();
    for(const id of groupIds??[]){
     if(seen.has(id))throw new TypeError("Record proof group selections must be unique.");seen.add(id);
     const group=groupMap.get(id);if(!group)throw new TypeError(`Record proof group is not presented in this request: ${id}`);
     for(const option of group.requiredEvidenceOptions){if(!option.quoteIds.some(quoteId=>selectedQuoteIds.has(quoteId)))throw new TypeError(`The selected evidence does not cover record proof group: ${id}`);}
     if(expandedChecks.length+group.resultIds.length>12)throw new RangeError("Expanded record proof checks exceed the 12-check finding limit.");
     for(const resultId of group.resultIds){const result=resultMap.get(resultId);if(!result)throw new TypeError("A presented record proof group references a missing or stale result.");
      if(!result.evidence.every(proof=>finding.evidence.some(citation=>{const excerpt=excerpts.get(citation.quoteId);return excerpt?.sourceId===proof.sourceId&&excerpt.sourceHash===proof.sourceHash&&excerpt.text.includes(proof.quote);})))throw new TypeError("Selected evidence does not bind every exact proof quote for the chosen record result.");
      expandedChecks.push({resultId:result.resultId,field:result.field,status:result.status});
     }
     proofGroupBindings.push({findingIndex,proofGroupId:id,resultIds:[...group.resultIds]});
    }
    if(legacy!==undefined){if(!Array.isArray(legacy))throw new TypeError("Legacy record checks are invalid in proof group mode.");expandedChecks.push(...legacy);}
   }
   return {
    id:`finding-${findingIndex+1}`,kind:finding.kind,summary:finding.summary,
    ...(finding.question===undefined?{}:{question:finding.question}),
    evidence:finding.evidence.map(citation=>resolveQuote(citation.quoteId)),
    ...(finding.comparisons?{comparisons:finding.comparisons.map(comparison=>({before:resolveQuote(comparison.beforeQuoteId),after:resolveQuote(comparison.afterQuoteId),relation:comparison.relation}))}:{}),
    ...(options.recordProofGroups?{recordChecks:expandedChecks}:finding.recordChecks?{recordChecks:structuredClone(finding.recordChecks)}:{}),
   };
  });
  const normalized: InvestigationReportInput = {
    disposition,
    summary: wire.summary,
    findings,
    ...(wire.question === undefined ? {} : { question: wire.question }),
  };
  const argumentsText = JSON.stringify({ runId, ...normalized });
  const catalogBody = JSON.stringify({ runId: catalog.runId, snapshotHash: catalog.snapshotHash, entries: catalog.entries, omissions: catalog.omissions });
  const proofGroupCatalogSha256=options.recordProofGroups?sha256(JSON.stringify(options.recordProofGroups)):undefined;
  return {
    argumentsText,
    audit: {
      wireSchemaVersion: options.recordProofGroups?"investigation-report-proof-groups-v1":"investigation-report-excerpt-v4",
      provenance: options.recordProofGroups?"model-selected-proof-group-and-source-excerpt-reference-resolved-by-server":"model-selected-source-excerpt-reference-resolved-by-server",
      wireNextStep: wire.nextStep,
      mappedDisposition: disposition,
      quoteCatalogSha256: sha256(catalogBody),
      quoteBindings,
      rawWireSha256: sha256(rawArguments),
      rawWireBytes: new TextEncoder().encode(rawArguments).byteLength,
      normalizedArgumentsSha256: sha256(argumentsText),
      ...(proofGroupCatalogSha256?{proofGroupCatalogSha256,proofGroupBindings}:{}),
    },
  };
}
