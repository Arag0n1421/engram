import { createHash } from "node:crypto";
import type { FeasiblePlan, Snapshot } from "./types.ts";

/** Stable for object-key order; rejects values JSON would silently discard. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot fingerprint a nonfinite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Only plain JSON values can be fingerprinted");
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Source row order is not meaningful. All relevant values and revisions are. */
export function fingerprintSnapshot(snapshot: Snapshot): string {
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => compareText(a.id, b.id));
  const {sourceRead: _telemetry, ...semanticSnapshot} = snapshot;
  return fingerprint({
    ...semanticSnapshot,
    scope: {
      ...snapshot.scope,
      affectedLots: [...snapshot.scope.affectedLots].sort(),
      reviewLots: [...snapshot.scope.reviewLots].sort(),
      evidenceRefs: [...snapshot.scope.evidenceRefs].sort(),
    },
    catalog: [...snapshot.catalog].sort((a, b) => compareText(a.internalSku, b.internalSku)),
    inventory: byId(snapshot.inventory),
    demands: byId(snapshot.demands),
    routes: byId(snapshot.routes),
    shipments: byId(snapshot.shipments),
  });
}

export function fingerprintPlan(plan: Omit<FeasiblePlan, "id" | "planFingerprint"> | FeasiblePlan): string {
  const { id: _id, planFingerprint: _fingerprint, ...payload } = plan as FeasiblePlan;
  return fingerprint(payload);
}
