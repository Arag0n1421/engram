import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assessSnapshot, planReplenishment } from "../../src/domain/index.ts";
import { checkClaims, claimCitationGuide } from "../../src/domain/claims.ts";
import { applyScenario, loadSeed } from "../../src/runtime/seed.ts";
import { projectTerminalClaims } from "../../src/runtime/terminal-projection.ts";
import { WorkspaceStore } from "../../src/runtime/store.ts";
import {enterPlanningPhase,readPlanningEvidence} from "./planning-phase-fixture.ts";

const repoRoot = resolve(process.cwd());

async function fixture(scenario: "on_time" | "qa_missing" = "on_time") {
  const {snapshot} = await loadSeed(repoRoot);
  const current = applyScenario(snapshot, scenario);
  return {snapshot: current, plan: planReplenishment(current)};
}

async function preparedStore(scenario: "on_time" | "qa_missing" = "on_time") {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-terminal-projection-"));
  const store = new WorkspaceStore({stateDir, model: "test-model", inferenceAllowed: true});
  if (scenario === "qa_missing") await store.changeScenario(scenario);
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await enterPlanningPhase(store,runId);
  await readPlanningEvidence(store,runId);
  const workspace = await store.calculatePlan(runId);
  await store.recordWorkflowCheckpoint(runId, "solve_plan");
  await store.recordWorkflowCheckpoint(runId, "validate_plan");
  await store.recordWorkflowCheckpoint(runId, "prepare_actions");
  return {store, runId, workspace};
}

test("compact terminal projection carries exact bindings, checked claims and supporting source facts", async () => {
  const {snapshot, plan} = await fixture();
  const projection = projectTerminalClaims(snapshot, plan);
  const assessment = assessSnapshot(snapshot);
  const guide = claimCitationGuide(snapshot, plan);

  assert.deepEqual(projection.bindings, {snapshotHash: guide.snapshotHash, planFingerprint: guide.planFingerprint});
  assert.deepEqual(projection.claimTemplate.snapshotHash, projection.bindings.snapshotHash);
  assert.deepEqual(projection.claimTemplate.planFingerprint, projection.bindings.planFingerprint);
  assert.equal(checkClaims(projection.claimTemplate, snapshot, plan).valid, true);
  assert.equal(projection.facts.affectedEa, assessment.totalAffectedEa);
  assert.equal(projection.facts.eligibleEa, assessment.totalEligibleEa);
  assert.equal(projection.facts.status, "feasible");
  assert.deepEqual(projection.facts.transfers.map(row => row.lineId), plan.status === "feasible" ? plan.transfers.map(row => row.lineId) : []);
  assert.ok(projection.claimTemplate.claims.inventory.citations.includes("FDA-PRODUCT-LOT-SCOPE"));
  assert.match(projection.instruction, /exactly one complete JSON object/);
  assert.match(projection.instruction, /no Markdown, prose, or tool calls/);

  const bytes = Buffer.byteLength(JSON.stringify(projection));
  assert.ok(bytes < 4_000, `terminal projection should fit a compact context; got ${bytes} bytes`);
});

test("infeasible shortfall30 produces checker-valid claims and explicit non-approval facts", async () => {
  const {snapshot, plan} = await fixture("qa_missing");
  assert.equal(plan.status, "infeasible");
  const projection = projectTerminalClaims(snapshot, plan);
  assert.equal(projection.facts.status, "infeasible");
  assert.equal(projection.facts.shortfallEa, 30);
  assert.deepEqual(projection.claimTemplate.claims.transfers, []);
  assert.equal(projection.claimTemplate.claims.plan.shortfallEa, 30);
  assert.equal(checkClaims(projection.claimTemplate, snapshot, plan).valid, true);
});

