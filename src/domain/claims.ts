import { z } from "zod";
import { fingerprint, fingerprintSnapshot, canonicalJson } from "./fingerprint.ts";
import { assessSnapshot, planReplenishment } from "./planning.ts";
import type { PlanResult, Snapshot, Transfer } from "./types.ts";

const citationList = z.array(z.string().min(1));
const safeEa = z.number().int().nonnegative().safe();

/** Model output is a typed set of proposed facts, not free-form prose. */
export const claimResponseSchema = z.object({
  snapshotHash: z.string().min(1),
  planFingerprint: z.string().min(1),
  claims: z.object({
    inventory: z.object({
      affectedEa: safeEa,
      eligibleEa: safeEa,
      citations: citationList,
    }).strict(),
    plan: z.object({
      status: z.enum(["feasible", "infeasible", "invalid_input"]),
      cutoff: z.string().min(1),
      totalRequiredEa: safeEa,
      projectedInboundEa: safeEa,
      projectedInbound: z.array(z.object({
        shipmentId: z.string().min(1),
        quantityEa: safeEa,
        eta: z.string().min(1),
        conditionalOnReceiptAndAcceptance: z.literal(true),
      }).strict()),
      shortfallEa: safeEa.nullable(),
      citations: citationList,
    }).strict(),
    transfers: z.array(z.object({
      lineId: z.string().min(1),
      routeId: z.string().min(1),
      originSiteId: z.string().min(1),
      destinationSiteId: z.string().min(1),
      quantityEa: safeEa,
      arriveAt: z.string().min(1),
      arrivesByCutoff: z.literal(true),
      stockAllocations: z.array(z.object({ inventoryId: z.string().min(1), quantityEa: safeEa }).strict()),
      citations: citationList,
    }).strict()),
  }).strict(),
}).strict();

export type ClaimResponse = z.infer<typeof claimResponseSchema>;
/** Pass this schema to providers that accept JSON Schema constrained output. */
export const claimResponseJsonSchema = z.toJSONSchema(claimResponseSchema);

type WireCitations<T> = Omit<T, "citations"> & {citations: string};
export type ClaimWireResponse = Omit<ClaimResponse, "claims"> & {
  claims: Omit<ClaimResponse["claims"], "inventory" | "plan" | "transfers"> & {
    inventory: WireCitations<ClaimResponse["claims"]["inventory"]>;
    plan: WireCitations<ClaimResponse["claims"]["plan"]>;
    transfers: Array<WireCitations<ClaimResponse["claims"]["transfers"][number]>>;
  };
};

/** Provider-only compact schema; the canonical checker schema above remains unchanged. */
export const claimResponseWireJsonSchema = (() => {
  const schema = structuredClone(claimResponseJsonSchema) as unknown as {
    properties: {claims: {properties: {
      inventory: {properties: Record<string, unknown>};
      plan: {properties: Record<string, unknown>};
      transfers: {items: {properties: Record<string, unknown>}};
    }}}};
  const citation = {type: "string", maxLength: 16_384, description: "ASCII-space separated citation references; preserve exact case and include every reference."};
  schema.properties.claims.properties.inventory.properties.citations = structuredClone(citation);
  schema.properties.claims.properties.plan.properties.citations = structuredClone(citation);
  schema.properties.claims.properties.transfers.items.properties.citations = structuredClone(citation);
  return schema;
})();

/** Encode only the known citation arrays. Whitespace in a canonical ref is ambiguous on this wire format. */
export function encodeClaimWire(canonical: ClaimResponse): ClaimWireResponse {
  const parsed = claimResponseSchema.parse(canonical);
  const encode = (refs: string[]): string => {
    if (refs.some(ref => /\s/u.test(ref))) throw new TypeError("Citation references containing whitespace cannot be encoded on the compact claim wire.");
    const joined = refs.join(" ");
    if (joined.length > 16_384) throw new TypeError("Citation list exceeds the compact claim wire limit.");
    return joined;
  };
  return {
    ...parsed,
    claims: {
      ...parsed.claims,
      inventory: {...parsed.claims.inventory, citations: encode(parsed.claims.inventory.citations)},
      plan: {...parsed.claims.plan, citations: encode(parsed.claims.plan.citations)},
      transfers: parsed.claims.transfers.map(row => ({...row, citations: encode(row.citations)})),
    },
  };
}

