import { z } from "zod";
import { fingerprintSnapshot } from "../domain/fingerprint.ts";
import { assessSnapshot, planReplenishment } from "../domain/planning.ts";
import { parseUtcTimestamp } from "../domain/time.ts";
import type { PlanResult, Snapshot } from "../domain/types.ts";

const boundedText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim() === value && value.trim().length > 0, "Must be nonempty and trimmed.");
const utcIso = z.string().max(40).datetime({ offset: false });

const shipmentEtaSchema = z.object({ shipmentId: boundedText(120), eta: utcIso }).strict();
const qaEvidenceSchema = z.object({ inventoryId: boundedText(120), evidenceRef: boundedText(240) }).strict();

export const whatIfInputSchema = z.object({
  shipmentEta: z.array(shipmentEtaSchema).min(1).max(10).optional(),
  qaEvidence: z.array(qaEvidenceSchema).min(1).max(10).optional(),
}).strict().superRefine((input, context) => {
  const etaRows = input.shipmentEta ?? [];
  const qaRows = input.qaEvidence ?? [];
  if (etaRows.length + qaRows.length > 10) {
    context.addIssue({ code: "custom", message: "At most 10 total hypothesis changes are allowed." });
  }
  const addDuplicateIssues = <T>(label: "shipmentEta" | "qaEvidence", rows: T[], idOf: (row: T) => string): void => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const id = idOf(row);
      if (seen.has(id)) context.addIssue({ code: "custom", path: [label, index], message: `Duplicate ${label} identifier: ${id}` });
      seen.add(id);
    });
  };
  addDuplicateIssues("shipmentEta", etaRows, (row) => row.shipmentId);
  addDuplicateIssues("qaEvidence", qaRows, (row) => row.inventoryId);
  if (etaRows.length + qaRows.length === 0) {
    context.addIssue({ code: "custom", message: "At least one hypothesis change is required." });
  }
});

export type WhatIfInput = z.infer<typeof whatIfInputSchema>;

type PlanSummary = {
  status: PlanResult["status"];
  shortfallEa: number;
  projectedInboundEa: number;
  transfers: Array<{ originSiteId: string; destinationSiteId: string; quantityEa: number; arriveAt: string }>;
  transportCostPoints: number | null;
};

export interface WhatIfResult {
  label: "HYPOTHETICAL";
  snapshotHash: string;
  baseline: PlanSummary;
  hypothesis: PlanSummary;
  comparison: { shortfallDeltaEa: number; projectedInboundDeltaEa: number };
  assumptions: string[];
  cannotApprove: true;
  neverMutatesSource: true;
}

function summarize(plan: PlanResult): PlanSummary {
  return {
    status: plan.status,
    shortfallEa: "shortfallEa" in plan ? plan.shortfallEa : 0,
    projectedInboundEa: plan.projectedInboundEa,
    transfers: plan.status === "feasible" ? plan.transfers.map(({ originSiteId, destinationSiteId, quantityEa, arriveAt }) => ({ originSiteId, destinationSiteId, quantityEa, arriveAt })) : [],
    transportCostPoints: plan.status === "feasible" ? plan.transportCostPoints : null,
  };
}

function describeReasons(label: string, plan: PlanResult): string[] {
  return plan.reasons.map((row) => `${label} condition ${row.code}${row.entityId ? ` (${row.entityId})` : ""}: ${row.message}`);
}

function describeExcludedInputs(label: string, snapshot: Snapshot): string[] {
  const assessment = assessSnapshot(snapshot);
  return [...assessment.shipments, ...assessment.inventory]
    .filter((item) => item.status === "EXCLUDED")
    .flatMap((item) => item.reasons.map((row) => `${label} condition ${row.code}${row.entityId ? ` (${row.entityId})` : ""}: ${row.message}`));
}

function describeCoverage(label: string, snapshot: Snapshot): string[] {
  const assessment = assessSnapshot(snapshot);
  return [...snapshot.demands].sort((a, b) => a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0).map((demand) => {
    const eligibleOnHandEa = assessment.sites.find((site) => site.siteId === demand.siteId)?.eligibleEa ?? 0;
    const projectedInboundEa = snapshot.shipments.reduce((sum, shipment, index) => {
      const eligible = assessment.shipments[index];
      return shipment.destinationSiteId === demand.siteId && eligible?.status === "CONDITIONAL_PROJECTED" ? sum + eligible.eligibleEa : sum;
    }, 0);
    const requiredEa = demand.demandEa + demand.requiredReserveEa;
    const gapEa = Math.max(0, requiredEa - eligibleOnHandEa - projectedInboundEa);
    return `${label} site ${demand.siteId}: eligible on-hand ${eligibleOnHandEa} EA plus projected inbound ${projectedInboundEa} EA against demand and reserve ${requiredEa} EA; direct gap ${gapEa} EA before any transfers.`;
  });
}

