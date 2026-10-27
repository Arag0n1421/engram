import React, { useEffect, useMemo, useState } from "react";
import type { WhatIfResult } from "../../src/runtime/what-if.ts";
import type { Workspace } from "../../src/shared/workspace.ts";
import { EvidenceRef } from "./Evidence";

function LinkedAssumption({ text, workspace }: { text: string; workspace: Workspace }) {
  const refs = useMemo(() => {
    const all = [...(workspace.evidenceRegistry?.entries ?? []), ...(workspace.investigationEvidence?.entries ?? [])]
      .flatMap((entry) => entry.refs)
      .filter((ref, index, values) => values.indexOf(ref) === index)
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    const segments: Array<string | { ref: string }> = [];
    let cursor = 0;
    while (cursor < text.length) {
      const match = all.find((ref) => text.startsWith(ref, cursor) &&
        (cursor === 0 || !/[A-Za-z0-9_-]/.test(text[cursor - 1]!)) &&
        (cursor + ref.length === text.length || !/[A-Za-z0-9_-]/.test(text[cursor + ref.length]!)));
      if (!match) { segments.push(text[cursor]!); cursor++; continue; }
      segments.push({ ref: match }); cursor += match.length;
    }
    return segments;
  }, [text, workspace.evidenceRegistry, workspace.investigationEvidence]);
  return <>{refs.map((part, index) => typeof part === "string" ? part : <EvidenceRef key={`${part.ref}-${index}`} id={part.ref} />)}</>;
}

function PlanSummary({ title, summary }: { title: string; summary: WhatIfResult["baseline"] }) {
  return <section className="whatif-summary-column"><div className="whatif-summary-heading"><strong>{title}</strong><span className={`evidence-status ${summary.status === "feasible" ? "evidence-status-current" : "evidence-status-stale"}`}>{summary.status.replaceAll("_", " ")}</span></div><dl className="whatif-kpis"><div><dt>Shortfall</dt><dd>{summary.shortfallEa} EA</dd></div><div><dt>Projected inbound</dt><dd>{summary.projectedInboundEa} EA</dd></div><div><dt>Transport cost</dt><dd>{summary.transportCostPoints === null ? "—" : `${summary.transportCostPoints} points`}</dd></div></dl>{summary.transfers.length ? <ul className="whatif-transfers">{summary.transfers.map((transfer, index) => <li key={`${transfer.originSiteId}-${transfer.destinationSiteId}-${index}`}><span>Site {transfer.originSiteId} → Site {transfer.destinationSiteId}</span><strong>{transfer.quantityEa} EA</strong><time>{transfer.arriveAt}</time></li>)}</ul> : <p className="quiet">{summary.status === "feasible" ? "No transfer is required." : "No feasible transfer proposal."}</p>}</section>;
}

