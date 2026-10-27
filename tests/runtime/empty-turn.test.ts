import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {WorkspaceStore} from '../../src/runtime/store.ts';
import {applyTurnCompletedEvent} from '../../src/runtime/events.ts';
import {finalizeClaimResponse} from '../../src/runtime/claims.ts';
import {enterPlanningPhase,readPlanningEvidence} from './planning-phase-fixture.ts';

async function setup() {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'engram-empty-turn-'));
  const store = new WorkspaceStore({stateDir, model: 'test', inferenceAllowed: true});
  const workspace = await store.startInvestigation();
  await enterPlanningPhase(store,workspace.agentRun.runId!);
  await readPlanningEvidence(store,workspace.agentRun.runId!);
  await store.calculatePlan(workspace.agentRun.runId!);
  await store.recordWorkflowCheckpoint(workspace.agentRun.runId!, 'solve_plan');
  await store.recordWorkflowCheckpoint(workspace.agentRun.runId!, 'validate_plan');
  await store.recordWorkflowCheckpoint(workspace.agentRun.runId!, 'prepare_actions');
  return {store, runId: workspace.agentRun.runId!};
}

test('empty successful turn fails closed with an unverified claim audit and no receipts', async () => {
  const {store, runId} = await setup();
  assert.equal(await applyTurnCompletedEvent(runId, store), true);
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.equal(run.claimAudit?.status, 'unverified');
  assert.deepEqual(run.claimAudit?.rawAttempts, ['']);
  assert.deepEqual(run.claimAudit?.result, {valid: false, feedbackCodes: ['MALFORMED_RESPONSE']});
  assert.equal(run.summary, 'The model turn ended without a verifiable terminal response.');
  assert.equal(run.error, run.summary);
  assert.equal(run.events.filter(event => event.tool === 'claims.unverified').length, 1);
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});

test('empty-turn fallback preserves exact arguments captured before SDK delivery failed', async () => {
  const {store, runId} = await setup();
  const prepared = await store.getPreparedTerminalProjection(runId);
  const raw = '{ "claims": "captured before SDK delivery" }';
  await store.recordTerminalAttempt(runId, raw, prepared.bindings);
  assert.equal(await applyTurnCompletedEvent(runId, store), true);
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.equal(run.claimAudit?.status, 'unverified');
  assert.deepEqual(run.claimAudit?.rawAttempts, [raw]);
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});

test('duplicate turn completion fallback is idempotent', async () => {
  const {store, runId} = await setup();
  const outcomes = await Promise.all([
    applyTurnCompletedEvent(runId, store),
    applyTurnCompletedEvent(runId, store),
    applyTurnCompletedEvent(runId, store),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.equal(run.events.filter(event => event.tool === 'claims.unverified').length, 1);
  assert.equal(run.events.filter(event => event.tool === 'investigation.failed').length, 1);
});

test('fallback ignores stale, cancelled and already completed runs', async () => {
  const stale = await setup();
  await stale.store.finishInvestigation(stale.runId, 'Stopped by operator.', 'Stopped.');
  const current = await stale.store.startInvestigation();
  assert.equal(await applyTurnCompletedEvent(stale.runId, stale.store), false);
  assert.equal((await stale.store.activeInvestigation()).agentRun.runId, current.agentRun.runId);
  assert.equal((await stale.store.activeInvestigation()).agentRun.status, 'running');

  const cancelled = await setup();
  await cancelled.store.finishInvestigation(cancelled.runId, 'Stopped by operator.', 'Stopped.');
  assert.equal(await applyTurnCompletedEvent(cancelled.runId, cancelled.store), false);
  assert.equal((await cancelled.store.activeInvestigation()).agentRun.summary, 'Stopped by operator.');

  const completed = await setup();
  const prepared = await completed.store.getPreparedTerminalProjection(completed.runId);
  await finalizeClaimResponse(completed.runId, JSON.stringify(prepared.claimTemplate), completed.store);
  const completedRun = (await completed.store.activeInvestigation()).agentRun;
  assert.equal(completedRun.status, 'complete');
  assert.equal(completedRun.claimAudit?.status, 'verified');
  assert.equal(await applyTurnCompletedEvent(completed.runId, completed.store), false);
  assert.equal((await completed.store.activeInvestigation()).agentRun.summary, completedRun.summary);
});

test('fallback preserves an active terminal claim finalizer', async () => {
  const {store, runId} = await setup();
  assert.equal(await store.claimFinalization(runId), true);
  assert.equal(await applyTurnCompletedEvent(runId, store), false);
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'running');
  assert.equal(run.events.filter(event => event.tool === 'claims.finalization.started').length, 1);
  assert.equal(run.claimAudit?.status, 'unverified');
  assert.deepEqual(run.claimAudit?.rawAttempts, ['']);
});

test('concurrent turn completion cannot overwrite a finalizer already doing its one repair', async () => {
  const {store, runId} = await setup();
  let notifyRepair!: () => void;
  let releaseRepair!: () => void;
  const repairStarted = new Promise<void>(resolve => {notifyRepair = resolve;});
  const repairGate = new Promise<void>(resolve => {releaseRepair = resolve;});
  const finalizing = finalizeClaimResponse(runId, 'empty', store, async () => {
    notifyRepair();
    await repairGate;
    return 'still malformed';
  });
  await repairStarted;
  assert.equal(await applyTurnCompletedEvent(runId, store), false);
  releaseRepair();
  await finalizing;
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /Terminal claims were not verified/);
  assert.equal(run.claimAudit?.status, 'unverified');
  assert.equal(run.claimAudit?.rawAttempts.length, 2);
  assert.match(run.summary, /could not be verified/);
  assert.equal(run.events.filter(event => event.tool === 'claims.finalization.started').length, 1);
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});

test('generic completion cannot mark a planning run complete without verified terminal claims', async () => {
  const {store, runId} = await setup();
  await store.finishInvestigation(runId, 'Checked plan remains available for review.');
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.equal(run.summary, 'Checked plan remains available for review.');
  assert.match(run.error!, /Terminal claims were not verified/);
  assert.equal(run.claimAudit, undefined);
  assert.equal(run.events.filter(event => event.tool === 'investigation.completed').length, 0);
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});

test('an unverified finalization marker cannot complete a legacy run with no planning disposition', async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'engram-legacy-finalization-'));
  const store = new WorkspaceStore({stateDir, model: 'test', inferenceAllowed: true});
  const runId = (await store.startInvestigation()).agentRun.runId!;
  assert.equal((await store.activeInvestigation()).agentRun.investigation?.disposition, null);
  await store.trace(runId, 'claims.finalization.started', 'Legacy finalization marker; no workflow readiness is implied.');
  await store.recordClaimAudit(runId, ['unverified legacy terminal output'], {valid: false, feedbackCodes: ['MALFORMED_RESPONSE']});
  await store.finishInvestigation(runId, 'Unverified legacy claims remain audit data.');
  const run = (await store.activeInvestigation()).agentRun;
  assert.equal(run.status, 'failed');
  assert.equal(run.claimAudit?.status, 'unverified');
  assert.deepEqual(run.claimAudit?.rawAttempts, ['unverified legacy terminal output']);
  assert.match(run.error!, /Terminal claims were not verified/);
  assert.equal(run.events.filter(event => event.tool === 'investigation.completed').length, 0);
  assert.equal((await store.receiptLedger()).receipts.length, 0);
});
