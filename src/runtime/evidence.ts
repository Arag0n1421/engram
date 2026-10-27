import { createHash } from "node:crypto";
import type { Snapshot } from "../domain/types.ts";
import type {BoundRecordMatch} from "./record-matching.ts";
import {evidenceFocusTerms,exactEvidenceTokenIndex} from "./evidence-excerpts.ts";
import { fingerprintSnapshot } from "../domain/fingerprint.ts";
import { INVESTIGATION_DOMAIN_FEEDBACK_CODES } from "../shared/investigation.ts";
import type {
  EvidenceDocument, EvidenceEntry, EvidenceRegistry, InvestigationFinding,
  InvestigationReportInput, InvestigationDomainFeedbackCode, InvestigationValidationIssue,
} from "../shared/investigation.ts";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function documentEntry(document: EvidenceDocument, snapshotHash: string): EvidenceEntry {
  return {
    ...document,
    refs: [...new Set([document.id, ...document.refs])],
    sourceHash: sha256(document.content),
    snapshotHash,
    support: document.authority === "public-source-excerpt"
      ? "Stored source excerpt; validation binds the submitted quote to these exact characters."
      : document.authority === "fictional-record"
        ? "Normalized row capture from a fictional operational fixture; this data describes the simulation only."
        : "Curated source summary; this is not a verbatim quotation.",
  };
}

function rowDocument(
  id: string, title: string, row: unknown, refs: string[], version: string | number,
  snapshot: Snapshot,
): EvidenceDocument {
  const hasQaOrExpiryRefs = isObject(row) && ("qaEvidenceRef" in row || "expiryEvidenceRef" in row);
  const metadataNote = hasQaOrExpiryRefs
    ? " QA and expiry evidence-reference values are metadata aliases on this normalized row only; they do not represent independently verified documents or stored document bodies."
    : "";
  const content = `${snapshot.dataMode === "fixture" ? "Fictional" : "Normalized"} operational row capture. Structured facts: ${JSON.stringify(row)}.${metadataNote}`;
  return {
    id, title, kind: "record", sourceURL: `urn:recallops:${snapshot.dataMode}:${encodeURIComponent(id)}`,
    version, retrievedAt: snapshot.sourceRead?.retrievedAt ?? snapshot.clock.analysisAt, content,
    refs: [...new Set([id, ...refs])], authority: snapshot.dataMode === "fixture" ? "fictional-record" : "curated-source-summary",
  };
}

function sourceMetadata(notice: Record<string, unknown>, wantedId: string) {
  const source = asArray(notice.sources).map(value => isObject(value) ? value : {})
    .find(value => value.id === wantedId) ?? {};
  return {
    sourceURL: string(source.url, wantedId === "FDA-213286"
      ? "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfres/res.cfm?id=213286"
      : "https://adapthealth.com/wp-content/uploads/2025/05/Medline-Urgent-Product-Recall-regarding-speci_Kelly-Williams.pdf"),
    retrievedAt: string(source.retrieved_at_utc, string(notice.retrieved_at_utc, "unknown")),
    version: string(source.page_last_updated_displayed, string(source.date_posted, string(source.notice_date, `capture:${string(source.retrieved_at_utc, string(notice.retrieved_at_utc, "unknown"))}`))),
    spans: asArray(source.observed_spans).map(value => isObject(value) ? value : {}),
  };
}

function sourceDocument(
  id: string, title: string, kind: EvidenceDocument["kind"], sourceURL: string,
  version: string | number, retrievedAt: string, content: string, refs: string[],
  authority: EvidenceDocument["authority"],
): EvidenceDocument {
  return { id, title, kind, sourceURL, version, retrievedAt, content, refs, authority };
}

