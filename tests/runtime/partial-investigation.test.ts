import {test} from "node:test";
import assert from "node:assert/strict";
import {investigationHeading, isPartialInvestigation} from "../../web/src/partial-investigation.ts";
import type {Workspace} from "../../src/shared/workspace.ts";

const workspace = (status: string, disposition: string | null, selections: unknown[] = [], recordMatches: unknown[] = []) => ({
  agentRun: {status, investigation: {disposition, selections, recordMatches, findings: []}},
}) as unknown as Workspace;

test("partial status never claims completion and requires preserved work", () => {
  assert.equal(isPartialInvestigation(workspace("failed", null, [{}])), true);
  assert.equal(isPartialInvestigation(workspace("failed", null, [], [{}])), true);
  assert.equal(isPartialInvestigation(workspace("running", null, [{}])), false);
  assert.equal(isPartialInvestigation(workspace("failed", null)), false);
  assert.equal(isPartialInvestigation(workspace("complete", "answered", [{}])), false);
  assert.equal(isPartialInvestigation(workspace("blocked", "needs_evidence", [{}])), false);
  assert.equal(isPartialInvestigation(workspace("idle", null, [{}])), false);
  assert.equal(isPartialInvestigation(workspace("complete", null, [{}])), false);
  assert.equal(isPartialInvestigation({agentRun: {status: "idle"}} as Workspace), false);
});

test("headings describe failed and blocked runs without preserved work accurately", () => {
  assert.equal(investigationHeading(workspace("failed", null)), "Investigation failed · report not accepted");
  assert.equal(investigationHeading(workspace("blocked", null)), "Investigation blocked · operator review needed");
  assert.equal(investigationHeading(workspace("blocked", "needs_evidence", [{}])), "Investigation blocked · operator review needed");
  assert.equal(investigationHeading(workspace("failed", null, [{}])), "Partial investigation · report not accepted");
  assert.equal(investigationHeading(workspace("running", null, [{}])), "Investigation in progress");
  assert.equal(investigationHeading(workspace("complete", null, [{}])), "Investigation incomplete");
});

test("partial evidence retains only run-bound selected source snapshots and checked receipts", async () => {
  const {boundPartialEvidence} = await import("../../web/src/partial-investigation.ts");
  const notice={id:"notice",kind:"notice",sourceHash:"h1",snapshotHash:"snap",content:"Exact notice body",title:"Notice"};
  const record={id:"row",kind:"record",sourceHash:"h2",snapshotHash:"snap",content:"Exact record body",title:"Row"};
  const result={runId:"run",snapshotHash:"snap",evidence:[{sourceId:"notice",sourceHash:"h1",quote:"Exact notice"},{sourceId:"row",sourceHash:"h2",quote:"Exact record"}]};
  const w={agentRun:{runId:"run",status:"failed",investigation:{runId:"run",snapshotHash:"snap",disposition:null,selections:[{sourceId:"notice",sourceHash:"h1"},{sourceId:"row",sourceHash:"h2"}],recordMatches:[result],findings:[]}},investigationEvidence:{snapshotHash:"snap",entries:[notice,record]}} as unknown as Workspace;
  assert.equal(boundPartialEvidence(w).notices.length,1);
  assert.equal(boundPartialEvidence(w).notices[0]!.content,"Exact notice body");
  assert.equal(boundPartialEvidence(w).recordChecks.length,1);
  const changed=structuredClone(w); changed.agentRun.investigation!.recordMatches![0]!.evidence[0]!.quote="Not in the notice";
  assert.equal(boundPartialEvidence(changed).recordChecks.length,0);
  const stale=structuredClone(w); stale.agentRun.runId="other-run";
  assert.equal(boundPartialEvidence(stale).notices.length,0);
  const mismatched=structuredClone(w); mismatched.investigationEvidence!.entries[0]!.sourceHash="different";
  assert.equal(boundPartialEvidence(mismatched).notices.length,0);
  assert.equal(boundPartialEvidence(mismatched).recordChecks.length,0);
});

test("model diagnostic prose is withheld whether the run is running or failed", async () => {
  const {safeToolActivityMessage} = await import("../../web/src/partial-investigation.ts");
  for (const tool of ["model.split.fragment.invalid", "model.split.fragment.deduplicated", "model.response.nemotron"]) {
    assert.equal(safeToolActivityMessage({tool,message:"UNTRUSTED_MODEL_PROSE"}),"Model diagnostic recorded; rejected text is not a report.");
  }
  assert.equal(safeToolActivityMessage({tool:"read_evidence_sections",message:"Read completed"}),"Read completed");
});

test("incomplete scope never presents zero recorded lots as a complete zero", async () => {
  const {presentLotScope} = await import("../../web/src/partial-investigation.ts");
  const absent=presentLotScope(false,0);
  assert.equal(absent.count,"Not established");
  assert.equal(absent.canInspect,false);
  assert.match(absent.explanation,/does not mean no lots are affected/);
  const partial=presentLotScope(false,2);
  assert.match(partial.count,/2 recorded.*incomplete/);
  assert.match(partial.explanation,/may omit affected lots/);
  const establishedZero=presentLotScope(true,0);
  assert.equal(establishedZero.count,"0");
  assert.equal(establishedZero.canInspect,true);
  assert.equal(presentLotScope(true,7).count,"7");
  assert.throws(()=>presentLotScope(false,-1));
});

test("empty inventory is unknown unless an inventory phase explicitly read zero rows", async () => {
  const {isInventoryUnassessed} = await import("../../web/src/partial-investigation.ts");
  const snapshot=(inventory:unknown[], sourceRead?:unknown)=>({snapshot:{inventory,sourceRead}}) as Workspace;
  assert.equal(isInventoryUnassessed(snapshot([])),true);
  assert.equal(isInventoryUnassessed(snapshot([],{queryCount:0,phases:[]})),true);
  assert.equal(isInventoryUnassessed(snapshot([],{queryCount:1,phases:[{name:"reviewed_scope",rows:0}]})),true);
  assert.equal(isInventoryUnassessed(snapshot([],{queryCount:1,phases:[{name:"inventory",rows:0}]})),false);
  assert.equal(isInventoryUnassessed(snapshot([{}])),false);
});
