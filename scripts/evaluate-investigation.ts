/** System evaluation collector. Gold labels are intentionally not accepted or loaded. */
import {readFile,writeFile} from "node:fs/promises";
import {fingerprintSnapshot} from "../src/domain/fingerprint.ts";
import type {Workspace} from "../src/shared/workspace.ts";
const args=process.argv.slice(2);const option=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const inputPath=option("--inputs"),caseId=option("--case"),out=option("--out");
const endpoint=option("--url")??"http://127.0.0.1:4318";
const url=new URL(endpoint);if(!["127.0.0.1","localhost"].includes(url.hostname))throw new Error("Evaluation collector permits only local endpoints.");
if(!inputPath||!caseId||!out)throw new Error("Usage: --inputs <runtime-inputs.json> --case <id> --url <local endpoint> --out <result.json>. Start isolated server with ENGRAM_INVESTIGATION_CASE_PATH/ID and separate state first.");
const pack=JSON.parse(await readFile(inputPath,"utf8"));const fixture=(Array.isArray(pack)?pack:pack.cases)?.find((item:{id:string})=>item.id===caseId);
if(!fixture?.snapshot||typeof fixture.question!=="string")throw new Error("Runtime case absent; no gold labels accepted.");
async function api(path:string,body?:unknown){const response=await fetch(new URL(path,url),body===undefined?{}:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const result=await response.json();if(!response.ok||result.error)throw new Error(`Local evaluation request failed (${response.status}): ${result.error??path}`);return result;}
const before=await api("/api/workspace") as Workspace;
// Source revisions are local persistence metadata; the runner compares product/rows as well as an emitted bound hash.
if(before.evaluation?.caseId!==caseId||before.snapshot.scope.recallId!==fixture.snapshot.scope.recallId||JSON.stringify(before.snapshot.inventory)!==JSON.stringify(fixture.snapshot.inventory))throw new Error("Server is not bound to the selected case. Original state must never be used for evaluation.");
const receiptsBefore=JSON.stringify(before.receipts),start=performance.now();
const started=await api("/api/analyze",{message:fixture.question}) as Workspace;const runId=started.agentRun.runId;
let progress=started;
for(let attempt=0;attempt<180;attempt++){await new Promise(resolve=>setTimeout(resolve,2000));const next=await api("/api/progress");if(next.agentRun.runId!==runId)throw new Error("Evaluation run identity changed.");if(next.agentRun.status!=="running"){progress=await api("/api/workspace");break;}}
if(progress.agentRun.status==="running")throw new Error("Evaluation timed out; stop the isolated run before retrying.");
const events=progress.agentRun.events;const actual=events.filter(event=>event.tool==="model.response.nemotron").map(event=>{try{return JSON.parse(event.message);}catch{return {};}});
const report={schema:"engram-system-evaluation-v1",caseId,question:fixture.question,memoryMode:progress.evaluation?.memoryMode??"unknown",classification:"heldout runtime observation; gold scoring is separate",status:progress.agentRun.status,disposition:progress.agentRun.investigation?.disposition??null,findings:progress.agentRun.investigation?.findings??[],selections:progress.agentRun.investigation?.selections??[],feedback:progress.agentRun.investigation?.feedback??[],questionForOperator:progress.agentRun.investigation?.question??null,snapshotHash:fingerprintSnapshot(progress.snapshot),runId,latencyMs:Math.round(performance.now()-start),actualModelCalls:actual.length,modelRequests:events.filter(event=>event.tool==="model.request.started").length,toolCalls:events.filter(event=>["list_evidence","inspect_evidence","read_notice","investigate_stock","fetch_constraints","solve_plan","validate_plan","prepare_actions","investigation.evidence_checked","investigation.feedback","what_if"].includes(event.tool)),usage:actual.map(item=>item.usage??{}),attribution:actual.map(item=>item.routeAttributions??[]),memoryEvents:events.filter(event=>event.tool.startsWith("memory.")),receiptsUnchanged:JSON.stringify(progress.receipts)===receiptsBefore,claimAudit:progress.agentRun.claimAudit??null,error:progress.agentRun.error??null};
await writeFile(out,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({caseId,status:report.status,disposition:report.disposition,latencyMs:report.latencyMs,actualModelCalls:report.actualModelCalls,receiptsUnchanged:report.receiptsUnchanged,output:out}));
