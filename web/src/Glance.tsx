import React from "react";
import type { Workspace } from "../../src/shared/workspace";
import { safeToolActivityMessage } from "./partial-investigation";

/* Presentation only. Every status below is derived from the workspace object; nothing is assumed. */

type StepTone = "done" | "review" | "failed" | "pending";
type Step = { title: string; status: string; detail: string; tone: StepTone };
type AgentEvent = Workspace["agentRun"]["events"][number];

const toneLabel: Record<StepTone, string> = { done: "Done", review: "Needs review", failed: "Failed", pending: "Not yet" };

function parseJson(message: string): Record<string, unknown> | null {
  if (!message.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(message) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function asStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function plural(count: number, one: string, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }
export function shortModelName(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.split("/").pop() || model;
}
/** "nvidia/nemotron-3.5-super-…" -> "Nemotron"; display only. */
export function modelFamily(model: string | null | undefined): string | null {
  const short = shortModelName(model);
  if (!short) return null;
  const head = short.split(/[-_ ]/)[0] || short;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/** Plain-English phrasing for the fixed validator vocabulary; falls back to the code itself. */
const feedbackReasons: Record<string, string> = {
  numeric_count_requires_source_or_checked_calculation: "a number was not backed by a source or the checked calculation",
  quote_not_found: "a quote did not appear in the cited source",
  invalid_quote: "a quote was malformed",
  unknown_evidence_source: "it cited a source that does not exist",
  stale_source_hash: "it cited an outdated copy of a source",
  unsupported_identifier_or_date: "an identifier or date was not in the sources",
  conflict_needs_two_sources: "a conflict claim cited only one source",
  source_inspection_required: "it cited a source it had not read",
  unselected_evidence: "it cited evidence it had not opened",
  record_match_mismatch: "a record match did not agree with the backend check",
  field_match_does_not_establish_clearance: "it treated a field match as clearance",
  absence_not_established_by_excerpt: "it claimed something was absent from an excerpt",
  invalid_summary: "the summary failed validation",
  invalid_findings: "the findings failed validation",
};
export function feedbackReason(code: string): string { return feedbackReasons[code] ?? code.replaceAll("_", " "); }

/* ------------------------------------------------------------------ */
/* Investigation at a glance                                           */
/* ------------------------------------------------------------------ */

export function investigationSteps(workspace: Workspace): Step[] {
  const run = workspace.agentRun;
  const read = workspace.snapshot.sourceRead;
  const zetaris = workspace.integrations.zetaris;
  const notices = workspace.evidenceRegistry?.entries.filter((entry) => entry.kind === "notice").length ?? 0;
  const modelCalls = run.events.filter((event) => event.tool === "model.request.started").length;
  const investigation = run.investigation;
  const rejectedDrafts = investigation?.feedback.filter((item) => item.codes.length > 0).length ?? 0;
  const plan = workspace.plan;
  const audit = run.claimAudit;
  const claimsCurrent = audit?.status === "verified" && audit.result.checked?.snapshotHash === workspace.assessment.inputFingerprint;

  const sources: Step = read && read.queryCount > 0
    ? { title: "Sources read", tone: zetaris.verified || workspace.dataMode === "replay" ? "done" : "review",
        status: `${zetaris.configured ? "Zetaris: " : ""}${plural(read.queryCount, "query", "queries")} in ${(read.elapsedMs / 1000).toFixed(1)} s`,
        detail: `${zetaris.verified ? (workspace.dataMode === "live" ? "Live read verified" : "Read verified") : zetaris.status} · ${plural(notices, "recall notice")} on file` }
    : { title: "Sources read", tone: "pending", status: "No source read recorded", detail: notices ? `${plural(notices, "recall notice")} on file` : "Waiting for a source read" };

  const model = shortModelName(run.model ?? workspace.agent.model);
  const agent: Step = run.status === "idle"
    ? { title: "Agent investigated", tone: "pending", status: "Not started", detail: model ? `Ready: ${model}` : workspace.agent.enabled ? "Agent ready" : "Agent unavailable" }
    : run.status === "running"
      ? { title: "Agent investigated", tone: "review", status: "Investigating now…", detail: `${model ?? "Model"} · ${plural(run.events.length, "event")} so far` }
      : run.status === "failed"
        ? { title: "Agent investigated", tone: "failed", status: "Run failed", detail: `${model ?? "Model"} · ${plural(run.events.length, "event")} logged` }
        : { title: "Agent investigated", tone: run.status === "blocked" ? "review" : "done",
            status: run.status === "blocked" ? "Paused for operator input" : `${plural(modelCalls, "model call")}, ${plural(run.events.length, "logged step")}`,
            detail: model ?? "Model not reported" };

  const report: Step = !investigation
    ? { title: "Report checked", tone: run.status === "complete" ? "review" : "pending", status: run.status === "complete" ? "No evidence report attached" : "No report yet", detail: "Quotes are checked against stored sources" }
    : investigation.disposition === null
      ? run.status === "running"
        ? { title: "Report checked", tone: "pending", status: "Waiting for the report", detail: rejectedDrafts ? `${plural(rejectedDrafts, "draft")} rejected so far` : "Checker runs when the report arrives" }
        : { title: "Report checked", tone: "failed", status: "Not accepted", detail: "Human review of the partial evidence is required" }
      : investigation.withheldFindings?.length
        ? { title: "Report checked", tone: "review", status: `Partially verified · ${plural(investigation.withheldFindings.length, "finding")} withheld`, detail: `${plural(investigation.findings.length, "finding")} passed the full check` }
        : investigation.disposition === "needs_evidence"
          ? { title: "Report checked", tone: "review", status: "Needs operator evidence", detail: investigation.question ? "The agent asked a follow-up question" : "More source evidence is needed" }
          : { title: "Report checked", tone: "done", status: `Accepted · ${plural(investigation.findings.length, "finding")}`,
              detail: rejectedDrafts ? `Checker rejected ${plural(rejectedDrafts, "earlier draft")} first` : "Accepted on the first draft" };

  const transfers = plan?.status === "feasible" ? plan.transfers : [];
  const transferText = transfers.length === 0 ? "No transfer needed"
    : transfers.map((transfer) => `${transfer.quantityEa} EA ${transfer.originSiteId} → ${transfer.destinationSiteId}`).join(", ");
  const planStep: Step = !plan
    ? { title: "Plan calculated", tone: "pending", status: "Not calculated", detail: "Deterministic solver, no model involved" }
    : workspace.planState === "stale"
      ? { title: "Plan calculated", tone: "review", status: "Out of date · recalculate", detail: "Source data changed after this plan" }
      : plan.status === "feasible"
        ? { title: "Plan calculated", tone: "done", status: workspace.planState === "reserved" ? `Reserved in sandbox · ${transferText}` : `Feasible · ${transferText}`,
            detail: `${plan.transportCostPoints} cost points · ${plan.projectedInboundEa} EA inbound counted` }
        : { title: "Plan calculated", tone: "failed", status: `No feasible plan · ${plan.shortfallEa} EA short`, detail: `${plan.totalRequiredEa} EA required, ${plan.totalEligibleEa} EA eligible` };

  const claims: Step = !audit
    ? { title: "Claims verified", tone: "pending", status: "Not checked yet", detail: "Runs after the agent finishes" }
    : audit.status === "verified"
      ? claimsCurrent
        ? { title: "Claims verified", tone: "done", status: "Every number matches the data", detail: `${plural(audit.result.checked?.explanations.length ?? 0, "explanation")} checked against this snapshot` }
        : { title: "Claims verified", tone: "review", status: "Verified on an older snapshot", detail: "Investigate again to check current data" }
      : { title: "Claims verified", tone: "failed", status: "Claims not verified", detail: "Treat the model summary as unchecked" };

  return [sources, agent, report, planStep, claims];
}

export function InvestigationGlance({ workspace }: { workspace: Workspace }) {
  const steps = investigationSteps(workspace);
  const isReplay = workspace.dataMode === "replay" || workspace.snapshot.dataMode === "fixture";
  return <section className="glance" aria-labelledby="glance-title">
    <div className="glance-heading">
      <div><span className="eyebrow">Investigation at a glance</span><h2 id="glance-title">From source data to a checked plan<span className="glance-period">.</span></h2></div>
      <div className="glance-honesty"><span>{isReplay ? "Historical replay" : "Live sources"}</span><span>Fictional stock data</span><span>Sandbox actions only</span><span>Human approval required</span></div>
    </div>
    <ol className="glance-steps">
      {steps.map((step, index) => <li key={step.title} className={`glance-step glance-${step.tone}`}>
        <div className="glance-rail" aria-hidden="true"><span className="glance-node">{index + 1}</span>{index < steps.length - 1 && <span className="glance-line" />}</div>
        <div className="glance-text">
          <span className="glance-title">{step.title}<span className="sr-only"> · {toneLabel[step.tone]}</span></span>
          <strong className="glance-status">{step.status}</strong>
          <span className="glance-detail">{step.detail}</span>
        </div>
      </li>)}
    </ol>
  </section>;
}

/* ------------------------------------------------------------------ */
/* Agent activity timeline                                             */
/* ------------------------------------------------------------------ */

type RowTone = "neutral" | "good" | "warn" | "bad" | "model";
type Row = { key: string; label: string; detail?: string; tone: RowTone; events: AgentEvent[] };

function stockLabel(key: string | undefined, siteId?: unknown): string {
  const site = typeof siteId === "string" ? siteId : key?.startsWith("stock:") ? key.slice(6) : undefined;
  return site && site !== "all" ? `Checked stock at site ${site}` : "Checked stock at every site";
}

function describe(event: AgentEvent): Omit<Row, "events"> {
  const data = parseJson(event.message);
  const tool = event.tool;
  if (tool.startsWith("model.")) return { key: "model", label: "Model reasoning step", tone: "model" };
  switch (tool) {
    case "source.snapshot": return { key: tool, label: "Froze the source data for this run", detail: "All later checks use this exact snapshot.", tone: "neutral" };
    case "memory.consulted": return { key: tool, label: "Checked past decisions (memory)", detail: event.message, tone: "neutral" };
    case "memory.context.bound": return { key: tool, label: "Attached memory as advice only", tone: "neutral" };
    case "inspect_evidence": {
      const ids = asStringArray(data?.sourceIds);
      return { key: tool, label: "Read the recall notices", detail: ids.length ? `${plural(ids.length, "source")}: ${ids.join(", ")}` : undefined, tone: "neutral" };
    }
    case "investigation.observation": {
      const inner = asString(data?.tool);
      return { key: `${tool}:${inner}`, label: inner === "recall_history" ? "Looked up the recall history" : `Looked up ${inner?.replaceAll("_", " ") ?? "supporting records"}`, tone: "neutral" };
    }
    case "investigation.report.requested": return { key: tool, label: "Agent started writing its report", tone: "neutral" };
    case "investigation.feedback": {
      const codes = asStringArray(data?.codes);
      return { key: `${tool}:${event.at}`, label: "Checker rejected a draft", detail: codes.length ? `Reason: ${codes.map(feedbackReason).join("; ")}. The agent had to revise.` : "The draft did not pass validation.", tone: "warn" };
    }
    case "investigation.evidence_checked": return { key: tool, label: "Checker accepted the report", detail: "Every quote was found verbatim in the stored sources. Interpretation still needs human review.", tone: "good" };
    case "operational.read.bound": case "investigate_stock": case "fetch_constraints": {
      const inner = asString(data?.tool) ?? tool;
      const args = data?.args && typeof data.args === "object" ? data.args as Record<string, unknown> : undefined;
      if (inner === "fetch_constraints") return { key: `read:${inner}`, label: "Read demand, reserves and routes", tone: "neutral" };
      if (inner === "investigate_stock") return { key: `read:${inner}:${asString(data?.key)}`, label: stockLabel(asString(data?.key), args?.siteId), tone: "neutral" };
      return { key: tool, label: "Read operational data", tone: "neutral" };
    }
    case "meterless.hmem": return { key: tool, label: "Saved this analysis to memory", detail: event.message, tone: "neutral" };
    case "workflow.solve_plan": case "solve_plan": return { key: "solve_plan", label: "Calculated the transfer plan", detail: tool === "solve_plan" ? event.message : undefined, tone: "neutral" };
    case "workflow.validate_plan": case "validate_plan": {
      const failed = data?.valid === false;
      return { key: "validate_plan", label: failed ? "Independent re-check failed" : "Independently re-checked the plan", detail: tool === "validate_plan" ? event.message : undefined, tone: failed ? "bad" : "good" };
    }
    case "workflow.prepare_actions": case "prepare_actions": return { key: "prepare_actions", label: "Prepared the approval checklist", detail: tool === "prepare_actions" ? event.message : undefined, tone: "neutral" };
    case "claims.finalization.started": return { key: tool, label: "Started the final claim check", tone: "neutral" };
    case "claims.verified": return { key: tool, label: "Verified every number against the snapshot", detail: event.message, tone: "good" };
    default: {
      const bad = /fail|error|reject|unverified/i.test(tool);
      return { key: `${tool}:${event.at}`, label: tool.replaceAll(/[._]/g, " "), detail: data ? undefined : safeToolActivityMessage(event), tone: bad ? "bad" : "neutral" };
    }
  }
}

export function groupEvents(events: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    const described = describe(event);
    const last = rows[rows.length - 1];
    if (last && last.key === described.key) {
      last.events.push(event);
      if (!last.detail && described.detail) last.detail = described.detail;
      continue;
    }
    rows.push({ ...described, events: [event] });
  }
  return rows;
}

function elapsed(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ToolTimeline({ events, model }: { events: AgentEvent[]; model: string | null }) {
  if (events.length === 0) return <p className="quiet">No tool events recorded for this run.</p>;
  const rows = groupEvents(events);
  const start = events[0].at;
  const modelName = modelFamily(model) ?? "Model";
  return <>
    <ol className="timeline">
      {rows.map((row, index) => {
        const requests = row.events.filter((event) => event.tool === "model.request.started" || event.tool === "model.report.request.started").length;
        const label = row.tone === "model" ? `${modelName} reasoned${requests > 0 ? ` · ${plural(requests, "request")}` : ""}` : row.label;
        const detail = row.tone === "model" ? undefined : row.detail;
        return <li key={`${row.key}-${index}`} className={`timeline-item timeline-${row.tone}`}>
          <span className="timeline-dot" aria-hidden="true" />
          <details className="timeline-raw"><summary>
            <span className="timeline-head"><strong>{label}</strong><time className="mono" dateTime={row.events[0].at} title={row.events[0].at}>{elapsed(start, row.events[0].at)}</time></span>
            {detail && <span className="timeline-detail">{detail}</span>}
          </summary>
            <span className="timeline-raw-label">Raw {row.events.length === 1 ? "event" : `events (${row.events.length})`}</span>
            {row.events.map((event, eventIndex) => <div key={eventIndex}><code>{event.tool}</code><pre>{safeToolActivityMessage(event)}</pre></div>)}
          </details>
        </li>;
      })}
    </ol>
    <p className="fine-print">Times are from the start of the run. Click any step to see its raw log entry; model text is never shown as status.</p>
  </>;
}
