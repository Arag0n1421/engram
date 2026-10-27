import { createHash } from "node:crypto";
import type { Snapshot } from "../domain/types.ts";
import { assessSnapshot } from "../domain/index.ts";
import { ZetarisClient, type ZetarisConfig } from "../integrations/index.ts";
import { normalizeDemand, normalizeInventory, normalizeProducts, normalizeShipments, type Row } from "./seed.ts";

/** Reads only registered views. Failures and truncation never fall back to bundled data. */
export function createLiveLoader(config: ZetarisConfig) {
  const client = new ZetarisClient(config);
  return async (seed: Snapshot): Promise<Snapshot> => {
    const started = performance.now();
    const phases: NonNullable<Snapshot["sourceRead"]>["phases"] = [];
    const names = ["inventory", "shipments", "demand", "products", "sites"] as const;
    const results: {name: typeof names[number]; rows: Row[]}[] = [];
    for (let offset = 0; offset < names.length; offset += 2) {
      const batch = names.slice(offset, offset + 2);
      const settled = await Promise.allSettled(batch.map(async name => {
        const phaseStarted = performance.now();
        const result = await client.queryRecallOpsView(name);
        if (result.possiblyTruncated) throw new Error(`Zetaris ${name} response may be truncated.`);
        const rows = result.rows.map(values => Object.fromEntries(result.columns.map((key, index) => [key, values[index]]))) as Row[];
        rows.sort((a, b) => String(a.id ?? a.internal_sku).localeCompare(String(b.id ?? b.internal_sku)));
        return {name, rows, phase: {name, elapsedMs: Math.round(performance.now() - phaseStarted), rows: rows.length}};
      }));
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        results.push({name: result.value.name, rows: result.value.rows});
        phases.push(result.value.phase);
      }
    }
    const sources = Object.fromEntries(results.map(r => [r.name, r.rows]));
    if (!sources.inventory.length || !sources.demand.length || !sources.products.length || sources.sites.length !== 3) throw new Error("Zetaris views must contain the complete three-site demo source pack.");
    if (sources.inventory.some(row => row.is_fictional !== true && row.is_fictional !== "true")) throw new Error("Only dedicated fictional operational data is accepted by this demo.");
    let reviewedScopeVersion: string | undefined;
    if (config.reviewedScopeView) {
      const phaseStarted = performance.now();
      const scope = await client.queryReviewedScope();
      if (scope.possiblyTruncated) throw new Error("Zetaris reviewed_scope response may be truncated.");
      const scopeRows = scope.rows.map(values => Object.fromEntries(scope.columns.map((key, index) => [key, values[index]])));
      const provenance = seed.recallProvenance;
      if (!provenance?.reviewed || scopeRows.length !== seed.scope.affectedLots.length) throw new Error("Zetaris FDA reviewed_scope is incomplete or has no reviewed raw source.");
      const expected = {source_url: provenance.sourceURL, retrieved_at: provenance.retrievedAt, rawsha256: provenance.rawsha256, recall_id: seed.scope.recallId, record_id: "213286", manufacturer_ref: seed.scope.manufacturerRef, product_description: provenance.productDescription, each_udi: provenance.eachUdi, case_udi: provenance.caseUdi, lot_source_field: "code_info"};
      if (scopeRows.some(row => Object.entries(expected).some(([key, value]) => row[key] !== value))) throw new Error("Zetaris FDA provenance, product or unit scope differs from the reviewed raw source.");
      const lots = scopeRows.map(row => row.lot_number);
      if (new Set(lots).size !== lots.length || lots.some(lot => typeof lot !== "string" || !seed.scope.affectedLots.includes(lot))) throw new Error("Zetaris FDA lot scope differs from the complete reviewed source.");
      scopeRows.sort((a, b) => String(a.lot_number).localeCompare(String(b.lot_number)));
      reviewedScopeVersion = createHash("sha256").update(JSON.stringify(scopeRows)).digest("hex");
      phases.push({name: "reviewed_scope", elapsedMs: Math.round(performance.now() - phaseStarted), rows: scopeRows.length});
    }
    const snapshot: Snapshot = {
      ...structuredClone(seed), dataMode: "live",
      sourceRead: {retrievedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), queryCount: phases.length, phases},
      inventory: normalizeInventory(sources.inventory), shipments: normalizeShipments(sources.shipments),
      demands: normalizeDemand(sources.demand), catalog: normalizeProducts(sources.products),
      ...(seed.recallProvenance ? {recallProvenance: {...seed.recallProvenance, zetarisScopeRead: !!reviewedScopeVersion}} : {}),
      sourceVersions: {...seed.sourceVersions, ...(reviewedScopeVersion ? {reviewed_scope: reviewedScopeVersion} : {}), ...Object.fromEntries(results.map(r => [r.name, createHash("sha256").update(JSON.stringify(r.rows)).digest("hex")]))},
    };
    const sites = new Set(sources.sites.map(row => String(row.id)));
    if (snapshot.inventory.some(row => !sites.has(row.siteId)) || snapshot.demands.some(row => !sites.has(row.siteId))) throw new Error("Source contains an unregistered site.");
    const checked = assessSnapshot(snapshot);
    if (!checked.valid) throw new Error(`Zetaris data violates the planning schema: ${checked.reasons.map(r => r.code).join(", ")}`);
    return snapshot;
  };
}
