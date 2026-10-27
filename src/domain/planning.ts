import { canonicalJson, fingerprintPlan, fingerprintSnapshot } from "./fingerprint.ts";
import { assessEligibility, assessShipmentEligibility, isQuantityEa, normalizeIdentifier, reason } from "./matching.ts";
import { parseExpiry, parseUtcTimestamp } from "./time.ts";
import type {
  AllocationValidation, FeasiblePlan, PlanResult, PlanValidation, RejectedPlan,
  SiteBalance, Snapshot, SnapshotAssessment, Transfer, ValidationReason,
} from "./types.ts";

const date = parseUtcTimestamp;
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const contextFor = (snapshot: Snapshot) => ({ targetSku: snapshot.targetSku, catalog: snapshot.catalog, cutoff: snapshot.clock.cutoff, analysisAt: snapshot.clock.analysisAt });

export function validateSnapshot(snapshot: Snapshot): ValidationReason[] {
  const reasons: ValidationReason[] = [];
  const add = (code: string, message: string, entityId?: string): void => { reasons.push(reason(code, message, entityId)); };
  for (const [name, value] of Object.entries(snapshot.clock)) {
    if (!value.includes("T") || !Number.isFinite(date(value))) add("INVALID_CLOCK", `${name} must be a complete ISO timestamp.`);
  }
  if (date(snapshot.clock.analysisAt) > date(snapshot.clock.dispatchAt) || date(snapshot.clock.dispatchAt) > date(snapshot.clock.cutoff)) {
    add("INVALID_CLOCK_ORDER", "Analysis must precede dispatch, which must precede or equal the coverage cutoff.");
  }
  if (!snapshot.targetSku || !snapshot.recipientSiteId) add("TARGET_MISSING", "A target SKU and recipient site are required.");
  if (!snapshot.scope.recallId || !normalizeIdentifier(snapshot.scope.manufacturerRef) || snapshot.scope.affectedLots.length === 0 || snapshot.scope.evidenceRefs.length === 0) {
    add("INVALID_RECALL_SCOPE", "A recall ID, manufacturer reference, affected lot scope and source evidence are required.");
  }
  if (typeof snapshot.scope.complete !== "boolean") add("INVALID_SCOPE_COMPLETENESS", "Recall scope completeness must be an explicit boolean.");
  if (snapshot.scope.affectedLots.some((lot) => !normalizeIdentifier(lot))) add("INVALID_RECALL_LOT", "The affected lot list cannot contain blank identifiers.");
  const affected = new Set(snapshot.scope.affectedLots.map(normalizeIdentifier));
  if (snapshot.scope.reviewLots.some((lot) => affected.has(normalizeIdentifier(lot)))) add("CONFLICTING_SCOPE_RULES", "An identifier cannot be both an approved exact affected rule and an unresolved review identifier.");
  const unique = (rows: Array<{ id: string }>, type: string): void => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) add("DUPLICATE_OR_MISSING_ID", `${type} IDs must be present and unique.`, row.id);
      seen.add(row.id);
    }
  };
  unique(snapshot.inventory, "Inventory"); unique(snapshot.demands, "Demand"); unique(snapshot.routes, "Route"); unique(snapshot.shipments, "Shipment");
  if (snapshot.catalog.filter((item) => item.internalSku === snapshot.targetSku).length !== 1) add("AMBIGUOUS_CATALOG", "Exactly one catalog mapping is required for the target SKU.");
  if (snapshot.demands.length !== 3) add("UNSUPPORTED_SITE_COUNT", "This bounded allocator supports exactly three demand sites.");
  const sites = new Set(snapshot.demands.map((row) => row.siteId));
  if (sites.size !== snapshot.demands.length || !sites.has(snapshot.recipientSiteId)) add("INVALID_DEMAND_SITES", "Demand must identify each site once, including the recipient.");
  for (const row of snapshot.demands) {
    if (row.internalSku !== snapshot.targetSku) add("UNSUPPORTED_MULTI_ITEM_DEMAND", "Demand must be for the single target SKU.", row.id);
    if (!isQuantityEa(row.demandEa) || !isQuantityEa(row.requiredReserveEa)) add("INVALID_DEMAND_QUANTITY", "Demand and ending reserves must be nonnegative safe integers.", row.id);
  }
  for (const row of snapshot.inventory) {
    if (!isQuantityEa(row.quantityEa) || !isQuantityEa(row.reservedEa) || row.reservedEa > row.quantityEa) add("INVALID_INVENTORY_QUANTITY", "Stock and reservations must be nonnegative safe integers and reservations cannot exceed stock.", row.id);
    if (!sites.has(row.siteId)) add("UNKNOWN_SITE", "Inventory belongs to an unknown site.", row.id);
  }
  for (const row of snapshot.shipments) {
    if (!isQuantityEa(row.quantityEa)) add("INVALID_SHIPMENT_QUANTITY", "Shipment quantity must be a nonnegative safe integer.", row.id);
    if (row.destinationSiteId !== snapshot.recipientSiteId) add("UNSUPPORTED_INBOUND_DESTINATION", "The bounded allocator supports projected supply only to the recipient site.", row.id);
  }
  const routedOrigins = new Set<string>();
  for (const route of snapshot.routes) {
    if (!sites.has(route.originSiteId) || route.originSiteId === snapshot.recipientSiteId || route.destinationSiteId !== snapshot.recipientSiteId) add("UNSUPPORTED_ROUTE", "Routes must run from a donor site directly to the recipient.", route.id);
    if (routedOrigins.has(route.originSiteId)) add("AMBIGUOUS_ROUTE", "This bounded allocator accepts at most one route per donor.", route.id);
    routedOrigins.add(route.originSiteId);
    if (!isQuantityEa(route.leadTimeMinutes) || !isQuantityEa(route.costPointsPerEa) || !isQuantityEa(route.capacityEa)) add("INVALID_ROUTE_VALUES", "Lead time, per-EA cost and capacity must be nonnegative safe integers.", route.id);
    if (!Number.isSafeInteger(route.leadTimeMinutes * 60_000) || !Number.isFinite(new Date(date(snapshot.clock.dispatchAt) + route.leadTimeMinutes * 60_000).getTime())) add("ROUTE_TIME_OVERFLOW", "Route lead time cannot be represented as an exact supported timestamp.", route.id);
  }
  for (const [label, value] of [
    ["on-hand", total(snapshot.inventory.map((row) => row.quantityEa))],
    ["required", total(snapshot.demands.map((row) => row.demandEa + row.requiredReserveEa))],
    ["projected inbound", total(snapshot.shipments.map((row) => row.quantityEa))],
    ["combined supply", total([...snapshot.inventory.map((row) => row.quantityEa), ...snapshot.shipments.map((row) => row.quantityEa)])],
  ] as const) if (!isQuantityEa(value)) add("AGGREGATE_QUANTITY_OVERFLOW", `Aggregate ${label} quantity exceeds exact integer arithmetic.`);
  return reasons;
}

