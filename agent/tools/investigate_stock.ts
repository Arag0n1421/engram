import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../../src/runtime/app.ts";
export default defineTool({
  description: "Read exact-item stock and supplier shipments from the bound investigation snapshot. Available after a documentary source has been inspected, including before the report handoff. This does not fetch fresh source data. A completed read is bound to this run and snapshot; repeat the same read to retrieve its stored result.",
  inputSchema: z.object({runId: z.string().uuid(), siteId: z.enum(["A", "B", "C"]).optional()}),
  async execute({runId, siteId}) {
    return store.readStockEvidence(runId, siteId);
  },
});
