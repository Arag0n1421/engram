import {readFileSync} from "node:fs";
import type {Snapshot} from "../domain/types.ts";
import type {EvidenceDocument} from "../shared/investigation.ts";
import { loadIntegrationConfig } from "../integrations/index.ts";
import { WorkspaceStore } from "./store.ts";
import { createLiveLoader } from "./live.ts";
import { RecallOpsMemory } from "../memory/index.ts";
import { resolve } from "node:path";
import { fingerprintSnapshot } from "../domain/index.ts";

const integrations = loadIntegrationConfig();
const live = process.env.RECALLOPS_DATA_MODE === "live";
if (live && integrations.zetaris.status !== "ready") throw new Error("Live mode requires valid Zetaris configuration; replay fallback is disabled.");
export const meterlessConfig = integrations.meterless.status === "ready" ? integrations.meterless.config : null;
type InvestigationCase={id:string;question:string;snapshot:Snapshot;documents:EvidenceDocument[];memoryMode:"on"|"off"};
function loadInvestigationCase():InvestigationCase|undefined {
  const path=process.env.ENGRAM_INVESTIGATION_CASE_PATH;if(!path)return undefined;
  const raw=JSON.parse(readFileSync(path,"utf8")) as InvestigationCase|{cases:InvestigationCase[]};
  const selected="cases" in raw?raw.cases.find(item=>item.id===process.env.ENGRAM_INVESTIGATION_CASE_ID):raw;
  if(!selected||typeof selected.id!=="string"||typeof selected.question!=="string"||!selected.snapshot||!Array.isArray(selected.documents)||!["on","off"].includes(selected.memoryMode))throw new Error("A valid selected investigation fixture is required.");
  if(process.env.ENGRAM_MEMORY_MODE&&!["on","off"].includes(process.env.ENGRAM_MEMORY_MODE))throw new Error("Invalid evaluation memory mode.");
  return {...selected,memoryMode:(process.env.ENGRAM_MEMORY_MODE as "on"|"off"|undefined)??selected.memoryMode};
}
export const investigationCase=loadInvestigationCase();
export const store = new WorkspaceStore({
  investigationCase,
  liveLoader: live && integrations.zetaris.status === "ready" ? createLiveLoader(integrations.zetaris.config) : undefined,
  model: meterlessConfig?.model, inferenceAllowed: process.env.RECALLOPS_ALLOW_INFERENCE === "true",
});
export const memory = new RecallOpsMemory({persistDir: resolve(process.env.RECALLOPS_STATE_DIR ?? "./state", "hmem")});
export async function calculateWithMemory(runId?: string) {
  const workspace = await store.calculatePlan(runId);
  if(process.env.ENGRAM_MEMORY_MODE==="off" || investigationCase?.memoryMode==="off")return workspace;
  const previous = memory.queryEvidence({query: "recall supplier coverage allocation evidence", recallId: workspace.snapshot.scope.recallId, currentSnapshotHash: fingerprintSnapshot(workspace.snapshot)});
  const p = workspace.plan;
  const record = memory.recordAnalysis({
    analysisId: `${workspace.incidentId}:${workspace.revision}`, recallId: workspace.recall.id,
    snapshotHash: workspace.assessment.inputFingerprint,
    summary: "Recall supplier coverage allocation evidence. Current QA and stock must be queried again. " + JSON.stringify({kind: "checked_allocation", scenario: workspace.scenario, dataMode: workspace.dataMode, affectedEa: workspace.assessment.totalAffectedEa, eligibleEa: workspace.assessment.totalEligibleEa, status: p?.status, transfers: p?.status === "feasible" ? p.transfers : [], shortfallEa: p && p.status !== "feasible" ? p.shortfallEa : 0}),
    sourceRefs: [...workspace.snapshot.scope.evidenceRefs, ...workspace.snapshot.inventory.map(row => row.id)],
  });
  await store.memoryAudit(`Meterless H-MEM queried ${previous.matches.length} advisory records and persisted ${record.memoryId} with exact source references. Historical memory cannot authorize stock or actions.`, runId);
  if (runId) await store.trace(runId, "meterless.hmem", `Retrieved ${previous.matches.length} advisory records; stored ${record.memoryId}. Current source evidence remains authoritative.`);
  return attachResolutionMemory(await store.getWorkspace(runId), runId);
}

