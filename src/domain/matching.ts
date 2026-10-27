import type {
  EligibilityAssessment, EligibilityContext, IdentifiedItem, InventoryLot,
  RecallMatch, RecallScope, Shipment, ValidationReason,
} from "./types.ts";
import { parseExpiry, parseUtcTimestamp } from "./time.ts";

export const normalizeIdentifier = (value: string | null): string => (value ?? "").trim().toUpperCase();
export const isQuantityEa = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function reason(code: string, message: string, entityId?: string, evidenceRefs: string[] = []): ValidationReason {
  return { code, message, ...(entityId ? { entityId } : {}), evidenceRefs: [...new Set(evidenceRefs)] };
}

/** Exact documented identifiers only: no edit distance, punctuation repair, or I/J substitution. */
export function assessRecallMatch(item: Pick<IdentifiedItem, "id" | "manufacturerRef" | "lot" | "evidenceRefs">, scope: RecallScope): RecallMatch {
  const reference = normalizeIdentifier(item.manufacturerRef);
  const lot = normalizeIdentifier(item.lot);
  const evidenceRefs = [...new Set([...item.evidenceRefs, ...scope.evidenceRefs])];
  const result = (status: RecallMatch["status"], code: string, message: string): RecallMatch => ({
    entityId: item.id, status, reasons: [reason(code, message, item.id, evidenceRefs)], evidenceRefs,
  });
  if (!reference) return result("POSSIBLE_MATCH_REVIEW", "MISSING_PRODUCT_IDENTIFIER", "Manufacturer reference is missing; manual identification is required.");
  if (reference !== normalizeIdentifier(scope.manufacturerRef)) {
    return result("OUT_OF_PRODUCT_SCOPE", "DIFFERENT_PRODUCT_REFERENCE", "This manufacturer reference is outside the checked product scope.");
  }
  if (!lot) return result("POSSIBLE_MATCH_REVIEW", "MISSING_LOT", "The lot is missing; exclude it pending investigation.");
  if (scope.evidenceRefs.length === 0) return result("POSSIBLE_MATCH_REVIEW", "UNSOURCED_RECALL_SCOPE", "The recall rule has no source evidence.");
  if (scope.reviewLots.some((candidate) => normalizeIdentifier(candidate) === lot)) {
    return result("POSSIBLE_MATCH_REVIEW", "DOCUMENTED_LOT_CONFLICT", "This exact identifier has a documented source conflict; do not silently repair it.");
  }
  if (scope.affectedLots.some((candidate) => normalizeIdentifier(candidate) === lot)) {
    return result("CONFIRMED_MATCH", "EXACT_AFFECTED_LOT", "Manufacturer reference and lot exactly match the sourced recall rule.");
  }
  if (scope.complete !== true) return result("POSSIBLE_MATCH_REVIEW", "INCOMPLETE_RECALL_SCOPE", "A positive-match-only lot sample cannot clear an unlisted lot.");
  return result("NOT_LISTED_IN_THIS_RECALL", "NOT_LISTED_IN_CHECKED_SCOPE", "This identified lot is not listed in the checked complete scope; this is not a general safety determination.");
}

function commonReasons(item: IdentifiedItem, scope: RecallScope, context: EligibilityContext, projected: boolean): { match: RecallMatch; reasons: ValidationReason[] } {
  const match = assessRecallMatch(item, scope);
  const reasons: ValidationReason[] = [];
  const add = (code: string, message: string, refs: string[] = item.evidenceRefs): void => {
    reasons.push(reason(code, message, item.id, refs));
  };
  if (match.status !== "NOT_LISTED_IN_THIS_RECALL") reasons.push(...match.reasons);
  if (item.internalSku !== context.targetSku) add("DIFFERENT_ITEM", "Only the exact approved target catalog item is allocatable; substitution is disabled.");
  const catalog = context.catalog.find((row) => row.internalSku === context.targetSku);
  if (!catalog || catalog.approvedForDemo !== true || catalog.evidenceRefs.length === 0) {
    add("CATALOG_NOT_APPROVED", "The target item lacks a sourced local catalog approval.");
  } else {
    if (normalizeIdentifier(item.manufacturerRef) !== normalizeIdentifier(catalog.manufacturerRef)) {
      add("CATALOG_REFERENCE_CONFLICT", "The source manufacturer reference conflicts with its catalog mapping.", catalog.evidenceRefs);
    }
    if (catalog.unit !== "EA") add("CATALOG_UNIT_UNSUPPORTED", "The approved catalog item must use individual-bottle EA units.", catalog.evidenceRefs);
  }
  if (item.unit !== "EA" || item.packagingLevel !== "EACH") add("UNSUPPORTED_PACKAGING_UNIT", "Only EACH/EA bottles are supported. Case conversion is disabled.");
  const allowedQa = projected ? ["RELEASED", "PROJECTED_RELEASE"] : ["RELEASED"];
  if (!allowedQa.includes(item.qaStatus)) add("QA_NOT_RELEASED", "Independent local QA release is absent or withdrawn.", item.qaEvidenceRef ? [item.qaEvidenceRef] : []);
  if (!item.qaEvidenceRef) add("QA_EVIDENCE_MISSING", "QA status lacks its evidence record.");
  const expiry = parseExpiry(item.expiresAt);
  const cutoff = parseUtcTimestamp(context.cutoff);
  if (!Number.isFinite(expiry)) add("EXPIRY_UNKNOWN", "Expiry is absent or invalid; exclude pending verification.");
  else if (!Number.isFinite(cutoff) || expiry <= cutoff) add("EXPIRED_BY_CUTOFF", "The lot is not demonstrably unexpired through the coverage cutoff.", item.expiryEvidenceRef ? [item.expiryEvidenceRef] : []);
  if (!item.expiryEvidenceRef) add("EXPIRY_EVIDENCE_MISSING", "Expiry lacks its evidence record.");
  return { match, reasons };
}

