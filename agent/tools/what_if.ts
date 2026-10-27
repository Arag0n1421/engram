import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";
import {whatIfInputSchema} from "../../src/runtime/what-if.ts";
export default defineTool({description:"Run a HYPOTHETICAL read-only solver comparison on a clone of the bound snapshot. Only shipment ETA and explicit QA evidence hypotheses are allowed. This cannot approve plans, release recalled stock, mutate inventory, receipts or memory.",inputSchema:z.object({runId:z.string().uuid(),hypothesis:whatIfInputSchema}).strict(),async execute({runId,hypothesis}){const result=await store.checkWhatIf(hypothesis,runId);await store.recordInvestigationObservation(runId,"what_if",result);await store.trace(runId,"what_if",JSON.stringify({hypothesis,label:result.label,snapshotHash:result.snapshotHash,comparison:result.comparison}));return result;}});
