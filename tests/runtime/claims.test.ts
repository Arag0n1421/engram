import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {WorkspaceStore} from '../../src/runtime/store.ts';
import {finalizeClaimResponse} from '../../src/runtime/claims.ts';
import {assessSnapshot} from '../../src/domain/index.ts';
import {claimCitationGuide} from '../../src/domain/claims.ts';
import type {Snapshot,PlanResult} from '../../src/domain/types.ts';
import {enterPlanningPhase,readPlanningEvidence} from './planning-phase-fixture.ts';
function correct(snapshot:Snapshot,plan:PlanResult) {
 const a=assessSnapshot(snapshot),g=claimCitationGuide(snapshot,plan);
 return JSON.stringify({snapshotHash:g.snapshotHash,planFingerprint:g.planFingerprint,claims:{inventory:{affectedEa:a.totalAffectedEa,eligibleEa:a.totalEligibleEa,citations:g.inventory},plan:{status:plan.status,cutoff:snapshot.clock.cutoff,totalRequiredEa:plan.totalRequiredEa,projectedInboundEa:plan.projectedInboundEa,projectedInbound:a.shipments.filter(r=>r.status==='CONDITIONAL_PROJECTED').map(r=>{const row=snapshot.shipments.find(s=>s.id===r.entityId)!;return {shipmentId:row.id,quantityEa:r.eligibleEa,eta:row.eta,conditionalOnReceiptAndAcceptance:true};}),shortfallEa:plan.status==='feasible'?null:plan.shortfallEa,citations:g.plan},transfers:plan.status==='feasible'?plan.transfers.map(t=>({...t,internalSku:undefined,arrivesByCutoff:true,citations:g.transfers.find(g=>g.lineId===t.lineId)!.citations})):[]}});
}
async function setup(){
 const stateDir=await mkdtemp(resolve(tmpdir(),'engram-claims-'));const store=new WorkspaceStore({stateDir,model:'test',inferenceAllowed:true});const w=await store.startInvestigation();const runId=w.agentRun.runId!;
 await enterPlanningPhase(store,runId);
 await readPlanningEvidence(store,runId);
 await store.calculatePlan(runId);
 await store.recordWorkflowCheckpoint(runId,'solve_plan');
 await store.recordWorkflowCheckpoint(runId,'validate_plan');
 await store.recordWorkflowCheckpoint(runId,'prepare_actions');
 return {store,stateDir,runId,workspace:await store.getWorkspace(runId)};
}
test('one failed claim response gets exactly one repair and retains raw audit',async()=>{const {store,runId,workspace:w}=await setup();let calls=0;await finalizeClaimResponse(runId,'120 EA eligible',store,async prompt=>{calls++;assert.match(prompt,/MALFORMED_RESPONSE/);return correct(w.snapshot,w.plan!);});const run=(await store.activeInvestigation()).agentRun;assert.equal(calls,1);assert.equal(run.status,'complete');assert.equal(run.claimAudit?.status,'verified');assert.equal(run.claimAudit?.rawAttempts.length,2);assert.match(run.summary,/Eligible inventory: 240 EA/);});
test('bad repair fails closed without another request or verified prose',async()=>{const {store,runId}=await setup();let calls=0;await finalizeClaimResponse(runId,'wrong',store,async()=>{calls++;return 'still wrong';});const run=(await store.activeInvestigation()).agentRun;assert.equal(calls,1);assert.equal(run.claimAudit?.status,'unverified');assert.equal(run.claimAudit?.rawAttempts.length,2);assert.match(run.summary,/could not be verified/);assert.equal((await store.receiptLedger()).receipts.length,0);});
test('valid claims need no repair',async()=>{const {store,runId,workspace:w}=await setup();let calls=0;await finalizeClaimResponse(runId,correct(w.snapshot,w.plan!),store,async()=>{calls++;return '';});assert.equal(calls,0);assert.equal((await store.activeInvestigation()).agentRun.claimAudit?.status,'verified');});

test('duplicate terminal callbacks atomically claim only one repair across restart',async()=>{const {store,runId}=await setup();let calls=0;await Promise.all([finalizeClaimResponse(runId,'wrong',store,async()=>{calls++;await new Promise(r=>setTimeout(r,5));return 'stillwrong';}),finalizeClaimResponse(runId,'duplicatewrong',store,async()=>{calls++;return 'wrong';})]);assert.equal(calls,1);await finalizeClaimResponse(runId,'late duplicate',store,async()=>{calls++;return 'wrong';});assert.equal(calls,1);assert.equal((await store.activeInvestigation()).agentRun.claimAudit?.rawAttempts.length,2);});

test('initial raw terminal attempt survives restart while the single repair is interrupted',async()=>{
 const {store,stateDir,runId}=await setup();
 let notifyStarted!:()=>void;let releaseRepair!:()=>void;
 const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
 const held=new Promise<void>(resolve=>{releaseRepair=resolve;});
 const raw='Original terminal attempt before repair.';
 const finalizing=finalizeClaimResponse(runId,raw,store,async()=>{notifyStarted();await held;return 'Still unverified.';});
 await started;
 try {
  const restarted=new WorkspaceStore({stateDir,model:'test',inferenceAllowed:true});
  const saved=(await restarted.activeInvestigation()).agentRun;
  assert.equal(saved.status,'running');
  assert.equal(saved.claimAudit?.status,'unverified');
  assert.deepEqual(saved.claimAudit?.rawAttempts,[raw]);
  assert.equal(saved.events.filter(event=>event.tool==='claims.finalization.started').length,1);
  assert.equal(await restarted.claimFinalization(runId,'duplicate'),false);
  assert.deepEqual((await restarted.activeInvestigation()).agentRun.claimAudit?.rawAttempts,[raw]);
 } finally {releaseRepair();await finalizing;}
 assert.deepEqual((await store.activeInvestigation()).agentRun.claimAudit?.rawAttempts,[raw,'Still unverified.']);
});

test('transport-persisted repair arguments survive a later SDK rejection without a second repair',async()=>{
 const {store,runId,workspace:w}=await setup();
 const raw=correct(w.snapshot,w.plan!).replace('"affectedEa":120','"affectedEa":121');
 const projection=await store.getPreparedTerminalProjection(runId);
 await store.recordTerminalAttempt(runId,raw,projection.bindings);
 let calls=0;
 await finalizeClaimResponse(runId,raw,store,async()=>{
  calls++;
  const repairProjection=await store.getPreparedTerminalProjection(runId);
  assert.deepEqual(repairProjection.repairFeedback,['CLAIM_MISMATCH']);
  const malformed='{ "claims":';
  await store.recordTerminalAttempt(runId,malformed,repairProjection.bindings);
  throw new Error('SDK rejected malformed arguments after transport persisted them.');
 });
 const run=(await store.activeInvestigation()).agentRun;
 assert.equal(calls,1);
 assert.equal(run.claimAudit?.status,'unverified');
 assert.deepEqual(run.claimAudit?.rawAttempts,[raw,'{ "claims":']);
 assert.equal(run.events.filter(event=>event.tool==='claims.repair.requested').length,1);
 assert.equal((await store.receiptLedger()).receipts.length,0);
});