import {resolutionSourceHash, type ResolutionSourceContext, type ResolutionResult} from '../memory/index.ts';
import {fingerprint} from '../domain/fingerprint.ts';
import type {Workspace} from '../shared/workspace.ts';
import {WorkspaceError} from './store.ts';
export type ResolutionMemoryView=ResolutionResult & {sourceHash:string;sourceRefs:string[]};
async function resolutionContext(w:Workspace,runId?:string):Promise<ResolutionSourceContext> {
  const notice=await store.getNotice(runId);
  return {recallId:w.snapshot.scope.recallId,manufacturerRef:w.snapshot.scope.manufacturerRef,affectedLots:w.snapshot.scope.affectedLots,observedLot:w.recall.conflict.observed,canonicalLot:w.recall.conflict.canonical,sourceRefs:[...new Set([...w.snapshot.scope.evidenceRefs,`notice-sha256:${fingerprint(notice)}`])]};
}
export async function attachResolutionMemory(w:Workspace,runId?:string):Promise<Workspace> {
  if(process.env.ENGRAM_MEMORY_MODE==="off" || investigationCase) return w;
  const context=await resolutionContext(w,runId),sourceHash=resolutionSourceHash(context);
  const resolutions=memory.queryResolutions({...context,sourceHash});
  return {...w,resolutionMemory:{...resolutions,sourceHash,sourceRefs:context.sourceRefs}};
}
export async function loadWorkspace():Promise<Workspace> {return attachResolutionMemory(await store.getWorkspace());}
export async function consultHistory(runId:string,query:string) {
  if(process.env.ENGRAM_MEMORY_MODE==="off" || investigationCase?.memoryMode==="off"){await store.trace(runId,"memory.disabled","Historical memory disabled for this case comparison.");return {analyses:{matches:[]},resolution:{decisions:[],nextInvestigationQuestion:"Inspect current sources relevant to the user question."}};}
  const w=await attachResolutionMemory(await store.getWorkspace(runId),runId);
  const analyses=memory.queryEvidence({query,recallId:w.snapshot.scope.recallId,currentSnapshotHash:fingerprintSnapshot(w.snapshot)});
  const resolution=w.resolutionMemory ?? {status:"human_resolution_advisory" as const,decisions:[],nextInvestigationQuestion:"Inspect current sources relevant to the user question.",neverAuthority:true as const,cannotChangeInventoryOrAuthorizeActions:true as const,hmemQuery:{retrievalReason:"disabled_or_no_conflict",strategy:"none",scores:{}}};
  await store.trace(runId,'memory.consulted',`H-MEM consulted ${analyses.matches.length} historical analyses and ${resolution.decisions.length} manually recorded document resolutions.`);
  for(const decision of resolution.decisions) await store.trace(runId,decision.status==='applied'?'memory.applied':'memory.rejected',`${decision.memoryId}: ${decision.status==='applied'?'document question resolved; physical identifiers, QA and approval gates unchanged':decision.reasonCodes.join(', ')}.`);
  return {analyses,resolution};
}
export async function saveOperatorResolution(input:{sourceHash:string;operator:string;reason:string;expiresAt:string}) {
  const w=await store.getWorkspace();
  if(w.agentRun.status==='running') throw new WorkspaceError('Finish or stop the investigation before recording a document resolution.');
  const expiry=Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 90 * 86400000) throw new WorkspaceError("Document resolution expiry must be within the next 90 days.", 400);
  const context=await resolutionContext(w),sourceHash=resolutionSourceHash(context);
  if(input.sourceHash!==sourceHash) throw new WorkspaceError('Source evidence changed. Refresh and review before recording the resolution.');
  const receipt=memory.recordResolution({...context,sourceHash,sourceContext:context,resolutionId:`resolution-${crypto.randomUUID()}`,operator:input.operator,reason:input.reason,effectiveAt:new Date().toISOString(),expiresAt:input.expiresAt});
  await store.memoryAudit(`Human operator ${input.operator} recorded source-bound document resolution ${receipt.memoryId}. Physical stock identifiers, QA and action authority are unchanged.`);
  return attachResolutionMemory(await store.getWorkspace());
}
export async function revokeOperatorResolution(input:{memoryId:string;reason:string}) {
  const progress=await store.getProgress();
  if(progress.agentRun.status==='running') throw new WorkspaceError('Finish or stop the investigation before revoking a document resolution.');
  memory.revokeResolution(input.memoryId,input.reason);
  await store.memoryAudit(`Human operator revoked document resolution ${input.memoryId}: ${input.reason}`);
  return loadWorkspace();
}
