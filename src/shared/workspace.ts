import type {EvidenceRegistry, InvestigationRecord} from "./investigation.ts";
import type { ResolutionResult } from "../memory/index.ts";
import type { ClaimCheckResult } from "../domain/claims.ts";
import type { Snapshot, SnapshotAssessment, PlanResult, Transfer } from "../domain/types.ts";

export type Scenario = "on_time" | "supplier_late" | "qa_missing";
export interface EvidenceSource { id: string; title: string; url: string; }
export interface ActionReceipt {
  id: string; incidentId: string; action: "hold" | "reserve"; at: string;
  inventoryIds: string[]; transfers: Transfer[]; semantic: string;
  inputFingerprint: string; idempotencyKey: string;
}
export interface AuditEvent { id: string; at: string; type: string; message: string; }
export interface IntegrationStatus { configured: boolean; verified: boolean; status: string; detail: string; }
export interface BoundOperationalRead {
  key: "stock:all" | "stock:A" | "stock:B" | "stock:C" | "constraints";
  tool: "investigate_stock" | "fetch_constraints";
  runId: string;
  snapshotHash: string;
  args: {siteId: "A" | "B" | "C" | null} | Record<string, never>;
  at: string;
  bytes: number;
  resultHash: string;
  result: unknown;
}
export interface AgentRun {
  investigation?: InvestigationRecord;
  boundOperationalReads?: BoundOperationalRead[];
  investigationObservations?: Array<{tool:string;at:string;snapshotHash:string;bytes:number;resultHash?:string;result?:unknown;omitted?:true;reason?:string}>;
  investigationObservationOmittedCount?:number;
  investigationHistory?: {decisions:unknown[];nextInvestigationQuestion:string;totalAppliedDecisions:number;omittedDecisionCount:number};
  claimAudit?: {status: "verified" | "unverified"; rawAttempts: string[]; result: ClaimCheckResult};
  status: "idle" | "running" | "complete" | "failed" | "blocked";
  summary: string; events: Array<{at: string; tool: string; message: string}>;
  model: string | null; error?: string; runId: string | null; incidentId: string | null;
}
export interface Workspace {
  evaluation?: {caseId:string|null;memoryMode:"on"|"off"};
  evidenceRegistry?: EvidenceRegistry;
  investigationEvidence?: EvidenceRegistry;
  resolutionMemory?: ResolutionResult & {sourceHash: string; sourceRefs: string[]};
  revision: number; incidentId: string; scenario: Scenario; dataMode: "replay" | "live";
  disclosure: string; clock: Snapshot["clock"];
  recall: {
    id: string; title: string; reference: string; affectedLots: string[];
    sources: EvidenceSource[];
    conflict: { observed: string; canonical: string; explanation: string };
    tasks: Array<{id: string; title: string; status: string}>;
  };
  snapshot: Snapshot; assessment: SnapshotAssessment;
  plan: PlanResult | null; planState: "none" | "current" | "stale" | "reserved";
  receipts: ActionReceipt[]; audit: AuditEvent[];
  integrations: { meterless: IntegrationStatus; zetaris: IntegrationStatus };
  agent: { enabled: boolean; reason: string; model: string | null };
  agentRun: AgentRun;
}