/** Build a compact immutable evidence index for one normalized investigation snapshot. */
export function buildEvidenceRegistry(
  snapshot: Snapshot,
  notice: unknown,
  documents?: EvidenceDocument[],
): EvidenceRegistry {
  const snapshotHash = fingerprintSnapshot(snapshot);
  const noticeObject = isObject(notice) ? notice : {};
  const recall = isObject(noticeObject.recall) ? noticeObject.recall : {};
  const fda = sourceMetadata(noticeObject, "FDA-213286");
  const manufacturer = sourceMetadata(noticeObject, "MANUFACTURER-R-25-057");
  const fdaScopeSpan = fda.spans.find(span => span.id === "FDA-PRODUCT-LOT-SCOPE");
  const fdaActionSpan = fda.spans.find(span => span.id === "FDA-REQUIRED-ACTIONS");
  const manufacturerScopeSpan = manufacturer.spans.find(span => span.id === "MFG-LOT-SCOPE");
  const manufacturerActionSpan = manufacturer.spans.find(span => span.id === "MFG-QUARANTINE-DESTRUCTION");
  const manufacturerResponseSpan = manufacturer.spans.find(span => span.id === "MFG-RESPONSE");
  const manufacturerDownstreamSpan = manufacturer.spans.find(span => span.id === "MFG-DOWNSTREAM");
  const conflict = asArray(noticeObject.known_source_conflicts).map(value => isObject(value) ? value : {})[0];
  const fdaLots = asArray(recall.affected_lots).filter((value): value is string => typeof value === "string");
  const fdaLocator = string(fdaScopeSpan?.locator, "FDA product and code information fields");
  const fdaSummary = string(fdaScopeSpan?.summary, "Stored notice extraction contains product identifiers and affected lot identifiers.");
  const manufacturerLocator = string(manufacturerScopeSpan?.locator, "Manufacturer attachment scope section");
  const manufacturerScopeContent = typeof manufacturerScopeSpan?.quote === "string" && manufacturerScopeSpan.quote.length > 0
    ? `${manufacturerLocator}: ${manufacturerScopeSpan.quote}`
    : `Curated source summary from ${manufacturerLocator}: ${string(manufacturerScopeSpan?.summary, "No manufacturer lot-scope summary is stored.")} This summary is not a verbatim quotation.`;
  const docs: EvidenceDocument[] = documents === undefined ? [
    sourceDocument(
      "FDA-PRODUCT-LOT-SCOPE", "FDA product and lot scope", "notice", fda.sourceURL,
      fda.version, fda.retrievedAt,
      `Curated source summary from ${fdaLocator}: ${fdaSummary} Recall ${string(recall.fda_recall_number, "not present in stored notice")}; manufacturer reference ${string(recall.manufacturer_ref, "not present in stored notice")}; affected lots from the stored notice extraction (${fdaLots.length}): ${fdaLots.join(", ")}. This is not a verbatim quotation.`,
      ["FDA-213286", "FDA-PRODUCT-LOT-SCOPE", "FDA-CODE-INFO-EXACT-SPAN"], "curated-source-summary",
    ),
    sourceDocument(
      "FDA-REQUIRED-ACTIONS", "FDA recall action excerpt", "notice", fda.sourceURL,
      fda.version, fda.retrievedAt,
      string(fdaActionSpan?.quote, "Recall action span has no stored verbatim quotation."),
      ["FDA-213286", "FDA-REQUIRED-ACTIONS"],
      typeof fdaActionSpan?.quote === "string" && fdaActionSpan.quote.length > 0 ? "public-source-excerpt" : "curated-source-summary",
    ),
    sourceDocument(
      "MFG-LOT-SCOPE", "Manufacturer attachment lot scope", "notice", manufacturer.sourceURL,
      manufacturer.version, manufacturer.retrievedAt, manufacturerScopeContent,
      ["MANUFACTURER-R-25-057", "MFG-LOT-SCOPE"],
      typeof manufacturerScopeSpan?.quote === "string" && manufacturerScopeSpan.quote.length > 0 ? "public-source-excerpt" : "curated-source-summary",
    ),
    sourceDocument(
      "MFG-QUARANTINE-DESTRUCTION", "Manufacturer required action excerpt", "notice", manufacturer.sourceURL,
      manufacturer.version, manufacturer.retrievedAt,
      string(manufacturerActionSpan?.quote, "Manufacturer action span has no stored verbatim quotation."),
      ["MANUFACTURER-R-25-057", "MFG-QUARANTINE-DESTRUCTION"],
      typeof manufacturerActionSpan?.quote === "string" && manufacturerActionSpan.quote.length > 0 ? "public-source-excerpt" : "curated-source-summary",
    ),
    sourceDocument(
      "MFG-RESPONSE", "Manufacturer response excerpt", "notice", manufacturer.sourceURL,
      manufacturer.version, manufacturer.retrievedAt,
      typeof manufacturerResponseSpan?.quote === "string" && manufacturerResponseSpan.quote.length > 0
        ? manufacturerResponseSpan.quote
        : "Curated source summary: the manufacturer requests a completed destruction form, including a response when no affected product is present; credit is conditional on receipt.",
      ["MANUFACTURER-R-25-057", "MFG-RESPONSE"],
      typeof manufacturerResponseSpan?.quote === "string" && manufacturerResponseSpan.quote.length > 0 ? "public-source-excerpt" : "curated-source-summary",
    ),
    sourceDocument(
      "MFG-DOWNSTREAM", "Manufacturer downstream notification summary", "notice", manufacturer.sourceURL,
      manufacturer.version, manufacturer.retrievedAt,
      typeof manufacturerDownstreamSpan?.quote === "string" && manufacturerDownstreamSpan.quote.length > 0
        ? manufacturerDownstreamSpan.quote
        : `Curated source summary: ${string(manufacturerDownstreamSpan?.summary, "notify recipients when product has been transferred and include downstream quantities in the response.")} This is not a verbatim quotation.`,
      ["MANUFACTURER-R-25-057", "MFG-DOWNSTREAM"],
      typeof manufacturerDownstreamSpan?.quote === "string" && manufacturerDownstreamSpan.quote.length > 0 ? "public-source-excerpt" : "curated-source-summary",
    ),
  ] : [];

  if (documents === undefined && snapshot.recallProvenance) {
    const provenance = snapshot.recallProvenance;
    const rawCaptureRef = `FDA-RAW-SHA256:${provenance.rawsha256}`;
    docs.push(sourceDocument(
      "FDA-CAPTURE-PROVENANCE", "FDA capture provenance metadata", "notice", provenance.sourceURL,
      provenance.datasetLastUpdated, provenance.retrievedAt,
      `FDA capture provenance metadata only: sourceURL=${provenance.sourceURL}; retrievedAt=${provenance.retrievedAt}; rawCaptureSha256=${provenance.rawsha256}; datasetLastUpdated=${provenance.datasetLastUpdated}; reviewed=${provenance.reviewed}. The full raw capture body is not embedded in this entry. The entry sourceHash hashes this metadata text, not the raw capture body.`,
      [rawCaptureRef], "curated-source-summary",
    ));
  }

  if (documents === undefined && conflict) {
    docs.push(sourceDocument(
      "DISTRIBUTOR-COVER-LOT-SCOPE", "Distributor cover lot identifier", "notice", manufacturer.sourceURL,
      manufacturer.version, manufacturer.retrievedAt,
      `Curated source summary: the distributor cover lists ${string(conflict.distributor_cover_value, "an unspecified identifier")} for ${string(conflict.field, "a lot identifier")}. This records the cover value only; it does not resolve or classify any inventory lot.`,
      ["DISTRIBUTOR-COVER-LOT-SCOPE", "DISTRIBUTOR-COVER", "MANUFACTURER-R-25-057"], "curated-source-summary",
    ));
  }

  for (const row of snapshot.inventory) docs.push(rowDocument(row.id, `Inventory ${row.id}`, row, row.evidenceRefs, row.version, snapshot));
  for (const row of snapshot.demands) docs.push(rowDocument(row.id, `Demand ${row.id}`, row, [row.id], row.version, snapshot));
  for (const row of snapshot.routes) docs.push(rowDocument(row.id, `Route ${row.id}`, row, [row.id], row.version, snapshot));
  for (const row of snapshot.shipments) docs.push(rowDocument(row.id, `Shipment ${row.id}`, row, row.evidenceRefs, row.version, snapshot));
  const manufacturerRefCounts = new Map<string, number>();
  for (const row of snapshot.catalog) manufacturerRefCounts.set(row.manufacturerRef, (manufacturerRefCounts.get(row.manufacturerRef) ?? 0) + 1);
  for (const row of snapshot.catalog) {
    const hasUniqueManufacturerRef = manufacturerRefCounts.get(row.manufacturerRef) === 1;
    const referenceOccupiedElsewhere = docs.some(doc => doc.id !== row.internalSku && (doc.id === row.manufacturerRef || doc.refs.includes(row.manufacturerRef))) ||
      snapshot.catalog.some(other => other.internalSku !== row.internalSku && (other.internalSku === row.manufacturerRef || other.evidenceRefs.includes(row.manufacturerRef)));
    const refs = hasUniqueManufacturerRef && !referenceOccupiedElsewhere
      ? [...row.evidenceRefs, row.manufacturerRef]
      : row.evidenceRefs;
    docs.push(rowDocument(row.internalSku, `Catalog ${row.internalSku}`, row, refs, snapshot.sourceVersions.catalog ?? 1, snapshot));
  }

  // Keep each evidence reference resolvable without duplicating the source text.
  const merged = new Map<string, EvidenceDocument>();
  for (const doc of docs) {
    const current = merged.get(doc.id);
    merged.set(doc.id, current ? { ...current, refs: [...new Set([...current.refs, ...doc.refs])] } : doc);
  }
  for (const doc of documents ?? []) {
    // External documents intentionally replace an indexed ID and take precedence for their aliases.
    merged.set(doc.id, { ...doc, refs: [...new Set([doc.id, ...doc.refs])] });
  }
  const entries = [...merged.values()].map(doc => documentEntry(doc, snapshotHash));
  // Aliases are exposed in each entry's refs and resolve through inspectEvidence.
  return { snapshotHash, entries };
}

export function inspectEvidence(registry: EvidenceRegistry, id: string): EvidenceEntry | { status: "unknown"; id: string } {
  const entry = registry.entries.find(candidate => candidate.id === id) ??
    registry.entries.find(candidate => candidate.refs.includes(id));
  return entry ?? { status: "unknown", id };
}

const boundedText = (value: unknown, max: number, required = true): value is string =>
  typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);

