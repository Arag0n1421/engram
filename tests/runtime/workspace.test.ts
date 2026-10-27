import {enterPlanningPhase,readPlanningEvidence} from "./planning-phase-fixture.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import { loadSeed, normalizeInventory, parseCsv } from "../../src/runtime/seed.ts";
import { guardLocal, readBody } from "../../src/runtime/http.ts";
import { applyMessageEvent } from "../../src/runtime/events.ts";
import { fingerprintSnapshot, validatePlanAgainstSnapshot } from "../../src/domain/index.ts";

const setup = async (extra = {}) => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-test-"));
  return {stateDir, store: new WorkspaceStore({root: process.cwd(), stateDir, ...extra})};
};

test("actual seed normalizes to expected baseline and exact supplier-delay plan", async () => {
  const {store} = await setup(); let w = await store.getWorkspace();
  assert.equal(w.snapshot.inventory.reduce((sum, row) => sum + row.quantityEa, 0), 370);
  assert.equal(w.assessment.totalEligibleEa, 240); assert.equal(w.assessment.totalAffectedEa, 120); assert.equal(w.assessment.totalReviewOrExcludedEa, 10);
  w = await store.calculatePlan(); assert.equal(w.plan?.status, "feasible");
  if (w.plan?.status !== "feasible") assert.fail();
  assert.deepEqual(w.plan.transfers.map(t => [t.originSiteId, t.quantityEa]), [["B", 30]]);
  assert.deepEqual(w.plan.projectedEndEa, {A: 10, B: 40, C: 50});
  await store.changeScenario("supplier_late");
  w = await store.getWorkspace(); assert.equal(w.planState, "stale");
  w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail();
  assert.deepEqual(w.plan.transfers.map(t => [t.originSiteId, t.quantityEa]), [["B", 50], ["C", 20]]);
  assert.equal(w.plan.transportCostPoints, 110);
  await store.changeScenario("qa_missing"); w = await store.calculatePlan();
  assert.equal(w.plan?.status, "infeasible");
  if (!w.plan) assert.fail();
  assert.equal(w.plan.shortfallEa, 30);
  await assert.rejects(store.reserve("invented", "infeasible-approval"), /feasible/);
});

test("stale proposals cannot be approved after source changes or applying a hold", async () => {
  const {store} = await setup(); let w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail();
  const first = w.plan.planFingerprint;
  await store.changeScenario("supplier_late"); await assert.rejects(store.reserve(first, "stale"), /changed|proposal/);
  w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail(); const second = w.plan.planFingerprint;
  w = await store.hold(w.assessment.inputFingerprint, ["DEMO-INV-A-AFFECTED"], "hold");
  assert.equal(w.planState, "stale"); await assert.rejects(store.reserve(second, "stale-hold"), /changed/);
  assert.equal(w.recall.tasks[0]!.status, "PENDING");
});

test("same reservation key is durable across restart; changed payload conflicts", async () => {
  const {stateDir, store} = await setup(); const w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail();
  const fingerprint = w.plan.planFingerprint;
  const once = await store.reserve(fingerprint, "reserve-once"); assert.equal(once.receipts.length, 1);
  const restarted = new WorkspaceStore({root: process.cwd(), stateDir});
  const twice = await restarted.reserve(fingerprint, "reserve-once"); assert.equal(twice.receipts.length, 1);
  assert.equal(twice.planState, "reserved"); assert.equal(twice.snapshot.inventory.find(r => r.id === "DEMO-INV-B-BASE")!.reservedEa, 30);
  assert.equal((await restarted.getWorkspace()).snapshot.inventory.find(r => r.id === "DEMO-INV-B-BASE")!.reservedEa, 30);
  await assert.rejects(restarted.reserve("different", "reserve-once"), /different action/);
  await assert.rejects(restarted.changeScenario("supplier_late"), /already has reserved/);
  const reset = await restarted.reset(); assert.equal(reset.receipts.length, 1); assert.equal(reset.planState, "none");
  assert.equal(reset.snapshot.inventory.find(r => r.id === "DEMO-INV-B-BASE")!.reservedEa, 0);
});

