import {checkClaims, type ClaimCheckResult} from '../domain/claims.ts';
import type {WorkspaceStore} from './store.ts';
export type ClaimRepair = (prompt: string) => Promise<string>;
/** One terminal check and at most one same-provider repair; arbitrary prose is never verified. */
export async function finalizeClaimResponse(runId: string, raw: string, store: WorkspaceStore, repair?: ClaimRepair): Promise<void> {
  if (!await store.claimFinalization(runId, raw)) return;
  const workspace=await store.getWorkspace(runId);
  const attempts=[raw];
  let result: ClaimCheckResult=workspace.plan ? checkClaims(raw,workspace.snapshot,workspace.plan) : {valid:false,feedbackCodes:['PLAN_MISMATCH']};
  if(!result.valid && workspace.plan && repair) {
    // The bound transport reads only this saved deterministic feedback and the
    // current prepared claim template; prior model text is never an instruction.
    await store.recordClaimAudit(runId,attempts,result);
    await store.trace(runId,'claims.repair.requested',`One repair requested: ${result.feedbackCodes.join(', ')}.`);
    try {
      const fixed=await repair(JSON.stringify({instruction:'Report the complete current prepared claim template through the forced report_claims output format. Copy every citation. This is the only repair.',feedback:result.feedbackCodes}));
      attempts.push(fixed);
      result=checkClaims(fixed,workspace.snapshot,workspace.plan);
    } catch {
      await store.trace(runId,'claims.repair.failed','The single repair failed; the original response remains unverified.');
    }
  }
  await store.recordClaimAudit(runId,attempts,result);
  const summary=result.valid && result.checked
    ? result.checked.descriptions.join('\n')+'\nProjected inbound remains conditional on receipt and acceptance. All operator actions remain pending approval.'
    : 'The model claims could not be verified against the investigation snapshot. Use the deterministic exposure and plan tables.';
  await store.finishInvestigation(runId,summary);
}