/** Conservative lexical task routing; no inferred clinical meaning or expected answer. */
export function investigationRequirements(question:string,registry:EvidenceRegistry) {
  const comparison=/\b(?:compare|comparison|differences?)\b/i.test(question)||(/\b(?:changes?|changed|updates?|new|previous|prior|original|earlier)\b/i.test(question)&&/\b(?:notice|notification|recall|risk|hazard|instructions?|revision)\b/i.test(question));
  const localClassification=/\b(?:local|inventory|stock|records?|rows?)\b/i.test(question)&&/\b(?:manufactur\w*|dates?|lots?|batches?|range|scope)\b/i.test(question)&&/\b(?:classify|classification|which|match|matching|within|outside|affected|included|excluded|covered|scope|appl(?:y|ies))\b/i.test(question);
  return {noticeComparison:comparison&&registry.entries.filter(entry=>entry.kind==="notice").length>=2,recordMatching:localClassification&&registry.entries.some(entry=>entry.kind==="record")};
}
const normalizedText=(text:string)=>text.normalize("NFC").replace(/\s+/g," ").trim();
const positiveChange=(text:string)=>/\b(?:new|changed|added|increased|higher|escalat\w*|worsen\w*)\b/i.test(text.replace(/\b(?:no|not|without) (?:new|change[sd]?|added|increased|higher)\b|\bunchanged\b/gi,""));
const riskEscalation=(text:string)=>text.split(/(?<=[.!?])\s+|;\s*/).some(clause=>{
  if(/\b(?:no|not|without|never)\b[^.!?;]{0,40}\b(?:new|higher|increased|changed|different|escalat\w*|worsen\w*)\b/i.test(clause))return false;
  return /\b(?:new|higher|increased|changed|different|escalat\w*|worsen\w*)\b[^.!?]{0,70}\b(?:risk|hazard|harm|severity)\b|\b(?:risk|hazard|harm|severity)\b[^.!?]{0,70}\b(?:higher|increased|escalat\w*|worsen\w*)\b/i.test(clause);
});
function reportClauses(text:string):string[]{
 return text.split(/(?<=[.!?])\s+|;\s*|\b(?:but|however|yet)\b/gi);
}
function assertsClearance(text:string):boolean {
 const predicate="(?:safe|cleared|unaffected|not recalled|not affected|outside (?:the )?recall scope)";
 const deniedPredicate=new RegExp(`\\b(?:cannot|can't|can not|must not|should not|may not|will not|would not|could not)\\s+(?:be\\s+)?(?:(?:considered|regarded|treated|deemed)\\s+)?${predicate}\\b`,"gi");
 const deniedSubject=new RegExp(`\\b(?:none|neither(?:\\s+(?:local\\s+)?(?:records?|rows?|devices?|units?))?|no\\s+(?:local\\s+)?(?:records?|rows?|devices?|units?))\\s+(?:can|may|should|must|could|would|will|is|are|was|were)\\s+(?:be\\s+)?${predicate}\\b`,"gi");
 const statusLabel="(?:clear|black|red|green|amber|affected|unaffected|safe|unsafe|recalled|not[ -]recalled|not[ -]affected)";
 const deniedClassification=new RegExp(`\\b(?:cannot|can't|can not|must not|should not|may not|will not|would not|could not)\\s+(?:be\\s+)?class(?:ed|ified)\\s+as\\s+(?:affected|unaffected|safe|cleared|recalled|not recalled|not affected|outside (?:the )?recall scope)\\b(?:\\s*\\(${statusLabel}\\))?(?:\\s+(?:or|and)\\s+(?:affected|unaffected|safe|cleared|recalled|not recalled|not affected|outside (?:the )?recall scope)\\b(?:\\s*\\(${statusLabel}\\))?)?`,"gi");
 const classification="(?:affected|unaffected|safe|cleared|recalled|not recalled|not affected|outside (?:the )?recall scope)";
 const cannotClassify=new RegExp(`\\b(?:cannot|can't|can not|must not|should not|may not|will not|would not|could not)\\s+(?:be\\s+)?class(?:ed|ified)\\s+as\\s+${classification}\\b(?:\\s*\\(${statusLabel}\\))?(?:\\s+(?:or|and)\\s+${classification}\\b(?:\\s*\\(${statusLabel}\\))?)?(?:\\s+without\\s+(?:verification|identity verification|a verified identity|additional evidence))?`,"gi");
 const neitherClassify=new RegExp(`\\b(?:neither|no|none)\\s+(?:local\\s+)?(?:rows?|records?|devices?|units?)\\s+(?:can|could|may|should|must|would|will)\\s+be\\s+class(?:ed|ified)\\s+as\\s+${classification}\\b(?:\\s*\\(${statusLabel}\\))?(?:\\s+(?:or|and)\\s+${classification}\\b(?:\\s*\\(${statusLabel}\\))?)?(?:\\s+without\\s+(?:verification|identity verification|a verified identity|additional evidence))?`,"gi");
 const remaining=text.replace(deniedPredicate,"").replace(deniedSubject,"").replace(deniedClassification,"").replace(cannotClassify,"").replace(neitherClassify,"").replace(/\b(?:not|never)\s+(?:(?:generally|necessarily|demonstrably)\s+)?(?:safe|cleared|unaffected)(?:\s+(?:or|and)\s+(?:safe|cleared|unaffected))*\b|\b(?:cannot|does not|do not)\s+(?:establish|prove|mean|imply)\b[^.!?;]{0,30}(?:safe|cleared|unaffected|not recalled|not affected)/gi,"");
 return new RegExp(`\\b${predicate}\\b`,"i").test(remaining);
}
function localClearanceClaim(text:string,recordIds:readonly string[],recordEvidence:boolean,noticeEvidence:boolean,documentaryOnlyEvidence:boolean):boolean {
 const documentaryAttribution=/\b(?:notice|notification|source|letter|document|manufacturer)\b/i.test(text);
 const hasLocalSubject=recordIds.some(id=>exactEvidenceTokenIndex(text,id)>=0)||/\b(?:local|records?|rows?|inventory|stock|on[ -]hand)\b/i.test(text);
 return reportClauses(text).some(clause=>{
  if(!assertsClearance(clause))return false;
  const named=recordIds.some(id=>exactEvidenceTokenIndex(clause,id)>=0);
  const local=/\b(?:local|records?|rows?|inventory|stock|on[ -]hand)\b/i.test(clause);
  const documentary=/\b(?:notice|notification|source|letter|document|manufacturer)\b/i.test(clause);
  const genericDevice=/\b(?:this|that)\s+(?:device|unit|item)\b|\b(?:these|those)\s+(?:devices|units|items)\b|\b(?:our|my|the)\s+(?:devices?|units?|items?)\b/i.test(clause);
  // Attribution may carry to a qualified documentary population in the next sentence.
  // Irrelevant selected R refs do not turn notice-only manufacturing scope into a local
  // certification. Named/local subjects, row evidence and generic device clearance retain guards.
  const qualifiedScope=/\b(?:devices?|products?|units?|lots?|batches?|models?)\s+(?:manufactur\w*|made\s+(?:after|before)\b|(?:listed|described|identified)\s+in\b)/i.test(clause)&&/\b(?:unaffected|not affected|not recalled|outside (?:the )?recall scope)\b/i.test(clause)&&!/\b(?:safe|cleared|match\w*|checked|recorded|supplied)\b/i.test(clause);
  if(!named&&!local&&!genericDevice&&!hasLocalSubject&&documentaryOnlyEvidence&&documentaryAttribution&&qualifiedScope)return false;
  if(genericDevice&&recordEvidence)return true;
  return named||local||!noticeEvidence||recordEvidence&&!documentary;
 });
}


