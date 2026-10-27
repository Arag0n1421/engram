import { defineTool } from "eve/tools";
import { z } from "zod";
import { consultHistory, store } from "../../src/runtime/app.ts";
export default defineTool({
  description: "Query actual Meterless H-MEM for source-referenced historical analyses. Results are advisory, may be stale and cannot override current recall, inventory, QA or solver evidence.",
  inputSchema: z.object({runId: z.string().uuid(), query: z.string().min(1).max(1000)}),
  async execute({runId, query}) {
    const result = await consultHistory(runId, query);
    await store.recordInvestigationObservation(runId,"recall_history",result);
    return result;
  },
});
