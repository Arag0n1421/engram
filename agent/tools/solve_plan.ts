import { defineTool } from "eve/tools";
import { z } from "zod";
import { store, calculateWithMemory } from "../../src/runtime/app.ts";
export default defineTool({
  description: "Calculate a checked minimum-cost integer allocation proposal using current evidence. Creates no hold, reservation or dispatch. May return infeasible.",
  inputSchema: z.object({runId: z.string().uuid()}),
  async execute({runId}) {
    const workspace = await calculateWithMemory(runId);
    await store.recordWorkflowCheckpoint(runId, "solve_plan");
    await store.trace(runId, "solve_plan", workspace.plan?.status === "feasible" ? "Calculated feasible proposal; explicit operator approval is still required." : "No feasible plan satisfies all constraints; approval disabled.");
    return workspace.plan;
  },
});
