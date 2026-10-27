import type {InvestigationReportInput} from "../shared/investigation.ts";
import {exactEvidenceTokenIndex} from "./evidence-excerpts.ts";
const normalizeTask=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
/** Checks request shape and identifier binding only, not whether an artifact would establish truth. */
export function concreteOperatorQuestion(input:InvestigationReportInput,originalTask:string,identifiers:string[],recordIds:string[]=[]):{question?:string;origin:"missing_evidence_finding"|"report"|"none"}{
  const candidates=[...input.findings.filter(finding=>finding.kind==="missing_evidence"&&finding.question).map(finding=>({question:finding.question!,origin:"missing_evidence_finding" as const})),...(input.question?[{question:input.question,origin:"report" as const}]:[])];
  for(const candidate of candidates){const question=candidate.question.trim();
    if(question.length<12||question.length>500||!question.endsWith("?")||normalizeTask(question)===normalizeTask(originalTask))continue;
    if(!/\b(evidence|record|document|label|certificate|release|qa|expiry|expiration|eta|status|identifier|confirmation|signed|signature)\b/i.test(question))continue;
    if(!identifiers.some(id=>id.length>=3&&question.toLowerCase().includes(id.toLowerCase())||id.length>=2&&recordIds.some(recordId=>recordId.toLowerCase()===id.toLowerCase())&&exactEvidenceTokenIndex(question.toLocaleLowerCase("en"),id.toLocaleLowerCase("en"))>=0))continue;
    return {question,origin:candidate.origin};
  }
  return {origin:"none"};
}
