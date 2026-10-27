import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../../src/runtime/app.ts";
export default defineTool({
  description: "Read exact approved catalog item, demands, required ending reserves, route deadlines and capacities from the bound investigation snapshot. Available after a documentary source has been inspected, including before the report handoff. No substitutions or case conversions. A completed read is bound to this run and snapshot; repeat the same read to retrieve its stored result.",
  inputSchema: z.object({runId: z.string().uuid()}),
  async execute({runId}) {
    return store.readConstraintEvidence(runId);
  },
});