test("concurrent distinct approvals serialize to one reservation", async () => {
  const {store} = await setup(); const w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail();
  const results = await Promise.allSettled([store.reserve(w.plan.planFingerprint, "click-one"), store.reserve(w.plan.planFingerprint, "click-two")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await store.getWorkspace()).receipts.filter(r => r.action === "reserve").length, 1);
});

test("hold retries do not duplicate receipts and cannot hold unidentified or reserved recalled stock", async () => {
  const {stateDir, store} = await setup(); const w = await store.getWorkspace();
  await assert.rejects(store.hold(w.assessment.inputFingerprint, ["DEMO-INV-A-REVIEW"], "unknown"), /confirmed/);
  await store.hold(w.assessment.inputFingerprint, ["DEMO-INV-A-AFFECTED"], "same-hold");
  const restarted = new WorkspaceStore({root: process.cwd(), stateDir});
  assert.equal((await restarted.hold(w.assessment.inputFingerprint, ["DEMO-INV-A-AFFECTED"], "same-hold")).receipts.length, 1);
  const seed = (await loadSeed()).snapshot; seed.inventory.find(r => r.id === "DEMO-INV-A-AFFECTED")!.reservedEa = 10;
  const live = await setup({liveLoader: async () => seed}); const liveW = await live.store.getWorkspace();
  await assert.rejects(live.store.hold(liveW.assessment.inputFingerprint, ["DEMO-INV-A-AFFECTED"], "reserved-hold"), /existing reservation/);
});

test("late model callbacks cannot change a new incident, and interrupted runs can be recovered", async () => {
  const {stateDir, store} = await setup({model: "meterless/nemotron-test", inferenceAllowed: true});
  const first = await store.startInvestigation(); const runId = first.agentRun.runId!;
  await store.trace(runId, "read_notice", "Actual notice read");
  await assert.rejects(store.reset(), /Wait/);
  const restarted = new WorkspaceStore({root: process.cwd(), stateDir, model: "meterless/nemotron-test", inferenceAllowed: true});
  await restarted.cancelInvestigation(runId); const fresh = await restarted.reset();
  await restarted.finishInvestigation(runId, "old answer");
  await assert.rejects(restarted.trace(runId, "old tool", "old trace"), /no longer active/);
  const readback = await restarted.getWorkspace(); assert.equal(readback.agentRun.status, "idle"); assert.equal(readback.incidentId, fresh.incidentId);
  await assert.rejects(restarted.getSnapshot(runId), /no longer active/);
});

test("investigation startup saves a running state only after one successful fresh source read", async () => {
  const seed = (await loadSeed()).snapshot;
  let unavailable = true; let reads = 0;
  const {store} = await setup({model: "test", inferenceAllowed: true, liveLoader: async () => {
    reads++; if (unavailable) throw new Error("source unavailable during startup"); return seed;
  }});
  const idle = await store.getProgress();
  await assert.rejects(store.startInvestigation(), /source unavailable during startup/);
  assert.equal(reads, 1);
  assert.deepEqual(await store.getProgress(), idle, "A failed first source read must not save a run ID, revision or running state");
  unavailable = false;
  const started = await store.startInvestigation();
  assert.equal(reads, 2, "Successful startup must reuse its sole fresh snapshot for the response");
  assert.equal(started.agentRun.status, "running");
  assert.ok(started.agentRun.runId);
  assert.equal(started.assessment.inputFingerprint, fingerprintSnapshot(started.snapshot));
  await assert.rejects(store.startInvestigation(), /already running/);
  assert.equal(reads, 2, "Duplicate startup must reject before querying providers");
  await store.finishInvestigation(started.agentRun.runId, "Previous investigation completed.");
  const previous = await store.getProgress();
  unavailable = true;
  await assert.rejects(store.startInvestigation(), /source unavailable during startup/);
  assert.equal(reads, 3);
  assert.deepEqual(await store.getProgress(), previous, "Failed restart must preserve the prior completed run and its revision");
});

