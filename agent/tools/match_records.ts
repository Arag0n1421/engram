import {defineTool} from "eve/tools";
import {z} from "zod";
import {recordReferenceBatchInputSchema} from "../../src/runtime/record-matching.ts";
import {store} from "../../src/runtime/app.ts";
export default defineTool({description:"Run the pending source-bound field checks. Omit proposals to let the backend mechanically schedule bounded parsed reference/record batches from the complete observed catalog until those checks finish. This does not choose a policy or create a finding. Explicit proposals remain available for a source section requiring literal field selection. Unknown identifiers and incomplete candidate sets stay unknown; scalar results never grant recall, configuration or QA clearance.",inputSchema:recordReferenceBatchInputSchema.partial().extend({runId:z.string().uuid()}),async execute({runId,proposals}){return proposals===undefined?store.matchPendingRecordReferences(runId):store.matchRecordReferenceBatch(runId,proposals);}});