test("prepared accessor is pinned, read-only and rejects absent, stale or replaced runs", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-terminal-projection-"));
  const store = new WorkspaceStore({stateDir, model: "test-model", inferenceAllowed: true});
  const firstRun = (await store.startInvestigation()).agentRun.runId!;
  await assert.rejects(store.getPreparedTerminalProjection(firstRun), /prepared plan/);
  await enterPlanningPhase(store,firstRun);
  await readPlanningEvidence(store,firstRun);
  await store.calculatePlan(firstRun);
  await store.recordWorkflowCheckpoint(firstRun, "solve_plan");
  await store.recordWorkflowCheckpoint(firstRun, "validate_plan");
  await store.recordWorkflowCheckpoint(firstRun, "prepare_actions");

  const pinned = await store.getSnapshot(firstRun);
  const projection = await store.getPreparedTerminalProjection(firstRun);
  assert.equal(projection.bindings.snapshotHash, projection.claimTemplate.snapshotHash);
  assert.equal(projection.bindings.snapshotHash, (await import("../../src/domain/fingerprint.ts")).fingerprintSnapshot(pinned));
  assert.equal(checkClaims(projection.claimTemplate, pinned, planReplenishment(pinned)).valid, true);

  await store.calculatePlan(firstRun);
  await assert.rejects(store.getPreparedTerminalProjection(firstRun), /prepared plan/);
  await store.cancelInvestigation(firstRun);
  const secondRun = (await store.startInvestigation()).agentRun.runId!;
  await assert.rejects(store.getPreparedTerminalProjection(firstRun), /no longer active/);
  await assert.rejects(store.getPreparedTerminalProjection(secondRun), /prepared plan/);
});

test("projection fails closed when supplied plan differs from deterministic snapshot calculation", async () => {
  const {snapshot, plan} = await fixture();
  if (plan.status !== "feasible") throw new Error("fixture should be feasible");
  const forged = structuredClone(plan); forged.totalRequiredEa++;
  assert.throws(() => projectTerminalClaims(snapshot, forged), /deterministic plan/);
});

test("infeasible prepared accessor allows valid false checkpoints but never grants approval", async () => {
  const {store, runId, workspace} = await preparedStore("qa_missing");
  assert.equal(workspace.plan?.status, "infeasible");
  const projection = await store.getPreparedTerminalProjection(runId);
  assert.equal(projection.facts.shortfallEa, 30);
  assert.equal(checkClaims(projection.claimTemplate, workspace.snapshot, workspace.plan!).valid, true);
});

test("raw terminal tool arguments persist before normalization and repair feedback stays typed", async () => {
  const {store, runId} = await preparedStore();
  const raw = '{ "claims": {"inventory": {"affectedEa": 1}} }';
  const prepared = await store.getPreparedTerminalProjection(runId);
  assert.deepEqual(await store.recordTerminalAttempt(runId, raw, prepared.bindings), {recorded: true, attemptCount: 1});
  await store.trace(runId, "claims.repair.requested", "A deterministic check rejected the first attempt.");
  await store.recordClaimAudit(runId, [raw], {valid: false, feedbackCodes: ["MISSING_CITATIONS", "CLAIM_MISMATCH"]});
  const projection = await store.getPreparedTerminalProjection(runId);
  assert.deepEqual(projection.repairFeedback, ["MISSING_CITATIONS", "CLAIM_MISMATCH"]);
  assert.deepEqual((await store.getWorkspace(runId)).agentRun.claimAudit?.rawAttempts, [raw]);
});

test("terminal attempt recording rejects unprepared and stale runs and deduplicates exact arguments", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-terminal-projection-"));
  const store = new WorkspaceStore({stateDir, model: "test-model", inferenceAllowed: true});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  await assert.rejects(store.recordTerminalAttempt(runId, "{}", {snapshotHash: "", planFingerprint: ""}), /prepared plan/);
  await enterPlanningPhase(store,runId);
  await readPlanningEvidence(store,runId);
  await store.calculatePlan(runId);
  await store.recordWorkflowCheckpoint(runId, "solve_plan");
  await store.recordWorkflowCheckpoint(runId, "validate_plan");
  await store.recordWorkflowCheckpoint(runId, "prepare_actions");
  const prepared = await store.getPreparedTerminalProjection(runId);
  await assert.rejects(store.recordTerminalAttempt(runId, "old response", {snapshotHash: "stale", planFingerprint: prepared.bindings.planFingerprint}), /different prepared plan/);
  assert.deepEqual(await store.recordTerminalAttempt(runId, "{}", prepared.bindings), {recorded: true, attemptCount: 1});
  assert.deepEqual(await store.recordTerminalAttempt(runId, "{}", prepared.bindings), {recorded: true, attemptCount: 2});
  await store.cancelInvestigation(runId);
  await assert.rejects(store.recordTerminalAttempt(runId, "stale", {snapshotHash: "", planFingerprint: ""}), /no longer active/);
});
