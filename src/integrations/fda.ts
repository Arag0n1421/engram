import { createHash } from "node:crypto";
import type { RecallScope, Snapshot } from "../domain/types.ts";

export interface ReviewedFdaScope {
  recallId: string;
  recordId: string;
  manufacturerRef: string;
  productDescriptionExact: string;
  codeInfoExact: string;
  codeInfoLotSpan: string;
  lastUpdated: string;
  sourceURL: string;
  eachUdi: string;
  caseUdi: string;
  expectedLotCount: number;
  affectedLots: string[];
  evidenceRef: string;
  spanEvidenceRef: string;
  version: string;
}

export interface FdaSourceEvidence {
  sourceURL: string;
  retrievedAt: string;
  rawsha256: string;
  rawJSON: string;
}

export type FdaScopeReview =
  | { status: "reviewed"; scope: RecallScope; recordId: string; rawSha256: string }
  | { status: "abstained"; reasons: string[] };

const LOT = /\b\d{2}[A-Z]{3}\d{3}\b/g;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function text(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Reviews only the captured exact source response and its reviewed code_info grammar. */
export function reviewFdaRecord(source: FdaSourceEvidence, reviewed: ReviewedFdaScope): FdaScopeReview {
  const reasons: string[] = [];
  if (!source || typeof source.rawJSON !== "string") return { status: "abstained", reasons: ["Raw FDA JSON is missing"] };
  const rawSha256 = createHash("sha256").update(source.rawJSON, "utf8").digest("hex");
  if (!/^[a-f0-9]{64}$/.test(source.rawsha256) || source.rawsha256 !== rawSha256) reasons.push("Declared FDA raw hash does not match the captured raw JSON bytes");
  if (source.sourceURL !== reviewed.sourceURL || !Number.isFinite(Date.parse(source.retrievedAt))) reasons.push("FDA source URL or retrieval timestamp is missing or mismatched");
  let payload: unknown;
  try { payload = JSON.parse(source.rawJSON); } catch { return { status: "abstained", reasons: [...reasons, "Raw FDA JSON is invalid"] }; }
  if (!isRecord(payload) || !isRecord(payload.meta) || !isRecord(payload.meta.results) || !Array.isArray(payload.results) || payload.meta.results.total !== 1 || payload.results.length !== 1) {
    return { status: "abstained", reasons: [...reasons, "FDA payload does not contain exactly one result"] };
  }
  const record: unknown = payload.results[0];
  if (!isRecord(record)) return { status: "abstained", reasons: ["FDA record is not an object"] };

  const recallNumber = text(record, "product_res_number");
  const recordId = text(record, "cfres_id");
  const product = text(record, "product_description");
  const codeInfo = text(record, "code_info");
  if (recallNumber !== reviewed.recallId) reasons.push("Recall number does not match reviewed scope");
  if (recordId !== reviewed.recordId) reasons.push("FDA record ID does not match reviewed scope");
  if (payload.meta.last_updated !== reviewed.lastUpdated) reasons.push("FDA dataset last_updated does not match reviewed provenance");
  if (!product || product !== reviewed.productDescriptionExact || !product.includes(reviewed.manufacturerRef) || !/\b100\s*mL\b/i.test(product) || !/normal\s+saline/i.test(product)) {
    reasons.push("Product description does not identify the exact reviewed 100 mL saline product");
  }
  if (product && /RDI30295|sterile\s+water/i.test(product)) reasons.push("Product description includes the separate sterile-water product");
  if (!codeInfo) reasons.push("FDA code_info is missing or not text");
  if (codeInfo !== reviewed.codeInfoExact || !reviewed.codeInfoLotSpan || !codeInfo?.includes(reviewed.codeInfoLotSpan)) reasons.push("FDA code_info differs from the exact reviewed source text and lot span");
  if (reviewed.expectedLotCount !== 32 || !Array.isArray(reviewed.affectedLots) || reviewed.affectedLots.length !== 32 || reviewed.affectedLots.length !== reviewed.expectedLotCount || new Set(reviewed.affectedLots).size !== reviewed.affectedLots.length || reviewed.affectedLots.some(lot => !/^\d{2}[A-Z]{3}\d{3}$/.test(lot))) {
    reasons.push("Reviewed exact-lot scope is incomplete or malformed");
  }
  if (!reviewed.eachUdi || !reviewed.caseUdi || reviewed.eachUdi === reviewed.caseUdi) reasons.push("Reviewed bottle and case identifiers are missing or ambiguous");
  if (!codeInfo) return { status: "abstained", reasons };
  const escapedEach = reviewed.eachUdi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedCase = reviewed.caseUdi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`${escapedEach}\\s*\\(EA\\)`, "i").test(codeInfo) || !new RegExp(`${escapedCase}\\s*\\(CS\\)`, "i").test(codeInfo)) {
    reasons.push("FDA code_info does not identify the reviewed each and case UDIs with their packaging labels");
  }

  // Numeric UDI strings are deliberately excluded from lot extraction. A code-info
  // range or ellipsis means the source text cannot establish a complete exact list.
  if (/\b(?:through|thru|to)\b|\.\.\.|…|\b(?:all|remaining)\s+(?:other\s+)?lots?\b|\betc\.?\b|\band others?\b|\bincluding but not limited to\b|\bnot limited to\b/i.test(codeInfo) || /\b\d{2}[A-Z]{3}\d{3}\s*[-–—]\s*\d{2}[A-Z]{3}\d{3}\b/i.test(codeInfo)) {
    reasons.push("FDA code_info uses a range or truncated lot statement");
  }
  const found = (codeInfo.match(LOT) ?? []);
  const foundSet = new Set(found);
  const expected = new Set(reviewed.affectedLots);
  if (found.length !== reviewed.expectedLotCount || foundSet.size !== reviewed.expectedLotCount || foundSet.size !== expected.size || [...expected].some(lot => !foundSet.has(lot))) {
    reasons.push("FDA code_info does not contain the complete reviewed lot list as exact identifiers");
  }
  if (reasons.length) return { status: "abstained", reasons };

  return {
    status: "reviewed",
    recordId: reviewed.recordId,
    rawSha256,
    scope: {
      recallId: reviewed.recallId,
      manufacturerRef: reviewed.manufacturerRef,
      affectedLots: [...reviewed.affectedLots],
      complete: true,
      reviewLots: [],
      version: reviewed.version,
      evidenceRefs: [reviewed.evidenceRef, reviewed.spanEvidenceRef, `FDA-RAW-SHA256:${rawSha256}`],
    },
  };
}

/** Applies a validated scope to a cloned snapshot; an abstention always fails closed. */
export function applyReviewedFdaScope(snapshot: Snapshot, review: FdaScopeReview): Snapshot {
  const next = structuredClone(snapshot);
  if (review.status === "reviewed") next.scope = {
    ...structuredClone(review.scope),
    reviewLots: [...snapshot.scope.reviewLots],
    evidenceRefs: [...new Set([...snapshot.scope.evidenceRefs, ...review.scope.evidenceRefs])],
  };
  else next.scope = { ...next.scope, affectedLots: [], complete: false, evidenceRefs: [] };
  return next;
}

