import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";

/** Internal acknowledgement invoked by the trusted report transport adapter, never exposed in the model tool list. */
export default defineTool({
  availableInSubagents:false,
  description:"Internal-only acknowledgement of a persisted report-format failure. This returns stored correction codes for the matching latest report request and does not create or accept findings.",
  inputSchema:z.object({runId:z.string().uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),failureSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  async execute({runId,snapshotHash,failureSha256}){return store.acknowledgeInvestigationReportFormatFailure(runId,snapshotHash,failureSha256);},
  endsTurn:false,
});
