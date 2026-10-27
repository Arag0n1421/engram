export interface EvidenceDocument {
  id: string;
  title: string;
  kind: "notice" | "record";
  sourceURL: string;
  version: string | number;
  retrievedAt: string;
  content: string;
  refs: string[];
  authority: "public-source-excerpt" | "fictional-record" | "curated-source-summary";
}

export interface EvidenceEntry extends Omit<EvidenceDocument, "refs"> {
  sourceHash: string;
  snapshotHash: string;
  refs: string[];
  support: string;
}

export interface EvidenceRegistry {
  snapshotHash: string;
  entries: EvidenceEntry[];
}

export interface EvidenceQuote {
  sourceId: string;
  sourceHash: string;
  quote: string;
}

export interface InvestigationFinding {
  id: string;
  kind: "conflict" | "missing_evidence" | "observation";
  summary: string;
  evidence: EvidenceQuote[];
  question?: string;
  comparisons?: Array<{before:EvidenceQuote;after:EvidenceQuote;relation:"same_text"|"different_text"}>;
  recordChecks?: Array<{resultId:string;field:"lot"|"manufacture_date"|"product";status:"match"|"no_match"|"unknown"}>;
  /** Present only on findings rendered by the backend from stored record receipts; never model-written. */
  origin?: "backend_record_check";
}

export interface InvestigationReportInput {
  /** Server-attached exact stored receipts; coverage data, never narrative entailment. */
  recordReceiptIds?: string[];
  /** Declared citation contract. Atomic receipts require complete exact backend binding. */
  recordCitationMode?: "atomic_receipts_v1";
  disposition: "answered" | "needs_evidence" | "plan";
  summary: string;
  findings: InvestigationFinding[];
  question?: string;
}

export interface InvestigationReportRequest {
  runId: string;
  snapshotHash: string;
  reason: string;
  at: string;
}

export interface InvestigationReportFormatFailure {
  runId: string;
  snapshotHash: string;
  requestNumber: number;
  reportRequestNumber: number;
  at: string;
  codes: string[];
  rawContent: string;
  rawContentHash: string;
  rawContentBytes: number;
  rawContentRetainedBytes: number;
  rawContentTruncated: boolean;
}

export interface InvestigationProofIssue {findingIndex:number;resultId?:string;code:"record_match_requires_criterion_and_record_quotes"|"comparison_requires_two_cited_notices";missingProofHashes:string[]}

/** Fixed validator vocabulary. Never include rejected prose, identifiers or citation text. */
export const INVESTIGATION_DOMAIN_FEEDBACK_CODES = [
  "absence_not_established_by_excerpt", "atomic_record_receipts_require_global_binding",
  "comparison_requires_two_cited_notices", "concrete_operator_question_required", "concrete_question_required",
  "conflict_needs_two_sources", "delegation_does_not_establish_conflict", "documentary_action_requires_notice_quote",
  "field_match_does_not_establish_clearance", "invalid_comparison", "invalid_disposition", "invalid_finding",
  "invalid_findings", "invalid_global_record_receipt_binding", "invalid_global_record_receipts", "invalid_quote",
  "invalid_record_citation_mode", "invalid_selection", "invalid_summary", "missing_evidence_finding_required",
  "notice_comparison_coverage_required", "numeric_count_requires_source_or_checked_calculation", "quote_not_found",
  "record_check_status_does_not_support_classification", "record_claim_requires_checked_reference",
  "record_match_coverage_required", "record_match_field_claim_mismatch", "record_match_mismatch",
  "record_match_requires_criterion_and_record_quotes", "record_findings_are_server_generated", "record_receipt_capacity_exceeded", "record_receipt_coverage_required",
  "risk_change_requires_notice_comparison", "scope_reduction_requires_explicit_prior_scope_withdrawal",
  "shared_immediate_stop_use_requires_both_notice_quotes", "source_bound_record_matching_required",
  "source_inspection_required", "stale_source_hash", "text_comparison_mismatch", "unchanged_evidence_cannot_support_change",
  "unknown_evidence_source", "unknown_global_record_receipt", "unknown_record_check_cannot_prove_classification",
  "unknown_selection", "unselected_evidence", "unsupported_identifier_or_date", "unsupported_material_risk_change",
] as const;
export type InvestigationDomainFeedbackCode = typeof INVESTIGATION_DOMAIN_FEEDBACK_CODES[number];
export interface InvestigationFindingIssue { findingIndex: number; code: InvestigationDomainFeedbackCode; unsupportedTokens?: string[] }
export interface InvestigationValidationIssue { findingIndex?: number; code: InvestigationDomainFeedbackCode; unsupportedTokens?: string[] }
export interface InvestigationValidationFeedback {
  at: string;
  codes: string[];
  findingIssues?: InvestigationFindingIssue[];
  reportIssues?: InvestigationDomainFeedbackCode[];
  unsupportedSummaryTokens?: string[];
  findingIssuesOmittedCount?: number;
  reportIssuesOmittedCount?: number;
  proofIssues?: InvestigationProofIssue[];
  proofIssuesOmittedCount?: number;
}

export interface InvestigationRecord {
  runId: string;
  snapshotHash: string;
  selections: Array<{ sourceId: string; sourceHash: string; reason: string; at: string }>;
  findings: InvestigationFinding[];
  reportAttempts?: InvestigationReportInput[];
  recordReceiptIds?: string[];
  recordCitationMode?: "atomic_receipts_v1";
  reportRequest?: InvestigationReportRequest;
  recordMatches?: import("../runtime/record-matching.ts").BoundRecordMatch[];
  retrievalReceipts?: import("../runtime/investigation-readiness.ts").InvestigationReadReceipt[];
  matchingFeedback?: Array<{at:string;codes:string[];proposalIndex?:number;criterionRef?:string;guidance?:string}>;
  formatFailures?: InvestigationReportFormatFailure[];
  feedback: InvestigationValidationFeedback[];
  /** Set only when the final attempt was accepted after withholding findings that failed validation. */
  withheldFindings?: Array<{kind: InvestigationFinding["kind"]; summary: string; codes: string[]}>;
  disposition: null | "answered" | "needs_evidence" | "plan";
  summary: string;
  question?: string;
}

/** Identity metadata copied from the run's pinned snapshot; never source evidence or a finding. */
export interface SnapshotTargetIdentity {
  runId: string;
  snapshotHash: string;
  targetSku: string;
  recallId: string;
  manufacturerRef: string;
  catalogMappings: Array<{ internalSku: string; manufacturerRef: string; unit: string }>;
}

export interface ProjectedTargetIdentity extends SnapshotTargetIdentity {
  provenance: "pinned_snapshot_metadata";
  metadataOnly: true;
  citable: false;
}