export function WhatIfPanel({ workspace }: { workspace: Workspace }) {
  const shipments = useMemo(() => workspace.snapshot.shipments.filter((shipment) => shipment.status === "PROJECTED_INBOUND_NOT_RECEIVED"), [workspace.snapshot.shipments]);
  const targetCatalog = useMemo(() => workspace.snapshot.catalog.filter((item) => item.internalSku === workspace.snapshot.targetSku), [workspace.snapshot.catalog, workspace.snapshot.targetSku]);
  const qaCandidates = useMemo(() => workspace.snapshot.inventory.filter((row) => {
    const assessment = workspace.assessment.inventory.find((item) => item.entityId === row.id);
    return row.qaStatus === "UNVERIFIED" && !row.allocationHold && assessment?.recallMatch.status === "NOT_LISTED_IN_THIS_RECALL" &&
      row.internalSku === workspace.snapshot.targetSku && targetCatalog.length === 1 &&
      row.manufacturerRef?.trim().toUpperCase() === targetCatalog[0]!.manufacturerRef.trim().toUpperCase() &&
      row.manufacturerRef?.trim().toUpperCase() === workspace.snapshot.scope.manufacturerRef.trim().toUpperCase();
  }), [workspace.snapshot.inventory, workspace.assessment.inventory, workspace.snapshot.targetSku, workspace.snapshot.scope.manufacturerRef, targetCatalog]);
  const [shipmentId, setShipmentId] = useState(shipments[0]?.id ?? "");
  const [eta, setEta] = useState(shipments[0]?.eta ?? "");
  const [includeEta, setIncludeEta] = useState(shipments.length > 0);
  const [inventoryId, setInventoryId] = useState(qaCandidates[0]?.id ?? "");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [includeQa, setIncludeQa] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  useEffect(() => {
    setShipmentId(shipments[0]?.id ?? "");
    setEta(shipments[0]?.eta ?? "");
    setIncludeEta(shipments.length > 0);
    setInventoryId(qaCandidates[0]?.id ?? "");
    setIncludeQa(false);
  }, [workspace.incidentId, workspace.scenario, shipments, qaCandidates]);
  const baselineHash = workspace.assessment.inputFingerprint;
  const resultStale = !!result && result.snapshotHash !== baselineHash;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setRunning(true); setError(null);
    try {
      const input = {
        ...(includeEta ? { shipmentEta: [{ shipmentId, eta: eta.trim() }] } : {}),
        ...(includeQa ? { qaEvidence: [{ inventoryId, evidenceRef: evidenceRef.trim() }] } : {}),
      };
      const response = await fetch("/api/what-if", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(input) });
      const data = await response.json() as WhatIfResult | { error: string };
      if (!response.ok || "error" in data) throw new Error("error" in data ? data.error : `The comparison failed (${response.status}).`);
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The comparison failed.");
    } finally { setRunning(false); }
  };

  return <section className="panel whatif-panel">
    <div className="section-heading"><div><span className="eyebrow">Read-only scenario</span><h3>Explore one bounded change.</h3></div><span className="hypothetical-label">HYPOTHETICAL</span></div>
    <p className="quiet">Compare the deterministic response using an existing projected shipment ETA and/or an explicit QA evidence reference.</p>
    <form className="whatif-form" onSubmit={(event) => void submit(event)}>
      {shipments.length > 0 && <fieldset className="whatif-change"><legend><label className="whatif-toggle"><input type="checkbox" checked={includeEta} onChange={(event) => setIncludeEta(event.target.checked)} />Hypothesize a shipment ETA</label></legend><label>Existing projected shipment<select value={shipmentId} onChange={(event) => { const selected = shipments.find((item) => item.id === event.target.value); setShipmentId(event.target.value); setEta(selected?.eta ?? ""); }}>{shipments.map((shipment) => <option key={shipment.id} value={shipment.id}>{shipment.id} · {shipment.quantityEa} EA → Site {shipment.destinationSiteId}</option>)}</select></label><label>ETA (UTC ISO 8601)<input value={eta} onChange={(event) => setEta(event.target.value)} maxLength={40} spellCheck={false} disabled={!includeEta} /></label></fieldset>}
      {qaCandidates.length > 0 && <fieldset className="whatif-change"><legend><label className="whatif-toggle"><input type="checkbox" checked={includeQa} onChange={(event) => setIncludeQa(event.target.checked)} />Hypothesize QA evidence</label></legend><label>Unverified, unlisted inventory<select value={inventoryId} onChange={(event) => setInventoryId(event.target.value)}>{qaCandidates.map((row) => <option key={row.id} value={row.id}>{row.id} · Site {row.siteId} · {row.quantityEa} EA</option>)}</select></label><label>Explicit QA evidence reference<input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} maxLength={240} placeholder="Enter the evidence reference to test" disabled={!includeQa} /></label></fieldset>}
      {shipments.length === 0 && qaCandidates.length === 0 && <div className="inline-warning">This snapshot has no projected shipment or eligible unverified inventory to explore.</div>}
      <div className="whatif-submit-row"><span className="fine-print">A hypothesis does not record QA release, receive stock, or reserve transfers.</span><button type="submit" disabled={running || (!includeEta && !includeQa) || (includeEta && (!shipmentId || !eta.trim())) || (includeQa && (!inventoryId || !evidenceRef.trim()))}>{running ? "Comparing…" : "Run comparison"}</button></div>
    </form>
    {error && <p className="whatif-error" role="alert">{error}</p>}
    {result && <div className="whatif-result"><div className="whatif-result-top"><span className="hypothetical-label">{result.label}</span>{resultStale ? <span className="evidence-status evidence-status-stale">stale snapshot · rerun</span> : <span className="evidence-status evidence-status-current">current snapshot</span>}</div><p className="fine-print">Source fingerprint <code>{result.snapshotHash}</code>{resultStale && " differs from the current workspace snapshot."}</p><div className="whatif-comparison"><PlanSummary title="Baseline" summary={result.baseline} /><PlanSummary title="Hypothesis" summary={result.hypothesis} /></div><div className="whatif-delta"><span>Shortfall change</span><strong>{result.comparison.shortfallDeltaEa > 0 ? "+" : ""}{result.comparison.shortfallDeltaEa} EA</strong><span>Projected inbound change</span><strong>{result.comparison.projectedInboundDeltaEa > 0 ? "+" : ""}{result.comparison.projectedInboundDeltaEa} EA</strong></div><details className="flat-details"><summary>Conditions and assumptions<span className="detail-count">{result.assumptions.length}</span></summary><ul className="reason-list">{result.assumptions.map((line, index) => <li key={`${index}-${line}`}><LinkedAssumption text={line} workspace={workspace} /></li>)}</ul></details><p className="fine-print">Hypothetical result only. Recalculate the checked plan separately before considering sandbox approval.</p></div>}
  </section>;
}