test("investigation startup requires model configuration and inference authorization before any source read", async () => {
  for (const options of [{model: "test", inferenceAllowed: false}, {inferenceAllowed: true}, {}]) {
    let reads = 0;
    const {store} = await setup({...options, liveLoader: async () => {reads++; throw new Error("must not read sources");}});
    const idle = await store.getProgress();
    await assert.rejects(store.startInvestigation(), {status: 403});
    assert.equal(reads, 0);
    assert.deepEqual(await store.getProgress(), idle);
  }
});

test("unclear holds fail closed and CSV preserves quoted delimiters", async () => {
  const rows = parseCsv(await readFile(resolve("data/inventory.csv"), "utf8"));
  assert.equal(normalizeInventory([{...rows[0], allocation_hold: "TRUE"}])[0]!.allocationHold, true);
  for (const invalid of [undefined, "", "unknown"]) assert.throws(() => normalizeInventory([{...rows[0], allocation_hold: invalid}]), /explicitly/);
  for (const invalid of [{}, true, ["DEMO-LOT"]]) assert.throws(() => normalizeInventory([{...rows[0], lot: invalid}]), /strings/);
  for (const invalid of [true, [20], {}, " "]) assert.throws(() => normalizeInventory([{...rows[0], quantity: invalid}]), /finite numbers/);
  assert.deepEqual(parseCsv('id,name\n1,"A, B"\n'), [{id: "1", name: "A, B"}]);
});

test("incomplete recall list cannot be relabelled complete by metadata", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "recallops-pack-")); await cp(resolve("data"), resolve(root, "data"), {recursive: true});
  const file = resolve(root, "data/recall-evidence.json"); const evidence = JSON.parse(await readFile(file, "utf8"));
  evidence.recall.affected_lots = evidence.recall.affected_lots.slice(0, 1); await writeFile(file, JSON.stringify(evidence));
  await assert.rejects(loadSeed(root), /incomplete/);
});

test("local API rejects remote origins, non-JSON mutations, and oversized bodies", async () => {
  assert.throws(() => guardLocal(new Request("https://example.com/api/workspace")), /Remote/);
  assert.throws(() => guardLocal(new Request("http://127.0.0.1:4317/api/workspace", {headers: {origin: "https://malicious.example"}})), /Origin/);
  assert.throws(() => guardLocal(new Request("http://127.0.0.1:4317/api/plan", {method: "POST", body: "{}"})), /application\/json/);
  await assert.rejects(readBody(new Request("http://127.0.0.1:4317/api/plan", {method: "POST", headers: {"content-type": "application/json"}, body: '"' + "x".repeat(20_000) + '"'})), /large/);
});

test("interim narration stays running and an unverified planning final reply fails", async () => {
  const {store} = await setup({model: "test-model", inferenceAllowed: true});
  const workspace = await store.startInvestigation(); const runId = workspace.agentRun.runId!;
  await applyMessageEvent({finishReason: "tool-calls", message: "I will inspect stock."}, runId, store);
  assert.equal((await store.activeInvestigation()).agentRun.status, "running");
  await enterPlanningPhase(store,runId);
  for (let i = 0; i < 12; i++) await store.claimModelCall(runId);
  await assert.rejects(store.claimModelCall(runId), /12-request/);
  await applyMessageEvent({finishReason: "stop", message: [{type: "text", text: "Checked evidence."}]}, runId, store);
  const final = await store.activeInvestigation();
  assert.equal(final.agentRun.status, "failed");
  assert.match(final.agentRun.summary,/12-request limit.*unfinished workflow/);
  assert.match(final.agentRun.error ?? "",/12-request limit.*unfinished workflow/);
  assert.notEqual(final.agentRun.claimAudit?.status, "verified");
});