export type ClaimFeedbackCode =
  | "MALFORMED_RESPONSE"
  | "MISSING_CITATIONS"
  | "UNKNOWN_CITATION"
  | "IRRELEVANT_CITATION"
  | "STALE_SNAPSHOT"
  | "STALE_PLAN"
  | "PLAN_MISMATCH"
  | "CLAIM_MISMATCH";

export interface CheckedClaimSummary {
  snapshotHash: string;
  planFingerprint: string;
  cutoff: string;
  affectedEa: number;
  eligibleEa: number;
  status: PlanResult["status"];
  totalRequiredEa: number;
  projectedInboundEa: number;
  projectedInbound: Array<{ shipmentId: string; quantityEa: number; eta: string; conditionalOnReceiptAndAcceptance: true }>;
  shortfallEa: number | null;
  transfers: Array<Pick<Transfer, "lineId" | "routeId" | "originSiteId" | "destinationSiteId" | "quantityEa" | "arriveAt" | "stockAllocations"> & { arrivesByCutoff: true }>;
  /** Stable descriptions for rendering; never taken from model prose. */
  descriptions: string[];
  explanations: Array<{text: string; citations: string[]}>;
}

export interface ClaimCheckResult {
  valid: boolean;
  feedbackCodes: ClaimFeedbackCode[];
  checked?: CheckedClaimSummary;
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  let json = trimmed;
  // Allow a complete code-fenced JSON transport wrapper only; arbitrary prose is never scanned.
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline < 0) throw new TypeError("Incomplete JSON fence");
    const label = trimmed.slice(3, firstNewline).trim();
    if (label && label.toLowerCase() !== "json") throw new TypeError("Unsupported code fence");
    json = trimmed.slice(firstNewline + 1, -3).trim();
  }
  return JSON.parse(json);
}

/** Decode only documented wire citation slots; leave all other data for strict canonical parsing. */
function normalizeWireCitations(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const cloned = structuredClone(input) as Record<string, unknown>;
  const claims = cloned.claims;
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return cloned;
  const claimRows = claims as Record<string, unknown>;
  const decode = (row: unknown): void => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const object = row as Record<string, unknown>;
    if (typeof object.citations !== "string") return;
    if (object.citations.length > 16_384) throw new TypeError("Compact citation list exceeds the wire limit.");
    if (/[^\S ]/u.test(object.citations)) throw new TypeError("Only ASCII spaces may separate compact citation references.");
    object.citations = object.citations === "" ? [] : object.citations.split(" ");
  };
  decode(claimRows.inventory);
  decode(claimRows.plan);
  if (Array.isArray(claimRows.transfers)) for (const row of claimRows.transfers) decode(row);
  return cloned;
}

function knownEvidenceRefs(snapshot: Snapshot): Set<string> {
  const refs = new Set<string>();
  const add = (values: Array<string | null | undefined>): void => {
    for (const value of values) if (typeof value === "string" && value.length > 0) refs.add(value);
  };
  add(snapshot.scope.evidenceRefs);
  for (const row of snapshot.catalog) add(row.evidenceRefs);
  for (const row of snapshot.inventory) add([row.id, ...row.evidenceRefs, row.qaEvidenceRef, row.expiryEvidenceRef]);
  for (const row of snapshot.demands) add([row.id]);
  for (const row of snapshot.routes) add([row.id]);
  for (const row of snapshot.shipments) add([row.id, ...row.evidenceRefs, row.qaEvidenceRef, row.expiryEvidenceRef]);
  return refs;
}

