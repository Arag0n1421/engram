import type { EvidenceEntry, EvidenceQuote, InvestigationFinding } from "../shared/investigation.ts";
import type { BoundRecordMatch } from "./record-matching.ts";

/**
 * Record findings are rendered by the backend from stored, run-bound field
 * comparisons. The model never writes record classifications: each sentence
 * here is a template over an exact receipt, and every quote is the receipt's
 * own stored proof. These findings state field comparisons only; they never
 * establish recall applicability, clearance or physical status.
 */
const FIELD_LABEL: Record<BoundRecordMatch["field"], string> = { lot: "lot / batch", manufacture_date: "manufacture date", product: "product identity" };
const REASON_TEXT: Record<BoundRecordMatch["reason"], string> = {
  exact_product_comparison: "exact identifier comparison",
  exact_lot_comparison: "exact comparison against the listed values",
  inclusive_date_comparison: "inclusive comparison against the stated date range",
  record_value_unknown: "the record does not state this value",
  unparseable_date: "the recorded date is not an explicit calendar date",
  field_not_explicit: "the record does not state this field explicitly",
  criterion_field_not_explicit: "the notice criterion is not explicit for this field",
  product_identity_unknown: "product identity could not be established from quoted identifiers",
  different_product: "the quoted product identifiers differ",
  incomplete_lot_set: "only the listed values were compared; an unlisted value is not shown to be excluded",
};
const STATUS_TEXT: Record<BoundRecordMatch["status"], string> = { match: "matches", no_match: "does not match", unknown: "could not be determined against" };

function describe(result: BoundRecordMatch, titles: Map<string, string>): string {
  const notice = [...new Set(result.evidence.map(proof => titles.get(proof.sourceId)).filter((title): title is string => !!title))].join(" / ") || "the cited notice";
  const value = result.normalizedRecordValue === null ? "no value recorded" : `recorded "${result.normalizedRecordValue}"`;
  // A different product makes any field comparison inapplicable; say so instead of "does not match".
  if (result.reason === "different_product") return `${FIELD_LABEL[result.field]} (${value}) was not counted as a match for ${notice} because the quoted product identifiers differ.`;
  return `${FIELD_LABEL[result.field]} (${value}) ${STATUS_TEXT[result.status]} the criterion in ${notice} (${REASON_TEXT[result.reason]}).`;
}

export function buildServerRecordFindings(results: readonly BoundRecordMatch[], entries: readonly EvidenceEntry[]): InvestigationFinding[] {
  const titles = new Map(entries.filter(entry => entry.kind === "notice").map(entry => [entry.id, entry.title]));
  const byRecord = new Map<string, BoundRecordMatch[]>();
  for (const result of results) byRecord.set(result.recordId, [...(byRecord.get(result.recordId) ?? []), result]);
  return [...byRecord].map(([recordId, rows], index) => {
    const statuses = new Set(rows.map(row => row.status));
    const lead = statuses.has("unknown") ? "At least one field could not be determined, so this record needs human review." : statuses.has("match") ? "At least one checked field matches a notice criterion, so this record needs human review." : "No checked field matched; this is not a clearance, because only the stated fields were compared.";
    const evidence = [...new Map(rows.flatMap(row => row.evidence).map(proof => [JSON.stringify([proof.sourceId, proof.sourceHash, proof.quote]), proof] as const)).values()].slice(0, 8) as EvidenceQuote[];
    return {
      id: `backend-record-${index + 1}`,
      kind: "observation" as const,
      origin: "backend_record_check" as const,
      summary: `Record ${recordId}: ${[...new Set(rows.map(row => describe(row, titles)))].join(" ")} ${lead}`.slice(0, 1000),
      evidence,
      recordChecks: rows.map(row => ({ resultId: row.resultId, field: row.field, status: row.status })),
    };
  });
}

