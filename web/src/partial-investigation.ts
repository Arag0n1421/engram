import type {Workspace} from "../../src/shared/workspace.ts";

/** This describes presentation only; it cannot finish or approve a run. */
export function isPartialInvestigation(workspace: Workspace): boolean {
  const investigation = workspace.agentRun.investigation;
  return !!investigation && investigation.disposition === null &&
    (workspace.agentRun.status === "failed" || workspace.agentRun.status === "blocked") &&
    (investigation.selections.length > 0 || (investigation.recordMatches?.length ?? 0) > 0);
}

/** Present the run state without treating a missing disposition as active work. */
export function investigationHeading(workspace: Workspace): string {
  const { investigation, status } = workspace.agentRun;
  if (!investigation) return "Investigation not started";
  if (isPartialInvestigation(workspace)) return "Partial investigation · report not accepted";
  if (status === "failed") return "Investigation failed · report not accepted";
  if (status === "blocked") return "Investigation blocked · operator review needed";
  if (status === "running") return "Investigation in progress";
  if (investigation.disposition === null) return "Investigation incomplete";
  if (investigation.withheldFindings?.length) return `Partially verified · ${investigation.withheldFindings.length} finding${investigation.withheldFindings.length === 1 ? "" : "s"} withheld`;
  return investigation.findings.length > 0
    ? "Quoted evidence checked · model interpretation"
    : "Evidence investigation · model interpretation";
}

/**
 * The partial evidence view can show only material from the pinned run and
 * snapshot, whose source hashes match the server's actual selection receipts.
 * This does not assert that every source was retrieved, relevant or complete.
 */
export function boundPartialEvidence(workspace: Workspace) {
  const run = workspace.agentRun;
  const investigation = run.investigation;
  const registry = workspace.investigationEvidence;
  if (!isPartialInvestigation(workspace) || !investigation || !run.runId ||
      investigation.runId !== run.runId || !registry || registry.snapshotHash !== investigation.snapshotHash) {
    return {notices: [], recordChecks: []};
  }
  const selected = registry.entries.filter(entry => entry.snapshotHash === investigation.snapshotHash &&
    investigation.selections.some(selection => selection.sourceId === entry.id && selection.sourceHash === entry.sourceHash));
  const notices = selected.filter(entry => entry.kind === 'notice');
  const recordChecks = (investigation.recordMatches ?? []).filter(result => result.runId === investigation.runId &&
    result.snapshotHash === investigation.snapshotHash && result.evidence.length > 0 && result.evidence.every(proof => {
      const entry = selected.find(item => item.id === proof.sourceId && item.sourceHash === proof.sourceHash);
      return !!entry && !!proof.quote && entry.content.includes(proof.quote);
    }));
  return {notices, recordChecks};
}

/** Untrusted model diagnostics can include rejected prose; never display them as status text. */
export function safeToolActivityMessage(event: {tool: string; message: string}): string {
  return event.tool.startsWith("model.") ? "Model diagnostic recorded; rejected text is not a report." : event.message;
}

/** A stored list is complete only when the snapshot explicitly says so. */
export function presentLotScope(complete: boolean, recordedCount: number) {
  if (!Number.isInteger(recordedCount) || recordedCount < 0) throw new RangeError("Invalid recorded lot count.");
  if (complete) return {
    count: String(recordedCount), heading: "Inspect all affected lots",
    countDetail: `${recordedCount} identifiers`,
    explanation: "Scope recorded as complete in this snapshot. A missing or uncertain identifier requires review.",
    canInspect: true,
  };
  if (recordedCount === 0) return {
    count: "Not established", heading: "Affected lots not established", countDetail: "",
    explanation: "The snapshot has no complete affected-lot list. This does not mean no lots are affected; review the source notices.",
    canInspect: false,
  };
  return {
    count: `${recordedCount} recorded · incomplete`, heading: "Inspect recorded lot identifiers",
    countDetail: `${recordedCount} recorded`,
    explanation: "This list is incomplete and may omit affected lots; review the source notices.",
    canInspect: true,
  };
}

/** Empty rows are a quantified zero only with an actual zero-row inventory read. */
export function isInventoryUnassessed(workspace: Workspace): boolean {
  if (workspace.snapshot.inventory.length > 0) return false;
  const read = workspace.snapshot.sourceRead;
  return !read || read.queryCount < 1 || !read.phases.some(phase => phase.name === "inventory" && phase.rows === 0);
}
