import type {WorkspaceStore} from "../../src/runtime/store.ts";
/** Enter the real source-bound handoff so protocol/global budget tests exercise the planning phase. */
export async function enterPlanningPhase(store:WorkspaceStore,runId:string){const {entries}=await store.inspectSources(runId,["FDA-REQUIRED-ACTIONS"],"Bind the protocol-test planning handoff to an actual stored source.");const entry=entries[0]!;if(!("content" in entry))throw new Error("Missing fixture source");const result=await store.submitInvestigationReport(runId,{disposition:"plan",summary:"Source scope was inspected; operational calculation remains pending.",findings:[{id:"planning-handoff",kind:"observation",summary:"The stored notice action is available for the planning handoff.",evidence:[{sourceId:entry.id,sourceHash:entry.sourceHash,quote:entry.content}]}]});if(!result.valid)throw new Error("Source-bound fixture handoff rejected");}

/** Obtain trusted bound read receipts; generic trace labels are never readiness proof. */
export async function readPlanningEvidence(store:WorkspaceStore,runId:string){
  await store.readStockEvidence(runId);
  await store.readConstraintEvidence(runId);
}