export function assessSnapshot(snapshot: Snapshot): SnapshotAssessment {
  const reasons = validateSnapshot(snapshot);
  let inputFingerprint = "invalid-json-snapshot";
  try { inputFingerprint = fingerprintSnapshot(snapshot); }
  catch { reasons.push(reason("NON_JSON_SNAPSHOT", "Snapshot includes values that cannot be safely fingerprinted.")); }
  const context = contextFor(snapshot);
  const inventory = snapshot.inventory.map((row) => assessEligibility(row, snapshot.scope, context));
  const shipments = snapshot.shipments.map((row) => assessShipmentEligibility(row, snapshot.scope, context));
  const sites = snapshot.demands.map((demand) => {
    const indices = snapshot.inventory.flatMap((row, index) => row.siteId === demand.siteId ? [index] : []);
    return {
      siteId: demand.siteId,
      onHandEa: total(indices.map((index) => snapshot.inventory[index]!.quantityEa)),
      eligibleEa: total(indices.map((index) => inventory[index]!.eligibleEa)),
      affectedEa: total(indices.filter((index) => inventory[index]!.recallMatch.status === "CONFIRMED_MATCH").map((index) => snapshot.inventory[index]!.quantityEa)),
      reviewOrExcludedEa: total(indices.filter((index) => inventory[index]!.status === "EXCLUDED" && inventory[index]!.recallMatch.status !== "CONFIRMED_MATCH").map((index) => snapshot.inventory[index]!.quantityEa)),
    };
  }).sort((a, b) => compareText(a.siteId, b.siteId));
  return {
    valid: reasons.length === 0, inputFingerprint, reasons, inventory, shipments, sites,
    totalEligibleEa: total(inventory.map((row) => row.eligibleEa)),
    totalAffectedEa: total(sites.map((row) => row.affectedEa)),
    totalReviewOrExcludedEa: total(sites.map((row) => row.reviewOrExcludedEa)),
  };
}

