/** All operational quantities are individual bottles (EA), never cases. */
export type QuantityEa = number;
export type EvidenceRef = string;
export type Version = string | number;

export interface ValidationReason {
  code: string;
  message: string;
  entityId?: string;
  evidenceRefs: EvidenceRef[];
}

export interface RecallScope {
  recallId: string;
  manufacturerRef: string;
  affectedLots: string[];
  complete: boolean;
  /** Explicit source conflicts only. Never populated by fuzzy string matching. */
  reviewLots: string[];
  version: Version;
  evidenceRefs: EvidenceRef[];
}

export interface CatalogItem {
  internalSku: string;
  manufacturerRef: string;
  unit: string;
  approvedForDemo: boolean;
  evidenceRefs: EvidenceRef[];
}

export type QaStatus = "RELEASED" | "PROJECTED_RELEASE" | "UNVERIFIED" | "BLOCKED";

export interface IdentifiedItem {
  id: string;
  internalSku: string;
  manufacturerRef: string | null;
  lot: string | null;
  unit: string;
  packagingLevel: string;
  expiresAt: string | null;
  qaStatus: QaStatus;
  qaEvidenceRef: EvidenceRef | null;
  expiryEvidenceRef: EvidenceRef | null;
  version: Version;
  evidenceRefs: EvidenceRef[];
}

export interface InventoryLot extends IdentifiedItem {
  siteId: string;
  quantityEa: QuantityEa;
  reservedEa: QuantityEa;
  allocationHold: boolean;
}

export interface Shipment extends IdentifiedItem {
  destinationSiteId: string;
  quantityEa: QuantityEa;
  eta: string;
  status: "PROJECTED_INBOUND_NOT_RECEIVED" | "RECEIVED" | "CANCELLED";
  /** A planning assumption, never a claim of receipt or final acceptance. */
  conditionalOnReceiptAndAcceptance: boolean;
}

export interface SiteDemand {
  id: string;
  siteId: string;
  internalSku: string;
  demandEa: QuantityEa;
  requiredReserveEa: QuantityEa;
  version: Version;
}

export interface Route {
  id: string;
  originSiteId: string;
  destinationSiteId: string;
  leadTimeMinutes: number;
  costPointsPerEa: number;
  capacityEa: QuantityEa;
  version: Version;
}

export interface Snapshot {
  recallProvenance?: {sourceURL: string; retrievedAt: string; rawsha256: string; datasetLastUpdated: string; reviewed: boolean; productDescription: string; eachUdi: string; caseUdi: string; zetarisScopeRead?: boolean};
  /** Collection telemetry is excluded from semantic source fingerprints. */
  sourceRead?: {retrievedAt: string; elapsedMs: number; queryCount: number; phases: Array<{name: string; elapsedMs: number; rows: number}>};
  dataMode: "fixture" | "live";
  clock: { analysisAt: string; dispatchAt: string; cutoff: string };
  sourceVersions: Record<string, Version>;
  targetSku: string;
  recipientSiteId: string;
  scope: RecallScope;
  catalog: CatalogItem[];
  inventory: InventoryLot[];
  demands: SiteDemand[];
  routes: Route[];
  shipments: Shipment[];
}

export type RecallMatchStatus =
  | "CONFIRMED_MATCH"
  | "POSSIBLE_MATCH_REVIEW"
  | "NOT_LISTED_IN_THIS_RECALL"
  | "OUT_OF_PRODUCT_SCOPE";

export interface RecallMatch {
  entityId: string;
  status: RecallMatchStatus;
  reasons: ValidationReason[];
  evidenceRefs: EvidenceRef[];
}

export interface EligibilityContext {
  targetSku: string;
  catalog: CatalogItem[];
  cutoff: string;
  analysisAt?: string;
}

export interface EligibilityAssessment {
  entityId: string;
  status: "ELIGIBLE" | "CONDITIONAL_PROJECTED" | "EXCLUDED";
  eligibleEa: QuantityEa;
  recallMatch: RecallMatch;
  reasons: ValidationReason[];
  evidenceRefs: EvidenceRef[];
}

export interface SiteAssessment {
  siteId: string;
  onHandEa: QuantityEa;
  eligibleEa: QuantityEa;
  affectedEa: QuantityEa;
  reviewOrExcludedEa: QuantityEa;
}

export interface SnapshotAssessment {
  valid: boolean;
  inputFingerprint: string;
  reasons: ValidationReason[];
  inventory: EligibilityAssessment[];
  shipments: EligibilityAssessment[];
  sites: SiteAssessment[];
  totalEligibleEa: QuantityEa;
  totalAffectedEa: QuantityEa;
  totalReviewOrExcludedEa: QuantityEa;
}

export interface Transfer {
  lineId: string;
  routeId: string;
  internalSku: string;
  originSiteId: string;
  destinationSiteId: string;
  quantityEa: QuantityEa;
  arriveAt: string;
  stockAllocations: Array<{ inventoryId: string; quantityEa: QuantityEa }>;
}

export interface SiteBalance {
  siteId: string;
  eligibleOnHandEa: QuantityEa;
  projectedInboundEa: QuantityEa;
  incomingTransferEa: QuantityEa;
  outgoingTransferEa: QuantityEa;
  demandEa: QuantityEa;
  requiredReserveEa: QuantityEa;
  projectedEndEa: number;
}

export interface FeasiblePlan {
  status: "feasible";
  id: string;
  inputFingerprint: string;
  planFingerprint: string;
  solverVersion: "star-min-cost-integer-v1";
  dataMode: Snapshot["dataMode"];
  createdAt: string;
  validUntil: string;
  transfers: Transfer[];
  projectedInboundIds: string[];
  projectedEndEa: Record<string, number>;
  siteBalances: SiteBalance[];
  transportCostPoints: number;
  totalEligibleEa: QuantityEa;
  totalRequiredEa: QuantityEa;
  projectedInboundEa: QuantityEa;
  reasons: ValidationReason[];
  executionApprovalEnabled: true;
  executionSemantics: "sandbox reservation only; no dispatch, receipt or physical quarantine confirmed";
}

export interface RejectedPlan {
  status: "infeasible" | "invalid_input";
  inputFingerprint: string;
  dataMode: Snapshot["dataMode"];
  reasons: ValidationReason[];
  shortfallEa: QuantityEa;
  totalEligibleEa: QuantityEa;
  totalRequiredEa: QuantityEa;
  projectedInboundEa: QuantityEa;
  executionApprovalEnabled: false;
}

export type PlanResult = FeasiblePlan | RejectedPlan;

export interface AllocationValidation {
  valid: boolean;
  reasons: ValidationReason[];
  siteBalances: SiteBalance[];
  projectedInboundIds: string[];
  transportCostPoints: number;
}

export interface PlanValidation extends AllocationValidation {
  currentInputFingerprint: string;
  stale: boolean;
}
