import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";
export default defineTool({description:"Run the backend-scheduled required-source inspection batch for this run. Call with only the supplied runId. The backend chooses current pending canonical sources, inspects at most three, and records exact source and section receipts. Do not supply IDs or reasons, select optional evidence, analyze the documents, or create findings.",inputSchema:z.object({runId:z.string().uuid()}).strict(),async execute({runId}){return store.inspectSources(runId);}});
