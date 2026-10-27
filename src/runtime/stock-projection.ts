import type {
  EligibilityAssessment,
  InventoryLot,
  Shipment,
  Snapshot,
  SnapshotAssessment,
  ValidationReason,
} from "../domain/types.ts";

type StockRow = InventoryLot | Shipment;

function reasonCodes(...groups: ValidationReason[][]): string[] {
  return [...new Set(groups.flatMap((rows) => rows.map((row) => row.code)))].sort();
}

function citationRefs(...groups: string[][]): string[] {
  return [...new Set(groups.flat())].sort();
}

function projectEvaluatedRow<T extends StockRow>(row: T, evaluation: EligibilityAssessment) {
  const reasons = [...evaluation.recallMatch.reasons, ...evaluation.reasons];
  const reasonDetails = [...new Map(reasons.map((reason) => [
    `${reason.code}\u0000${reason.message}\u0000${reason.evidenceRefs.join("\u0000")}`,
    { code: reason.code, message: reason.message, citationRefs: reason.evidenceRefs },
  ])).values()];
  return {
    id: row.id,
    internalSku: row.internalSku,
    manufacturerRef: row.manufacturerRef,
    lot: row.lot,
    unit: row.unit,
    packagingLevel: row.packagingLevel,
    expiresAt: row.expiresAt,
    qaStatus: row.qaStatus,
    qaEvidenceRef: row.qaEvidenceRef,
    expiryEvidenceRef: row.expiryEvidenceRef,
    version: row.version,
    quantityEa: "quantityEa" in row ? row.quantityEa : undefined,
    reservedEa: "reservedEa" in row ? row.reservedEa : undefined,
    allocationHold: "allocationHold" in row ? row.allocationHold : undefined,
    siteId: "siteId" in row ? row.siteId : undefined,
    destinationSiteId: "destinationSiteId" in row ? row.destinationSiteId : undefined,
    eta: "eta" in row ? row.eta : undefined,
    shipmentStatus: "status" in row && "destinationSiteId" in row ? row.status : undefined,
    conditionalOnReceiptAndAcceptance: "conditionalOnReceiptAndAcceptance" in row ? row.conditionalOnReceiptAndAcceptance : undefined,
    eligibility: evaluation.status,
    eligibleEa: evaluation.eligibleEa,
    recallMatch: evaluation.recallMatch.status,
    reasons: reasonDetails.map(({code, message}) => ({code, message})),
    citationRefs: citationRefs(row.evidenceRefs, evaluation.recallMatch.evidenceRefs, evaluation.evidenceRefs, reasonDetails.flatMap((reason) => reason.citationRefs)),
  };
}

/**
 * Return bounded evidence for one site from an already loaded investigation snapshot.
 * Totals remain global so repeated A/B/C calls retain the shared exposure context.
 */
export function projectStockEvidence(snapshot: Snapshot, assessment: SnapshotAssessment, siteId?: string) {
  const inventoryEvaluation = new Map(assessment.inventory.map((row) => [row.entityId, row]));
  const shipmentEvaluation = new Map(assessment.shipments.map((row) => [row.entityId, row]));
  const inventory = snapshot.inventory
    .filter((row) => !siteId || row.siteId === siteId)
    .map((row) => projectEvaluatedRow(row, inventoryEvaluation.get(row.id)!));
  const shipments = snapshot.shipments
    .filter((row) => !siteId || row.destinationSiteId === siteId)
    .map((row) => projectEvaluatedRow(row, shipmentEvaluation.get(row.id)!));
  const selectedSites = siteId ? assessment.sites.filter((row) => row.siteId === siteId) : assessment.sites;

  return {
    investigation: {
      snapshotAsOf: snapshot.clock.analysisAt,
      freshSourceRead: false,
    },
    dataMode: snapshot.dataMode,
    clock: snapshot.clock,
    inputFingerprint: assessment.inputFingerprint,
    sourceVersions: snapshot.sourceVersions,
    provenance: snapshot.recallProvenance ? {
      sourceURL: snapshot.recallProvenance.sourceURL,
      retrievedAt: snapshot.recallProvenance.retrievedAt,
      reviewed: snapshot.recallProvenance.reviewed,
      rawSha256: snapshot.recallProvenance.rawsha256,
    } : null,
    scope: {
      recallId: snapshot.scope.recallId,
      manufacturerRef: snapshot.scope.manufacturerRef,
      complete: snapshot.scope.complete,
      affectedLotCount: snapshot.scope.affectedLots.length,
      reviewLotCount: snapshot.scope.reviewLots.length,
      version: snapshot.scope.version,
      citationRefs: snapshot.scope.evidenceRefs,
    },
    totals: {
      valid: assessment.valid,
      totalEligibleEa: assessment.totalEligibleEa,
      totalAffectedEa: assessment.totalAffectedEa,
      totalReviewOrExcludedEa: assessment.totalReviewOrExcludedEa,
      reasonCodes: reasonCodes(assessment.reasons),
    },
    selectedSites,
    selectedSiteId: siteId ?? null,
    inventory,
    shipments,
  };
}
