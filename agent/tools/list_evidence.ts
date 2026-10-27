import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";
export default defineTool({description:"List available source/document and record IDs and titles for the bound snapshot; an exact query also searches full stored document text to locate late appendix identifiers. Choose the next source based on the user question; no source contents or conclusions are returned.",inputSchema:z.object({runId:z.string().uuid(),query:z.string().max(120).optional()}).strict(),async execute({runId,query}){return store.getEvidenceIndex(runId,query);}});
