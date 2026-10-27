import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";
export default defineTool({description:"Run the backend-packed batch of pending required evidence sections for this run. Call with only the supplied runId. The backend chooses exact canonical sections within the 30-reference and 14KB bounds, reads them, and records actual receipts. Do not supply section IDs, analyze text, or create findings.",inputSchema:z.object({runId:z.string().uuid()}).strict(),async execute({runId}){return store.readEvidenceSections(runId);}});
