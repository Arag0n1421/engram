import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assessSnapshot, fingerprintSnapshot, planReplenishment } from "../../src/domain/index.ts";
import { RECALL_OPS_COLUMNS, type RecallOpsView, type ZetarisConfig } from "../../src/integrations/index.ts";
import { createLiveLoader } from "../../src/runtime/live.ts";
import { loadSeed, parseCsv, type Row } from "../../src/runtime/seed.ts";

const names = ["inventory", "shipments", "demand", "products", "sites"] as const;
const config: ZetarisConfig = {
  baseUrl: "http://localhost:8888/api/v1.0", apiKey: "private-test-key", orgId: "1",
  views: Object.fromEntries(names.map(name => [name, `recallops.${name}`])),
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status, headers: {"content-type": "application/json"}});

async function sources(): Promise<Record<RecallOpsView, Row[]>> {
  const [csv, shipments, demand, catalog] = await Promise.all([
    readFile(resolve("data/inventory.csv"), "utf8"), readFile(resolve("data/shipments.json"), "utf8"),
    readFile(resolve("data/demand.json"), "utf8"), readFile(resolve("data/catalog.json"), "utf8"),
  ]);
  const products = JSON.parse(catalog);
  return {inventory: parseCsv(csv), shipments: JSON.parse(shipments).rows, demand: JSON.parse(demand).rows, products: products.products, sites: products.sites};
}

function requestName(input: Parameters<typeof fetch>[0], init?: RequestInit): RecallOpsView {
  assert.equal(String(input), `${config.baseUrl}/sql-editor/sqls/run`);
  const body = JSON.parse(String(init?.body));
  const name = names.find(name => body.sql === `SELECT ${RECALL_OPS_COLUMNS[name].join(", ")} FROM recallops.${name} LIMIT 1000`);
  assert.ok(name, "Every read must retain the exact configured view and explicit ordered columns");
  return name;
}

test("live loader reads five fresh views in bounded pairs and preserves order, normalized content, and canonical hashes", async t => {
  const seed = (await loadSeed()).snapshot;
  const raw = await sources();
  const requests: RecallOpsView[] = [];
  let active = 0; let maxActive = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const name = requestName(input, init);
    requests.push(name); active++; maxActive = Math.max(maxActive, active);
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      return json([...raw[name]].reverse().map(row => RECALL_OPS_COLUMNS[name].map(column => row[column])));
    } finally {active--;}
  });
  const loader = createLiveLoader(config);
  const first = await loader(seed);
  assert.deepEqual(requests, names);
  assert.equal(maxActive, 2, "Independent view reads should overlap, with concurrency bounded at two");
  assert.deepEqual(first.sourceRead?.phases.map(phase => phase.name), names, "Phase evidence remains in the established source order");
  assert.equal(first.dataMode, "live");
  assert.deepEqual(first.inventory, [...seed.inventory].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(first.shipments, seed.shipments);
  assert.deepEqual(first.demands, seed.demands);
  assert.deepEqual(first.catalog, seed.catalog);
  const expectedVersions = {...seed.sourceVersions};
  for (const name of names) {
    const ordered = raw[name].map(row => Object.fromEntries(RECALL_OPS_COLUMNS[name].map(column => [column, row[column]])))
      .sort((a, b) => String(a.id ?? a.internal_sku).localeCompare(String(b.id ?? b.internal_sku)));
    expectedVersions[name] = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  }
  assert.deepEqual(first.sourceVersions, expectedVersions);
  const assessment = assessSnapshot(first);
  assert.equal(assessment.totalAffectedEa, 120); assert.equal(assessment.totalEligibleEa, 240);
  const baseline = planReplenishment(first);
  if (baseline.status !== "feasible") assert.fail();
  assert.deepEqual(baseline.transfers.map(line => [line.originSiteId, line.quantityEa]), [["B", 30]]);
  raw.shipments[0]!.eta = "2025-05-02T18:00:00Z";
  const second = await loader(seed);
  assert.deepEqual(requests, [...names, ...names], "A second call must reread every view without a cache");
  assert.equal(maxActive, 2);
  assert.notEqual(fingerprintSnapshot(second), fingerprintSnapshot(first));
  assert.equal(first.shipments[0]!.eta, "2025-05-02T14:00:00Z", "New reads must not mutate earlier snapshots");
  const late = planReplenishment(second);
  if (late.status !== "feasible") assert.fail();
  assert.deepEqual(late.transfers.map(line => [line.originSiteId, line.quantityEa]), [["B", 50], ["C", 20]]);
});

test("a failed live view rejects without replay fallback or querying later batches", async t => {
  const seed = (await loadSeed()).snapshot;
  const raw = await sources(); const requests: RecallOpsView[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const name = requestName(input, init); requests.push(name);
    if (name === "shipments") return json([], 503);
    return json(raw[name].map(row => RECALL_OPS_COLUMNS[name].map(column => row[column])));
  });
  await assert.rejects(createLiveLoader(config)(seed), {code: "HTTP_ERROR", status: 503});
  assert.deepEqual(requests, ["inventory", "shipments"]);
  assert.equal(seed.dataMode, "fixture");
  assert.equal(seed.shipments[0]!.eta, "2025-05-02T14:00:00Z");
});

test("a possibly truncated live view fails closed after its bounded pair and before later batches", async t => {
  const seed = (await loadSeed()).snapshot;
  const raw = await sources(); const requests: RecallOpsView[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const name = requestName(input, init); requests.push(name);
    const row = RECALL_OPS_COLUMNS.inventory.map(column => raw.inventory[0]![column]);
    return json(Array.from({length: 1000}, () => row));
  });
  await assert.rejects(createLiveLoader(config)(seed), /inventory response may be truncated/);
  assert.deepEqual(requests, ["inventory", "shipments"]);
  assert.ok(!requests.includes("demand"), "A failed batch must not launch subsequent views");
});

test("optional sixth FDA read binds exact complete lot scope and raw provenance; mismatch fails closed", async t => {
  const {FDA_SCOPE_COLUMNS}=await import('../../src/integrations/zetaris.ts');
  const seed=(await loadSeed()).snapshot,raw=await sources();
  const scopeCsv=await readFile(resolve('data/zetaris/reviewed_scope.csv'),'utf8');
  let reviewed=parseCsv(scopeCsv);let scopeReads=0;
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(body.sql===`SELECT ${FDA_SCOPE_COLUMNS.join(', ')} FROM recallops.reviewed_scope LIMIT 1000`){scopeReads++;return json(reviewed.map(row=>FDA_SCOPE_COLUMNS.map(key=>row[key])));}
    const name=requestName(input,init);return json(raw[name].map(row=>RECALL_OPS_COLUMNS[name].map(key=>row[key])));
  });
  const loader=createLiveLoader({...config,reviewedScopeView:'recallops.reviewed_scope'});
  const snapshot=await loader(seed);assert.equal(scopeReads,1);assert.equal(snapshot.sourceRead?.queryCount,6);assert.equal(snapshot.recallProvenance?.zetarisScopeRead,true);assert.ok(snapshot.sourceVersions.reviewed_scope);assert.equal(snapshot.scope.affectedLots.length,32);
  reviewed=reviewed.slice(1);await assert.rejects(loader(seed),/incomplete/);
  reviewed=parseCsv(scopeCsv);reviewed[0]!.rawsha256='0'.repeat(64);await assert.rejects(loader(seed),/provenance/);
  reviewed=parseCsv(scopeCsv);reviewed[0]!.lot_number='23IJA103';await assert.rejects(loader(seed),/lot scope/);
});