function usableInbound(snapshot: Snapshot, assessment: SnapshotAssessment): Array<{ id: string; siteId: string; quantityEa: number }> {
  return assessment.shipments.filter((row) => row.status === "CONDITIONAL_PROJECTED").map((row) => ({
    id: row.entityId,
    siteId: snapshot.shipments.find((shipment) => shipment.id === row.entityId)!.destinationSiteId,
    quantityEa: row.eligibleEa,
  }));
}

function balances(snapshot: Snapshot, assessment: SnapshotAssessment, transfers: Transfer[]): SiteBalance[] {
  const inbound = usableInbound(snapshot, assessment);
  return [...snapshot.demands].sort((a, b) => compareText(a.siteId, b.siteId)).map((demand) => {
    const eligibleOnHandEa = assessment.sites.find((row) => row.siteId === demand.siteId)!.eligibleEa;
    const projectedInboundEa = total(inbound.filter((row) => row.siteId === demand.siteId).map((row) => row.quantityEa));
    const incomingTransferEa = total(transfers.filter((row) => row.destinationSiteId === demand.siteId && isQuantityEa(row.quantityEa)).map((row) => row.quantityEa));
    const outgoingTransferEa = total(transfers.filter((row) => row.originSiteId === demand.siteId && isQuantityEa(row.quantityEa)).map((row) => row.quantityEa));
    return {
      siteId: demand.siteId, eligibleOnHandEa, projectedInboundEa, incomingTransferEa, outgoingTransferEa,
      demandEa: demand.demandEa, requiredReserveEa: demand.requiredReserveEa,
      projectedEndEa: eligibleOnHandEa + projectedInboundEa + incomingTransferEa - outgoingTransferEa - demand.demandEa,
    };
  });
}

