import { ZodError } from "zod";

/** Constructed only from current trusted packet maps, never rejected narrative. */
export class ReportFormatDiagnosticError extends TypeError {
  readonly diagnosticCodes: string[];
  constructor(codes: string[]) {
    super("Selected report checks require their exact source and record citations.");
    if (codes.some(code => !isSafeDiagnosticCode(code))) throw new TypeError("Invalid trusted report diagnostic code.");
    this.diagnosticCodes = [...new Set(codes)].slice(0, 11);
  }
}

const fields = new Set([
  "findings", "kind", "summary", "evidence", "quoteId", "comparisons",
  "beforeQuoteId", "afterQuoteId", "beforeEvidenceIndex", "afterEvidenceIndex", "relation", "recordChecks", "resultId",
  "field", "status", "proofGroupIds", "recordCheckRefs", "question", "nextStep",
  "packetId", "recordSections", "documentFindings", "B1", "B2", "B3", "B4", "B5",
]);

function isSafeDiagnosticCode(code:string):boolean {
  if (/^REPORT_findings_[0-5]_check_C_[a-f0-9]{24}_needs_E_[a-f0-9]{24}$/.test(code)) return true;
  if (/^REPORT_documentFindings_[0-5]_recordCheckRefs_(?:[0-9]|1[01])_MISSING_PROOF_CITATIONS$/.test(code)) return true;
  if (/^REPORT_documentFindings_[0-5]_comparisons_[01]_(?:REQUIRES_DISTINCT_NOTICE_SOURCES|ENDPOINTS_MUST_BE_CITED)$/.test(code)) return true;
  if (code === "REPORT_question_REQUIRED_FOR_ASK_OPERATOR") return true;
  const match = /^REPORT_(.+)_(EXPECTED_TYPE|INVALID_CHOICE|INVALID_REFERENCE_FORMAT|UNRECOGNIZED_FIELDS|INVALID_SHAPE|INVALID|MAX_\d+|MIN_\d+)$/.exec(code);
  if (!match || code.length > 100) return false;
  const path = match[1]!.split("_");
  return path.length > 0 && path.every(part => fields.has(part) || /^(?:[0-9]|[1-3][0-9]|4[0-8])$/.test(part));
}

/** Model repair hints contain schema paths and fixed codes, never rejected prose. */
export function reportFormatDiagnosticCodes(error: unknown): string[] {
  if (error instanceof ReportFormatDiagnosticError) return [...error.diagnosticCodes];
  if (error instanceof ZodError) {
    const codes: string[] = [];
    for (const issue of error.issues.slice(0, 24)) {
      if (!issue.path.every(part => typeof part === "string" ? fields.has(part) :
        typeof part === "number" && Number.isSafeInteger(part) && part >= 0 && part <= 48)) continue;
      if (issue.code === "custom" && issue.path.length === 1 && issue.path[0] === "question") {
        codes.push("REPORT_question_REQUIRED_FOR_ASK_OPERATOR");
        if (codes.length === 11) break;
        continue;
      }
      const path = issue.path.map(String).join("_") || "report";
      let detail: string;
      if (issue.code === "too_big" && typeof issue.maximum === "number" && Number.isSafeInteger(issue.maximum) && issue.maximum <= 48_000) detail = `MAX_${issue.maximum}`;
      else if (issue.code === "too_small" && typeof issue.minimum === "number" && Number.isSafeInteger(issue.minimum) && issue.minimum >= 0) detail = `MIN_${issue.minimum}`;
      else detail = ({ invalid_type: "EXPECTED_TYPE", invalid_value: "INVALID_CHOICE", invalid_format: "INVALID_REFERENCE_FORMAT", unrecognized_keys: "UNRECOGNIZED_FIELDS", invalid_union: "INVALID_SHAPE", custom: "INVALID" } as Record<string, string>)[issue.code] ?? "INVALID";
      const code = `REPORT_${path}_${detail}`;
      if (code.length <= 100 && !codes.includes(code)) codes.push(code);
      if (codes.length === 11) break;
    }
    return codes;
  }
  if (!(error instanceof Error)) return [];
  const prefixes: Array<[string, string]> = [
    ["Unknown report quote alias", "REPORT_UNKNOWN_QUOTE_ALIAS"],
    ["Unknown report check alias", "REPORT_UNKNOWN_CHECK_ALIAS"],
    ["Unknown report result alias", "REPORT_UNKNOWN_RESULT_ALIAS"],
    ["Record proof group is not presented", "REPORT_UNKNOWN_CHECK_ALIAS"],
    ["Investigation report quote ID is not presented", "REPORT_UNKNOWN_QUOTE_ALIAS"],
    ["The selected evidence does not cover record proof group", "REPORT_MISSING_CHECK_CITATIONS"],
    ["Selected evidence does not bind every exact proof quote", "REPORT_MISSING_CHECK_CITATIONS"],
    ["Expanded record proof checks exceed", "REPORT_EXPANDED_CHECKS_MAX_12"],
    ["A finding cannot mix proof group", "REPORT_MIXED_CHECK_REPRESENTATION"],
    ["Every finding must explicitly contain", "REPORT_EXPLICIT_PROOF_ARRAYS_REQUIRED"],
  ];
  return prefixes.filter(([prefix]) => error.message.startsWith(prefix)).map(([, code]) => code);
}
