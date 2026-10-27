import { assessSnapshot, planReplenishment, validatePlanAgainstSnapshot } from "../domain/planning.ts";
import { claimCitationGuide, claimResponseSchema, checkClaims, type ClaimFeedbackCode, type ClaimResponse } from "../domain/claims.ts";
import { canonicalJson, fingerprintSnapshot } from "../domain/fingerprint.ts";
import type { PlanResult, Snapshot } from "../domain/types.ts";

/** Static trusted direction; the model receives only the checked template and compact facts. */
export const terminalProjectionInstruction = "Return exactly one complete JSON object matching the supplied report_claims schema, with no Markdown, prose, or tool calls. Copy claimTemplate exactly, including every field and ALL references in each citation string, without truncation. Citation references are separated by one literal ASCII space. Preserve every reference's exact case and spelling; do not add, replace or omit references. Use no historical memory. This output formatting step does not execute actions or grant approval. Facts are deterministic.";

export interface TerminalProjection {
  instruction: string;
  bindings: {snapshotHash: string; planFingerprint: string};
  claimTemplate: ClaimResponse;
  facts: {
    cutoff: string;
    validUntil: string | null;
    affectedEa: number;
    eligibleEa: number;
    status: PlanResult["status"];
    totalRequiredEa: number;
    projectedInboundEa: number;
    shortfallEa: number | null;
    transfers: Array<{
      lineId: string;
      routeId: string;
      originSiteId: string;
      destinationSiteId: string;
      quantityEa: number;
      arriveAt: string;
      stockAllocations: Array<{inventoryId: string; quantityEa: number}>;
    }>;
  };
  repairFeedback: ClaimFeedbackCode[];
}

/** Build a small terminal context from the immutable snapshot and its deterministic prepared plan. */
export function projectTerminalClaims(
  snapshot: Snapshot,
  plan: PlanResult,
  repairFeedback: ClaimFeedbackCode[] = [],
): TerminalProjection {
  const snapshotHash = fingerprintSnapshot(snapshot);
  const deterministicPlan = planReplenishment(snapshot);
  if (plan.inputFingerprint !== snapshotHash || canonicalJson(plan) !== canonicalJson(deterministicPlan)) {
    throw new Error("Terminal projection requires the deterministic plan for the bound snapshot.");
  }
  if (plan.status === "feasible" && !validatePlanAgainstSnapshot(plan, snapshot).valid) {
    throw new Error("Terminal projection requires an independently valid feasible plan.");
  }

  const guide = claimCitationGuide(snapshot, deterministicPlan);
  const assessment = assessSnapshot(snapshot);
  const projectedInbound = assessment.shipments
    .filter(row => row.status === "CONDITIONAL_PROJECTED")
    .map(row => {
      const shipment = snapshot.shipments.find(item => item.id === row.entityId)!;
      return {shipmentId: shipment.id, quantityEa: row.eligibleEa, eta: shipment.eta, conditionalOnReceiptAndAcceptance: true as const};
    })
    .sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  const claimTemplate: ClaimResponse = claimResponseSchema.parse({
    snapshotHash: guide.snapshotHash,
    planFingerprint: guide.planFingerprint,
    claims: {
      inventory: {affectedEa: assessment.totalAffectedEa, eligibleEa: assessment.totalEligibleEa, citations: guide.inventory},
      plan: {
        status: deterministicPlan.status,
        cutoff: snapshot.clock.cutoff,
        totalRequiredEa: deterministicPlan.totalRequiredEa,
        projectedInboundEa: deterministicPlan.projectedInboundEa,
        projectedInbound,
        shortfallEa: deterministicPlan.status === "feasible" ? null : deterministicPlan.shortfallEa,
        citations: guide.plan,
      },
      transfers: deterministicPlan.status === "feasible" ? deterministicPlan.transfers.map(transfer => ({
        lineId: transfer.lineId, routeId: transfer.routeId, originSiteId: transfer.originSiteId,
        destinationSiteId: transfer.destinationSiteId, quantityEa: transfer.quantityEa,
        arriveAt: transfer.arriveAt, arrivesByCutoff: Date.parse(transfer.arriveAt) <= Date.parse(snapshot.clock.cutoff),
        stockAllocations: transfer.stockAllocations,
        citations: guide.transfers.find(row => row.lineId === transfer.lineId)!.citations,
      })) : [],
    },
  });
  if (!checkClaims(claimTemplate, snapshot, deterministicPlan).valid) throw new Error("Generated terminal claim template did not pass the deterministic checker.");

  return structuredClone({
    instruction: terminalProjectionInstruction,
    bindings: {snapshotHash, planFingerprint: guide.planFingerprint},
    claimTemplate,
    facts: {
      cutoff: snapshot.clock.cutoff,
      validUntil: deterministicPlan.status === "feasible" ? deterministicPlan.validUntil : null,
      affectedEa: assessment.totalAffectedEa,
      eligibleEa: assessment.totalEligibleEa,
      status: deterministicPlan.status,
      totalRequiredEa: deterministicPlan.totalRequiredEa,
      projectedInboundEa: deterministicPlan.projectedInboundEa,
      shortfallEa: deterministicPlan.status === "feasible" ? null : deterministicPlan.shortfallEa,
      transfers: deterministicPlan.status === "feasible" ? deterministicPlan.transfers.map(({lineId, routeId, originSiteId, destinationSiteId, quantityEa, arriveAt, stockAllocations}) => ({
        lineId, routeId, originSiteId, destinationSiteId, quantityEa, arriveAt, stockAllocations,
      })) : [],
    },
    repairFeedback: [...new Set(repairFeedback)],
  });
}