export function validateAllocations(snapshot: Snapshot, transfers: Transfer[]): AllocationValidation {
  const assessment = assessSnapshot(snapshot);
  const reasons = [...assessment.reasons];
  if (!assessment.valid) return { valid: false, reasons, siteBalances: [], projectedInboundIds: [], transportCostPoints: 0 };
  const add = (code: string, message: string, id?: string): void => { reasons.push(reason(code, message, id)); };
  const usedByLot = new Map<string, number>();
  const usedByRoute = new Map<string, number>();
  const lineIds = new Set<string>();
  let transportCostPoints = 0;
  for (const transfer of transfers) {
    if (!transfer.lineId || lineIds.has(transfer.lineId)) add("DUPLICATE_TRANSFER_LINE", "Transfer line IDs must be present and unique.", transfer.lineId);
    lineIds.add(transfer.lineId);
    if (!isQuantityEa(transfer.quantityEa) || transfer.quantityEa === 0) add("INVALID_TRANSFER_QUANTITY", "Transfers must contain positive integer EA.", transfer.lineId);
    if (transfer.internalSku !== snapshot.targetSku) add("TRANSFER_ITEM_MISMATCH", "Substitution is disabled; transfer must use the target SKU.", transfer.lineId);
    const route = snapshot.routes.find((row) => row.id === transfer.routeId);
    if (!route || route.originSiteId !== transfer.originSiteId || route.destinationSiteId !== transfer.destinationSiteId) {
      add("TRANSFER_ROUTE_MISMATCH", "The transfer must match a current direct route.", transfer.lineId);
    } else {
      const expectedArrival = date(snapshot.clock.dispatchAt) + route.leadTimeMinutes * 60_000;
      if (date(transfer.arriveAt) !== expectedArrival) add("TRANSFER_ARRIVAL_MISMATCH", "Transfer arrival must be recomputed from dispatch and route lead time.", transfer.lineId);
      if (expectedArrival > date(snapshot.clock.cutoff)) add("ROUTE_AFTER_CUTOFF", "The route arrives after the required deadline.", transfer.lineId);
      const routeQuantity = (usedByRoute.get(route.id) ?? 0) + transfer.quantityEa;
      usedByRoute.set(route.id, routeQuantity);
      if (routeQuantity > route.capacityEa) add("ROUTE_CAPACITY_EXCEEDED", "Total transfer EA exceeds current route capacity.", transfer.lineId);
      transportCostPoints += transfer.quantityEa * route.costPointsPerEa;
    }
    let allocatedEa = 0;
    for (const allocation of transfer.stockAllocations) {
      if (!isQuantityEa(allocation.quantityEa) || allocation.quantityEa === 0) {
        add("INVALID_LOT_ALLOCATION", "Lot allocations must be positive integer EA.", allocation.inventoryId); continue;
      }
      allocatedEa += allocation.quantityEa;
      const lot = snapshot.inventory.find((row) => row.id === allocation.inventoryId);
      const eligibility = assessment.inventory.find((row) => row.entityId === allocation.inventoryId);
      if (!lot || !eligibility || lot.siteId !== transfer.originSiteId || lot.internalSku !== transfer.internalSku || eligibility.status !== "ELIGIBLE") {
        add("INELIGIBLE_LOT_ALLOCATION", "Allocated stock must be an eligible exact-item lot at the donor site.", allocation.inventoryId); continue;
      }
      const used = (usedByLot.get(lot.id) ?? 0) + allocation.quantityEa;
      usedByLot.set(lot.id, used);
      if (used > eligibility.eligibleEa) add("LOT_AVAILABILITY_EXCEEDED", "Cumulative allocations exceed stock net of current reservations.", lot.id);
    }
    if (allocatedEa !== transfer.quantityEa) add("LOT_ALLOCATION_SUM_MISMATCH", "Specific lot allocations must sum exactly to the transfer EA.", transfer.lineId);
  }
  const siteBalances = balances(snapshot, assessment, transfers);
  for (const site of siteBalances) if (site.projectedEndEa < site.requiredReserveEa) add("DEMAND_OR_RESERVE_SHORTFALL", `Projected ending stock at ${site.siteId} is below its required reserve.`, site.siteId);
  if (!isQuantityEa(transportCostPoints)) add("TRANSPORT_COST_OVERFLOW", "Transport cost is outside exact integer arithmetic.");
  return { valid: reasons.length === 0, reasons, siteBalances, projectedInboundIds: usableInbound(snapshot, assessment).map((row) => row.id).sort(), transportCostPoints };
}

