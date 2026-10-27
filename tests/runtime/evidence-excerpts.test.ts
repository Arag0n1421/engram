import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { EvidenceEntry } from "../../src/shared/investigation.ts";
import { buildEvidenceExcerptCatalog, validateEvidenceExcerptCatalog } from "../../src/runtime/evidence-excerpts.ts";

const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d";
const snapshotHash="b".repeat(64);
const entry=(id:string,content:string):EvidenceEntry=>({id,title:id,kind:"record",sourceURL:`urn:${id}`,version:1,retrievedAt:"2026-10-23T00:00:00.000Z",content,refs:[id],authority:"fictional-record",sourceHash:createHash("sha256").update(content).digest("hex"),snapshotHash,support:"Fixture."});

test("excerpt catalog preserves exact contiguous UTF-16 ranges and keeps surrogate pairs intact",()=>{
  const source=entry("UNICODE","a".repeat(900)+"😀.\n\n"+"z".repeat(900)+".");
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],maxBytes:10_000});
  assert.ok(catalog.entries.length>=2);
  for(const excerpt of catalog.entries){
    assert.ok(excerpt.end-excerpt.start<=1000);
    assert.equal(source.content.slice(excerpt.start,excerpt.end),excerpt.text);
    assert.equal(excerpt.start>0&&/[\uD800-\uDBFF]/.test(source.content[excerpt.start-1]!)&&/[\uDC00-\uDFFF]/.test(source.content[excerpt.start]!),false);
    assert.equal(excerpt.end<source.content.length&&/[\uD800-\uDBFF]/.test(source.content[excerpt.end-1]!)&&/[\uDC00-\uDFFF]/.test(source.content[excerpt.end]!),false);
  }
  assert.equal(validateEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],catalog}).size,catalog.entries.length);
});

test("catalog allocates excerpts round-robin and labels omitted ranges for every selected source",()=>{
  const first=entry("FIRST",Array.from({length:3},()=>"1".repeat(900)+".").join("\n\n"));
  const second=entry("SECOND",Array.from({length:3},()=>"2".repeat(900)+".").join("\n\n"));
  const full=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[first,second],maxBytes:40_000});
  assert.deepEqual(full.entries.slice(0,2).map(row=>row.sourceId),["FIRST","SECOND"]);
  const capped=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[first,second],maxBytes:full.bytes-2500});
  assert.ok(capped.entries.length<full.entries.length);
  assert.equal(capped.omissions.length,2);
  for(const omission of capped.omissions){
    assert.equal(omission.totalSegments,3);
    assert.ok(omission.omittedSegments>0);
    assert.ok(omission.omittedRanges.length>0);
  }
  assert.ok(capped.bytes<=full.bytes-1000);
});

test("catalog rejects tiny budgets, stale source hashes, and tampered excerpt content",()=>{
  const source=entry("SOURCE","Exact text.");
  assert.throws(()=>buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],maxBytes:0}),/byte limit/);
  assert.throws(()=>buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],maxBytes:80_001}),/byte limit/);
  const stale={...source,sourceHash:"c".repeat(64)};
  assert.throws(()=>buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[stale],maxBytes:1000}),/not bound/);
  const catalog=buildEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],maxBytes:1000});
  const forged={...catalog,entries:catalog.entries.map(row=>({...row,text:"forged"}))};
  assert.throws(()=>validateEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],catalog:forged}),/exact source range/);
  assert.throws(()=>validateEvidenceExcerptCatalog({runId,snapshotHash:"d".repeat(64),selected:[source],catalog}),/stale/);
  assert.throws(()=>validateEvidenceExcerptCatalog({runId,snapshotHash,selected:[source],catalog:{...catalog,bytes:80_001}}),/byte count/);
});