/** Counts need literal source wording; an unexecuted model count is not checked arithmetic. */
function unsupportedCountClaim(text:string,evidenceText:string):boolean {
 // Attachment/table/section numbers are labels, not quantities. Remove only
 // the bounded label-number pair; counts following that reference still test.
 const countText=text.replace(/\b(?:attachment|appendix|exhibit|table|figure|annex|schedule|section|page)\s+(?:no\.?\s*)?#?\d+(?:[.-]\d+)*\b/gi," ").replace(/\b(?:document|notice|source)\s+(?:no\.?\s*)?#?\d+(?:[.-]\d+)*(?=\s+(?:(?:lot|batch|product)\s+)?(?:check|status|comparison|result)\b)/gi," ").replace(/\b(matches?|matching)\s+(?:a\s+)?(?:document|notice|source)\s+(?:no\.?\s*)?#?\d+(?:[.-]\d+)*(?=\s+(?:lot|batch)\b)/gi,"$1 a source");
 for(const match of countText.matchAll(/(?<![\p{L}\p{N}_:./-])(\d{1,3})\s+(?:(?:distinct|affected|recalled|listed)\s+)?(batches?|lots?|models?|devices?|units?)\b/giu)){
  const literal=new RegExp(`\\b${match[1]}\\s+(?:(?:distinct|affected|recalled|listed)\\s+)?${match[2]}\\b`,"i");
  if(!literal.test(evidenceText))return true;
 }
 return false;
}
function assertsScopeReduction(text:string):boolean {
 return text.split(/(?<=[.!?])\s+|;\s*/).some(clause=>{
  if(/\b(?:no evidence|not established|cannot establish|does not establish|does not mean|do not infer|not shown)\b|\b(?:not|never|does not|did not|do not|cannot)\s+(?:narrow\w*|reduc\w*)\b/i.test(clause))return false;
  // A prior-state descriptor such as "limited lots" can look like an action
  // when the report says scope changed from those lots to all lots. Mask only
  // that explicit expansion transition, then keep the established detector for
  // actual limit/narrow/reduce predicates elsewhere in the same clause.
  // Likewise "the August 2025 notice limited removal to listed lots" describes the
  // earlier notice's own scope, not a reduction. Mask only that attributed prior-notice
  // predicate; a reduction asserted elsewhere in the clause still trips the detector.
  const withoutExpansion=clause.replace(/\bfrom\b[^.!?;,]{0,55}?\b(?:limited|restricted|selected|specific|some|subset)\b[^.!?;,]{0,55}?\bto\b[^.!?;,]{0,40}?\b(?:all|every|entire|full|unrestricted)\b/gi," ")
    .replace(/\b(?:earlier|previous|prior|original|initial|first|older|(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{1,2},?)?\s+\d{4})\s+(?:field\s+safety\s+)?(?:notices?|notifications?|letters?|FSNs?)\b\s+(?:had\s+|was\s+|were\s+)?(?:limited|restricted)\b/gi," prior notice described ");
  return /\b(?:narrow(?:s|ed|ing)?|reduc(?:e[sd]?|ing)|limit(?:s|ed|ing)?)\b[^.!?;]{0,70}\b(?:scope|recall|affected|batches|lots)\b|\b(?:scope|recall|affected (?:batches|lots))\b[^.!?;]{0,70}\b(?:narrow(?:s|ed|ing)?|reduc(?:e[sd]?|ing)|limit(?:s|ed|ing)?)\b/i.test(withoutExpansion);
 });
}
function explicitPriorScopeWithdrawal(text:string):boolean {
 return text.split(/(?<=[.!?])\s+|;\s*/).some(clause=>{
  if(/\b(?:no|none|neither|not|never|does not|do not|no evidence)\b[^.!?;]{0,150}\b(?:withdraw\w*|revok\w*|reduc\w*|narrow\w*)/i.test(clause))return false;
  return /\b(?:previously|earlier|prior|previous)\b[^.!?;]{0,100}\b(?:batches|lots|scope|recall)\b[^.!?;]{0,70}\b(?:withdrawn|revoked|no longer (?:recalled|affected|included))\b|\b(?:affected|recalled) scope\b[^.!?;]{0,40}\b(?:is|has been) (?:reduced|narrowed)\b/i.test(clause);
 });
}
function sharedImmediateStopUseClaim(text:string,recordIds:readonly string[]=[]):boolean {
 // Contrast clauses must not transfer an earlier action into a different
 // later duty. Keep the split local so other claim detectors retain their
 // existing handling of temporal "while" clauses.
 return reportClauses(text).flatMap(clause=>clause.split(/\b(?:while|whereas)\b/i)).some(clause=>{
  if(/\b(?:not|never|neither|cannot|no evidence|do not|does not)\b/i.test(clause))return false;
  const explicitNotices=/\b(?:both|each|the two)\s+(?:notices?|sources?|notifications?|documents?)\b/i.test(clause);
  const local=/\b(?:local|records?|rows?|inventory|stock)\b/i.test(clause)||recordIds.some(id=>exactEvidenceTokenIndex(clause,id)>=0);
  const shared=explicitNotices||!local&&/\b(?:both|each notice|unchanged|retain(?:s|ed|ing)?)\b/i.test(clause);
  const immediate=/\bimmediate(?:ly)?\b[^.!?;]{0,45}\b(?:ceas\w*|cessation|stop\w*|discontinu\w*)\b[^.!?;]{0,25}\b(?:use|using)\b|\b(?:ceas\w*|cessation|stop\w*|discontinu\w*)\b[^.!?;]{0,25}\b(?:use|using)\b[^.!?;]{0,25}\bimmediate(?:ly)?\b/i.test(clause);
  return shared&&immediate;
 });
}
function unconditionalImmediateStopUseQuote(text:string):boolean {
 return text.split(/(?<=[.!?])\s+|;\s*/).some(clause=>{
  if(/\b(?:if|when|unless|only when|in the event|not|never|neither|cannot|no|do not|does not)\b/i.test(clause))return false;
  return /\bimmediate(?:ly)?\b[^.!?;]{0,45}\b(?:ceas\w*|cessation|stop\w*|discontinu\w*)\b[^.!?;]{0,25}\b(?:use|using)\b|\b(?:ceas\w*|cessation|stop\w*|discontinu\w*)\b[^.!?;]{0,25}\b(?:use|using)\b[^.!?;]{0,25}\bimmediate(?:ly)?\b/i.test(clause);
 });
}
const mentionsRecord=(text:string,id:string)=>exactEvidenceTokenIndex(text,id)>=0;
/** Server-record mode: a sentence that names no record, states no match/classification and only
 *  recommends review is a documentary review criterion, not a record claim. Clearance checks still
 *  run on the full text; only the scalar-claim detector skips these sentences. */
function withoutGenericReviewCriteria(text:string,recordIds:readonly string[]):string{
 return text.split(/(?<=[.!?])\s+/).filter(sentence=>{
  if(recordIds.some(id=>mentionsRecord(sentence,id)))return true;
  const review=/\b(?:needs?\s+(?:human\s+)?review|requires?\s+review|(?:must|should)\s+be\s+(?:re)?(?:checked|reviewed|verified)|(?:re)?check(?:ed)?\s+against|review(?:ed)?\s+against)\b/i.test(sentence);
  const status=/\b(?:match(?:es|ed|ing)?|within|outside|excluded|included|covered|cleared|safe|unaffected|affected|not recalled|eligible)\b/i.test(sentence);
  return !(review&&!status);
 }).join(" ");
}
function localScalarClaims(text:string,hasNamedRecord=false){
 const local=hasNamedRecord||/\b(?:local|records?|inventory|stock|on[ -]hand|units?|rows?)\b/i.test(text);
 return {local,product:local&&/\b(?:product|model|UDI|GTIN)\b[^.?!;]{0,45}\b(?:match(?:es|ed|ing)?|no[_ -]?match|unknown|exact)\b|\bmatch(?:es|ed|ing)?\b[^.?!;]{0,45}\b(?:product|model|UDI|GTIN)\b/i.test(text),manufacture:local&&/manufactur\w*(?:[ -]date)?[^.?!;]{0,80}\b(?:within|outside|match(?:es|ed|ing)?|no[_ -]?match|unknown|included|excluded|covered|affected)\b/i.test(text),configuration:local&&/\b(?:configuration|host[_ ]?os|host (?:operating system)|operating system|connector|retainer(?:[ _-]ring)?|ring(?:[ _-](?:colou?r|condition))?|reservoir[ _-]lock)\b[^.?!;]{0,80}\b(?:matches?|matched|affected|eligible|covered|within|included)\b|\b(?:matches?|matched|affected|eligible|covered|within|included)\b[^.?!;]{0,80}\b(?:configuration|host[_ ]?os|operating system|connector|retainer(?:[ _-]ring)?|ring(?:[ _-](?:colou?r|condition))?|reservoir[ _-]lock)\b/i.test(text),distribution:local&&/distribut\w*(?:[ -]date)?[^.?!;]{0,80}\b(?:within|outside|match(?:es|ed|ing)?|no[_ -]?match|unknown|included|excluded|covered|affected|falls)\b/i.test(text),lot:local&&/\b(?:lot|batch)(?: numbers?| codes?| conditions?)?\b[^.?!;]{0,45}\b(?:match(?:es|ed|ing)?|no[_ -]?match|unknown|within|outside|included|excluded)\b/i.test(text)};
}
/** Documentary instructions need a documentary citation; a scalar receipt is not an action source. */
function documentaryActionClaim(text:string){
 const action="(?:quarantin\\w*|stop(?:ping)?\\s+(?:all\\s+)?use|ceas\\w*|cessation|discontinu\\w*|remov\\w*|return\\w*|replac\\w*|notif\\w*|forward\\w*|acknowledg\\w*|inspect\\w*|examin\\w*|check\\w*)";
 const actionWord=new RegExp(`\\b${action}\\b`,"i");
 const imperative=new RegExp(`^\\s*(?:please\\s+)?${action}\\s+(?:all|any|the|affected|identified|remaining|these|those)\\b`,"i");
 // These bounded artifact/history spans describe verification work, not a current
 // manufacturer instruction. Keep every other action word so a separate positive
 // instruction in the same sentence, including after "and", still requires notice E.
 const historyAction="(?:return|quarantin\\w*|replacement|notification|forwarding|acknowledg(?:e)?ment|removal|cessation)";
 const artifact="(?:completion|status|records?|receipts?|documentation|evidence)";
 const quotedHistory=/\bprior\s+(?:decision|status|note|record|action)\s*(?:(?:was|is|says|stated|recorded)\s*:?\s*)?(?:“[^”]{0,500}”|"[^"\n]{0,500}"|'[^'\n]{0,500}')/gi;
 // A local request for completion/status follow-up names an evidence artifact.
 // Replace only that noun phrase; any separate physical obligation stays visible.
 const workflowText=/\b(?:local|supplied|synthetic)\s+(?:records?|rows?)\b/i.test(text)
  ?text.replace(new RegExp(`\\b(?:needs?|requires?)\\s+${historyAction}[ -](?:completion|status)\\s+follow[ -]?up\\b`,"gi"),"needs follow-up for workflow history")
  :text;
 const outsideQuotes=workflowText.replace(quotedHistory,"prior history");
 const obligation="(?:must|shall|should|required?|requires?|requiring|instruct\\w*|directs?|recommend\\w*|mandates?|orders?|needs?(?:\\s+to)?)";
 const reviewTarget=/^\s*(?:(?:be|not|never|now|still|further|additional|immediate(?:ly)?)\s+)*(?:review(?:ed|ing)?|follow[ -]?up|verif(?:y|ied|ication)|confirm(?:ed|ation)?)(?=\b)/i;
 let reviewOnly=true;
 for(const match of outsideQuotes.matchAll(new RegExp(`\\b${obligation}\\b`,"gi"))){
  const tail=reportClauses(outsideQuotes.slice(match.index+match[0].length))[0]??"";
  if(!reviewTarget.test(tail)){reviewOnly=false;break;}
  // A coordinated adoption is still an obligation: "reviewed and followed" is
  // different from "reviewed and confirmed". Unknown targets retain the quote.
  for(const conjunction of tail.matchAll(/\b(?:and|also|then|plus|as well as)\b|[+&]/gi)){
   const target=tail.slice(conjunction.index+conjunction[0].length).replace(new RegExp(`^\\s*${obligation}\\b`,"i"),"");
   if(!reviewTarget.test(target)){reviewOnly=false;break;}
  }
  if(!reviewOnly)break;
 }
 const prepared=(reviewOnly?outsideQuotes:workflowText)
  .replace(new RegExp(`\\b(?:verify|confirm)\\s+whether\\s+${historyAction}\\s+${artifact}\\s+(?:is|was|has\\s+been)\\s+(?:recorded|documented|verified|confirmed)\\b`,"gi"),"verify workflow history")
  .replace(new RegExp(`\\b${historyAction}\\s+${artifact}\\s+(?:(?:is|are|was|were|remains?)\\s+)?(?:still\\s+)?(?:unknown|unverified|missing|unrecorded|unavailable|not\\s+(?:recorded|documented|confirmed|verified|available))\\b`,"gi"),"unknown workflow history")
  .replace(/\breturn\s+verification\b/gi,"workflow verification");
 return reportClauses(prepared).some(clause=>imperative.test(clause)||actionWord.test(clause)&&(/\b(?:notices?|manufacturer|supplier|communication|letters?|instructions?)\b/i.test(clause)||/\b(?:must|shall|required?|requires?|requiring|instruct\w*|directs?|recommend\w*|mandates?|orders?|should|need(?:s)?\s+to)\b/i.test(clause)));
}
function validateLocalScalarClaims(text:string,checks:NonNullable<InvestigationFinding["recordChecks"]>,results:Map<string,BoundRecordMatch>,codes:Set<string>,sourceLabels:Map<string,string[]> = new Map()){
 let previousNamed=new Set<string>();
 const genericLabels=/^(?:match|lot|product|record|notice|source|document|unknown|result|check|status)$/i;
 const statusPattern=/\b(?:not(?:\s+a)?\s+match(?:es|ed|ing)?|(?:does not|did not|do not)\s+match(?:es|ed|ing)?|no[_ -]?match|unknown|outside|excluded|not\s+(?:within|included|covered|eligible|exact)|match(?:es|ed|ing)?|within|included|covered|eligible|exact)\b/giu;
 const statusOf=(value:string):"match"|"no_match"|"unknown"=>/^unknown$/i.test(value)?"unknown":/^(?:not(?:\s+a)?\s+match|(?:does not|did not|do not)\s+match|no[_ -]?match|outside|excluded|not\s+(?:within|included|covered|eligible|exact))$/i.test(value)?"no_match":"match";
 const claimClauses=text.split(/(?<=[.!?])\s+|;\s*/).flatMap(sentence=>sentence.split(/\b(?:but|however|yet)\b/gi).map(clause=>({sentence,clause})));
 for(const {sentence,clause} of claimClauses){
  const explicitNamed=new Set([...results.values()].filter(result=>mentionsRecord(sentence,result.recordId)).map(result=>result.recordId));
  const anaphoric=/^\s*(?:(?:it|its|they|their|both|these|those)\b|(?:this|the)\s+(?:same\s+)?(?:records?|rows?|devices?|products?|models?|lots?|batches|manufactur\w*(?:[ -]date)?))\b/i.test(sentence);
  const sourceContinuation=[...sourceLabels.values()].some(labels=>labels.some(label=>label.length>=3&&!genericLabels.test(label)&&new RegExp(`(?<![\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![\\p{L}\\p{N}_])`,"iu").test(sentence)));
  const named=explicitNamed.size?explicitNamed:anaphoric||sourceContinuation?new Set(previousNamed.size?previousNamed:checks.flatMap(check=>{const result=results.get(check.resultId);return result?[result.recordId]:[];})):new Set<string>();
  if(explicitNamed.size)previousNamed=explicitNamed;
  else if(/\b(?:notice|notification|source|letter|document|manufacturer)\b/i.test(clause)&&!anaphoric&&!sourceContinuation)previousNamed=new Set();
  const claims=localScalarClaims(sentence,named.size>0);
  if(!Object.entries(claims).some(([key,value])=>key!=="local"&&value))continue;
  if(!checks.length)codes.add("record_claim_requires_checked_reference");
  if(claims.configuration||claims.distribution)codes.add("record_match_field_claim_mismatch");
  const selected=checks.flatMap(check=>{const result=results.get(check.resultId);return result&&(!named.size||named.has(result.recordId))?[result]:[];});
  for(const [field,claimed] of [["manufacture_date",claims.manufacture],["lot",claims.lot],["product",claims.product]] as const)if(claimed){
   const typed=selected.filter(result=>result.field===field);
   if(!typed.length||[...named].some(recordId=>!typed.some(result=>result.recordId===recordId))){codes.add("record_match_field_claim_mismatch");continue;}
   const mentions:Array<{sourceId:string;index:number;label:string}>=[];
   for(const [sourceId,labels] of sourceLabels)for(const label of labels){
    if(label.length<3||genericLabels.test(label))continue;
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,"giu");
    for(const match of clause.matchAll(pattern))mentions.push({sourceId,index:match.index!,label});
   }
   const uniqueMentions=[...new Map(mentions.sort((a,b)=>a.index-b.index).map(mention=>[`${mention.sourceId}:${mention.index}`,mention])).values()];
   const explicitDocumentNumbers=new Set(uniqueMentions.flatMap(mention=>(sourceLabels.get(mention.sourceId)??[]).map(label=>label.match(/^Document\s+(\d+)$/i)?.[1]).filter((value):value is string=>!!value)));
   const hasElidedDocumentReference=[...clause.matchAll(/\bDocument\s+(\d+)\s+and\s+(\d+)\b/gi)].some(match=>[match[1]!,match[2]!].some(number=>[...sourceLabels.values()].some(labels=>labels.some(label=>new RegExp(`^Document\\s+${number}$`,`i`).test(label)))&&!explicitDocumentNumbers.has(number)));
   if(!uniqueMentions.length){
    const descriptions=[...clause.matchAll(/\b(?:status\s+(?:is\s+)?|(?:check|comparison|result)(?:\s+status)?\s+(?:is\s+)?|(?:is|was|were)\s+(?:a\s+)?)(unknown|no[_ -]?match|match)\b/gi)];
    const declared=new Set(descriptions.map(item=>item[1]!.toLowerCase().replace(/[ -]/g,"_")));
    if(declared.size===1&&typed.some(result=>!declared.has(result.status)))codes.add("record_check_status_does_not_support_classification");
    const withoutDescriptions=clause.replace(/\b(?:(?:match|check|comparison|result)\s+)?status\s+(?:is\s+)?(?:unknown|no[_ -]?match|match)\b/gi," ");
    const negative=/\b(?:outside|excluded|(?:does not|did not|do not|not(?:\s+a)?|no)[ _-]+match(?:es|ed|ing)?)\b/i.test(withoutDescriptions);
    const positiveText=withoutDescriptions.replace(/\b(?:does not|did not|do not|not(?:\s+a)?|no)[ _-]+match(?:es|ed|ing)?\b/gi," ");
    const positive=/\b(?:match(?:es|ed|ing)?|within|included|covered|eligible|exact)\b/i.test(positiveText);
    if(positive||negative){if(typed.some(result=>result.status==="unknown"))codes.add("unknown_record_check_cannot_prove_classification");if((positive&&!negative&&typed.some(result=>result.status!=="match"))||(negative&&!positive&&typed.some(result=>result.status!=="no_match")))codes.add("record_check_status_does_not_support_classification");}
    continue;
   }
   const contrasts:Array<{text:string;start:number}>=[];let start=0;
   for(const match of clause.matchAll(/\b(?:while|whereas|but|however)\b/gi)){contrasts.push({text:clause.slice(start,match.index!),start});start=match.index!+match[0].length;}contrasts.push({text:clause.slice(start),start});
   let pairingFailed=hasElidedDocumentReference;
   for(const part of contrasts){
    const partMentions=uniqueMentions.filter(item=>item.index>=part.start&&item.index<part.start+part.text.length).map(item=>({...item,index:item.index-part.start}));
    if(!partMentions.length)continue;
    const statuses=[...part.text.matchAll(statusPattern)].map(match=>({index:match.index!,status:statusOf(match[0])}));
    if(!statuses.length||statuses.length>1&&statuses.length!==partMentions.length){pairingFailed=true;continue;}
    const pairs=statuses.length===1?partMentions.map(mention=>({mention,status:statuses[0]!.status})):partMentions.map(mention=>{
     const ranked=statuses.map(status=>({status,distance:Math.abs(status.index-mention.index)})).sort((a,b)=>a.distance-b.distance);return {mention,status:ranked[0]!.status.status,tie:ranked[1]?.distance===ranked[0]!.distance};
    });
    for(const pair of pairs){
     if("tie" in pair&&pair.tie){pairingFailed=true;continue;}
     const sourceTyped=typed.filter(result=>result.evidence.some(proof=>proof.sourceId===pair.mention.sourceId));
     if(!sourceTyped.length||[...named].some(recordId=>!sourceTyped.some(result=>result.recordId===recordId))||sourceTyped.some(result=>result.status!==pair.status))codes.add("record_check_status_does_not_support_classification");
     if(pair.status!=="unknown"&&sourceTyped.some(result=>result.status==="unknown"))codes.add("unknown_record_check_cannot_prove_classification");
    }
   }
   if(pairingFailed)codes.add("record_check_status_does_not_support_classification");
  }
 }
}