/** Exact min-cost integer solution for the bounded, single-SKU, single-recipient star. */
export function planReplenishment(snapshot: Snapshot): PlanResult {
  const assessment = assessSnapshot(snapshot);
  const inbound = usableInbound(snapshot, assessment);
  const projectedInboundEa = total(inbound.map((row) => row.quantityEa));
  const totalRequiredEa = total(snapshot.demands.map((row) => row.demandEa + row.requiredReserveEa));
  const reject = (status: RejectedPlan["status"], reasons: ValidationReason[], shortfallEa = 0): RejectedPlan => ({
    status, inputFingerprint: assessment.inputFingerprint, dataMode: snapshot.dataMode, reasons, shortfallEa,
    totalEligibleEa: assessment.totalEligibleEa, totalRequiredEa, projectedInboundEa, executionApprovalEnabled: false,
  });
  if (!assessment.valid) return reject("invalid_input", assessment.reasons);
  const initialBalances = balances(snapshot, assessment, []);
  const recipient = initialBalances.find((row) => row.siteId === snapshot.recipientSiteId)!;
  const need = Math.max(0, recipient.requiredReserveEa - recipient.projectedEndEa);
  const donorLocalShortfall = total(initialBalances.filter((row) => row.siteId !== snapshot.recipientSiteId).map((row) => Math.max(0, row.requiredReserveEa - row.projectedEndEa)));
  const routeExclusions: ValidationReason[] = [];
  const donors = snapshot.routes.flatMap((route) => {
    const balance = initialBalances.find((row) => row.siteId === route.originSiteId)!;
    const arrival = date(snapshot.clock.dispatchAt) + route.leadTimeMinutes * 60_000;
    if (arrival > date(snapshot.clock.cutoff)) {
      routeExclusions.push(reason("ROUTE_AFTER_CUTOFF", "This donor route arrives after the coverage deadline.", route.id)); return [];
    }
    return [{ route, maxEa: Math.min(route.capacityEa, Math.max(0, balance.projectedEndEa - balance.requiredReserveEa)), arrival }];
  }).sort((a, b) => a.route.costPointsPerEa - b.route.costPointsPerEa || compareText(a.route.originSiteId, b.route.originSiteId));
  const donorCapacity = total(donors.map((row) => row.maxEa));
  if (donorLocalShortfall > 0 || donorCapacity < need) {
    return reject("infeasible", [
      reason("NO_FEASIBLE_ALLOCATION", "No allocation meets all demand, ending reserves and arrival constraints; execution approval is disabled."),
      ...routeExclusions,
      ...assessment.shipments.filter((row) => row.status === "EXCLUDED").flatMap((row) => row.reasons),
      ...assessment.inventory.filter((row) => row.status === "EXCLUDED" && row.recallMatch.status !== "CONFIRMED_MATCH").flatMap((row) => row.reasons),
    ], donorLocalShortfall + Math.max(0, need - donorCapacity));
  }
  let remaining = need;
  const transfers: Transfer[] = [];
  for (const donor of donors) {
    const quantityEa = Math.min(remaining, donor.maxEa);
    if (quantityEa === 0) continue;
    let unallocated = quantityEa;
    const stockAllocations: Transfer["stockAllocations"] = [];
    const lots = snapshot.inventory.filter((row) => row.siteId === donor.route.originSiteId)
      .sort((a, b) => parseExpiry(a.expiresAt) - parseExpiry(b.expiresAt) || compareText(a.id, b.id));
    for (const lot of lots) {
      const eligibility = assessment.inventory.find((row) => row.entityId === lot.id)!;
      const allocated = Math.min(unallocated, eligibility.eligibleEa);
      if (allocated > 0) { stockAllocations.push({ inventoryId: lot.id, quantityEa: allocated }); unallocated -= allocated; }
      if (unallocated === 0) break;
    }
    if (unallocated !== 0) return reject("invalid_input", [reason("LOT_ALLOCATION_INTERNAL_ERROR", "Eligible site totals could not be allocated to their source lots.")]);
    transfers.push({
      lineId: `transfer-${donor.route.id}`, routeId: donor.route.id, internalSku: snapshot.targetSku,
      originSiteId: donor.route.originSiteId, destinationSiteId: snapshot.recipientSiteId,
      quantityEa, arriveAt: iso(donor.arrival), stockAllocations,
    });
    remaining -= quantityEa;
  }
  const checked = validateAllocations(snapshot, transfers);
  if (!checked.valid) return reject("invalid_input", checked.reasons);
  const payload: Omit<FeasiblePlan, "id" | "planFingerprint"> = {
    status: "feasible", inputFingerprint: assessment.inputFingerprint, solverVersion: "star-min-cost-integer-v1", dataMode: snapshot.dataMode,
    createdAt: snapshot.clock.analysisAt, validUntil: snapshot.clock.dispatchAt,
    transfers, projectedInboundIds: checked.projectedInboundIds,
    projectedEndEa: Object.fromEntries(checked.siteBalances.map((row) => [row.siteId, row.projectedEndEa])),
    siteBalances: checked.siteBalances, transportCostPoints: checked.transportCostPoints,
    totalEligibleEa: assessment.totalEligibleEa, totalRequiredEa, projectedInboundEa,
    reasons: projectedInboundEa > 0 ? [reason("PROJECTED_INBOUND_CONDITIONAL", "Coverage relies on projected inbound receipt and acceptance; stock has not arrived.", undefined, inbound.map((row) => row.id))] : [],
    executionApprovalEnabled: true,
    executionSemantics: "sandbox reservation only; no dispatch, receipt or physical quarantine confirmed",
  };
  const planFingerprint = fingerprintPlan(payload);
  return { ...payload, id: `plan-${planFingerprint.slice(0, 20)}`, planFingerprint };
}

