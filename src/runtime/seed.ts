import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Snapshot, InventoryLot, Shipment, QaStatus } from "../domain/types.ts";
import { reviewFdaRecord, applyReviewedFdaScope } from "../integrations/fda.ts";
import type { Scenario, EvidenceSource } from "../shared/workspace.ts";

export type Row = Record<string, unknown>;
const str = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error("Source text fields must contain strings");
  return value;
};
const nullable = (value: unknown): string | null => str(value).trim() || null;
const num = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  throw new Error("Source quantities must contain finite numbers or decimal text");
};
const version = (value: unknown): string | number => {
  if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim())) return value;
  throw new Error("Source version must be present");
};
const bool = (value: unknown): boolean => value === true || value === "true";
const holdState = (value: unknown): boolean => {
  if (value === true || (typeof value === "string" && value.trim().toLowerCase() === "true")) return true;
  if (value === false || (typeof value === "string" && value.trim().toLowerCase() === "false")) return false;
  throw new Error("Inventory allocation_hold must explicitly be true or false");
};
const qa = (value: unknown): QaStatus => ["RELEASED", "PROJECTED_RELEASE", "BLOCKED"].includes(str(value)) ? value as QaStatus : "UNVERIFIED";

/** Small RFC4180 reader, also used by the bundled fixture validator tests. */
export function parseCsv(csv: string): Row[] {
  const records: string[][] = []; let record: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) {
      record.push(field.replace(/\r$/, "")); field = "";
      if (c === "\n") { if (record.some(Boolean)) records.push(record); record = []; }
    } else field += c;
  }
  if (quoted) throw new Error("Unclosed CSV field");
  if (field || record.length) { record.push(field.replace(/\r$/, "")); records.push(record); }
  const headers = records.shift() ?? [];
  if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV column");
  return records.map((values) => {
    if (values.length !== headers.length) throw new Error("CSV row width differs from header");
    return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
  });
}

function identified(row: Row) {
  return {
    id: str(row.id), internalSku: str(row.internal_sku), manufacturerRef: nullable(row.manufacturer_ref),
    lot: nullable(row.lot), unit: str(row.unit), packagingLevel: str(row.packaging_level),
    expiresAt: nullable(row.expires_at), qaStatus: qa(row.qa_status),
    qaEvidenceRef: nullable(row.qa_evidence_ref), expiryEvidenceRef: nullable(row.expiry_evidence_ref),
    version: version(row.source_version),
    evidenceRefs: [str(row.id), nullable(row.qa_evidence_ref), nullable(row.expiry_evidence_ref)].filter((v): v is string => !!v),
  };
}
export function normalizeInventory(rows: Row[]): InventoryLot[] {
  return rows.map(row => ({ ...identified(row), siteId: str(row.site_id), quantityEa: num(row.quantity), reservedEa: num(row.reserved_quantity), allocationHold: holdState(row.allocation_hold) }));
}
export function normalizeShipments(rows: Row[]): Shipment[] {
  return rows.map(row => ({ ...identified(row), destinationSiteId: str(row.destination_site_id), quantityEa: num(row.quantity), eta: str(row.eta), status: str(row.status) as Shipment["status"], conditionalOnReceiptAndAcceptance: bool(row.planning_availability_is_conditional_on_receipt_and_acceptance) }));
}
export function normalizeDemand(rows: Row[]): Snapshot["demands"] {
  return rows.map(row => ({id: str(row.id), siteId: str(row.site_id), internalSku: str(row.internal_sku), demandEa: num(row.demand_quantity), requiredReserveEa: num(row.required_ending_reserve), version: version(row.source_version)}));
}
export function normalizeProducts(rows: Row[]): Snapshot["catalog"] {
  return rows.map(row => ({internalSku: str(row.internal_sku), manufacturerRef: str(row.manufacturer_ref), unit: str(row.unit), approvedForDemo: bool(row.approved_item_for_demo), evidenceRefs: [str(row.approval_evidence_ref)].filter(Boolean)}));
}

