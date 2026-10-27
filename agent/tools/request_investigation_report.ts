import {defineTool} from "eve/tools";
import {z} from "zod";
import {store} from "../../src/runtime/app.ts";

export const READY_REPORT_REQUEST_REASON="All required source retrieval and source-bound matching checks are complete for this run and snapshot.";

export async function requestInvestigationReportWithReason(
  target:Pick<typeof store,"getInvestigationContext"|"requestInvestigationReport">,
  runId:string,
  reason?:string,
) {
  if(reason!==undefined){
    if(!reason.trim()||reason.length>300)throw new Error("An explicit report request reason must contain 1 to 300 characters.");
    return target.requestInvestigationReport(runId,reason);
  }
  const current=await target.getInvestigationContext(runId);
  const readiness=current.active?current.projection?.work?.readiness:null;
  if(!readiness?.reportReady||readiness.stage!=="ready"||readiness.pendingSourceIds.length||readiness.pendingSectionIds.length||readiness.unmatchedRecordChecks.length){
    throw new Error("A run-ID-only report marker requires current report readiness.");
  }
  return target.requestInvestigationReport(runId,READY_REPORT_REQUEST_REASON);
}

export default defineTool({
  description:"Request an immediate documentary report after inspecting a canonical source when the evidence already answers the user's question. This switches the next model request to report-only mode; it creates no findings, disposition, calculation, or approval. Do not use it before source inspection or when a useful investigation step remains.",
  inputSchema:z.object({runId:z.string().uuid(),reason:z.string().min(1).max(300).refine(value=>value.trim().length>0).optional()}).strict(),
  async execute({runId,reason}){return requestInvestigationReportWithReason(store,runId,reason);},
});
