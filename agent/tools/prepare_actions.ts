import { defineTool } from "eve/tools";
import { z } from "zod";
import { claimResponseJsonSchema, claimCitationGuide } from "../../src/domain/claims.ts";
import { fingerprintSnapshot } from "../../src/domain/index.ts";
import { fingerprint } from "../../src/domain/fingerprint.ts";
import { store } from "../../src/runtime/app.ts";
export default defineTool({
  description: "Prepare the pending operator checklist and action semantics. This tool cannot approve, send, reserve, dispatch, destroy or submit anything.",
  inputSchema: z.object({runId: z.string().uuid()}),
  async execute({runId}) {
    const w = await store.getWorkspace(runId);
    await store.recordWorkflowCheckpoint(runId, "prepare_actions");
    await store.trace(runId, "prepare_actions", "Prepared pending human checklist; no operational action executed.");
    return {terminalClaimSchema: claimResponseJsonSchema, terminalClaimBindings: {snapshotHash: fingerprintSnapshot(w.snapshot), planFingerprint: w.plan?.status === "feasible" ? w.plan.planFingerprint : fingerprint(w.plan)}, citationGuide: w.plan ? claimCitationGuide(w.snapshot, w.plan) : null, tasks: w.recall.tasks, planState: w.planState, approval: "Use the proposal already returned by solve_plan. Explicit interface controls save sandbox hold/reservation only; physical tasks and all communications remain pending."};
  },
});