/** Validate exact binding plus bounded comparison/field assertions. Arbitrary narrative truth remains unverified. */
export function validateInvestigationReport(
  registry: EvidenceRegistry,
  selectedIds: string[],
  input: InvestigationReportInput,
  context:{runId?:string;question?:string;recordMatches?:BoundRecordMatch[];issueSink?:InvestigationValidationIssue[];serverRecordFindings?:boolean}={},
): { valid: boolean; codes: string[] } {
  const codes = new Set<string>();
  let activeFindingIndex:number|undefined;
  if(context.issueSink){
    const allowed=new Set<string>(INVESTIGATION_DOMAIN_FEEDBACK_CODES),seen=new Set<string>();
    const originalAdd=codes.add.bind(codes);
    codes.add=(code:string)=>{
      const key=`${activeFindingIndex??"report"}:${code}`;
      if(allowed.has(code)&&!seen.has(key)){
        seen.add(key);
        context.issueSink!.push({...(activeFindingIndex===undefined?{}:{findingIndex:activeFindingIndex}),code:code as InvestigationDomainFeedbackCode});
      }
      return originalAdd(code);
    };
    const addUnsupportedTokens=(tokens:string[])=>{
      if(!tokens.length)return;
      const missing=[...new Set(tokens)].filter(token=>token.length<=100&&/^[\p{L}\p{N}][\p{L}\p{N}._:/-]{2,99}$/u.test(token)&&/\d/.test(token)).slice(0,12);
      const code="unsupported_identifier_or_date",key=`${activeFindingIndex??"report"}:${code}`;
      originalAdd(code);
      if(allowed.has(code)&&!seen.has(key)){
        seen.add(key);
        context.issueSink!.push({...(activeFindingIndex===undefined?{}:{findingIndex:activeFindingIndex}),code,...(missing.length?{unsupportedTokens:missing}:{})});
      }
    };
    (codes as Set<string>&{addUnsupportedTokens?:(tokens:string[])=>void}).addUnsupportedTokens=addUnsupportedTokens;
  }
  const boundedSelected = Array.isArray(selectedIds) ? selectedIds.slice(0, 12) : [];
  const selected = new Set(boundedSelected);
  const refs = new Map<string, EvidenceEntry>();
  for (const entry of registry.entries) for (const ref of entry.refs) if (ref !== entry.id && !refs.has(ref)) refs.set(ref, entry);
  for (const entry of registry.entries) refs.set(entry.id, entry);
  if (!Array.isArray(selectedIds) || selectedIds.length > 12) codes.add("invalid_selection");
  for (const id of boundedSelected) if (typeof id !== "string" || !refs.has(id)) codes.add("unknown_selection");
  if (!input || !["answered", "needs_evidence", "plan"].includes(input.disposition)) codes.add("invalid_disposition");
  if (!boundedText(input?.summary, 2000)) codes.add("invalid_summary");
  if (!Array.isArray(input?.findings) || input.findings.length < 1 || input.findings.length > 6) codes.add("invalid_findings");

  let missingEvidenceFinding = false;
  const comparedNotices=new Set<string>();
  const usedRecordResults=new Set<string>();
  const recordResults=new Map((context.recordMatches??[]).map(result=>[result.resultId,result]));
  const sourceLabelsFor=(checks:NonNullable<InvestigationFinding["recordChecks"]>)=>{
    const labelsBySource=new Map<string,Set<string>>();
    for(const check of checks){
      const result=recordResults.get(check.resultId);if(!result)continue;
      for(const proof of result.evidence){
        const source=refs.get(proof.sourceId);
        if(!source||source.kind!=="notice"||!selected.has(source.id))continue;
        const labels=labelsBySource.get(source.id)??new Set<string>();
        for(const label of [source.id,source.title,...source.refs])if(label.trim())labels.add(label.trim());
        labelsBySource.set(source.id,labels);
      }
    }
    const owners=new Map<string,Set<string>>();
    for(const [sourceId,labels] of labelsBySource)for(const label of labels){const ids=owners.get(label)??new Set<string>();ids.add(sourceId);owners.set(label,ids);}
    return new Map([...labelsBySource].map(([sourceId,labels])=>[sourceId,[...labels].filter(label=>owners.get(label)?.size===1)]));
  };
  const knownRecordIds=[...new Set([...recordResults.values()].map(result=>result.recordId))];
  const globalReceiptIds=input?.recordReceiptIds;
  const atomicReceipts=input?.recordCitationMode==="atomic_receipts_v1";
  // With server-rendered record findings the backend covers every checked row itself;
  // model findings must stay documentary and are rejected if they make record claims.
  const serverRecordFindings=!!context.serverRecordFindings&&atomicReceipts;
  // In server-record mode every existing record-claim detector also reports the explicit
  // boundary code, so a correction knows to remove the record claim, not to re-cite it.
  const RECORD_CLAIM_CODES=new Set(["record_claim_requires_checked_reference","record_match_field_claim_mismatch","record_check_status_does_not_support_classification","unknown_record_check_cannot_prove_classification","field_match_does_not_establish_clearance","record_match_mismatch"]);
  let recordClaimSeen=false;
  if(serverRecordFindings){const innerAdd=codes.add.bind(codes);codes.add=(code:string)=>{if(RECORD_CLAIM_CODES.has(code))recordClaimSeen=true;return innerAdd(code);};}
  const requiresFindingRecordCoverage=!serverRecordFindings&&!!context.question&&investigationRequirements(context.question,registry).recordMatching&&recordResults.size>0&&atomicReceipts;
  const findingCoveredRecordIds=new Set<string>();
  const findingQuoteLimit=atomicReceipts?8:5, findingCheckLimit=atomicReceipts?24:12;
  if(input?.recordCitationMode!==undefined&&!atomicReceipts)codes.add("invalid_record_citation_mode");
  if(atomicReceipts&&globalReceiptIds===undefined)codes.add("atomic_record_receipts_require_global_binding");
  const globalReceiptProofs:EvidenceEntry["content"][]=[];
  if(globalReceiptIds!==undefined){
    const stored=context.recordMatches??[];
    const validShape=Array.isArray(globalReceiptIds)&&globalReceiptIds.length<=24&&globalReceiptIds.every(id=>typeof id==="string"&&/^[a-f0-9]{64}$/.test(id))&&new Set(globalReceiptIds).size===globalReceiptIds.length;
    if(!validShape)codes.add("invalid_global_record_receipts");
    if(stored.length>24||new TextEncoder().encode(JSON.stringify(stored)).byteLength>48_000)codes.add("record_receipt_capacity_exceeded");
    if(!validShape||globalReceiptIds.length!==stored.length||stored.some(result=>!globalReceiptIds.includes(result.resultId)))codes.add("record_receipt_coverage_required");
    for(const id of Array.isArray(globalReceiptIds)?globalReceiptIds.slice(0,24):[]){
      const result=recordResults.get(id);
      if(!result){codes.add("unknown_global_record_receipt");continue;}
      const {resultId,...body}=result;
      const exact=result.runId===context.runId&&result.snapshotHash===registry.snapshotHash&&sha256(JSON.stringify(body))===resultId&&Array.isArray(result.evidence)&&result.evidence.length>0&&["notice","record"].every(kind=>result.evidence.some(proof=>refs.get(proof.sourceId)?.kind===kind))&&result.evidence.every(proof=>{
        const source=refs.get(proof.sourceId);
        return !!source&&selected.has(source.id)&&source.snapshotHash===registry.snapshotHash&&source.sourceHash===proof.sourceHash&&sha256(source.content)===proof.sourceHash&&boundedText(proof.quote,1000)&&source.content.includes(proof.quote);
      });
      if(!exact){codes.add("invalid_global_record_receipt_binding");continue;}
      usedRecordResults.add(id);globalReceiptProofs.push(...result.evidence.map(proof=>proof.quote));
    }
  }

  for (const [findingIndex,finding] of (Array.isArray(input?.findings) ? input.findings.slice(0, 6) : []).entries()) {
    activeFindingIndex=findingIndex;recordClaimSeen=false;
    if (!finding || !["conflict", "missing_evidence", "observation"].includes(finding.kind) ||
        !boundedText(finding.id, 120) || !boundedText(finding.summary, 1000) || !Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > findingQuoteLimit || Array.isArray(finding.recordChecks) && finding.recordChecks.length > findingCheckLimit) {
      codes.add("invalid_finding"); continue;
    }
    if (finding.kind === "missing_evidence") missingEvidenceFinding = true;
    const citedSources = new Set<string>();
    for (const citation of finding.evidence.slice(0, findingQuoteLimit)) {
      if (!citation || !boundedText(citation.sourceId, 200) || !boundedText(citation.sourceHash, 128) ||
          !boundedText(citation.quote, 1000) || citation.quote.length > 1000) {
        codes.add("invalid_quote"); continue;
      }
      const entry = refs.get(citation.sourceId);
      if (!entry) { codes.add("unknown_evidence_source"); continue; }
      citedSources.add(entry.id);
      if (!selected.has(citation.sourceId) && !selected.has(entry.id)) codes.add("unselected_evidence");
      if (citation.sourceHash !== entry.sourceHash) codes.add("stale_source_hash");
      if (!entry.content.includes(citation.quote)) codes.add("quote_not_found");
    }
    const evidenceText=finding.evidence.map(citation=>citation.quote).join("\n");
    if(serverRecordFindings&&(knownRecordIds.some(id=>mentionsRecord(finding.summary,id))||finding.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="record")||(Array.isArray(finding.recordChecks)&&finding.recordChecks.length>0)))codes.add("record_findings_are_server_generated");
    if(atomicReceipts&&documentaryActionClaim(finding.summary)&&!finding.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="notice"))codes.add("documentary_action_requires_notice_quote");
    if(globalReceiptIds!==undefined){
      const checks=Array.isArray(finding.recordChecks)?finding.recordChecks:[];
      validateLocalScalarClaims(serverRecordFindings?withoutGenericReviewCriteria(finding.summary,knownRecordIds):finding.summary,checks,recordResults,codes,sourceLabelsFor(checks));
      const usedRecords=new Set(checks.flatMap(check=>{const result=recordResults.get(check.resultId);return result?[result.recordId]:[];}));
      if(requiresFindingRecordCoverage){
        for(const recordId of knownRecordIds){
          if(!mentionsRecord(finding.summary,recordId))continue;
          const referenced=checks.map(check=>recordResults.get(check.resultId)).filter((result):result is BoundRecordMatch=>!!result&&result.recordId===recordId&&usedRecordResults.has(result.resultId));
          const hasExactRowEvidence=referenced.some(result=>result.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="record"&&mentionsRecord(proof.quote,recordId)&&finding.evidence.some(citation=>citation.sourceId===proof.sourceId&&citation.sourceHash===proof.sourceHash&&citation.quote.includes(proof.quote))));
          if(referenced.length&&hasExactRowEvidence)findingCoveredRecordIds.add(recordId);
        }
      }
      const namedRecords=[...new Set((context.recordMatches??[]).filter(result=>mentionsRecord(finding.summary,result.recordId)).map(result=>result.recordId))];
      if(namedRecords.some(id=>!usedRecords.has(id))||finding.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="record")&&!checks.length)codes.add("record_claim_requires_checked_reference");
      if(unsupportedCountClaim(finding.summary,evidenceText))codes.add("numeric_count_requires_source_or_checked_calculation");
      if(sharedImmediateStopUseClaim(finding.summary,knownRecordIds)){
        const noticeIds=[...new Set(finding.evidence.filter(proof=>refs.get(proof.sourceId)?.kind==="notice").map(proof=>proof.sourceId))];
        if(noticeIds.length<2||noticeIds.some(id=>!finding.evidence.some(proof=>proof.sourceId===id&&unconditionalImmediateStopUseQuote(proof.quote))))codes.add("shared_immediate_stop_use_requires_both_notice_quotes");
      }
    }

    const missingFindingTokens=evidenceFocusTerms(finding.summary).filter(token=>!evidenceText.includes(token));
    if(missingFindingTokens.length){const add=(codes as Set<string>&{addUnsupportedTokens?:(tokens:string[])=>void}).addUnsupportedTokens;if(add)add(missingFindingTokens);else codes.add("unsupported_identifier_or_date");}
    const comparisons=Array.isArray(finding.comparisons)?finding.comparisons:[];
    if(comparisons.length>2)codes.add("invalid_comparison");
    for(const comparison of comparisons.slice(0,2)){
      if(!comparison||!["same_text","different_text"].includes(comparison.relation)){codes.add("invalid_comparison");continue;}
      const before=refs.get(comparison.before?.sourceId),after=refs.get(comparison.after?.sourceId);
      const valid=(quote:typeof comparison.before,entry:EvidenceEntry|undefined)=>!!entry&&entry.kind==="notice"&&selected.has(entry.id)&&quote.sourceId===entry.id&&quote.sourceHash===entry.sourceHash&&boundedText(quote.quote,1000)&&entry.content.includes(quote.quote)&&finding.evidence.some(citation=>citation.sourceId===quote.sourceId&&citation.sourceHash===quote.sourceHash&&citation.quote===quote.quote);
      if(!valid(comparison.before,before)||!valid(comparison.after,after)||before?.id===after?.id){codes.add("comparison_requires_two_cited_notices");continue;}
      comparedNotices.add(before!.id);comparedNotices.add(after!.id);
      const same=normalizedText(comparison.before.quote)===normalizedText(comparison.after.quote);
      if(same!==(comparison.relation==="same_text"))codes.add("text_comparison_mismatch");
      if(same&&positiveChange(finding.summary))codes.add("unchanged_evidence_cannot_support_change");
    }
    if(globalReceiptIds!==undefined&&assertsScopeReduction(finding.summary)&&!comparisons.some(comparison=>explicitPriorScopeWithdrawal(comparison.after?.quote??"")))codes.add("scope_reduction_requires_explicit_prior_scope_withdrawal");
    if(riskEscalation(finding.summary)){
      if(!comparisons.length)codes.add("risk_change_requires_notice_comparison");
      // Text difference alone is not a checked escalation. Require an explicit escalation in the after source,
      // prior communication alone cannot establish a new escalation, but does not veto an explicit later increase.
      if(!comparisons.some(comparison=>riskEscalation(comparison.after?.quote??"")))codes.add("unsupported_material_risk_change");
    }
    if(/\b(?:absent|unspecified|not specified|not stated|not mentioned)\b/i.test(finding.summary)&&!/\b(?:absent|unspecified|not specified|not stated|not mentioned|null|unknown|missing|not recorded|not available)\b/i.test(evidenceText))codes.add("absence_not_established_by_excerpt");
    if(finding.kind==="conflict"&&/\b(?:follow|refer to|defer to|comply with|in accordance with)\b[^.!?\n]{0,100}\b(?:manufacturer|supplier|original|notice|instructions)\b/i.test(evidenceText))codes.add("delegation_does_not_establish_conflict");
    if(recordResults.size&&localClearanceClaim(finding.summary,knownRecordIds,finding.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="record")||!!finding.recordChecks?.length,finding.evidence.some(proof=>refs.get(proof.sourceId)?.kind==="notice"),finding.evidence.every(proof=>refs.get(proof.sourceId)?.kind==="notice")))codes.add("field_match_does_not_establish_clearance");
    for(const check of Array.isArray(finding.recordChecks)?finding.recordChecks:[]){
      const result=recordResults.get(check.resultId);
      if(!result||result.snapshotHash!==registry.snapshotHash||check.status!==result.status||check.field!==result.field){codes.add("record_match_mismatch");continue;}
      usedRecordResults.add(result.resultId);
      const claimText=finding.summary;
      if(globalReceiptIds===undefined&&result.field!=="lot"&&/\b(?:lot|batch)(?: numbers?| codes?| conditions?)?\b[^.?!;]{0,45}\b(?:match(?:es|ed|ing)?|within|outside|included|excluded)\b/i.test(claimText.replace(/\b(?:cannot|does not|do not)\b[^.?!;]{0,70}\b(?:match|prove|establish)\b/gi,"")))codes.add("record_match_field_claim_mismatch");

      if(globalReceiptIds===undefined&&/manufactur\w*(?:[ -]date)?[^.?!]{0,80}\b(?:within|outside|match(?:es|ed|ing)?|included|excluded|covered|affected)\b|\b(?:within|outside|match(?:es|ed|ing)?|included|excluded|covered|affected)\b[^.?!]{0,80}manufactur/i.test(claimText)&&result.field!=="manufacture_date")codes.add("record_match_field_claim_mismatch");
      if(result.field==="product"&&claimText.split(/[.;!?]/).some(clause=>/\b(?:configuration|host[_ ]?os|operating system|connector)\b/i.test(clause)&&/\b(?:matches?|matched|affected|unaffected|eligible|cleared|safe|covered)\b/i.test(clause)))codes.add("record_match_field_claim_mismatch");
      if(/distribut\w*(?:[ -]date)?[^.?!]{0,80}\b(?:within|outside|match(?:es|ed|ing)?|included|excluded|covered|affected)\b|\b(?:within|outside|match(?:es|ed|ing)?|included|excluded|covered|affected)\b[^.?!]{0,80}distribut/i.test(claimText))codes.add("record_match_field_claim_mismatch");
      // In the attested atomic protocol an explicitly selected check cites its entire exact
      // stored receipt. Its private proofs were checked globally above. Documentary quotes
      // remain independently selected and are never synthesized from those receipt proofs.
      if(!atomicReceipts&&result.evidence.some(quote=>!finding.evidence.some(citation=>citation.sourceId===quote.sourceId&&citation.sourceHash===quote.sourceHash&&citation.quote.includes(quote.quote))))codes.add("record_match_requires_criterion_and_record_quotes");
    }
    if (finding.kind === "conflict" && citedSources.size < 2) codes.add("conflict_needs_two_sources");
    if(serverRecordFindings&&recordClaimSeen)codes.add("record_findings_are_server_generated");
  }
  activeFindingIndex=undefined;recordClaimSeen=false;
  const allFindings=Array.isArray(input?.findings)?input.findings:[];
  if(serverRecordFindings&&knownRecordIds.some(id=>mentionsRecord(input?.summary??"",id)))codes.add("record_findings_are_server_generated");
  if(atomicReceipts&&documentaryActionClaim(input?.summary??"")&&!allFindings.some(finding=>finding.evidence?.some(proof=>refs.get(proof.sourceId)?.kind==="notice")))codes.add("documentary_action_requires_notice_quote");
  const allEvidence=[...allFindings.flatMap(finding=>Array.isArray(finding?.evidence)?finding.evidence:[]).map(quote=>quote?.quote??""),...(atomicReceipts?[]:globalReceiptProofs)].join("\n");
  const missingSummaryTokens=evidenceFocusTerms(input?.summary??"").filter(token=>!allEvidence.includes(token));
  if(missingSummaryTokens.length){const add=(codes as Set<string>&{addUnsupportedTokens?:(tokens:string[])=>void}).addUnsupportedTokens;if(add)add(missingSummaryTokens);else codes.add("unsupported_identifier_or_date");}
  const allComparisons=allFindings.flatMap(finding=>Array.isArray(finding?.comparisons)?finding.comparisons:[]).filter(comparison=>typeof comparison?.before?.quote==="string"&&typeof comparison?.after?.quote==="string");
  if(globalReceiptIds!==undefined){
    const explicitChecks=allFindings.flatMap(finding=>Array.isArray(finding.recordChecks)?finding.recordChecks:[]);
    validateLocalScalarClaims(serverRecordFindings?withoutGenericReviewCriteria(input?.summary??"",knownRecordIds):input?.summary??"",explicitChecks,recordResults,codes,sourceLabelsFor(explicitChecks));
    const explicitlyUsed=new Set(allFindings.flatMap(finding=>Array.isArray(finding.recordChecks)?finding.recordChecks:[]).flatMap(check=>{const result=recordResults.get(check.resultId);return result?[result.recordId]:[];}));
    if((context.recordMatches??[]).some(result=>mentionsRecord(input?.summary??"",result.recordId)&&!explicitlyUsed.has(result.recordId)))codes.add("record_claim_requires_checked_reference");
    if(unsupportedCountClaim(input?.summary??"",allEvidence))codes.add("numeric_count_requires_source_or_checked_calculation");
    if(assertsScopeReduction(input?.summary??"")&&!allComparisons.some(comparison=>explicitPriorScopeWithdrawal(comparison.after?.quote??"")))codes.add("scope_reduction_requires_explicit_prior_scope_withdrawal");
    if(sharedImmediateStopUseClaim(input?.summary??"",knownRecordIds)){
      const proofs=allFindings.flatMap(finding=>Array.isArray(finding.evidence)?finding.evidence:[]),noticeIds=[...new Set(proofs.filter(proof=>refs.get(proof.sourceId)?.kind==="notice").map(proof=>proof.sourceId))];
      if(noticeIds.length<2||noticeIds.some(id=>!proofs.some(proof=>proof.sourceId===id&&unconditionalImmediateStopUseQuote(proof.quote))))codes.add("shared_immediate_stop_use_requires_both_notice_quotes");
    }
  }
  if(riskEscalation(input?.summary??"")&&(!allComparisons.length||!allComparisons.some(comparison=>riskEscalation(comparison.after?.quote??""))))codes.add("unsupported_material_risk_change");
  if(positiveChange(input?.summary??"")&&allComparisons.length&&allComparisons.every(comparison=>normalizedText(comparison.before.quote)===normalizedText(comparison.after.quote)))codes.add("unchanged_evidence_cannot_support_change");
  const documentaryOnlyEvidence=allFindings.length>0&&allFindings.every(finding=>Array.isArray(finding.evidence)&&finding.evidence.length>0&&finding.evidence.every(proof=>refs.get(proof.sourceId)?.kind==="notice"));
  if(recordResults.size&&localClearanceClaim(input?.summary??"",knownRecordIds,allFindings.some(finding=>!!finding.recordChecks?.length||finding.evidence?.some(proof=>refs.get(proof.sourceId)?.kind==="record")),allFindings.some(finding=>finding.evidence?.some(proof=>refs.get(proof.sourceId)?.kind==="notice")),documentaryOnlyEvidence))codes.add("field_match_does_not_establish_clearance");
  if(serverRecordFindings&&recordClaimSeen)codes.add("record_findings_are_server_generated");
  if(context.question&&input?.disposition==="answered"&&investigationRequirements(context.question,registry).recordMatching&&!recordResults.size)codes.add("source_bound_record_matching_required");
  if(requiresFindingRecordCoverage&&knownRecordIds.some(id=>!findingCoveredRecordIds.has(id)))codes.add("record_match_coverage_required");
  if(context.question&&investigationRequirements(context.question,registry).noticeComparison&&comparedNotices.size<2)codes.add("notice_comparison_coverage_required");
  if((context.recordMatches??[]).some(result=>!usedRecordResults.has(result.resultId)))codes.add("record_match_coverage_required");
  if (input?.disposition === "needs_evidence") {
    if (!boundedText(input.question, 500) || input.question.trim().length < 12 || !input.question.trim().endsWith("?")) codes.add("concrete_question_required");
    if (!missingEvidenceFinding) codes.add("missing_evidence_finding_required");
  }
  return { valid: codes.size === 0, codes: [...codes].sort() };
}
