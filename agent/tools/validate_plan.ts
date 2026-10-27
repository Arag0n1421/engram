import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../../src/runtime/app.ts";
import { validatePlanAgainstSnapshot } from "../../src/domain/index.ts";
export default defineTool({
  description: "Independently recheck the stored proposal against the immutable investigation snapshot quantities; approval separately rereads current sources, source versions, reserves, exact lots and arrival constraints. Does not execute it.",
  inputSchema: z.object({runId: z.string().uuid()}),
  async execute({runId}) {
    const {snapshot, plan} = await store.getWorkspace(runId);
    const result = plan?.status === "feasible" ? validatePlanAgainstSnapshot(plan, snapshot) : {valid: false, reasons: plan?.reasons ?? [], status: plan?.status ?? "no_proposal"};
    await store.recordWorkflowCheckpoint(runId, "validate_plan");
    await store.trace(runId, "validate_plan", result.valid ? "Independent validation passed for the current source snapshot." : "Validation did not authorize an executable proposal.");
    return result;
  },
});