export function assessEligibility(lot: InventoryLot, scope: RecallScope, context: EligibilityContext): EligibilityAssessment {
  const { match, reasons } = commonReasons(lot, scope, context, false);
  if (!isQuantityEa(lot.quantityEa) || !isQuantityEa(lot.reservedEa) || lot.reservedEa > lot.quantityEa) {
    reasons.push(reason("INVALID_QUANTITY", "On-hand and reserved EA must be nonnegative integers with reservations not exceeding stock.", lot.id, lot.evidenceRefs));
  }
  if (lot.allocationHold) reasons.push(reason("ALLOCATION_HOLD", "The lot has a digital allocation hold.", lot.id, lot.evidenceRefs));
  const eligible = reasons.length === 0;
  return {
    entityId: lot.id,
    status: eligible ? "ELIGIBLE" : "EXCLUDED",
    eligibleEa: eligible ? lot.quantityEa - lot.reservedEa : 0,
    recallMatch: match,
    reasons,
    evidenceRefs: [...new Set([...lot.evidenceRefs, ...match.evidenceRefs, ...(lot.qaEvidenceRef ? [lot.qaEvidenceRef] : []), ...(lot.expiryEvidenceRef ? [lot.expiryEvidenceRef] : [])])],
  };
}

export function assessShipmentEligibility(shipment: Shipment, scope: RecallScope, context: EligibilityContext): EligibilityAssessment {
  const { match, reasons } = commonReasons(shipment, scope, context, true);
  if (!isQuantityEa(shipment.quantityEa)) reasons.push(reason("INVALID_QUANTITY", "Projected inbound EA must be a nonnegative integer.", shipment.id, shipment.evidenceRefs));
  if (shipment.status !== "PROJECTED_INBOUND_NOT_RECEIVED") {
    reasons.push(reason("NOT_PROJECTED_INBOUND", "Received or cancelled shipments are not counted as projected stock; receipt belongs in on-hand inventory.", shipment.id, shipment.evidenceRefs));
  }
  if (!shipment.conditionalOnReceiptAndAcceptance) reasons.push(reason("INBOUND_ACCEPTANCE_ASSUMPTION_MISSING", "Projected availability must explicitly remain conditional on receipt and acceptance.", shipment.id, shipment.evidenceRefs));
  const eta = parseUtcTimestamp(shipment.eta);
  if (!Number.isFinite(eta)) reasons.push(reason("INVALID_ETA", "Projected arrival time is invalid.", shipment.id, shipment.evidenceRefs));
  else if (eta > parseUtcTimestamp(context.cutoff)) reasons.push(reason("INBOUND_AFTER_CUTOFF", "Projected arrival is after the coverage deadline.", shipment.id, shipment.evidenceRefs));
  else if (context.analysisAt && eta < parseUtcTimestamp(context.analysisAt)) reasons.push(reason("PROJECTED_ETA_PASSED", "An unreceived shipment with a past ETA needs an updated status before being counted.", shipment.id, shipment.evidenceRefs));
  return {
    entityId: shipment.id,
    status: reasons.length === 0 ? "CONDITIONAL_PROJECTED" : "EXCLUDED",
    eligibleEa: reasons.length === 0 ? shipment.quantityEa : 0,
    recallMatch: match,
    reasons,
    evidenceRefs: [...new Set([...shipment.evidenceRefs, ...match.evidenceRefs, ...(shipment.qaEvidenceRef ? [shipment.qaEvidenceRef] : []), ...(shipment.expiryEvidenceRef ? [shipment.expiryEvidenceRef] : [])])],
  };
}

/** Reuse only with an assessment made against the current snapshot. */
export function availableEa(lot: InventoryLot, assessment: EligibilityAssessment): number {
  return assessment.entityId === lot.id && assessment.status === "ELIGIBLE" && !lot.allocationHold && lot.qaStatus === "RELEASED" && isQuantityEa(lot.quantityEa) && isQuantityEa(lot.reservedEa)
    ? Math.min(assessment.eligibleEa, Math.max(0, lot.quantityEa - lot.reservedEa)) : 0;
}