function normalizedTransfers(plan: PlanResult): CheckedClaimSummary["transfers"] {
  if (plan.status !== "feasible") return [];
  return [...plan.transfers].sort((a, b) => a.lineId.localeCompare(b.lineId)).map((row) => ({
    lineId: row.lineId,
    routeId: row.routeId,
    originSiteId: row.originSiteId,
    destinationSiteId: row.destinationSiteId,
    quantityEa: row.quantityEa,
    arriveAt: row.arriveAt,
    arrivesByCutoff: true,
    stockAllocations: [...row.stockAllocations].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)),
  }));
}

function expectedFingerprint(plan: PlanResult): string {
  return plan.status === "feasible" ? plan.planFingerprint : fingerprint(plan);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

/** Exact per-claim references the model should return alongside its typed fields. */
export function claimCitationGuide(snapshot: Snapshot, plan: PlanResult): {
  snapshotHash: string;
  planFingerprint: string;
  inventory: string[];
  plan: string[];
  transfers: Array<{ lineId: string; citations: string[] }>;
} {
  const transferRows = normalizedTransfers(plan);
  const inventoryRefs = snapshot.inventory.flatMap((row) => [row.id, ...row.evidenceRefs, row.qaEvidenceRef ?? "", row.expiryEvidenceRef ?? ""]);
  const inventory = uniqueSorted([...inventoryRefs, ...snapshot.scope.evidenceRefs]);
  const planRefs = [
    ...inventoryRefs,
    ...snapshot.scope.evidenceRefs,
    ...snapshot.catalog.flatMap((row) => row.evidenceRefs),
    ...snapshot.demands.map((row) => row.id),
    ...snapshot.routes.map((row) => row.id),
    ...snapshot.shipments.flatMap((row) => [row.id, ...row.evidenceRefs, row.qaEvidenceRef ?? "", row.expiryEvidenceRef ?? ""]),
  ];
  return {
    snapshotHash: fingerprintSnapshot(snapshot),
    planFingerprint: expectedFingerprint(plan),
    inventory,
    plan: uniqueSorted(planRefs),
    transfers: transferRows.map((row) => ({
      lineId: row.lineId,
      citations: uniqueSorted([
        row.routeId,
        ...row.stockAllocations.flatMap((allocation) => {
          const lot = snapshot.inventory.find((item) => item.id === allocation.inventoryId);
          return lot ? [lot.id, ...lot.evidenceRefs, lot.qaEvidenceRef ?? "", lot.expiryEvidenceRef ?? ""] : [allocation.inventoryId];
        }),
      ]),
    })),
  };
}

function sameCitationSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    [...actual].sort().every((value, index) => value === expected[index]);
}

/**
 * Checks only the typed claims against the deterministic domain calculation.
 * Any accompanying natural-language response must be treated as unverified prose.
 */