test("larger model output budget requires current-run persisted planning checkpoints", async () => {
  const {store} = await setup({model: "test", inferenceAllowed: true});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await enterPlanningPhase(store,runId);
  const budget = () => store.claimModelCall(runId);
  assert.equal((await budget()).maxOutputTokens, 4096);
  await store.trace(runId, "assistant", "Independent validation passed for the current source snapshot. Prepared pending human checklist; no operational action executed.");
  assert.equal((await budget()).maxOutputTokens, 4096, "Model prose cannot authorize a larger budget");
  await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
  assert.equal((await budget()).maxOutputTokens, 4096, "Preparation traces alone cannot authorize a larger budget");
  await store.trace(runId, "validate_plan", "Validation did not authorize an executable proposal.");
  await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
  assert.equal((await budget()).maxOutputTokens, 4096, "Legacy validation traces do not create a checkpoint");
  await store.trace(runId, "validate_plan", "Independent validation passed for the current source snapshot.");
  assert.equal((await budget()).maxOutputTokens, 4096, "A successful validation trace is not a bound checkpoint");
  await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
  await readPlanningEvidence(store,runId);
  await store.calculatePlan(runId);
  await store.recordWorkflowCheckpoint(runId, "solve_plan");
  await store.recordWorkflowCheckpoint(runId, "validate_plan");
  assert.equal((await budget()).phase, "prepare");
  await store.recordWorkflowCheckpoint(runId, "prepare_actions");
  assert.equal((await budget()).maxOutputTokens, 4096);
  await store.calculatePlan(runId);
  assert.equal((await budget()).maxOutputTokens, 4096, "A new calculation revokes preparation even when its plan is identical");
  await store.finishInvestigation(runId, "Ended run.");
  const nextRun = (await store.startInvestigation()).agentRun.runId!;
  await assert.rejects(store.claimModelCall(runId), /no longer active/);
  assert.equal((await store.claimModelCall(nextRun)).maxOutputTokens, 4096, "Previous-run evidence cannot authorize a new run's budget");
});

test("saved reservation receipt is returned without a second provider read after commit", async () => {
  let reads = 0;
  const seed = (await loadSeed()).snapshot;
  const {store} = await setup({liveLoader: async () => {if (++reads > 2) throw new Error("provider unavailable"); return seed;}});
  const w = await store.calculatePlan(); if (w.plan?.status !== "feasible") assert.fail();
  const result = await store.reserve(w.plan.planFingerprint, "persist-before-outage");
  assert.equal(result.receipts.length, 1); assert.equal(reads, 2);
  await assert.rejects(store.getWorkspace(), /unavailable/);
  assert.equal((await store.receiptLedger()).receipts.length, 1);
});

test("source outage cannot prevent local run cancellation and recovery", async () => {
  let unavailable = false; const seed = (await loadSeed()).snapshot;
  const {store} = await setup({liveLoader: async () => {if (unavailable) throw new Error("source down"); return seed;}, model: "test", inferenceAllowed: true});
  const w = await store.startInvestigation(); unavailable = true;
  assert.equal((await store.activeInvestigation()).agentRun.runId, w.agentRun.runId);
  await assert.rejects(store.cancelInvestigation(w.agentRun.runId!), /source down/);
  assert.equal((await store.activeInvestigation()).agentRun.status, "failed");
});