function requireKnownId(kind: string, id: string, exists: boolean): void {
  if (!exists) throw new Error(`Unknown ${kind} identifier: ${id}`);
}

function applyQaEvidence(snapshot: Snapshot, inventoryId: string, evidenceRef: string): string {
  const row = snapshot.inventory.find((candidate) => candidate.id === inventoryId);
  requireKnownId("inventory", inventoryId, !!row);
  if (!row) throw new Error(`Unknown inventory identifier: ${inventoryId}`);

  const match = assessSnapshot(snapshot).inventory.find((assessment) => assessment.entityId === inventoryId)?.recallMatch.status;
  if (row.qaStatus !== "UNVERIFIED") throw new Error(`QA hypothesis requires UNVERIFIED inventory: ${inventoryId}`);
  if (row.allocationHold) throw new Error(`QA hypothesis is disallowed for held inventory: ${inventoryId}`);
  if (match !== "NOT_LISTED_IN_THIS_RECALL") throw new Error(`QA hypothesis requires inventory confirmed NOT_LISTED_IN_THIS_RECALL: ${inventoryId}`);
  const catalog = snapshot.catalog.filter((item) => item.internalSku === snapshot.targetSku);
  if (row.internalSku !== snapshot.targetSku || catalog.length !== 1 ||
      row.manufacturerRef?.trim().toUpperCase() !== catalog[0]!.manufacturerRef.trim().toUpperCase() ||
      row.manufacturerRef?.trim().toUpperCase() !== snapshot.scope.manufacturerRef.trim().toUpperCase()) {
    throw new Error(`QA hypothesis requires the exact existing target product scope: ${inventoryId}`);
  }

  row.qaStatus = "RELEASED";
  row.qaEvidenceRef = evidenceRef;
  row.evidenceRefs = [...new Set([...row.evidenceRefs, evidenceRef])];
  return `Hypothetically add QA evidence ${evidenceRef} to inventory ${inventoryId}; all existing product, lot, expiry, quantity, reservation, and allocation constraints remain in force.`;
}

/** Pure read-only scenario analysis. It never returns an executable plan or persists state. */
export function runWhatIf(snapshot: Snapshot, input: WhatIfInput): WhatIfResult {
  const hypothesis = whatIfInputSchema.parse(input);
  const sourceHash = fingerprintSnapshot(snapshot);
  const hypotheticalSnapshot = structuredClone(snapshot);
  const assumptions: string[] = [];

  for (const change of hypothesis.shipmentEta ?? []) {
    const shipment = hypotheticalSnapshot.shipments.find((row) => row.id === change.shipmentId);
    requireKnownId("shipment", change.shipmentId, !!shipment);
    if (!shipment) throw new Error(`Unknown shipment identifier: ${change.shipmentId}`);
    if (shipment.status !== "PROJECTED_INBOUND_NOT_RECEIVED") {
      throw new Error(`ETA hypothesis requires an existing projected, unreceived shipment: ${change.shipmentId}`);
    }
    if (!Number.isFinite(parseUtcTimestamp(change.eta))) throw new Error(`Invalid UTC ETA for shipment: ${change.shipmentId}`);
    shipment.eta = change.eta;
    assumptions.push(`Hypothetically set the ETA of existing shipment ${change.shipmentId} to ${change.eta}; supply remains conditional on receipt and acceptance.`);
  }

  for (const change of hypothesis.qaEvidence ?? []) {
    assumptions.push(applyQaEvidence(hypotheticalSnapshot, change.inventoryId, change.evidenceRef));
  }

  const baselinePlan = planReplenishment(snapshot);
  const hypothesisPlan = planReplenishment(hypotheticalSnapshot);
  assumptions.push(...describeReasons("Baseline", baselinePlan));
  assumptions.push(...describeExcludedInputs("Baseline", snapshot));
  assumptions.push(...describeCoverage("Baseline", snapshot));
  assumptions.push(...describeReasons("Hypothesis", hypothesisPlan));
  assumptions.push(...describeExcludedInputs("Hypothesis", hypotheticalSnapshot));
  assumptions.push(...describeCoverage("Hypothesis", hypotheticalSnapshot));

  const baseline = summarize(baselinePlan);
  const projected = summarize(hypothesisPlan);
  return {
    label: "HYPOTHETICAL",
    snapshotHash: sourceHash,
    baseline,
    hypothesis: projected,
    comparison: {
      shortfallDeltaEa: projected.shortfallEa - baseline.shortfallEa,
      projectedInboundDeltaEa: projected.projectedInboundEa - baseline.projectedInboundEa,
    },
    assumptions,
    cannotApprove: true,
    neverMutatesSource: true,
  };
}
