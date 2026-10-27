import { buildServerRecordFindings } from "./server-record-findings.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessSnapshot, fingerprintSnapshot, planReplenishment, validatePlanAgainstSnapshot } from "../domain/index.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import type { PlanResult, Snapshot } from "../domain/types.ts";
import type { ActionReceipt, AgentRun, AuditEvent, BoundOperationalRead, IntegrationStatus, Scenario, Workspace } from "../shared/workspace.ts";
import type { ClaimCheckResult, ClaimFeedbackCode } from "../domain/claims.ts";
import { extractMeterlessAttribution } from "../integrations/meterless.ts";
import {projectInvestigationContext} from "./investigation-projection.ts";
import {DOCUMENTARY_PHASE_TASK} from "./investigation-prompt.ts";
import {collectReportProofIssues} from "./investigation-report-packet.ts";
import {concreteOperatorQuestion} from "./investigation-question.ts";
import {matchSourceBoundRecords,resolveRecordReferenceInput,automaticRecordReferenceProposals,RecordReferenceError,RECORD_REFERENCE_FEEDBACK,type RecordMatchInput,type RecordReferenceInput,type BoundRecordMatch} from "./record-matching.ts";
import {investigationWork,type InvestigationReadiness} from "./investigation-readiness.ts";
import { buildEvidenceRegistry, inspectEvidence, validateInvestigationReport } from "./evidence.ts";
import {INVESTIGATION_DOMAIN_FEEDBACK_CODES} from "../shared/investigation.ts";
import type {EvidenceDocument, EvidenceRegistry, InvestigationReportInput, InvestigationValidationIssue, InvestigationFindingIssue, InvestigationDomainFeedbackCode} from "../shared/investigation.ts";
import {runWhatIf, type WhatIfInput} from "./what-if.ts";
import { applyScenario, loadSeed } from "./seed.ts";
import { projectTerminalClaims, type TerminalProjection } from "./terminal-projection.ts";
import { projectStockEvidence } from "./stock-projection.ts";

export class WorkspaceError extends Error {
  constructor(message: string, public status = 409) { super(message); this.name = "WorkspaceError"; }
}
interface RecordReferenceBatchResult {
  valid:boolean;readiness:InvestigationReadiness;matches?:BoundRecordMatch[];codes?:string[];
  proposalIndex?:number;criterionRef?:string;stage?:string;guidance?:string;scope?:string;
}
type Saved = {
  schema: 1; revision: number; incidentId: string; scenario: Scenario; sourceRevision: number;
  plan: PlanResult | null; receipts: ActionReceipt[]; audit: AuditEvent[];
  keys: Record<string, {digest: string; receiptId: string}>; agentRun: AgentRun;
  workflow?: WorkflowState;
  boundEvidence?: EvidenceRegistry;
  investigationQuestion?: string;
  investigationSnapshot?: {runId: string; sourceRevision: number; overlayHash: string; snapshot: Snapshot};
};
const idleRun = (): AgentRun => ({status: "idle", summary: "", events: [], model: null, runId: null, incidentId: null});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestText = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const now = () => new Date().toISOString();
function utf8Prefix(value:string,maxBytes:number):string {
  const parts:string[]=[];let bytes=0;
  for(const codePoint of value){const size=Buffer.byteLength(codePoint,"utf8");if(bytes+size>maxBytes)break;parts.push(codePoint);bytes+=size;}
  return parts.join("");
}
export type SnapshotLoader = (base: Snapshot) => Promise<Snapshot>;
export type WorkspaceProgress = Pick<Workspace, "revision" | "incidentId" | "agentRun"> & {integrations: Pick<Workspace["integrations"], "meterless">};
type WorkflowStage = "solve_plan" | "validate_plan" | "prepare_actions";
type WorkflowBinding = {snapshotHash: string; planFingerprint: string; planStatus: PlanResult["status"]};
type WorkflowState = {runId: string; solve: WorkflowBinding | null; validation: (WorkflowBinding & {valid: boolean}) | null; prepared: WorkflowBinding | null};
export type WorkflowCheckpoint = WorkflowBinding & {valid?: boolean};
export type ModelCallBudget = {
  maxOutputTokens: 4096 | 8192 | 16384;
  phase: "investigation" | "investigation_inspect" | "investigation_report" | "solve" | "validate" | "prepare" | "terminal" | "repair";
  requiredTool: "inspect_evidence" | "read_evidence_sections" | "match_records" | "request_investigation_report" | "report_investigation" | "solve_plan" | "validate_plan" | "prepare_actions" | null;
  terminal: boolean;
  repair: boolean;
  reportRequestNumber?: number;
};

function verifiedResponse(message: string): boolean {
  try {
    const proof = JSON.parse(message);
    if (typeof proof.httpStatus !== "number" || proof.httpStatus < 200 || proof.httpStatus >= 300 || !Array.isArray(proof.routeAttributions) || proof.routeAttributions.length === 0) return false;
    const routes: ReturnType<typeof extractMeterlessAttribution>[] = proof.routeAttributions.map((route: Record<string, unknown>) => extractMeterlessAttribution({meterless: {provider_model: route.providerModel, routed_model: route.routedModel, winning_route: route.winningRoute}}));
    return routes.every(route => route.status === "response_reports_nemotron") && new Set(routes.map(route => route.underlyingModel)).size === 1;
  } catch {return false;}
}

function meterlessStatus(s: Saved, model?: string): IntegrationStatus {
  const current = !!s.agentRun.runId && s.agentRun.incidentId === s.incidentId;
  const rejected = current && (s.agentRun.status === "failed" || s.agentRun.status === "blocked" && s.agentRun.investigation?.disposition !== "needs_evidence" || !!s.agentRun.error || s.agentRun.events.some(event => event.tool === "model.attribution.rejected"));
  const count = current ? s.agentRun.events.filter(event => event.tool === "model.response.nemotron" && verifiedResponse(event.message)).length : 0;
  const verified = current && !rejected && (s.agentRun.status === "running" || s.agentRun.status === "complete" || s.agentRun.status === "blocked" && s.agentRun.investigation?.disposition === "needs_evidence") && count > 0;
  const hmem = s.audit.some(event => event.type === "meterless.hmem");
  return {
    configured: !!model || hmem,
    verified,
    status: verified ? "Verified in current investigation" : rejected ? "Current investigation not verified" : current ? "No verified response in current investigation" : hmem ? "H-MEM local · inference pending" : model ? "Configured · not verified" : "Inference configuration pending",
    detail: verified
      ? `${count} persisted response${count === 1 ? "" : "s"} in this investigation report coherent actual Nemotron route metadata. This verifies those completed responses; it does not establish award eligibility or future model routing.`
      : rejected
        ? "The current investigation failed or rejected model attribution. Earlier responses, external smoke checks and H-MEM memory do not verify this investigation."
        : "No actual Nemotron response has been verified in the current investigation. H-MEM use and external smoke evidence do not establish this run's model attribution.",
  };
}
function applyReceipt(snapshot: Snapshot, receipt: ActionReceipt) {
  if (receipt.action === "hold") for (const id of receipt.inventoryIds) {
    const row = snapshot.inventory.find(r => r.id === id);
    if (row) {row.allocationHold = true; row.version = `${row.version}:hold:${receipt.id}`;}
  }
  if (receipt.action === "reserve") for (const line of receipt.transfers) for (const allocation of line.stockAllocations) {
    const row = snapshot.inventory.find(r => r.id === allocation.inventoryId);
    if (row) {row.reservedEa += allocation.quantityEa; row.version = `${row.version}:reservation:${receipt.id}`;}
  }
}