test("run tools share one immutable snapshot and approval detects later live changes", async () => {
  const seed = (await loadSeed()).snapshot;
  let reads = 0;
  const {store} = await setup({model: "test", inferenceAllowed: true, liveLoader: async () => {reads++; return seed;}});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  assert.equal(reads, 1);
  const notice = await store.getNotice(runId);
  assert.equal(notice.recall.affected_lots.length, 32);
  await store.trace(runId, "read_notice", "Read only local sourced evidence.");
  assert.equal(reads, 1, "Reading and tracing the notice must not query operational providers");
  await enterPlanningPhase(store,runId);
  await readPlanningEvidence(store,runId);
  const planned = await store.calculatePlan(runId);
  assert.equal(reads, 1, "Planning reuses the run snapshot");
  if (planned.plan?.status !== "feasible") assert.fail();
  seed.shipments[0]!.eta = "2025-05-02T18:00:00Z";
  const validationWorkspace = await store.getWorkspace(runId);
  assert.equal(reads, 1, "Validation reuses the immutable run snapshot");
  assert.equal(validationWorkspace.planState, "current");
  assert.equal(validationWorkspace.assessment.inputFingerprint, fingerprintSnapshot(validationWorkspace.snapshot));
  if (validationWorkspace.plan?.status !== "feasible") assert.fail();
  assert.equal(validatePlanAgainstSnapshot(validationWorkspace.plan, validationWorkspace.snapshot).valid, true);
  const actionWorkspace = await store.getWorkspace(runId);
  await store.trace(runId, "prepare_actions", "Prepared checklist; no approval performed.");
  assert.equal(reads, 1, "Preparing the checklist reuses the same snapshot");
  assert.equal(actionWorkspace.planState, "current");
  assert.equal(actionWorkspace.receipts.length, 0);
  await store.memoryAudit("Advisory memory remains scoped to the active investigation.", runId);
  assert.equal(reads, 1, "Memory audit is a local write");
  await assert.rejects(store.reserve(planned.plan.planFingerprint, "active-run"), /Finish or stop/);
  await store.finishInvestigation(runId, "Finished checking evidence.");
  await assert.rejects(store.reserve(planned.plan.planFingerprint, "changed-after-run"), /changed/);
  await assert.rejects(store.getNotice(runId), /no longer active/);
  await assert.rejects(store.getWorkspace(runId), /no longer active/);
  await assert.rejects(store.memoryAudit("Late audit", runId), /no longer active/);
  assert.equal(reads, 2, "Fresh approval reads current source and inactive guards add no provider reads");
  const nextRun = (await store.startInvestigation()).agentRun.runId!;
  const beforeOldCallbacks = reads;
  await assert.rejects(store.getNotice(runId), /no longer active/);
  await assert.rejects(store.getWorkspace(runId), /no longer active/);
  await assert.rejects(store.memoryAudit("Old run audit", runId), /no longer active/);
  await store.getNotice(nextRun);
  assert.equal(reads, beforeOldCallbacks, "Old callbacks cannot query sources or borrow the new run's guard");
  assert.equal((await store.receiptLedger()).audit.some(event => event.message === "Late audit" || event.message === "Old run audit"), false);
});

test("local progress adds no provider reads and does not queue behind a slow live refresh", {timeout: 10_000}, async () => {
  const seed = (await loadSeed()).snapshot;
  let reads = 0; let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const {store} = await setup({liveLoader: async () => {reads++; entered(); await gate; return seed;}});
  const initial = await store.getProgress();
  assert.equal(reads, 0, "Progress initialization must not fetch operational sources");
  const refreshing = store.getWorkspace();
  await started;
  try {
    const progressReads = await Promise.all(Array.from({length: 25}, () => store.getProgress()));
    for (const progress of progressReads) {
      assert.equal(progress.incidentId, initial.incidentId);
      assert.equal("snapshot" in progress, false);
      assert.equal("plan" in progress, false);
      assert.equal("assessment" in progress, false);
    }
    assert.equal(reads, 1, "Progress must not trigger a second source read");
  } finally {release();}
  await refreshing;
  await Promise.all([store.getProgress(), store.getProgress(), store.getProgress()]);
  assert.equal(reads, 1);
  const planned = await store.calculatePlan();
  if (planned.plan?.status !== "feasible") assert.fail();
  assert.equal(reads, 2, "Planning still reads fresh sources after progress polling");
  seed.shipments[0]!.eta = "2025-05-02T18:00:00Z";
  await store.getProgress();
  assert.equal(reads, 2, "Local progress does not refresh externally changed operational data");
  await assert.rejects(store.reserve(planned.plan.planFingerprint, "external-eta-change"), /changed|stale/);
  assert.equal(reads, 3, "Approval must still read fresh sources and reject an externally changed snapshot");
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});

