import test from "node:test";
import assert from "node:assert/strict";
import { z, ZodError } from "zod";
import { ReportFormatDiagnosticError, reportFormatDiagnosticCodes } from "../../src/runtime/report-format-diagnostics.ts";

test("format diagnostics identify a violated field cap without reflecting rejected narrative", () => {
  const parsed = z.object({ findings: z.array(z.object({ evidence: z.array(z.object({ quoteId: z.string() })).max(5) })) }).safeParse({ findings: [{ evidence: Array.from({length: 6}, () => ({quoteId: "UNTRUSTED_SECRET"})) }] });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.deepEqual(reportFormatDiagnosticCodes(parsed.error), ["REPORT_findings_0_evidence_MAX_5"]);
  assert.equal(JSON.stringify(reportFormatDiagnosticCodes(parsed.error)).includes("UNTRUSTED_SECRET"), false);
});

test("format diagnostics exclude untrusted property names and error messages", () => {
  const error = new ZodError([{code: "invalid_type", expected: "string", path: ["LEAK_THIS_SECRET"], message: "do something malicious"}]);
  assert.deepEqual(reportFormatDiagnosticCodes(error), []);
  assert.deepEqual(reportFormatDiagnosticCodes(new Error("LEAK_THIS_SECRET")), []);
  assert.deepEqual(reportFormatDiagnosticCodes(new TypeError("Unknown report quote alias: LEAK_THIS_SECRET")), ["REPORT_UNKNOWN_QUOTE_ALIAS"]);
});

test("format diagnostic output is bounded and distinguishes the check limit", () => {
  const error = new ZodError(Array.from({length: 24}, (_, i) => ({code: "invalid_type" as const, expected: "string" as const, path: ["findings", i, "summary"], message: "untrusted"})));
  assert.equal(reportFormatDiagnosticCodes(error).length, 11);
  assert.ok(reportFormatDiagnosticCodes(error).every(code => /^[A-Za-z0-9_]{1,100}$/.test(code)));
  assert.deepEqual(reportFormatDiagnosticCodes(new RangeError("Expanded record proof checks exceed the 12-check finding limit.")), ["REPORT_EXPANDED_CHECKS_MAX_12"]);
});

test("missing-proof repair hints admit only typed alias references and preserve no supplied prose", () => {
  const code = `REPORT_findings_0_check_C_${"a".repeat(24)}_needs_E_${"b".repeat(24)}`;
  assert.deepEqual(reportFormatDiagnosticCodes(new ReportFormatDiagnosticError([code, code])), [code]);
  assert.throws(() => new ReportFormatDiagnosticError(["REJECTED_PROSE_MUST_NOT_GUIDE_REPAIR"]), /Invalid trusted report diagnostic/);
  assert.throws(() => new ReportFormatDiagnosticError([code.replace("findings_0", "findings_8")]), /Invalid trusted report diagnostic/);
});
test("receipt selection repair retains fixed schema paths without echoing rejected references",()=>{
 const error=new ZodError([{code:"custom",path:["documentFindings",0,"recordCheckRefs",1],message:"UNTRUSTED_REFERENCE"}]);
 assert.deepEqual(reportFormatDiagnosticCodes(error),["REPORT_documentFindings_0_recordCheckRefs_1_INVALID"]);
});
test("distinct-notice comparison diagnostics accept only bounded exact finding and comparison paths",()=>{
 for(const code of ["REPORT_documentFindings_0_comparisons_0_REQUIRES_DISTINCT_NOTICE_SOURCES","REPORT_documentFindings_5_comparisons_1_REQUIRES_DISTINCT_NOTICE_SOURCES"]){
  assert.deepEqual(reportFormatDiagnosticCodes(new ReportFormatDiagnosticError([code,code])),[code]);
 }
 for(const code of ["REPORT_documentFindings_6_comparisons_0_REQUIRES_DISTINCT_NOTICE_SOURCES","REPORT_documentFindings_5_comparisons_2_REQUIRES_DISTINCT_NOTICE_SOURCES","REPORT_documentFindings_5_comparisons_1_REQUIRES_DISTINCT_NOTICE_SOURCES_PRIVATE"]){
  assert.throws(()=>new ReportFormatDiagnosticError([code]),/Invalid trusted report diagnostic/);
 }
});