/** One local writer process; the queue serializes check-and-save. No distributed transaction is claimed. */
export class WorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private workspaceReadEpoch = 0;
  private readonly workspaceReads = new Map<string, {epoch: number; promise: Promise<Workspace>}>();
  private readonly file: string;
  constructor(private options: {root?: string; stateDir?: string; liveLoader?: SnapshotLoader; model?: string; inferenceAllowed?: boolean; investigationCase?: {id:string; question:string; snapshot:Snapshot; documents:EvidenceDocument[]; memoryMode:"on"|"off"}} = {}) {
    this.file = resolve(options.stateDir ?? process.env.RECALLOPS_STATE_DIR ?? "./state", "workspace.json");
  }
  private initial(): Saved {
    const incidentId = `incident-${randomUUID()}`;
    return {schema: 1, revision: 1, incidentId, scenario: "on_time", sourceRevision: 1, plan: null, receipts: [], audit: [{id: randomUUID(), at: now(), type: "incident.created", message: "Historical replay started with fictional operations."}], keys: {}, agentRun: idleRun()};
  }
  private async readPersisted(): Promise<Saved> {
    const state = JSON.parse(await readFile(this.file, "utf8")) as Saved;
    if (state.schema !== 1 || !Array.isArray(state.receipts) || !state.incidentId || !state.keys) throw new Error("Unsupported or damaged workspace state");
    return state;
  }
  private async load(): Promise<Saved> {
    try {
      return await this.readPersisted();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const state = this.initial(); await this.save(state); return state;
    }
  }
  private async save(state: Saved): Promise<void> {
    await mkdir(resolve(this.file, ".."), {recursive: true, mode: 0o700});
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const encoded = JSON.stringify(state, null, 2);
    await writeFile(temp, encoded, {mode: 0o600}); await rename(temp, this.file);
    if (await readFile(this.file, "utf8") !== encoded) throw new Error("Workspace persistence readback failed");
  }
  private async locked<T>(operation: () => Promise<T>, invalidateWorkspaceReads = true): Promise<T> {
    // Any other serialized operation is a barrier for workspace reads. A
    // later read must queue after it instead of joining a snapshot captured
    // before that operation was enqueued.
    if (invalidateWorkspaceReads) this.workspaceReadEpoch++;
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => undefined); return pending;
  }
  private event(s: Saved, type: string, message: string) {s.audit.push({id: randomUUID(), at: now(), type, message});}
  private async snapshot(s: Saved, runId?: string): Promise<Snapshot> {
    if (runId) {
      this.assertRun(s, runId);
      const pinned = s.investigationSnapshot;
      if (!pinned || pinned.runId !== runId || pinned.sourceRevision !== s.sourceRevision || pinned.overlayHash !== digest(s.receipts.filter(r => r.incidentId === s.incidentId))) throw new WorkspaceError("Investigation snapshot was invalidated; start a fresh investigation.");
      return structuredClone(pinned.snapshot);
    }
    const captureStarted = performance.now();
    const seed = await loadSeed(this.options.root);
    const base = this.options.investigationCase ? structuredClone(this.options.investigationCase.snapshot) : this.options.liveLoader ? structuredClone(await this.options.liveLoader(seed.snapshot)) : applyScenario(seed.snapshot, s.scenario);
    base.sourceRead ??= {retrievedAt: now(), elapsedMs: Math.round(performance.now() - captureStarted), queryCount: 0, phases: []};
    base.sourceVersions.workspace = s.sourceRevision;
    for (const receipt of s.receipts.filter(r => r.incidentId === s.incidentId)) applyReceipt(base, receipt);
    return base;
  }
  private async workspace(s: Saved, preparedSnapshot?: Snapshot): Promise<Workspace> {
    const seed = await loadSeed(this.options.root); const snapshot = preparedSnapshot ?? await this.snapshot(s, s.agentRun.status === "running" ? s.agentRun.runId! : undefined); const assessment = assessSnapshot(snapshot);
    const reserved = s.receipts.some(r => r.incidentId === s.incidentId && r.action === "reserve");
    const model = this.options.model ?? null;
    return {
      evaluation: {caseId:this.options.investigationCase?.id??null,memoryMode:process.env.ENGRAM_MEMORY_MODE==="off"||this.options.investigationCase?.memoryMode==="off"?"off":"on"},
      evidenceRegistry: buildEvidenceRegistry(snapshot, seed.evidence, this.options.investigationCase?.documents),
      investigationEvidence: s.boundEvidence,
      revision: s.revision, incidentId: s.incidentId, scenario: s.scenario, dataMode: snapshot.dataMode === "live" ? "live" : "replay",
      disclosure: this.options.investigationCase ? `Fictional evaluation case ${this.options.investigationCase.id}. No real supply, exposure or FDA status is asserted.` : seed.disclosure, clock: snapshot.clock,
      recall: {
        id: snapshot.scope.recallId, title: this.options.investigationCase ? `Fictional investigation ${snapshot.scope.recallId}` : "100mL saline · leaking bottle seals", reference: snapshot.scope.manufacturerRef,
        affectedLots: snapshot.scope.affectedLots, sources: this.options.investigationCase ? this.options.investigationCase.documents.map(d=>({id:d.id,title:d.title,url:d.sourceURL})) : seed.sources,
        conflict: this.options.investigationCase ? {observed:snapshot.scope.reviewLots[0]??"Not recorded",canonical:"Unresolved",explanation:"Inspect the fictional case documents; no source conflict is assumed."} : {observed: "23IJA103", canonical: "23JJA103", explanation: "Distributor cover lists 23IJA103. FDA and the manufacturer attachment list 23JJA103. Preserve the discrepancy; do not rewrite stock identifiers."},
        tasks: this.options.investigationCase ? [] : seed.evidence.required_tasks.map((t: {id:string;type:string;status:string}) => ({id: t.id, title: ({PHYSICAL_QUARANTINE: "Physically quarantine affected stock", AUTHORIZED_DISPOSITION: "Arrange authorized destruction", MANUFACTURER_RESPONSE: "Complete the manufacturer response", DOWNSTREAM_NOTIFICATION_REVIEW: "Review downstream distribution"} as Record<string,string>)[t.type] ?? t.type, status: t.status})),
      },
      snapshot, assessment, plan: s.plan,
      planState: reserved ? "reserved" : !s.plan ? "none" : s.plan.inputFingerprint === assessment.inputFingerprint ? "current" : "stale",
      receipts: s.receipts, audit: s.audit,
      integrations: {
        meterless: meterlessStatus(s, model ?? undefined),
        zetaris: {configured: !!this.options.liveLoader, verified: snapshot.dataMode === "live", status: snapshot.dataMode === "live" ? "Live read succeeded" : "Replay data", detail: snapshot.dataMode === "live" ? "Current data was read through configured Zetaris views; operational records remain fictional. No cross-source transaction guarantee." : "Bundled fictional source pack. Live Zetaris registration and readback are pending."},
      },
      agent: {enabled: !!model && !!this.options.inferenceAllowed, model, reason: !model ? "Configure the verified Meterless endpoint and Nemotron model first." : !this.options.inferenceAllowed ? "Inference is disabled until account and test spending are authorized." : "Real model calls enabled. Approval actions remain available only through the interface."},
      agentRun: s.agentRun,
    };
  }
  async getWorkspace(runId?: string): Promise<Workspace> {
    const key = runId === undefined ? "\u0000workspace" : `\u0001${runId}`;
    const epoch = this.workspaceReadEpoch;
    const current = this.workspaceReads.get(key);
    if (current?.epoch === epoch) return current.promise.then(workspace => structuredClone(workspace));

    const promise = this.locked(async () => {
      const s = await this.load(); if (runId) this.assertRun(s, runId); return this.workspace(s);
    }, false);
    const flight = {epoch, promise};
    this.workspaceReads.set(key, flight);
    void promise.then(
      () => {if (this.workspaceReads.get(key) === flight) this.workspaceReads.delete(key);},
      () => {if (this.workspaceReads.get(key) === flight) this.workspaceReads.delete(key);},
    );
    return promise.then(workspace => structuredClone(workspace));
  }
  /** Display-only local progress. Atomic rename permits coherent reads without waiting behind live SQL.
   * Never returns source snapshots, proposals or anything that can authorize an action. */
  async getProgress(): Promise<WorkspaceProgress> {
    let s: Saved;
    try {s = await this.readPersisted();}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      s = await this.locked(() => this.load());
    }
    return {revision: s.revision, incidentId: s.incidentId, agentRun: s.agentRun, integrations: {meterless: meterlessStatus(s, this.options.model)}};
  }
  async getSnapshot(runId?: string): Promise<Snapshot> {return this.locked(async () => {const s = await this.load(); if (runId) this.assertRun(s, runId); return this.snapshot(s, runId);});}
  async getEvidenceIndex(runId: string, query = "") {
    return this.locked(async () => {
      const s = await this.load(); this.assertRun(s,runId);
      const registry = s.boundEvidence; if(!registry) throw new WorkspaceError("No bound evidence registry.");
      if(query.length>120)throw new WorkspaceError("Discovery queries are limited to 120 characters.",400);
      const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
      const entries=registry.entries.filter(e=>!terms.length||terms.some(t=>`${e.id} ${e.title} ${e.kind} ${e.content}`.toLowerCase().includes(t)));
      const selected=new Set(s.agentRun.investigation?.selections.map(selection=>selection.sourceId)??[]);
      const complete=registry.entries.length<=60;
      const result={snapshotHash:registry.snapshotHash,entries:entries.slice(0,complete?60:20).map(({id,title,kind,authority})=>({id,title,kind,authority,alreadyInspected:selected.has(id)})),total:entries.length,omittedCount:0,quotedDataOnly:true,investigationBudget:{totalModelRequests:12,readinessRequiredBeforeReport:true,requestsUsed:s.agentRun.events.filter(event=>event.tool==="model.request.started").length},recordReferenceSemantics:"QA, expiry and other aliases on a normalized row are metadata references to that same row, not independently verified document bodies. Inspect a separately indexed document to read independent evidence."};
      result.omittedCount=entries.length-result.entries.length;
      if(!complete){
        while(result.entries.length&&Buffer.byteLength(JSON.stringify(result))>7000){result.entries.pop();result.omittedCount=entries.length-result.entries.length;}
        const observationResult={query,result},bytes=Buffer.byteLength(JSON.stringify(observationResult));
        const observation={tool:"list_evidence",at:now(),snapshotHash:registry.snapshotHash,bytes,resultHash:digest(observationResult),result:structuredClone(observationResult)};
        const observations=[...(s.agentRun.investigationObservations??[]),observation];s.agentRun.investigationObservationOmittedCount=(s.agentRun.investigationObservationOmittedCount??0)+Math.max(0,observations.length-2);s.agentRun.investigationObservations=observations.slice(-2);
      }
      s.agentRun.events.push({at:now(),tool:"list_evidence",message:JSON.stringify({queryLength:query.length,matchedCount:entries.length,returnedCount:result.entries.length,snapshotHash:registry.snapshotHash,observationRetained:!complete})});s.revision++;await this.save(s);
      return result;
    });
  }
  private investigationWork(s:Saved,runId:string) {
    if(!s.boundEvidence||!s.agentRun.investigation)throw new WorkspaceError("No bound investigation evidence.");
    const snapshot=this.investigationSnapshot(s,runId);
    const operationalIds=[...snapshot.inventory.map(row=>row.id),...snapshot.demands.map(row=>row.id),...snapshot.routes.map(row=>row.id),...snapshot.shipments.map(row=>row.id),...snapshot.catalog.map(row=>row.internalSku)];
    return investigationWork({runId,snapshotHash:s.boundEvidence.snapshotHash,question:s.investigationQuestion??"",registry:s.boundEvidence,investigation:s.agentRun.investigation,operationalIds});
  }
  private assertInvestigationWorkReady(s:Saved,runId:string):void {
    const readiness=this.investigationWork(s,runId).readiness;
    if(!readiness.reportReady)throw new WorkspaceError(`Investigation stage ${readiness.stage} is unfinished; retrieve required sources and complete valid record matching before reporting. Unperformed work is not missing evidence.`);
  }
  async readEvidenceSections(runId:string,sectionIds?:string[]) {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!investigation||investigation.disposition!==null)throw new WorkspaceError("Section reads require an active preliminary investigation.");
      const backendScheduled=sectionIds===undefined;
      const work=this.investigationWork(s,runId);
      if(backendScheduled){
        if(work.readiness.stage!=="retrieve"||!work.readiness.pendingSectionIds.length)throw new WorkspaceError("There are no pending required evidence sections to retrieve.",400);
        const pending=new Set(work.readiness.pendingSectionIds),batch:typeof work.sections=[];
        for(const section of work.sections){if(!pending.has(section.sectionId))continue;if(batch.length>=30||Buffer.byteLength(JSON.stringify([...batch,section]),"utf8")>14_000)break;batch.push(section);}
        sectionIds=batch.map(section=>section.sectionId);
      }
      if(!Array.isArray(sectionIds)||!sectionIds.length||sectionIds.length>30||new Set(sectionIds).size!==sectionIds.length)throw new WorkspaceError("Select 1 to 30 unique exact section references.",400);
      const sections=sectionIds.map(id=>work.sections.find(section=>section.sectionId===id));
      if(sections.some(section=>!section||section.text.length>1000))throw new WorkspaceError("Section references are unknown, stale or unsupported.",400);
      if(Buffer.byteLength(JSON.stringify(sections))>14_000)throw new WorkspaceError("Read fewer complete sections; a retrieval result is bounded to 14KB.",400);
      investigation.retrievalReceipts=[...(investigation.retrievalReceipts??[]),{runId,snapshotHash:investigation.snapshotHash,sectionIds:[...sectionIds],at:now()}];
      s.agentRun.events.push({at:now(),tool:"read_evidence_sections",message:JSON.stringify({runId,snapshotHash:investigation.snapshotHash,sectionIds,bytes:Buffer.byteLength(JSON.stringify(sections)),execution:backendScheduled?"backend_required_section_batch":"model_selected_section_ids"})});s.revision++;await this.save(s);
      return {runId,snapshotHash:investigation.snapshotHash,sections,readiness:this.investigationWork(s,runId).readiness,quotedDataOnly:true,execution:backendScheduled?"backend_required_section_batch":"model_selected_section_ids"};
    });
  }
  async inspectSources(runId:string, sourceIds?:string[], reason?:string) {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!s.boundEvidence||!investigation)throw new WorkspaceError("No bound investigation evidence.");
      const backendScheduled=sourceIds===undefined&&reason===undefined;
      let execution:"backend_required_source_batch"|"backend_initial_source_batch"|"model_selected_source_ids"=backendScheduled?"backend_required_source_batch":"model_selected_source_ids";
      if(backendScheduled){
        const work=this.investigationWork(s,runId),pending=work.readiness.pendingSourceIds;
        if(pending.length){sourceIds=pending.slice(0,3);reason="Backend required-source inspection batch.";}
        else if(work.readiness.stage==="inspect"&&!investigation.selections.length){
          const snapshot=this.investigationSnapshot(s,runId),operationalRecordIds=[...snapshot.inventory.map(row=>row.id),...snapshot.demands.map(row=>row.id),...snapshot.routes.map(row=>row.id),...snapshot.shipments.map(row=>row.id),...snapshot.catalog.map(row=>row.internalSku)],operationalRecordFamilies={inventoryLots:snapshot.inventory.length>0,shipments:snapshot.shipments.length>0,siteDemands:snapshot.demands.length>0,routes:snapshot.routes.length>0,catalogItems:snapshot.catalog.length>0},requestsUsed=s.agentRun.events.filter(event=>event.tool==="model.request.started").length,operationalReads=this.currentBoundOperationalReads(s,runId),targetIdentity={runId,snapshotHash:s.boundEvidence.snapshotHash,targetSku:snapshot.targetSku,recallId:snapshot.scope.recallId,manufacturerRef:snapshot.scope.manufacturerRef,catalogMappings:snapshot.catalog.filter(item=>item.internalSku===snapshot.targetSku).map(({internalSku,manufacturerRef,unit})=>({internalSku,manufacturerRef,unit}))};
          const projection=projectInvestigationContext({runId,question:s.investigationQuestion??"Investigate current evidence and calculate coverage only if requested.",phaseTask:DOCUMENTARY_PHASE_TASK,targetIdentity,snapshotHash:s.boundEvidence.snapshotHash,registry:s.boundEvidence,investigation,history:s.agentRun.investigationHistory,observations:s.agentRun.investigationObservations,observationOmittedCount:s.agentRun.investigationObservationOmittedCount,requestsUsed,reportOnly:false,work,operationalRecordIds,operationalRecordFamilies,operationalReads,operationalReadsAllowed:requestsUsed>=1&&!investigation.reportRequest&&this.hasCanonicalDocumentarySelection(s,runId,s.boundEvidence.snapshotHash)});
          sourceIds=projection.context.newInspectionSourceIds.slice(0,Math.min(3,12-investigation.selections.length));
          if(!sourceIds.length)throw new WorkspaceError("There are no presented canonical sources available for initial inspection.",400);
          reason="Backend initial canonical-source inspection batch.";execution="backend_initial_source_batch";
        }else throw new WorkspaceError("There are no pending required canonical sources to inspect.",400);
      }
      if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>3||new Set(sourceIds).size!==sourceIds.length||typeof reason!=="string"||reason.length<1||reason.length>300)throw new WorkspaceError("Select 1 to 3 unique source IDs with a bounded reason.",400);
      const previouslySelected=new Set(investigation.selections.map(selection=>selection.sourceId));
      const results=sourceIds.map(id=>({requestedId:id,entry:inspectEvidence(s.boundEvidence!,id)}));
      const inspectedRequestCount=s.agentRun.events.filter(event=>event.tool==="inspect_evidence").reduce((sum,event)=>{try{const parsed=JSON.parse(event.message);return sum+(Array.isArray(parsed.sourceIds)?parsed.sourceIds.length:0);}catch{return sum;}},0);
      if(inspectedRequestCount+sourceIds.length>12)throw new WorkspaceError("Source inspection limit reached; report findings or ask a concrete evidence question.");
      const newIds=new Set(results.flatMap(({entry})=>"sourceHash" in entry&&!previouslySelected.has(entry.id)?[entry.id]:[]));
      if(investigation.selections.length+newIds.size>12)throw new WorkspaceError("Source inspection limit reached; report findings or ask a concrete evidence question.");
      const resolved=results.map(({requestedId,entry})=>"sourceHash" in entry?{requestedId,canonicalSourceId:entry.id,sourceHash:entry.sourceHash,aliasOnly:requestedId!==entry.id,alreadyInspected:previouslySelected.has(entry.id),meaning:requestedId!==entry.id?"Alias resolves to the same stored record; it is not an independently verified document.":"Canonical stored evidence entry."}:{requestedId,status:"unknown" as const});
      const entries=[...new Map(results.map(({entry})=>["sourceHash" in entry?entry.id:`unknown:${entry.id}`,entry])).values()];
      for(const entry of entries)if("sourceHash" in entry&&!previouslySelected.has(entry.id))investigation.selections.push({sourceId:entry.id,sourceHash:entry.sourceHash,reason,at:now()});
      const work=this.investigationWork(s,runId),delivered:typeof work.sections=[];
      for(const section of work.sections.filter(section=>newIds.has(section.sourceId))){
        if(section.text.length<=1000&&Buffer.byteLength(JSON.stringify([...delivered,section]))<=14_000)delivered.push(section);
      }
      if(delivered.length)investigation.retrievalReceipts=[...(investigation.retrievalReceipts??[]),{runId,snapshotHash:s.boundEvidence.snapshotHash,sectionIds:delivered.map(section=>section.sectionId),at:now()}];
      s.agentRun.events.push({at:now(),tool:"inspect_evidence",message:JSON.stringify({sourceIds,reason,resolutions:resolved,snapshotHash:s.boundEvidence.snapshotHash,presentedSectionIds:delivered.map(section=>section.sectionId),execution})});s.revision++;await this.save(s);
      const received=new Set((investigation.retrievalReceipts??[]).flatMap(receipt=>receipt.sectionIds));
      return {snapshotHash:s.boundEvidence.snapshotHash,resolutions:resolved,entries:entries.map(entry=>"content" in entry?{...entry,content:work.sections.filter(section=>section.sourceId===entry.id).every(section=>received.has(section.sectionId))?entry.content:"",bodyOmitted:work.sections.filter(section=>section.sourceId===entry.id).some(section=>!received.has(section.sectionId))}:entry),sections:delivered,readiness:this.investigationWork(s,runId).readiness,execution,interpretation:"Only the exact returned sections have been retrieved. Remaining section references require read_evidence_sections before report. Aliases are metadata, not independent verification."};
    });
  }
  async matchRecords(runId:string,request:RecordMatchInput) {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!s.boundEvidence||!investigation||investigation.disposition!==null)throw new WorkspaceError("Matching requires an active preliminary investigation.");
      const requests=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
      if(requests<1||investigation.reportRequest)throw new WorkspaceError("Read-only record matching requires the matching stage before report.");
      const selected=investigation.selections.map(selection=>s.boundEvidence!.entries.find(entry=>entry.id===selection.sourceId&&entry.sourceHash===selection.sourceHash)).filter((entry):entry is EvidenceRegistry["entries"][number]=>!!entry);
      const matches=matchSourceBoundRecords({runId,snapshotHash:s.boundEvidence.snapshotHash,selected,request});
      const merged=[...new Map([...(investigation.recordMatches??[]),...matches].map(result=>[result.resultId,result])).values()];
      if(merged.length>12||Buffer.byteLength(JSON.stringify(merged))>24_000)throw new WorkspaceError("Bounded record-match proof limit exceeded.");
      investigation.recordMatches=structuredClone(merged);
      s.agentRun.events.push({at:now(),tool:"match_records",message:JSON.stringify({snapshotHash:s.boundEvidence.snapshotHash,resultIds:matches.map(result=>result.resultId),records:matches.length,verificationScope:"explicit_source_bound_field_comparison_only"})});
      s.revision++;await this.save(s);return {matches,interpretation:"Checked only the explicitly supplied, source-bound field criteria. Unknown dates remain unknown; expiry is never manufacture date. These results do not establish recall completeness, QA, safety or permission."};
    });
  }
  async matchRecordReferences(runId:string,request:RecordReferenceInput) {return this.matchRecordReferenceBatch(runId,[request]);}
  async matchPendingRecordReferences(runId:string) {
    const batches:Array<{valid:boolean;matches?:unknown[];readiness:InvestigationReadiness}>=[];
    for(let index=0;index<24;index++){
      const result=await this.matchRecordReferenceBatch(runId);batches.push(result);
      if(!result.valid||result.readiness.stage!=="match")return {...result,batches:batches.length};
      const next=(await this.getInvestigationContext(runId)).projection?.work;
      if(!next||!automaticRecordReferenceProposals(next.recordCatalog,next.readiness.unmatchedRecordChecks,1).length)return {...result,batches:batches.length};
    }
    throw new WorkspaceError("Bounded deterministic matching did not finish; no report was accepted.");
  }
  async matchRecordReferenceBatch(runId:string,proposals?:RecordReferenceInput[]):Promise<RecordReferenceBatchResult> {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!investigation||investigation.disposition!==null||investigation.reportRequest)throw new WorkspaceError("Reference matching requires an active unfinished preliminary investigation.");
      const work=this.investigationWork(s,runId);
      if(work.readiness.pendingSourceIds.length||work.readiness.pendingSectionIds.length)throw new WorkspaceError("Retrieve the required source sections before matching.");
      const backendScheduled=proposals===undefined;
      proposals??=automaticRecordReferenceProposals(work.recordCatalog,work.readiness.unmatchedRecordChecks,Math.min(12,Math.max(0,24-(investigation.recordMatches??[]).length)));
      const rejectCapacity=async()=>{
        const message="The remaining source-bound comparisons exceed the current proof capacity; no complete investigation was accepted.";
        s.agentRun.status="failed";s.agentRun.error=message;s.agentRun.summary=message;
        s.agentRun.events.push({at:now(),tool:"investigation.capacity.rejected",message:JSON.stringify({stage:"match",maxResults:24,maxProofBytes:48_000,noReportTransition:true})});s.revision++;await this.save(s);
        return {valid:false,codes:["record_match_capacity_exceeded"],stage:"match",readiness:work.readiness,guidance:message};
      };
      let proposalIndex=0;
      try {
        if(backendScheduled&&!proposals.length)return await rejectCapacity();
        if(!Array.isArray(proposals)||!proposals.length||proposals.length>6)throw new TypeError("Choose one to six bounded matching proposals.");
        const selected=investigation.selections.map(selection=>s.boundEvidence!.entries.find(entry=>entry.id===selection.sourceId&&entry.sourceHash===selection.sourceHash)).filter((entry):entry is EvidenceRegistry["entries"][number]=>!!entry);
        const matches:NonNullable<typeof investigation.recordMatches>=[];
        for(proposalIndex=0;proposalIndex<proposals.length;proposalIndex++){
          const resolved=matchSourceBoundRecords({runId,snapshotHash:investigation.snapshotHash,selected,request:resolveRecordReferenceInput(work.recordCatalog,proposals[proposalIndex]!,work.readiness.unmatchedRecordChecks)});
          for(const result of resolved){
            if(backendScheduled){
              const trial=[...new Map([...(investigation.recordMatches??[]),...matches,result].map(item=>[item.resultId,item])).values()];
              if(trial.length>24||Buffer.byteLength(JSON.stringify(trial))>48_000)continue;
            }
            matches.push(result);
          }
        }
        if(backendScheduled&&!matches.length)return await rejectCapacity();
        const merged=[...new Map([...(investigation.recordMatches??[]),...matches].map(result=>[result.resultId,result])).values()];
        if(merged.length>24||Buffer.byteLength(JSON.stringify(merged))>48_000)throw new TypeError("Record match proof capacity exceeded.");
        investigation.recordMatches=structuredClone(merged);investigation.matchingFeedback=[];
        s.agentRun.events.push({at:now(),tool:"match_records",message:JSON.stringify({snapshotHash:investigation.snapshotHash,resultIds:matches.map(result=>result.resultId),referenceResolution:"exact_source_record_references",backendScheduled,proposals:proposals.length,pendingRowExpansionProposals:proposals.filter(proposal=>proposal.recordRefs===undefined).length,records:matches.length})});s.revision++;await this.save(s);
        return {valid:true,matches,readiness:this.investigationWork(s,runId).readiness,scope:"explicit_source_bound_field_comparison_only"};
      }catch(error) {
        const reason=error instanceof RecordReferenceError&&Object.hasOwn(RECORD_REFERENCE_FEEDBACK,error.code)?error.code:"invalid_source_bound_values";
        const codes=["invalid_record_match_proposal",reason],guidance=RECORD_REFERENCE_FEEDBACK[reason]!;
        const ref=proposals[proposalIndex]?.criterionRef;
        const criterionRef=typeof ref==="string"&&/^[a-f0-9]{64}$/.test(ref)&&[...work.recordCatalog.criteria,...work.recordCatalog.criterionSections].some(value=>value.criterionRef===ref)?ref:undefined;
        investigation.matchingFeedback=[...(investigation.matchingFeedback??[]),{at:now(),codes,proposalIndex,...(criterionRef?{criterionRef}:{}),guidance}].slice(-3);
        s.agentRun.events.push({at:now(),tool:"match_records.rejected",message:JSON.stringify({codes,proposalIndex,stage:"match",noReportTransition:true})});s.revision++;await this.save(s);
        return {valid:false,codes,proposalIndex,...(criterionRef?{criterionRef}:{}),stage:"match",readiness:this.investigationWork(s,runId).readiness,guidance};
      }
    });
  }
  async requestInvestigationReport(runId:string,reason:string):Promise<{reportRequested:true;runId:string;snapshotHash:string;reason:string;at:string;idempotent:boolean}> {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!investigation||investigation.disposition!==null||!s.boundEvidence)throw new WorkspaceError("A report can only be requested during an active preliminary investigation.");
      const boundedReason=typeof reason==="string"?reason.trim():"";
      if(!boundedReason||boundedReason.length>300)throw new WorkspaceError("Report request reason must contain 1 to 300 characters.",400);
      const snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
      if(investigation.runId!==runId||investigation.snapshotHash!==snapshotHash||s.boundEvidence.snapshotHash!==snapshotHash)throw new WorkspaceError("Report request does not match the active snapshot.");
      if(!this.hasCanonicalDocumentarySelection(s,runId,snapshotHash))throw new WorkspaceError("Inspect at least one canonical documentary source before requesting a report.");
      this.assertInvestigationWorkReady(s,runId);
      const existing=investigation.reportRequest;
      if(existing){
        if(existing.runId!==runId||existing.snapshotHash!==snapshotHash||existing.reason!==boundedReason)throw new WorkspaceError("A different or stale report request is already bound to this investigation.");
        return {reportRequested:true,runId,snapshotHash,reason:existing.reason,at:existing.at,idempotent:true};
      }
      const at=now();investigation.reportRequest={runId,snapshotHash,reason:boundedReason,at};
      s.agentRun.events.push({at,tool:"investigation.report.requested",message:JSON.stringify({runId,snapshotHash,reason:boundedReason})});
      s.revision++;await this.save(s);
      return {reportRequested:true,runId,snapshotHash,reason:boundedReason,at,idempotent:false};
    });
  }
  async recordInvestigationReportFormatFailure(runId:string,input:{snapshotHash:string;rawContent:string;codes:string[]}):Promise<void> {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!investigation||investigation.runId!==runId||investigation.disposition!==null||!s.boundEvidence)throw new WorkspaceError("A report-format failure can only be recorded during an active preliminary investigation.");
      const snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
      if(input.snapshotHash!==snapshotHash||investigation.snapshotHash!==snapshotHash||s.boundEvidence.snapshotHash!==snapshotHash)throw new WorkspaceError("Report-format failure does not match the active snapshot.");
      if(typeof input.rawContent!=="string"||!Array.isArray(input.codes)||input.codes.length<1||input.codes.length>12||input.codes.some(code=>typeof code!=="string"||!code.trim()||code.length>100))throw new WorkspaceError("Report-format failure audit fields are invalid.",400);
      const prior=investigation.formatFailures??[];
      if(prior.length>=3)throw new WorkspaceError("The three report-format failure budget was exhausted.");
      const requests=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
      const reportRequests=s.agentRun.events.filter(event=>event.tool==="model.report.request.started").length;
      if(reportRequests<1)throw new WorkspaceError("Report-format failures can only be recorded after a report-only request was claimed.");
      const codes=[...new Set(input.codes.map(code=>code.trim()))],rawContentHash=digestText(input.rawContent),latest=prior.at(-1);
      if(latest?.requestNumber===requests&&latest.reportRequestNumber===reportRequests){
        if(latest.rawContentHash===rawContentHash&&JSON.stringify(latest.codes)===JSON.stringify(codes))return;
        throw new WorkspaceError("A different format failure is already recorded for this report request.");
      }
      const fullBytes=Buffer.byteLength(input.rawContent,"utf8"),rawContent=utf8Prefix(input.rawContent,48_000),retainedBytes=Buffer.byteLength(rawContent,"utf8"),at=now();
      const failure={runId,snapshotHash,requestNumber:requests,reportRequestNumber:reportRequests,at,codes,rawContent,rawContentHash,rawContentBytes:fullBytes,rawContentRetainedBytes:retainedBytes,rawContentTruncated:retainedBytes<fullBytes};
      investigation.formatFailures=[...prior,failure];investigation.feedback.push({at,codes:failure.codes});
      s.agentRun.events.push({at,tool:"investigation.report.format_failure",message:JSON.stringify({runId,snapshotHash,codes:failure.codes,rawContentHash:failure.rawContentHash,rawContentBytes:fullBytes,rawContentRetainedBytes:retainedBytes,rawContentTruncated:failure.rawContentTruncated})});
      if(reportRequests>=3){
        const error="Report validation budget exhausted; no findings or plan were accepted.";
        s.agentRun.summary=error;s.agentRun.error=error;s.agentRun.status="failed";
        this.event(s,"investigation.failed","Report validation budget exhausted; no findings, evidence question, or plan was accepted. No action approval was performed.");
      }
      s.revision++;await this.save(s);
    });
  }
  async acknowledgeInvestigationReportFormatFailure(runId:string,snapshotHash:string,failureSha256:string):Promise<{feedbackRecorded:true;codes:string[];runId:string;snapshotHash:string;failureSha256:string}> {
    return this.locked(async()=>{
      const s=await this.load();
      if(!["running","failed"].includes(s.agentRun.status)||s.agentRun.runId!==runId||s.agentRun.incidentId!==s.incidentId)throw new WorkspaceError("This investigation is no longer active.");
      const investigation=s.agentRun.investigation;
      if(!investigation||investigation.runId!==runId||investigation.disposition!==null||!s.boundEvidence)throw new WorkspaceError("Report-format feedback cannot be acknowledged outside the active preliminary investigation.");
      const snapshot=this.investigationSnapshot(s,runId),currentHash=fingerprintSnapshot(snapshot),latest=investigation.formatFailures?.at(-1);
      if(snapshotHash!==currentHash||investigation.snapshotHash!==currentHash||s.boundEvidence.snapshotHash!==currentHash||
        !latest||latest.runId!==runId||latest.snapshotHash!==currentHash||latest.rawContentHash!==failureSha256||
        latest.requestNumber!==s.agentRun.events.filter(event=>event.tool==="model.request.started").length||
        latest.reportRequestNumber!==s.agentRun.events.filter(event=>event.tool==="model.report.request.started").length) {
        throw new WorkspaceError("Report-format feedback proof is stale or does not identify the latest claimed report request.");
      }
      return {feedbackRecorded:true,codes:[...latest.codes],runId,snapshotHash:currentHash,failureSha256};
    });
  }
  async submitInvestigationReport(runId:string,input:InvestigationReportInput) {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(!s.boundEvidence||!investigation)throw new WorkspaceError("No bound investigation evidence.");
      if(investigation.feedback.length>=3)throw new WorkspaceError("The bounded finding review limit was reached.");
      this.assertInvestigationWorkReady(s,runId);
      investigation.reportAttempts=[...(investigation.reportAttempts??[]),structuredClone(input)].slice(-3);
      const snapshot=this.investigationSnapshot(s,runId);
      const trustedRecordIds=(investigation.recordMatches??[]).map(result=>result.recordId);
      const question=input.disposition==="needs_evidence"?concreteOperatorQuestion(input,s.investigationQuestion??"",[snapshot.scope.manufacturerRef,snapshot.targetSku,...trustedRecordIds,...snapshot.inventory.flatMap(row=>[row.id,row.lot??""]),...snapshot.shipments.map(row=>row.id),...s.boundEvidence.entries.flatMap(entry=>[entry.id,...entry.refs])],trustedRecordIds):{question:input.question,origin:"report" as const};
      const normalized={...input,...(question.question?{question:question.question}:{})};
      const issueSink:InvestigationValidationIssue[]=[];
      const serverRecordFindings=input.recordCitationMode==="atomic_receipts_v1"&&(investigation.recordMatches??[]).length>0;
      const result=validateInvestigationReport(s.boundEvidence,investigation.selections.map(x=>x.sourceId),normalized,{runId,question:s.investigationQuestion,recordMatches:investigation.recordMatches,issueSink,serverRecordFindings});
      if(!investigation.selections.length){result.valid=false;result.codes=[...new Set([...result.codes,"source_inspection_required"])];issueSink.push({code:"source_inspection_required"});}
      if(input.disposition==="needs_evidence"&&!question.question){result.valid=false;result.codes=[...new Set([...result.codes,"concrete_operator_question_required"])];issueSink.push({code:"concrete_operator_question_required"});}
      const allowedIssueCodes=new Set<string>(INVESTIGATION_DOMAIN_FEEDBACK_CODES),seenIssues=new Set<string>();
      const findingIssues:InvestigationFindingIssue[]=[],reportIssues:InvestigationDomainFeedbackCode[]=[];
      let findingIssuesOmittedCount=0,reportIssuesOmittedCount=0;const unsupportedSummaryTokens:string[]=[];
      for(const issue of issueSink){
        if(!allowedIssueCodes.has(issue.code)||!result.codes.includes(issue.code))continue;
        const index=issue.findingIndex;
        if(index!==undefined&&(!Number.isInteger(index)||index<0||index>5))continue;
        const key=`${index??"report"}:${issue.code}`;if(seenIssues.has(key))continue;seenIssues.add(key);
        const unsupportedTokens=issue.code==="unsupported_identifier_or_date"&&Array.isArray(issue.unsupportedTokens)?[...new Set(issue.unsupportedTokens.filter(token=>typeof token==="string"&&token.length<=100&&/^[\p{L}\p{N}][\p{L}\p{N}._:/-]{2,99}$/u.test(token)&&/\d/.test(token)))].slice(0,12):undefined;
        if(index===undefined){if(reportIssues.length<24)reportIssues.push(issue.code);else reportIssuesOmittedCount++;if(issue.code==="unsupported_identifier_or_date"&&unsupportedTokens)unsupportedSummaryTokens.push(...unsupportedTokens);}
        else if(findingIssues.filter(value=>value.findingIndex===index).length<12)findingIssues.push({findingIndex:index,code:issue.code,...(unsupportedTokens?.length?{unsupportedTokens}:{})});
        else findingIssuesOmittedCount++;
      }
      const diagnosticFeedback={...(findingIssues.length?{findingIssues}:{}),...(reportIssues.length?{reportIssues}:{}),...(findingIssuesOmittedCount?{findingIssuesOmittedCount}:{}),...(reportIssuesOmittedCount?{reportIssuesOmittedCount}:{}),...(unsupportedSummaryTokens.length?{unsupportedSummaryTokens:[...new Set(unsupportedSummaryTokens)].slice(0,12)}:{})};
      const proofFeedback=result.valid?{issues:[],omittedCount:0}:collectReportProofIssues(normalized,investigation.recordMatches??[],s.boundEvidence.entries);
      // Final attempt only: if every remaining issue is tied to specific findings, withhold those
      // findings and re-validate the reduced report as a whole. Nothing that failed a check is shown;
      // withheld findings stay listed with their codes. Missing-evidence findings are never withheld.
      let accepted:InvestigationReportInput=normalized,acceptedValid=result.valid,withheldFindings:NonNullable<typeof investigation.withheldFindings>|undefined;
      if(!result.valid&&investigation.feedback.length>=2&&input.disposition!=="needs_evidence"&&!reportIssues.length&&!reportIssuesOmittedCount&&!findingIssuesOmittedCount&&findingIssues.length&&!proofFeedback.issues.length){
        const flagged=new Set(findingIssues.map(issue=>issue.findingIndex));
        const kept=normalized.findings.filter((_,index)=>!flagged.has(index));
        const withheld=normalized.findings.flatMap((finding,index)=>flagged.has(index)?[{kind:finding.kind,summary:finding.summary,codes:[...new Set(findingIssues.filter(issue=>issue.findingIndex===index).map(issue=>issue.code))]}]:[]);
        if(kept.length&&!withheld.some(finding=>finding.kind==="missing_evidence")){
          const reduced={...normalized,findings:kept};
          const recheck=validateInvestigationReport(s.boundEvidence,investigation.selections.map(x=>x.sourceId),reduced,{runId,question:s.investigationQuestion,recordMatches:investigation.recordMatches,serverRecordFindings});
          if(recheck.valid&&investigation.selections.length){accepted=reduced;acceptedValid=true;withheldFindings=withheld;}
        }
      }
      investigation.feedback.push({at:now(),codes:result.codes,...diagnosticFeedback,...(proofFeedback.issues.length?{proofIssues:proofFeedback.issues,proofIssuesOmittedCount:proofFeedback.omittedCount}:{})});
      s.agentRun.events.push({at:now(),tool:result.valid?"investigation.evidence_checked":"investigation.feedback",message:JSON.stringify({disposition:input.disposition,codes:result.codes,verificationScope:"exact quote binding and bounded text/record support checks; arbitrary interpretation unverified",questionOrigin:question.origin})});
      if(withheldFindings)s.agentRun.events.push({at:now(),tool:"investigation.partially_verified",message:JSON.stringify({acceptedFindings:accepted.findings.length,withheldFindings:withheldFindings.map(finding=>({kind:finding.kind,codes:finding.codes})),verificationScope:"reduced report re-validated in full; withheld findings are not shown as accepted"})});
      if(acceptedValid){investigation.withheldFindings=withheldFindings;investigation.recordCitationMode=input.recordCitationMode;investigation.recordReceiptIds=input.recordReceiptIds?structuredClone(input.recordReceiptIds):undefined;investigation.findings=[...structuredClone(accepted.findings),...(serverRecordFindings?buildServerRecordFindings(investigation.recordMatches??[],s.boundEvidence.entries):[])];investigation.summary=input.summary;investigation.disposition=input.disposition;investigation.question=question.question;
        if(input.disposition!=="plan"){s.agentRun.summary=input.summary+(question.question?`\nEvidence needed: ${question.question}`:"");s.agentRun.status=input.disposition==="needs_evidence"?"blocked":"complete";this.event(s,"investigation.reported",withheldFindings?`Partially verified investigation recorded: ${withheldFindings.length} finding(s) failed validation and were withheld; the remaining report was re-validated. Interpretations remain model findings.`:"Evidence investigation recorded; quoted source binding checked, interpretations remain model findings.");}}
      else {
        const preliminaryRequests=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
        if(investigation.disposition===null&&investigation.feedback.length>=3){
          const error="Report validation budget exhausted; no findings or plan were accepted.";
          s.agentRun.summary=error;s.agentRun.error=error;s.agentRun.status="failed";
          this.event(s,"investigation.failed","Report validation budget exhausted; no findings, evidence question, or plan was accepted. No action approval was performed.");
        }
      }
      s.revision++;await this.save(s);return {...result,...diagnosticFeedback,...(proofFeedback.issues.length?{proofIssues:proofFeedback.issues,proofIssuesOmittedCount:proofFeedback.omittedCount}:{}),operatorQuestion:question.question??null,verificationScope:"exact quote binding and bounded text/record support checks; arbitrary interpretation unverified",valid:acceptedValid,...(withheldFindings?{partiallyVerified:true,withheldFindingCount:withheldFindings.length}:{}),endsInvestigation:acceptedValid&&input.disposition!=="plan",next:acceptedValid&&input.disposition==="plan"?"Reuse any existing run-bound stock:all and constraints reads; read only whichever required key is missing, then solve, validate and prepare. Deterministic tools remain authoritative.":null};
    });
  }
  async bindInvestigationHistory(runId:string,history:{decisions:unknown[];nextInvestigationQuestion:string}) {
    return this.locked(async()=>{const s=await this.load();this.assertRun(s,runId);
      const applicable=history.decisions.filter(value=>!!value&&typeof value==="object"&&(value as {status?:unknown}).status==="applied");
      const included=applicable.filter(value=>Buffer.byteLength(JSON.stringify(value))<=6000).slice(0,3);
      const bound={decisions:structuredClone(included),nextInvestigationQuestion:included.length&&history.nextInvestigationQuestion.length<=1000?history.nextInvestigationQuestion:"No applicable prior resolution; inspect current sources.",totalAppliedDecisions:applicable.length,omittedDecisionCount:applicable.length-included.length};
      if(s.agentRun.investigationHistory){if(digest(s.agentRun.investigationHistory)!==digest(bound))throw new WorkspaceError("The advisory history is already bound for this run.");return;}
      if(s.agentRun.events.some(event=>event.tool==="model.request.started"))throw new WorkspaceError("Advisory history must bind before the first model request.");
      s.agentRun.investigationHistory=bound;s.agentRun.events.push({at:now(),tool:"memory.context.bound",message:JSON.stringify({includedDecisions:included.length,totalAppliedDecisions:applicable.length,omittedDecisions:bound.omittedDecisionCount,advisoryOnly:true})});s.revision++;await this.save(s);
    });
  }
  async recordInvestigationObservation(runId:string,tool:"what_if"|"recall_history",result:unknown) {
    return this.locked(async()=>{const s=await this.load();this.assertRun(s,runId);if(!["what_if","recall_history"].includes(tool))throw new WorkspaceError("Unsupported preliminary observation.",400);
      const snapshot=this.investigationSnapshot(s,runId),encoded=JSON.stringify(result),bytes=Buffer.byteLength(encoded);
      const observation={tool,at:now(),snapshotHash:fingerprintSnapshot(snapshot),bytes,resultHash:digest(result),...(bytes<=8000?{result:structuredClone(result)}:{omitted:true as const,reason:"observation_size"})};
      const observations=[...(s.agentRun.investigationObservations??[]),observation];s.agentRun.investigationObservationOmittedCount=(s.agentRun.investigationObservationOmittedCount??0)+Math.max(0,observations.length-2);s.agentRun.investigationObservations=observations.slice(-2);
      s.agentRun.events.push({at:now(),tool:"investigation.observation",message:JSON.stringify({tool,bytes,retained:bytes<=8000,snapshotHash:observation.snapshotHash,runOnly:true})});s.revision++;await this.save(s);
    });
  }
  private hasCanonicalDocumentarySelection(s:Saved,runId:string,snapshotHash:string):boolean {
    const investigation=s.agentRun.investigation,registry=s.boundEvidence;
    if(!investigation||investigation.runId!==runId||investigation.snapshotHash!==snapshotHash||!registry||registry.snapshotHash!==snapshotHash)return false;
    const snapshot=this.investigationSnapshot(s,runId);
    const operationalIds=new Set([...snapshot.inventory.map(row=>row.id),...snapshot.demands.map(row=>row.id),...snapshot.routes.map(row=>row.id),...snapshot.shipments.map(row=>row.id),...snapshot.catalog.map(row=>row.internalSku)]);
    return investigation.selections.some(selection=>{
      if(operationalIds.has(selection.sourceId))return false;
      const entry=registry.entries.find(candidate=>candidate.id===selection.sourceId);
      return !!entry&&entry.sourceHash===selection.sourceHash&&entry.snapshotHash===snapshotHash;
    });
  }
  private assertOperationalReadAllowed(s:Saved,runId:string,snapshotHash:string):void {
    const investigation=s.agentRun.investigation;
    if(!investigation||investigation.runId!==runId||investigation.snapshotHash!==snapshotHash||!this.hasCanonicalDocumentarySelection(s,runId,snapshotHash))throw new WorkspaceError("Inspect a canonical documentary source from this run before reading operational records.");
    if(investigation.disposition==="plan")return;
    if(investigation.disposition!==null)throw new WorkspaceError("Operational reads are unavailable after a non-planning disposition.");
    const requests=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
    if(requests<1||investigation.reportRequest)throw new WorkspaceError("Preliminary operational reads require an inspected source before report.");
  }
  private currentBoundOperationalReads(s:Saved,runId:string):BoundOperationalRead[] {
    const snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
    const reads=s.agentRun.boundOperationalReads??[];
    if(!Array.isArray(reads)||reads.length>5)throw new WorkspaceError("Operational read receipts are invalid.");
    const keys=new Set<string>();
    for(const read of reads){
      if(!read||typeof read!=="object")throw new WorkspaceError("An operational read receipt is invalid or stale.");
      let expectedKey="";
      if(read.tool==="investigate_stock"){
        if(!read.args||typeof read.args!=="object"||!("siteId" in read.args)||Object.keys(read.args).length!==1)throw new WorkspaceError("A stock read receipt has invalid arguments.");
        const siteId=(read.args as {siteId?:unknown}).siteId;
        if(siteId!==null&&siteId!=="A"&&siteId!=="B"&&siteId!=="C")throw new WorkspaceError("A stock read receipt has invalid arguments.");
        expectedKey=siteId?`stock:${siteId}`:"stock:all";
      }else if(read.tool==="fetch_constraints"){
        if(!read.args||typeof read.args!=="object"||Object.keys(read.args).length!==0)throw new WorkspaceError("A constraint read receipt has invalid arguments.");
        expectedKey="constraints";
      }
      const encoded=JSON.stringify(read.result);
      if(read.runId!==runId||read.snapshotHash!==snapshotHash||!read.key||keys.has(read.key)||read.key!==expectedKey||!encoded||Buffer.byteLength(encoded)!==read.bytes||read.bytes>16_000||digest(read.result)!==read.resultHash){
        throw new WorkspaceError("An operational read receipt is invalid or stale.");
      }
      if(read.tool!=="investigate_stock"&&read.tool!=="fetch_constraints")throw new WorkspaceError("An operational read receipt has an unsupported tool.");
      if(read.key==="constraints"&&(read.tool!=="fetch_constraints"||Object.keys(read.args).length!==0))throw new WorkspaceError("A constraint read receipt has invalid arguments.");
      if(read.key.startsWith("stock:")&&read.tool!=="investigate_stock")throw new WorkspaceError("A stock read receipt has an invalid tool.");
      keys.add(read.key);
    }
    return structuredClone(reads);
  }
  private assertPlanningDispositionAndReadProofs(s:Saved,runId:string):void {
    const investigation=s.agentRun.investigation,snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
    if(!investigation||investigation.disposition!=="plan"||!this.hasCanonicalDocumentarySelection(s,runId,snapshotHash))throw new WorkspaceError("An accepted source-backed planning handoff is required before calculation.");
    if(!this.hasFullOperationalReadProofs(s,runId))throw new WorkspaceError("Full bound stock and constraint reads are required before calculation.");
  }
  private hasPlanningReadiness(s:Saved,runId:string):boolean {
    const investigation=s.agentRun.investigation,snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
    if(!investigation||investigation.disposition!=="plan"||!this.hasCanonicalDocumentarySelection(s,runId,snapshotHash))return false;
    return this.hasFullOperationalReadProofs(s,runId);
  }
  private hasFullOperationalReadProofs(s:Saved,runId:string):boolean {
    const reads=this.currentBoundOperationalReads(s,runId);
    return reads.some(read=>read.key==="stock:all")&&reads.some(read=>read.key==="constraints");
  }
  private saveBoundOperationalRead(s:Saved,runId:string,snapshotHash:string,key:BoundOperationalRead["key"],tool:BoundOperationalRead["tool"],args:BoundOperationalRead["args"],result:unknown):BoundOperationalRead {
    const encoded=JSON.stringify(result);
    if(encoded===undefined)throw new WorkspaceError("Operational read result could not be serialized.");
    // Persist exactly the JSON value that was sized and hashed. This strips
    // undefined object properties consistently before returning a receipt.
    const persistedResult=JSON.parse(encoded) as unknown;
    const bytes=Buffer.byteLength(encoded),resultHash=digest(persistedResult);
    if(bytes>16_000)throw new WorkspaceError("Operational read exceeds the 16000-byte result limit; no read receipt was recorded.",413);
    const reads=this.currentBoundOperationalReads(s,runId),existing=reads.find(read=>read.key===key);
    if(existing){
      if(existing.tool!==tool||existing.snapshotHash!==snapshotHash||existing.resultHash!==resultHash||JSON.stringify(existing.args)!==JSON.stringify(args))throw new WorkspaceError("A different operational read already occupies this run-bound key.");
      return structuredClone(existing);
    }
    if(reads.length>=5)throw new WorkspaceError("The five-key operational read receipt limit was reached.");
    const receipt:BoundOperationalRead={key,tool,runId,snapshotHash,args:structuredClone(args),at:now(),bytes,resultHash,result:structuredClone(persistedResult)};
    s.agentRun.boundOperationalReads=[...reads,receipt];
    s.agentRun.events.push({at:now(),tool:"operational.read.bound",message:JSON.stringify({key,tool,runId,snapshotHash,bytes,resultHash})});
    s.revision++;
    return structuredClone(receipt);
  }
  async readStockEvidence(runId:string,siteId?:"A"|"B"|"C") {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
      this.assertOperationalReadAllowed(s,runId,snapshotHash);
      const args={siteId:siteId??null},key:BoundOperationalRead["key"]=siteId?`stock:${siteId}`:"stock:all";
      const prior=this.currentBoundOperationalReads(s,runId).find(read=>read.key===key);
      if(prior){if(prior.tool!=="investigate_stock"||JSON.stringify(prior.args)!==JSON.stringify(args))throw new WorkspaceError("A different stock read already occupies this run-bound key.");return structuredClone(prior.result);}
      const result=projectStockEvidence(snapshot,assessSnapshot(snapshot),siteId);
      const receipt=this.saveBoundOperationalRead(s,runId,snapshotHash,key,"investigate_stock",args,result);
      await this.save(s);return structuredClone(receipt.result);
    });
  }
  async readConstraintEvidence(runId:string) {
    return this.locked(async()=>{
      const s=await this.load();this.assertRun(s,runId);const snapshot=this.investigationSnapshot(s,runId),snapshotHash=fingerprintSnapshot(snapshot);
      this.assertOperationalReadAllowed(s,runId,snapshotHash);
      const args:Record<string,never>={},prior=this.currentBoundOperationalReads(s,runId).find(read=>read.key==="constraints");
      if(prior){if(prior.tool!=="fetch_constraints"||JSON.stringify(prior.args)!==JSON.stringify(args))throw new WorkspaceError("A different constraint read already occupies this run-bound key.");return structuredClone(prior.result);}
      const result={clock:snapshot.clock,catalog:snapshot.catalog,demands:snapshot.demands,routes:snapshot.routes,targetSku:snapshot.targetSku,recipientSiteId:snapshot.recipientSiteId};
      const receipt=this.saveBoundOperationalRead(s,runId,snapshotHash,"constraints","fetch_constraints",args,result);
      await this.save(s);return structuredClone(receipt.result);
    });
  }
  async getInvestigationContext(runId:string,options:{reportOnly?:boolean}={}) {
    return this.locked(async()=>{const s=await this.load();this.assertRun(s,runId);const investigation=s.agentRun.investigation;
      if(investigation?.disposition!==null||!s.boundEvidence)return {active:false,projection:null};
      const snapshot=this.investigationSnapshot(s,runId);
      const operationalRecordIds=[...snapshot.inventory.map(row=>row.id),...snapshot.demands.map(row=>row.id),...snapshot.routes.map(row=>row.id),...snapshot.shipments.map(row=>row.id),...snapshot.catalog.map(row=>row.internalSku)];
      const operationalRecordFamilies={inventoryLots:snapshot.inventory.length>0,shipments:snapshot.shipments.length>0,siteDemands:snapshot.demands.length>0,routes:snapshot.routes.length>0,catalogItems:snapshot.catalog.length>0};
      const requestsUsed=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
      const operationalReads=this.currentBoundOperationalReads(s,runId);
      const operationalReadsAllowed=investigation.disposition===null&&requestsUsed>=1&&!investigation.reportRequest&&this.hasCanonicalDocumentarySelection(s,runId,fingerprintSnapshot(snapshot));
      const work=this.investigationWork(s,runId);
      const reportOnly=options.reportOnly===true||!!investigation.reportRequest;
      const targetIdentity={runId,snapshotHash:s.boundEvidence.snapshotHash,targetSku:snapshot.targetSku,recallId:snapshot.scope.recallId,manufacturerRef:snapshot.scope.manufacturerRef,catalogMappings:snapshot.catalog.filter(item=>item.internalSku===snapshot.targetSku).map(({internalSku,manufacturerRef,unit})=>({internalSku,manufacturerRef,unit}))};
      return {active:true,projection:projectInvestigationContext({runId,question:s.investigationQuestion??"Investigate current evidence and calculate coverage only if requested.",phaseTask:DOCUMENTARY_PHASE_TASK,targetIdentity,snapshotHash:s.boundEvidence.snapshotHash,registry:s.boundEvidence,investigation,history:s.agentRun.investigationHistory,observations:s.agentRun.investigationObservations,observationOmittedCount:s.agentRun.investigationObservationOmittedCount,requestsUsed,reportOnly,work,operationalRecordIds,operationalRecordFamilies,operationalReads,operationalReadsAllowed})};
    });
  }
  async getOperationsContext(runId:string) {
    return this.locked(async()=>{const s=await this.load();this.assertRun(s,runId);const i=s.agentRun.investigation;if(i?.disposition!=="plan")return null;
      const operationalReads=this.currentBoundOperationalReads(s,runId);
      const requiredReadKeys=["stock:all","constraints"] as const;
      const completedKeys=new Set(operationalReads.map(read=>read.key));
      const missingReadKeys=requiredReadKeys.filter(key=>!completedKeys.has(key));
      const readTools=[...(completedKeys.has("stock:all")?["investigate_stock"]:[]),...(completedKeys.has("constraints")?["fetch_constraints"]:[])];
      return {runId,question:s.investigationQuestion??"Investigate evidence and supply coverage.",snapshotHash:i.snapshotHash,findings:i.findings,disposition:i.disposition,readTools,requiredReadKeys:[...requiredReadKeys],missingReadKeys,operationalReads,plan:s.plan};});
  }
  async checkWhatIf(input:WhatIfInput,runId?:string) {
    return this.locked(async()=>{const s=await this.load();if(runId)this.assertRun(s,runId);const snapshot=await this.snapshot(s,runId);try{return runWhatIf(snapshot,input);}catch(error){throw new WorkspaceError(error instanceof Error?error.message:"Invalid hypothesis.",400);}});
  }
  async getNotice(runId?: string) {
    return this.locked(async () => {const s = await this.load(); if (runId) this.assertRun(s, runId); return this.options.investigationCase ? {documents:this.options.investigationCase.documents,disclosure:"Fictional evaluation case; no default public notice is included."} : (await loadSeed(this.options.root)).evidence;});
  }
  private assertNoReservation(s: Saved) {
    if (s.receipts.some(r => r.incidentId === s.incidentId && r.action === "reserve")) throw new WorkspaceError("This incident already has reserved transfers. Start a new replay incident to explore another scenario; the receipts are retained.");
  }
  async calculatePlan(runId?: string): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load();
      if(runId){this.assertRun(s,runId);this.assertPlanningDispositionAndReadProofs(s,runId);}
      else if(s.agentRun.status==="running")throw new WorkspaceError("A run-bound calculation requires the accepted planning handoff and read receipts.");
      this.assertNoReservation(s); const snapshot = await this.snapshot(s, runId); s.plan = planReplenishment(snapshot); s.revision++;
      if (s.agentRun.status === "running" && s.workflow?.runId === s.agentRun.runId) s.workflow = {runId: s.workflow.runId, solve: null, validation: null, prepared: null};
      this.event(s, "plan.calculated", s.plan.status === "feasible" ? `Checked proposal: ${s.plan.transfers.map(t => `${t.originSiteId}→${t.destinationSiteId} ${t.quantityEa} EA`).join(", ")}; ${s.plan.transportCostPoints} transport points.` : `No feasible proposal: ${s.plan.shortfallEa} EA shortfall.`);
      await this.save(s); return this.workspace(s, snapshot);
    });
  }
  async changeScenario(scenario: Scenario): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load(); this.assertNoReservation(s);
      if(this.options.investigationCase)throw new WorkspaceError("This explicit investigation fixture has a fixed snapshot; replay scenario switches are unavailable.",400);
      if (this.options.liveLoader) throw new WorkspaceError("Scenario controls change bundled replay data only. Change the registered Zetaris source and refresh for a live test.");
      if (s.agentRun.status === "running") throw new WorkspaceError("Wait for the current investigation before changing source data.");
      if (!["on_time", "supplier_late", "qa_missing"].includes(scenario)) throw new WorkspaceError("Unknown replay scenario", 400);
      if (s.scenario !== scenario) {s.scenario = scenario; s.sourceRevision++; s.revision++; this.event(s, "source.changed", `Replay source changed to ${scenario}. Existing proposals need revalidation.`); await this.save(s);}
      return this.workspace(s);
    });
  }
  async reset(): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load();
      if (s.agentRun.status === "running") throw new WorkspaceError("Wait for the current investigation before starting a new incident.");
      s.incidentId = `incident-${randomUUID()}`; s.scenario = "on_time"; s.sourceRevision++; s.plan = null; s.workflow = undefined; s.investigationSnapshot = undefined; s.boundEvidence = undefined; s.agentRun = idleRun(); s.revision++;
      this.event(s, "incident.created", "New replay incident started. Earlier receipts and audit history are retained."); await this.save(s); return this.workspace(s);
    });
  }
  private duplicate(s: Saved, key: string, payload: unknown): boolean {
    if (!key || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new WorkspaceError("A valid idempotency key is required", 400);
    const previous = s.keys[key];
    if (previous && previous.digest !== digest(payload)) throw new WorkspaceError("Idempotency key already belongs to a different action payload.");
    return !!previous;
  }
  async hold(inputFingerprint: string, inventoryIds: string[], key: string): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load(); if (s.agentRun.status === "running") throw new WorkspaceError("Finish or stop the investigation before approving a source-changing action."); const ids = [...new Set(inventoryIds)].sort();
      const payload = {incidentId: s.incidentId, action: "hold", inputFingerprint, inventoryIds: ids};
      if (this.duplicate(s, key, payload)) return this.workspace(s);
      this.assertNoReservation(s);
      const snapshot = await this.snapshot(s); const assessment = assessSnapshot(snapshot);
      if (!assessment.valid || assessment.inputFingerprint !== inputFingerprint) throw new WorkspaceError("Source values changed. Refresh the exposure assessment before applying the hold.");
      const confirmed = new Set(assessment.inventory.filter(r => r.recallMatch.status === "CONFIRMED_MATCH").map(r => r.entityId));
      if (!ids.length || ids.some(id => !confirmed.has(id))) throw new WorkspaceError("Only confirmed recalled inventory can receive this hold.", 400);
      if (ids.some(id => (snapshot.inventory.find(r => r.id === id)?.reservedEa ?? 0) > 0)) throw new WorkspaceError("Recalled stock has an existing reservation. Resolve that conflict before recording this allocation hold.");
      if (ids.every(id => snapshot.inventory.find(r => r.id === id)?.allocationHold)) throw new WorkspaceError("These lots already have an allocation hold.");
      const receipt: ActionReceipt = {id: randomUUID(), incidentId: s.incidentId, action: "hold", at: now(), inventoryIds: ids, transfers: [], semantic: "Sandbox allocation hold saved; physical quarantine remains pending.", inputFingerprint, idempotencyKey: key};
      s.receipts.push(receipt); s.keys[key] = {digest: digest(payload), receiptId: receipt.id}; s.revision++;
      this.event(s, "hold.saved", receipt.semantic); applyReceipt(snapshot, receipt); await this.save(s); return this.workspace(s, snapshot);
    });
  }
  async reserve(planFingerprint: string, key: string): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load(); if (s.agentRun.status === "running") throw new WorkspaceError("Finish or stop the investigation before approving a source-changing action."); const payload = {incidentId: s.incidentId, action: "reserve", planFingerprint};
      if (this.duplicate(s, key, payload)) return this.workspace(s);
      this.assertNoReservation(s);
      if (!s.plan || s.plan.status !== "feasible" || s.plan.planFingerprint !== planFingerprint) throw new WorkspaceError("A current feasible proposal is required.");
      const snapshot = await this.snapshot(s); const validation = validatePlanAgainstSnapshot(s.plan, snapshot, snapshot.clock.analysisAt);
      if (!validation.valid) throw new WorkspaceError(validation.reasons.map(r => r.message).join(" "));
      const receipt: ActionReceipt = {id: randomUUID(), incidentId: s.incidentId, action: "reserve", at: now(), inventoryIds: [], transfers: s.plan.transfers, semantic: "Sandbox lot reservations saved; no dispatch, receipt or delivery has occurred.", inputFingerprint: fingerprintSnapshot(snapshot), idempotencyKey: key};
      s.receipts.push(receipt); s.keys[key] = {digest: digest(payload), receiptId: receipt.id}; s.revision++;
      this.event(s, "reservation.saved", receipt.semantic); applyReceipt(snapshot, receipt); await this.save(s); return this.workspace(s, snapshot);
    });
  }
  async startInvestigation(question?:string): Promise<Workspace> {
    return this.locked(async () => {
      const s = await this.load();
      if (!this.options.model || !this.options.inferenceAllowed) throw new WorkspaceError("Verified model configuration and explicit inference authorization are required.", 403);
      if (s.agentRun.status === "running") throw new WorkspaceError("An investigation is already running.");
      const snapshot = await this.snapshot(s);
      s.investigationQuestion = this.options.investigationCase?.question ?? question;
      s.agentRun = {status: "running", summary: "", events: [], model: this.options.model, runId: randomUUID(), incidentId: s.incidentId};
      s.investigationSnapshot = {runId: s.agentRun.runId!, sourceRevision: s.sourceRevision, overlayHash: digest(s.receipts.filter(r => r.incidentId === s.incidentId)), snapshot: structuredClone(snapshot)};
      const notice = (await loadSeed(this.options.root)).evidence;
      s.boundEvidence = buildEvidenceRegistry(snapshot, notice, this.options.investigationCase?.documents);
      s.agentRun.investigation = {runId:s.agentRun.runId!,snapshotHash:fingerprintSnapshot(snapshot),selections:[],findings:[],feedback:[],disposition:null,summary:""};
      s.workflow = {runId: s.agentRun.runId!, solve: null, validation: null, prepared: null};
      s.agentRun.events.push({at: now(), tool: "source.snapshot", message: JSON.stringify({snapshotHash: fingerprintSnapshot(snapshot), sourceVersions: snapshot.sourceVersions, immutableForRun: true, sourceRead: snapshot.sourceRead ?? null})}); s.revision++; await this.save(s); return this.workspace(s, snapshot);
    });
  }
  private assertRun(s: Saved, runId: string): void {
    if (s.agentRun.status !== "running" || s.agentRun.runId !== runId || s.agentRun.incidentId !== s.incidentId) throw new WorkspaceError("This investigation is no longer active.");
  }
  async trace(runId: string, tool: string, message: string): Promise<void> {
    await this.locked(async () => {
      if(tool==="model.request.started"||tool==="model.report.request.started"||tool==="model.report.retry.request.started"||tool==="investigation.report.requested"||tool==="investigation.report.format_failure")throw new WorkspaceError("Reserved workflow proof events can only be written by their typed store methods.");
      const s = await this.load(); this.assertRun(s, runId); s.agentRun.events.push({at: now(), tool, message}); s.revision++; await this.save(s);
    });
  }
  async finishInvestigation(runId: string, summary: string, error?: string): Promise<void> {
    await this.locked(async () => {
      const s = await this.load();
      if (s.agentRun.status !== "running" || s.agentRun.runId !== runId || s.agentRun.incidentId !== s.incidentId) return;
      const terminalClaimsExpected = s.agentRun.investigation?.disposition === "plan" ||
        s.agentRun.events.some(event => event.tool === "claims.finalization.started");
      const finalError = error || (terminalClaimsExpected &&
        (s.agentRun.claimAudit?.status !== "verified" || s.agentRun.claimAudit.result.valid !== true)
        ? "Terminal claims were not verified; the planning investigation did not complete." : undefined);
      s.agentRun.summary = summary; s.agentRun.status = finalError ? "failed" : "complete"; if (finalError) s.agentRun.error = finalError;
      s.revision++; this.event(s, finalError ? "investigation.failed" : "investigation.completed", finalError ? "Investigation stopped; no action approval was performed." : "Investigation completed; proposals still need explicit approval."); await this.save(s);
    });
  }
  async claimFinalization(runId: string, raw = ""): Promise<boolean> {
    return this.locked(async () => {
      const s = await this.load();
      if (s.agentRun.status !== "running" || s.agentRun.runId !== runId || s.agentRun.incidentId !== s.incidentId) return false;
      if (s.agentRun.events.some(event => event.tool === "claims.finalization.started")) return false;
      if (!this.workflowPrepared(s, runId)) {
        const message = "Terminal claims arrived before the trusted workflow was prepared; no claims were verified.";
        const result: ClaimCheckResult = {valid: false, feedbackCodes: ["CLAIM_MISMATCH"]};
        s.agentRun.claimAudit = {status: "unverified", rawAttempts: [raw.slice(0, 48_000)], result};
        s.agentRun.summary = "The investigation did not complete its required evidence and planning checkpoints. Use the deterministic exposure and plan tables.";
        s.agentRun.error = message;
        s.agentRun.status = "failed";
        s.agentRun.events.push({at: now(), tool: "claims.unverified", message}, {at: now(), tool: "investigation.failed", message});
        s.revision++; this.event(s, "investigation.failed", message); await this.save(s);
        return false;
      }
      const priorAttempts = s.agentRun.claimAudit?.rawAttempts ?? [];
      const boundedRaw = raw.slice(0, 48_000);
      const rawAttempts = priorAttempts.at(-1) === boundedRaw ? priorAttempts : [...priorAttempts, boundedRaw];
      s.agentRun.claimAudit = {status: "unverified", rawAttempts: rawAttempts.slice(-2), result: {valid: false, feedbackCodes: []}};
      s.agentRun.events.push({at: now(), tool: "claims.finalization.started", message: "Claim finalization claimed once for this investigation. An interrupted finalization must be stopped and restarted."});
      s.revision++; await this.save(s); return true;
    });
  }
  /** Fail closed if a successful Eve turn ended without a terminal assistant message. */
  async failUnfinalizedTurn(runId: string): Promise<boolean> {
    return this.locked(async () => {
      const s = await this.load();
      if (s.agentRun.status !== "running" || s.agentRun.runId !== runId || s.agentRun.incidentId !== s.incidentId) return false;
      if (s.agentRun.events.some(event => event.tool === "claims.finalization.started")) return false;
      const message = "The model turn ended without a verifiable terminal response.";
      const result: ClaimCheckResult = {valid: false, feedbackCodes: ["MALFORMED_RESPONSE"]};
      const rawAttempts = s.agentRun.claimAudit?.rawAttempts;
      s.agentRun.claimAudit = {status: "unverified", rawAttempts: rawAttempts?.length ? rawAttempts : [""], result};
      s.agentRun.summary = message;
      s.agentRun.error = message;
      s.agentRun.status = "failed";
      s.agentRun.events.push(
        {at: now(), tool: "claims.unverified", message: "The turn completed without a terminal assistant response; no claims were verified."},
        {at: now(), tool: "investigation.failed", message},
      );
      s.revision++;
      this.event(s, "investigation.failed", message);
      await this.save(s);
      return true;
    });
  }
  async recordClaimAudit(runId: string, rawAttempts: string[], result: ClaimCheckResult): Promise<void> {
    await this.locked(async () => {
      const s = await this.load(); this.assertRun(s, runId);
      const durable = s.agentRun.claimAudit?.rawAttempts ?? [];
      const supplied = rawAttempts.map(text => text.slice(0, 48_000));
      const isPrefix = (prefix: string[], values: string[]) => prefix.length <= values.length && prefix.every((value, index) => value === values[index]);
      const merged = isPrefix(durable, supplied) ? supplied : isPrefix(supplied, durable) ? durable : [...durable, ...supplied];
      s.agentRun.claimAudit = {status: result.valid ? "verified" : "unverified", rawAttempts: merged.slice(-2), result};
      s.agentRun.events.push({at: now(), tool: result.valid ? "claims.verified" : "claims.unverified", message: result.valid ? "Typed counts, allocations, time and citations match this investigation snapshot. Raw model text remains audit material." : `Claim check failed: ${result.feedbackCodes.join(", ")}. No verified narrative is available.`});
      s.revision++; await this.save(s);
    });
  }
  async cancelInvestigation(runId: string): Promise<Workspace> {
    await this.finishInvestigation(runId, "Investigation stopped by the operator.", "Stopped or recovered after interruption.");
    return this.getWorkspace();
  }
  async activeInvestigation() {return this.locked(async () => {const s = await this.load(); return {incidentId: s.incidentId, agentRun: s.agentRun};});}
  async claimModelCall(runId: string, options?: {reportTransportRetry?: {reportRequestNumber:number}}): Promise<ModelCallBudget> {
    return this.locked(async () => {
      const s = await this.load(); this.assertRun(s, runId);
      if (s.agentRun.events.filter(e => e.tool === "model.request.started").length >= 12) {
        const stage=s.agentRun.investigation?.disposition===null?this.investigationWork(s,runId).readiness.stage:"workflow";
        const error=`Investigation reached its 12-request limit with unfinished ${stage} work. No missing-evidence disposition was inferred.`;
        s.agentRun.status="failed";s.agentRun.error=error;s.agentRun.summary=error;this.event(s,"investigation.unfinished",error);s.revision++;await this.save(s);throw new WorkspaceError(error);
      }
      const repairIndex = s.agentRun.events.findIndex(event => event.tool === "claims.repair.requested");
      const repairing = repairIndex >= 0;
      const planningReady = this.hasPlanningReadiness(s,runId);
      const prepared = planningReady && this.workflowPrepared(s, runId);
      if (repairing && !prepared) throw new WorkspaceError("A terminal repair request is only permitted after the trusted workflow is prepared.");
      if (repairing && s.agentRun.events.slice(repairIndex + 1).some(event => event.tool === "model.request.started")) throw new WorkspaceError("The single repair request budget has already been used.");
      let phase: ModelCallBudget["phase"] = "investigation";
      let requiredTool: ModelCallBudget["requiredTool"] = null;
      let reportRequestNumber:number|undefined;
      if (prepared) phase = repairing ? "repair" : "terminal";
      else if (planningReady && this.workflowValidated(s, runId)) {phase = "prepare"; requiredTool = "prepare_actions";}
      else if (planningReady && this.workflowSolved(s, runId)) {phase = "validate"; requiredTool = "validate_plan";}
      else if (planningReady) {phase = "solve"; requiredTool = "solve_plan";}
      if(options?.reportTransportRetry && (phase!=="investigation" || s.agentRun.investigation?.disposition!==null))throw new WorkspaceError("A report transport retry requires an active preliminary investigation.");
      if(phase==="investigation" && s.agentRun.investigation?.disposition===null){
        const requests=s.agentRun.events.filter(event=>event.tool==="model.request.started").length;
        const work=this.investigationWork(s,runId);
        const reportRequests=s.agentRun.events.filter(event=>event.tool==="model.report.request.started").length;
        if(work.readiness.stage==="unsupported"){
          const error=work.readiness.matchingSupport.startsWith("unsupported_")?"The supplied sources cannot establish a fitting supported product/lot/manufacture-date record comparison. This is an unsupported extraction or comparison capability, not missing operator evidence.":"Evidence retrieval is unsupported for an indivisible source unit; no complete report packet is available.";
          s.agentRun.status="failed";s.agentRun.error=error;s.agentRun.summary=error;
          this.event(s,"investigation.unfinished",JSON.stringify({stage:work.readiness.stage,unavailableSections:work.readiness.unavailableSections}));s.revision++;await this.save(s);throw new WorkspaceError(error);
        }
        const reportOnly=work.readiness.reportReady&&!!s.agentRun.investigation.reportRequest;
        if(options?.reportTransportRetry && !reportOnly)throw new WorkspaceError("A report transport retry requires the current report-only request.");
        if(reportOnly){
          if(options?.reportTransportRetry){
            const events=s.agentRun.events;
            const reverseReportIndex=[...events].reverse().findIndex(event=>event.tool==="model.report.request.started");
            const lastReport=reverseReportIndex<0?-1:events.length-1-reverseReportIndex;
            const sinceReport=events.slice(lastReport+1);
            const claim=[...sinceReport].reverse().find(event=>event.tool==="model.http.retry.budget_claiming");
            let evidence:unknown;try{evidence=claim?JSON.parse(claim.message):null;}catch{evidence=null;}
            const detail=evidence && typeof evidence==="object" ? evidence as Record<string,unknown> : {};
            const upstream=detail.upstreamFailure && typeof detail.upstreamFailure==="object" ? detail.upstreamFailure as Record<string,unknown> : {};
            if(lastReport<0 || options.reportTransportRetry.reportRequestNumber!==reportRequests || detail.reportRequestNumber!==reportRequests || sinceReport.filter(event=>event.tool==="model.request.started").length!==1 || sinceReport.some(event=>event.tool==="model.report.retry.request.started") || detail.retryReason!=="provider_declared_empty_upstream_response" || typeof detail.httpStatus!=="number" || detail.httpStatus<500 || detail.httpStatus>599 || upstream.category!=="empty_upstream_response")throw new WorkspaceError("A single provider-declared empty report transport retry must follow its claimed report request.");
            s.agentRun.events.push({at:now(),tool:"model.report.retry.request.started",message:JSON.stringify({runId,snapshotHash:s.agentRun.investigation.snapshotHash,reportRequestCount:reportRequests})});
          }else if(reportRequests>=3){
            const error="Report request budget exhausted; no findings or plan were accepted.";
            s.agentRun.summary=error;s.agentRun.error=error;s.agentRun.status="failed";
            this.event(s,"investigation.failed","Three report-only requests were used without an accepted report. No findings, question, plan or action approval were assumed.");
            s.revision++;await this.save(s);throw new WorkspaceError(error);
          }
          phase="investigation_report";requiredTool="report_investigation";
          reportRequestNumber=options?.reportTransportRetry?reportRequests:reportRequests+1;
          if(!options?.reportTransportRetry)s.agentRun.events.push({at:now(),tool:"model.report.request.started",message:JSON.stringify({runId,snapshotHash:s.agentRun.investigation.snapshotHash,reportRequestCount:reportRequests+1})});
        }else if(work.readiness.stage==="inspect"&&((s.boundEvidence?.entries.length??0)<=60||s.agentRun.investigation.selections.length>0||requests>=3)) {phase="investigation_inspect";requiredTool="inspect_evidence";}
        else if(work.readiness.stage==="retrieve")requiredTool="read_evidence_sections";
        else if(work.readiness.stage==="match")requiredTool="match_records";
        else if(work.readiness.reportReady&&work.readiness.matchingRequired)requiredTool="request_investigation_report";
      }
      const terminal = prepared;
      // A larger per-request ceiling is available only for still-preliminary,
      // report-eligible turns after at least one source was actually inspected
      // into this run's bound evidence. It is only a requested model ceiling;
      // it does not reserve the Eve session's cumulative output budget or
      // guarantee that the provider will spend or return that many tokens.
      const investigation = s.agentRun.investigation;
      const reportEligible = investigation?.disposition === null && investigation.selections.length > 0 &&
        (phase === "investigation_report" || requiredTool === "match_records");
      const maxOutputTokens = reportEligible && phase === "investigation_report" ? 16384 : reportEligible ? 8192 : 4096;
      s.agentRun.events.push({at: now(), tool: "model.request.started", message: `Started one bounded model request (maximum ${maxOutputTokens} output tokens; separate from the Eve session limit).`}); s.revision++; await this.save(s);
      return {maxOutputTokens, phase, requiredTool, terminal, repair: repairing,...(reportRequestNumber===undefined?{}:{reportRequestNumber})};
    });
  }
  async recordWorkflowCheckpoint(runId: string, stage: WorkflowStage): Promise<WorkflowCheckpoint> {
    return this.locked(async () => {
      const s = await this.load(); this.assertRun(s, runId);
      this.assertPlanningDispositionAndReadProofs(s,runId);
      const binding = this.currentWorkflowBinding(s, runId);
      if (!binding) throw new WorkspaceError("The persisted plan does not match this investigation snapshot.");
      const workflow = s.workflow?.runId === runId ? s.workflow : {runId, solve: null, validation: null, prepared: null};
      if (stage === "solve_plan") {
        if (!this.currentBoundOperationalReads(s,runId).some(read=>read.key==="stock:all") || !this.currentBoundOperationalReads(s,runId).some(read=>read.key==="constraints")) throw new WorkspaceError("Full bound stock and constraint reads must be captured before solving.");
        workflow.solve = binding; workflow.validation = null; workflow.prepared = null;
      } else if (stage === "validate_plan") {
        if (!workflow.solve || !this.sameWorkflowBinding(workflow.solve, binding)) throw new WorkspaceError("The latest plan must be solved for this snapshot before validation.");
        const validation = s.plan?.status === "feasible" ? validatePlanAgainstSnapshot(s.plan, this.investigationSnapshot(s, runId), this.investigationSnapshot(s, runId).clock.analysisAt) : {valid: false};
        workflow.validation = {...binding, valid: validation.valid}; workflow.prepared = null;
      } else {
        if (!workflow.validation || !this.sameWorkflowBinding(workflow.validation, binding)) throw new WorkspaceError("The latest plan must be validated for this snapshot before preparation.");
        workflow.prepared = binding;
      }
      s.workflow = workflow;
      const result: WorkflowCheckpoint = {...binding, ...(stage === "validate_plan" ? {valid: workflow.validation!.valid} : {})};
      s.agentRun.events.push({at: now(), tool: `workflow.${stage}`, message: JSON.stringify(result)});
      s.revision++; await this.save(s); return result;
    });
  }
  private investigationSnapshot(s: Saved, runId: string): Snapshot {
    const snapshot = s.investigationSnapshot;
    if (!snapshot || snapshot.runId !== runId || snapshot.sourceRevision !== s.sourceRevision || snapshot.overlayHash !== digest(s.receipts.filter(r => r.incidentId === s.incidentId))) throw new WorkspaceError("Investigation snapshot was invalidated; start a fresh investigation.");
    return snapshot.snapshot;
  }
  private currentWorkflowBinding(s: Saved, runId: string): WorkflowBinding | null {
    const snapshot = this.investigationSnapshot(s, runId);
    if (!s.plan) return null;
    const snapshotHash = fingerprintSnapshot(snapshot);
    if (s.plan.inputFingerprint !== snapshotHash) return null;
    return {snapshotHash, planFingerprint: s.plan.status === "feasible" ? s.plan.planFingerprint : fingerprint(s.plan), planStatus: s.plan.status};
  }
  private sameWorkflowBinding(a: WorkflowBinding, b: WorkflowBinding): boolean {
    return a.snapshotHash === b.snapshotHash && a.planFingerprint === b.planFingerprint && a.planStatus === b.planStatus;
  }
  private workflowSolved(s: Saved, runId: string): boolean {
    if(!this.hasPlanningReadiness(s,runId))return false;
    const current = this.currentWorkflowBinding(s, runId);
    return !!current && s.workflow?.runId === runId && !!s.workflow.solve && this.sameWorkflowBinding(s.workflow.solve, current);
  }
  private workflowValidated(s: Saved, runId: string): boolean {
    if(!this.hasPlanningReadiness(s,runId))return false;
    const current = this.currentWorkflowBinding(s, runId);
    return !!current && s.workflow?.runId === runId && !!s.workflow.solve && this.sameWorkflowBinding(s.workflow.solve, current) && !!s.workflow.validation && this.sameWorkflowBinding(s.workflow.validation, current);
  }
  private workflowPrepared(s: Saved, runId: string): boolean {
    if(!this.hasPlanningReadiness(s,runId))return false;
    const current = this.currentWorkflowBinding(s, runId);
    return this.workflowValidated(s, runId) && !!current && s.workflow?.runId === runId && !!s.workflow.prepared && this.sameWorkflowBinding(s.workflow.prepared, current);
  }
  /** Read-only terminal context from the active run's pinned snapshot and prepared deterministic plan. */
  async getPreparedTerminalProjection(runId: string): Promise<TerminalProjection> {
    return this.locked(async () => {
      const s = await this.load(); this.assertRun(s, runId);
      if (!this.workflowPrepared(s, runId) || !s.plan) throw new WorkspaceError("A current prepared plan is required for terminal projection.");
      if (s.plan.status === "feasible" && s.workflow?.validation?.valid !== true) throw new WorkspaceError("The feasible plan did not pass trusted independent validation.");
      const snapshot = this.investigationSnapshot(s, runId);
      const repairRequested = s.agentRun.events.some(event => event.tool === "claims.repair.requested");
      const repairFeedback: ClaimFeedbackCode[] = repairRequested
        ? (s.agentRun.claimAudit?.result.feedbackCodes ?? []).filter((code): code is ClaimFeedbackCode => ["MALFORMED_RESPONSE", "MISSING_CITATIONS", "UNKNOWN_CITATION", "IRRELEVANT_CITATION", "STALE_SNAPSHOT", "STALE_PLAN", "PLAN_MISMATCH", "CLAIM_MISMATCH"].includes(code))
        : [];
      return structuredClone(projectTerminalClaims(snapshot, s.plan, repairFeedback));
    });
  }
  /** Persist the exact terminal tool arguments before any schema parsing or transport normalization. */
  async recordTerminalAttempt(runId: string, rawArguments: string, expectedBindings: {snapshotHash: string; planFingerprint: string}): Promise<{recorded: true; attemptCount: number}> {
    return this.locked(async () => {
      const s = await this.load(); this.assertRun(s, runId);
      if (!this.workflowPrepared(s, runId) || !s.plan) throw new WorkspaceError("A current prepared plan is required to record terminal claims.");
      this.investigationSnapshot(s, runId);
      const binding = this.currentWorkflowBinding(s, runId);
      if (!binding || binding.snapshotHash !== expectedBindings.snapshotHash || binding.planFingerprint !== expectedBindings.planFingerprint) throw new WorkspaceError("Terminal claims were produced for a different prepared plan.");
      const current = s.agentRun.claimAudit?.rawAttempts ?? [];
      const bounded = rawArguments.slice(0, 48_000);
      const next = [...current, bounded];
      s.agentRun.claimAudit = {
        status: s.agentRun.claimAudit?.status ?? "unverified",
        rawAttempts: next.slice(-2),
        result: s.agentRun.claimAudit?.result ?? {valid: false, feedbackCodes: []},
      };
      s.revision++;
      await this.save(s);
      return {recorded: true, attemptCount: s.agentRun.claimAudit.rawAttempts.length};
    });
  }
  async receiptLedger() {return this.locked(async () => {const s = await this.load(); return {incidentId: s.incidentId, receipts: s.receipts, audit: s.audit};});}
  async memoryAudit(message: string, runId?: string): Promise<void> {
    await this.locked(async () => {const s = await this.load(); if (runId) this.assertRun(s, runId); this.event(s, "meterless.hmem", message); s.revision++; await this.save(s);});
  }
}