const actualNemotronProof = () => JSON.stringify({httpStatus: 200, routeAttributions: [{status: "response_reports_nemotron", providerModel: "meterless/auto", routedModel: "nvidia/nemotron-3.5-lightning-30b-a3b", winningRoute: {model: "nvidia/nemotron-3.5-lightning-30b-a3b", provider: "nvidia"}}]});

test("Meterless status derives only from actual persisted response evidence in the current investigation", async () => {
  const {store, stateDir} = await setup({model: "meterless/auto", inferenceAllowed: true});
  await store.memoryAudit("External smoke passed; this is not current investigation evidence.");
  assert.equal((await store.getProgress()).integrations.meterless.verified, false);
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await store.trace(runId, "model.response.nemotron", "Requested a model named Nemotron");
  await store.trace(runId, "model.response.nemotron", JSON.stringify({httpStatus: 200, routeAttributions: [{status: "response_reports_nemotron", routedModel: "openai/gpt-4.1"}]}));
  assert.equal((await store.getProgress()).integrations.meterless.verified, false, "An event name or claimed status cannot replace actual route evidence");
  await store.trace(runId, "model.response.nemotron", actualNemotronProof());
  const progress = await store.getProgress();
  assert.equal(progress.integrations.meterless.verified, true);
  assert.equal(progress.integrations.meterless.status, "Verified in current investigation");
  assert.match(progress.integrations.meterless.detail, /1 persisted response/);
  assert.equal((await store.getWorkspace()).integrations.meterless.verified, true);
  const restarted = new WorkspaceStore({root: process.cwd(), stateDir, model: "meterless/auto", liveLoader: async () => {throw new Error("Progress must not query sources");}});
  assert.equal((await restarted.getProgress()).integrations.meterless.verified, true, "Actual current-run evidence persists across a process restart");
  await store.trace(runId, "model.attribution.rejected", "A later response did not establish an actual Nemotron route.");
  assert.equal((await store.getProgress()).integrations.meterless.verified, false);
  await store.trace(runId, "model.response.nemotron", actualNemotronProof());
  assert.equal((await store.getProgress()).integrations.meterless.verified, false, "A later good response cannot erase an attribution failure in the same investigation");
  await store.finishInvestigation(runId, "Stopped", "Model attribution failed");
  const nextRun = (await store.startInvestigation()).agentRun.runId!;
  assert.equal((await store.getProgress()).integrations.meterless.verified, false, "Previous investigation evidence does not carry into a new run");
  await store.trace(nextRun, "model.response.nemotron", actualNemotronProof());
  assert.equal((await store.getProgress()).integrations.meterless.verified, true);
  await store.finishInvestigation(nextRun, "Incomplete", "A later tool or model request failed");
  assert.equal((await store.getProgress()).integrations.meterless.verified, false);
  await store.reset();
  assert.equal((await store.getProgress()).integrations.meterless.verified, false, "Earlier incident evidence never verifies a new incident");
});

 test("infeasible terminal receives the full bounded final budget", async () => {
 const {store}=await setup({model:"test",inferenceAllowed:true});
 await store.changeScenario("qa_missing"); const w=await store.startInvestigation(); const id=w.agentRun.runId!;
 await enterPlanningPhase(store,id); await readPlanningEvidence(store,id);
 const planned=await store.calculatePlan(id); assert.equal(planned.plan?.status,"infeasible");
 assert.equal(planned.plan?.status==="infeasible"?planned.plan.shortfallEa:null,30);
 await store.recordWorkflowCheckpoint(id,"solve_plan");
 await store.recordWorkflowCheckpoint(id,"validate_plan");
 assert.equal((await store.claimModelCall(id)).maxOutputTokens,4096,"Infeasibility still requires a prepared terminal checklist");
 await store.recordWorkflowCheckpoint(id,"prepare_actions");
 assert.equal((await store.claimModelCall(id)).maxOutputTokens,4096);
});