export function checkClaims(input: unknown, snapshot: Snapshot, plan: PlanResult): ClaimCheckResult {
  let parsed: ClaimResponse;
  try {
    parsed = claimResponseSchema.parse(normalizeWireCitations(parseInput(input)));
  } catch {
    return { valid: false, feedbackCodes: ["MALFORMED_RESPONSE"] };
  }

  const codes = new Set<ClaimFeedbackCode>();
  let snapshotHash: string;
  let deterministicPlan: PlanResult;
  try {
    snapshotHash = fingerprintSnapshot(snapshot);
    deterministicPlan = planReplenishment(snapshot);
  } catch {
    return { valid: false, feedbackCodes: ["PLAN_MISMATCH"] };
  }
  const planFingerprint = expectedFingerprint(deterministicPlan);
  if (parsed.snapshotHash !== snapshotHash) codes.add("STALE_SNAPSHOT");
  if (plan.inputFingerprint !== snapshotHash || canonicalJson(plan) !== canonicalJson(deterministicPlan)) codes.add("STALE_PLAN");
  if (parsed.planFingerprint !== planFingerprint) codes.add("PLAN_MISMATCH");

  const guide = claimCitationGuide(snapshot, deterministicPlan);
  const allCitations = [
    ...parsed.claims.inventory.citations,
    ...parsed.claims.plan.citations,
    ...parsed.claims.transfers.flatMap((row) => row.citations),
  ];
  const validRefs = knownEvidenceRefs(snapshot);
  if (parsed.claims.inventory.citations.length === 0 || parsed.claims.plan.citations.length === 0 || parsed.claims.transfers.some((row) => row.citations.length === 0)) {
    codes.add("MISSING_CITATIONS");
  }
  if (allCitations.some((ref) => !validRefs.has(ref))) codes.add("UNKNOWN_CITATION");
  const transferGuides = new Map(guide.transfers.map((row) => [row.lineId, row.citations]));
  if (!sameCitationSet(parsed.claims.inventory.citations, guide.inventory)) {
    if (parsed.claims.inventory.citations.some((ref) => validRefs.has(ref) && !guide.inventory.includes(ref))) codes.add("IRRELEVANT_CITATION");
    else codes.add("MISSING_CITATIONS");
  }
  if (!sameCitationSet(parsed.claims.plan.citations, guide.plan)) {
    if (parsed.claims.plan.citations.some((ref) => validRefs.has(ref) && !guide.plan.includes(ref))) codes.add("IRRELEVANT_CITATION");
    else codes.add("MISSING_CITATIONS");
  }
  for (const row of parsed.claims.transfers) {
    const expected = transferGuides.get(row.lineId);
    if (!expected) { codes.add("CLAIM_MISMATCH"); continue; }
    if (!sameCitationSet(row.citations, expected)) {
      if (row.citations.some((ref) => validRefs.has(ref) && !expected.includes(ref))) codes.add("IRRELEVANT_CITATION");
      else codes.add("MISSING_CITATIONS");
    }
  }

  const assessment = assessSnapshot(snapshot);
  const expectedTransfers = normalizedTransfers(deterministicPlan);
  const expectedInbound = assessment.shipments
    .filter((row) => row.status === "CONDITIONAL_PROJECTED")
    .map((row) => {
      const shipment = snapshot.shipments.find((item) => item.id === row.entityId)!;
      return { shipmentId: shipment.id, quantityEa: row.eligibleEa, eta: shipment.eta, conditionalOnReceiptAndAcceptance: true as const };
    })
    .sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  const expectedShortfall = deterministicPlan.status === "feasible" ? null : deterministicPlan.shortfallEa;
  const claimedTransfers = [...parsed.claims.transfers].sort((a, b) => a.lineId.localeCompare(b.lineId)).map(({ citations: _citations, ...row }) => ({
    ...row,
    stockAllocations: [...row.stockAllocations].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)),
  }));
  if (
    parsed.claims.inventory.affectedEa !== assessment.totalAffectedEa ||
    parsed.claims.inventory.eligibleEa !== assessment.totalEligibleEa ||
    parsed.claims.plan.status !== deterministicPlan.status ||
    parsed.claims.plan.cutoff !== snapshot.clock.cutoff ||
    parsed.claims.plan.totalRequiredEa !== deterministicPlan.totalRequiredEa ||
    parsed.claims.plan.projectedInboundEa !== deterministicPlan.projectedInboundEa ||
    canonicalJson(parsed.claims.plan.projectedInbound) !== canonicalJson(expectedInbound) ||
    parsed.claims.plan.shortfallEa !== expectedShortfall ||
    canonicalJson(claimedTransfers) !== canonicalJson(expectedTransfers)
  ) codes.add("CLAIM_MISMATCH");

  if (codes.size > 0) return { valid: false, feedbackCodes: [...codes] };
  const checked: CheckedClaimSummary = {
    snapshotHash,
    planFingerprint,
    cutoff: snapshot.clock.cutoff,
    affectedEa: assessment.totalAffectedEa,
    eligibleEa: assessment.totalEligibleEa,
    status: deterministicPlan.status,
    totalRequiredEa: deterministicPlan.totalRequiredEa,
    projectedInboundEa: deterministicPlan.projectedInboundEa,
    projectedInbound: expectedInbound,
    shortfallEa: expectedShortfall,
    transfers: expectedTransfers,
    explanations: [
      ...assessment.inventory.filter(row => row.recallMatch.status === "CONFIRMED_MATCH").map(row => ({text: `${row.entityId} is excluded because its exact product and lot are in the reviewed recall scope; QA release cannot override a recall match.`, citations: uniqueSorted([row.entityId, ...row.evidenceRefs, ...snapshot.scope.evidenceRefs])})),
      ...snapshot.shipments.filter(row => Date.parse(row.eta) > Date.parse(snapshot.clock.cutoff)).map(row => ({text: `${row.id} arrives at ${row.eta}, after cutoff ${snapshot.clock.cutoff}; its ${row.quantityEa} EA cannot cover this deadline.`, citations: uniqueSorted([row.id, ...row.evidenceRefs])})),
      ...assessment.inventory.filter(row => row.status === "EXCLUDED" && row.recallMatch.status !== "CONFIRMED_MATCH").map(row => ({text: `${row.entityId} remains excluded: ${row.reasons.map(reason => reason.message).join(" ")}`, citations: uniqueSorted([row.entityId, ...row.evidenceRefs])})),
      ...(deterministicPlan.status === "feasible" ? deterministicPlan.siteBalances.map(row => ({text: `Site ${row.siteId} projects ${row.projectedEndEa} EA after ${row.demandEa} EA demand; required ending reserve is ${row.requiredReserveEa} EA.`, citations: guide.plan})) : [{text: `The checked eligible supply cannot cover demand and required ending reserves; shortfall is ${deterministicPlan.shortfallEa} EA.`, citations: guide.plan}]),
      ...(deterministicPlan.projectedInboundEa > 0 ? [{text: `${deterministicPlan.projectedInboundEa} EA projected inbound is counted conditionally on on-time receipt and acceptance.`, citations: uniqueSorted(snapshot.shipments.filter(row => assessment.shipments.find(a => a.entityId === row.id)?.status === "CONDITIONAL_PROJECTED").flatMap(row => [row.id, ...row.evidenceRefs, row.qaEvidenceRef ?? "", row.expiryEvidenceRef ?? ""]))}] : []),
    ],
    descriptions: [
      `Affected inventory: ${assessment.totalAffectedEa} EA.`,
      `Eligible inventory: ${assessment.totalEligibleEa} EA.`,
      `Required total: ${deterministicPlan.totalRequiredEa} EA; projected inbound: ${deterministicPlan.projectedInboundEa} EA; coverage cutoff: ${snapshot.clock.cutoff}.`,
      ...expectedInbound.map((row) => `Projected inbound ${row.shipmentId}: ${row.quantityEa} EA, ETA ${row.eta} ${Date.parse(row.eta) <= Date.parse(snapshot.clock.cutoff) ? "is by cutoff" : "is after cutoff"}; receipt and acceptance remain conditional.`),
      deterministicPlan.status === "feasible"
        ? `Plan status: feasible; ${expectedTransfers.length} transfer line(s).`
        : `Plan status: ${deterministicPlan.status}; unmet shortfall ${deterministicPlan.shortfallEa} EA.`,
      ...expectedTransfers.map((row) => `${row.originSiteId} to ${row.destinationSiteId}: ${row.quantityEa} EA via ${row.routeId}, arriving ${row.arriveAt} by cutoff; lots ${row.stockAllocations.map((allocation) => `${allocation.inventoryId} ${allocation.quantityEa} EA`).join(", ")}.`),
    ],
  };
  return { valid: true, feedbackCodes: [], checked };
}