/** Pure guard only. Caller must serialize current-state check and persistence locally. */
export function validatePlanAgainstSnapshot(plan: FeasiblePlan, snapshot: Snapshot, now = snapshot.clock.analysisAt): PlanValidation {
  const checked = validateAllocations(snapshot, plan.transfers);
  const reasons = [...checked.reasons];
  let currentInputFingerprint = "invalid-json-snapshot";
  try { currentInputFingerprint = fingerprintSnapshot(snapshot); }
  catch { reasons.push(reason("NON_JSON_SNAPSHOT", "Current state cannot be safely fingerprinted.")); }
  const stale = currentInputFingerprint !== plan.inputFingerprint;
  if (stale) reasons.push(reason("STALE_PLAN", "Relevant source values or versions changed; generate a new proposal before approval."));
  if (!Number.isFinite(date(now)) || !Number.isFinite(date(plan.validUntil)) || date(now) < date(snapshot.clock.analysisAt) || date(now) > Math.min(date(plan.validUntil), date(snapshot.clock.dispatchAt))) reasons.push(reason("PLAN_EXPIRED", "The proposal is outside its analysis/dispatch approval window or the clock is invalid."));
  try {
    if (fingerprintPlan(plan) !== plan.planFingerprint || plan.id !== `plan-${plan.planFingerprint.slice(0, 20)}`) reasons.push(reason("PLAN_FINGERPRINT_MISMATCH", "Plan contents differ from the fingerprinted proposal."));
    const expectedEnd = Object.fromEntries(checked.siteBalances.map((row) => [row.siteId, row.projectedEndEa]));
    if (plan.transportCostPoints !== checked.transportCostPoints || canonicalJson(plan.siteBalances) !== canonicalJson(checked.siteBalances) || canonicalJson(plan.projectedEndEa) !== canonicalJson(expectedEnd) || canonicalJson(plan.projectedInboundIds) !== canonicalJson(checked.projectedInboundIds)) {
      reasons.push(reason("PLAN_DERIVED_VALUES_MISMATCH", "Projected balances, inbound or cost do not match current deterministic validation."));
    }
  } catch { reasons.push(reason("PLAN_FINGERPRINT_MISMATCH", "Plan contents cannot be safely fingerprinted.")); }
  return { ...checked, valid: reasons.length === 0, reasons, currentInputFingerprint, stale };
}