export async function loadSeed(root = process.cwd()) {
  const json = async (file: string) => JSON.parse(await readFile(resolve(root, "data", file), "utf8"));
  const [catalog, demand, shipments, routes, evidence, csv, fdaSource, fdaReviewed] = await Promise.all([
    json("catalog.json"), json("demand.json"), json("shipments.json"), json("routes.json"), json("recall-evidence.json"),
    readFile(resolve(root, "data/inventory.csv"), "utf8"), json("fda/source.json"), json("fda/reviewed_scope.json"),
  ]);
  const inventory = normalizeInventory(parseCsv(csv));
  const lots: unknown = evidence.recall.affected_lots;
  if (evidence.recall.fda_recall_number !== "Z-1706-2025" || evidence.recall.manufacturer_ref !== "RDI30296" || evidence.recall.affected_lot_count !== 32 || !Array.isArray(lots) || lots.length !== 32 || new Set(lots).size !== 32 || lots.some(lot => typeof lot !== "string" || !/^[0-9]{2}[A-Z]{3}[0-9]{3}$/.test(lot)) || !lots.includes("23JJA103")) {
    throw new Error("Recall source scope is incomplete or differs from the validated source pack");
  }
  let snapshot: Snapshot = {
    dataMode: "fixture", targetSku: "DEMO-SKU-SALINE-100", recipientSiteId: "A",
    clock: {analysisAt: catalog.scenario_clock.analysis_at, dispatchAt: catalog.scenario_clock.dispatch_by, cutoff: catalog.scenario_clock.coverage_cutoff},
    sourceVersions: {inventory: 1, demand: 1, shipments: 1, catalog: 1, routes: 1, recall: "FDA-213286-20261022"},
    scope: {recallId: evidence.recall.fda_recall_number, manufacturerRef: evidence.recall.manufacturer_ref, affectedLots: evidence.recall.affected_lots, complete: true, reviewLots: evidence.known_source_conflicts.map((r: Row) => str(r.distributor_cover_value)), version: "FDA-213286-20261022", evidenceRefs: ["FDA-PRODUCT-LOT-SCOPE", "MFG-LOT-SCOPE"]},
    catalog: normalizeProducts(catalog.products), inventory, demands: normalizeDemand(demand.rows), shipments: normalizeShipments(shipments.rows),
    routes: routes.rows.map((row: Row) => ({id: str(row.id), originSiteId: str(row.origin_site_id), destinationSiteId: str(row.destination_site_id), leadTimeMinutes: num(row.lead_time_minutes), costPointsPerEa: num(row.cost_points_per_unit), capacityEa: num(row.capacity_units), version: version(row.source_version)})),
  };
  const fdaReview = reviewFdaRecord(fdaSource, fdaReviewed);
  if (fdaReview.status !== "reviewed") throw new Error(`FDA source requires human review: ${fdaReview.reasons.join("; ")}`);
  snapshot = applyReviewedFdaScope(snapshot, fdaReview);
  snapshot.sourceVersions.recall = snapshot.scope.version;
  snapshot.recallProvenance = {sourceURL: fdaSource.sourceURL, retrievedAt: fdaSource.retrievedAt, rawsha256: fdaSource.rawsha256, datasetLastUpdated: fdaReviewed.lastUpdated, reviewed: true, productDescription: fdaReviewed.productDescriptionExact, eachUdi: fdaReviewed.eachUdi, caseUdi: fdaReviewed.caseUdi};
  const titles: Record<string, string> = {"FDA-213286": "FDA recall record · Z-1706-2025", "MANUFACTURER-R-25-057": "Manufacturer letter and distributor packet"};
  return {
    snapshot, evidence,
    disclosure: `${catalog.disclosure} Historical replay: 2 May 2025; source snapshots retrieved October 2026.`,
    sources: evidence.sources.map((row: Row) => ({id: str(row.id), title: titles[str(row.id)] ?? str(row.id), url: str(row.url)})) as EvidenceSource[],
  };
}

export function applyScenario(base: Snapshot, scenario: Scenario): Snapshot {
  const s = structuredClone(base);
  if (scenario !== "on_time") {
    s.shipments[0]!.eta = "2025-05-02T18:00:00Z";
    s.shipments[0]!.version = 2; s.sourceVersions.shipments = 2;
  }
  if (scenario === "qa_missing") {
    const row = s.inventory.find(row => row.id === "DEMO-INV-B-FAULTABLE")!;
    row.qaStatus = "UNVERIFIED"; row.qaEvidenceRef = "DEMO-QA-B-002-REVOKED";
    row.evidenceRefs = [row.id, "DEMO-QA-B-002-REVOKED", row.expiryEvidenceRef!]; row.version = 2;
    s.sourceVersions.inventory = 2;
  }
  return s;
}
