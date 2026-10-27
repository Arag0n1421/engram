import test from "node:test";
import assert from "node:assert/strict";
import { compactReportWireJsonSchemaForQuotes } from "../../src/runtime/investigation-report-wire.ts";

test("every advertised citation alias is admissible for all three provider reference fields", () => {
  for (const ids of [[`E_${"a".repeat(24)}`, `E_${"b".repeat(24)}`], ["a".repeat(64)]]) {
    const schema = compactReportWireJsonSchemaForQuotes(ids) as any;
    const finding = schema.properties.findings.items;
    const fields = [finding.properties.evidence.items.properties.quoteId,
      finding.properties.comparisons.items.properties.beforeQuoteId,
      finding.properties.comparisons.items.properties.afterQuoteId];
    for (const field of fields) {
      assert.deepEqual(field.enum, ids);
      assert.ok(ids.every(id => !field.pattern || new RegExp(field.pattern).test(id)), "An enum and pattern cannot exclude every advertised reference.");
      assert.equal(field.type, "string");
    }
  }
});
