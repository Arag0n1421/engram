import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { EvidenceEntry } from "../../src/shared/investigation.ts";
import type { Workspace } from "../../src/shared/workspace.ts";

type EvidenceScope = "current" | "bound";
type OpenRequest = { id: string; sourceHash?: string; scope: EvidenceScope; claim?: string; quote?: string };
type RegistryEntry = { entry: EvidenceEntry; scope: EvidenceScope };
type EvidenceContextValue = { open: (id: string, sourceHash?: string, scope?: EvidenceScope, claim?: string, quote?: string) => void };
const EvidenceContext = createContext<EvidenceContextValue | null>(null);

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function snapshotStatus(entry: EvidenceEntry | undefined, scope: EvidenceScope, workspace: Workspace): "bound" | "current" | "stale" | "unknown" {
  if (!entry || !entry.snapshotHash) return "unknown";
  if (scope === "bound" && entry.snapshotHash === workspace.agentRun.investigation?.snapshotHash) return "bound";
  if (entry.snapshotHash === workspace.assessment.inputFingerprint) return "current";
  if (entry.snapshotHash === workspace.agentRun.investigation?.snapshotHash) return "bound";
  return "stale";
}

export function EvidenceProvider({ workspace, children }: { workspace: Workspace; children: React.ReactNode }) {
  const [selection, setSelection] = useState<OpenRequest | null>(null);
  const entries = useMemo(() => [
    ...(workspace.evidenceRegistry?.entries.map((entry) => ({ entry, scope: "current" as const })) ?? []),
    ...(workspace.investigationEvidence?.entries.map((entry) => ({ entry, scope: "bound" as const })) ?? []),
  ], [workspace.evidenceRegistry, workspace.investigationEvidence]);
  const activeMatch = selection ? chooseEntry(entries, selection) : undefined;
  const activeEntry = activeMatch?.entry;
  const status = snapshotStatus(activeEntry, selection?.scope ?? "current", workspace);

  useEffect(() => {
    if (!selection) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelection(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selection]);

  return <EvidenceContext.Provider value={{ open: (id, sourceHash, scope = "current", claim, quote) => setSelection({ id, sourceHash, scope, claim, quote }) }}>
    {children}
    {selection && <div className="evidence-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelection(null); }}>
      <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-drawer-title">
        <div className="evidence-drawer-header"><div><span className="eyebrow">Evidence record</span><h2 id="evidence-drawer-title">{activeEntry?.title ?? selection.id}</h2></div><button className="secondary evidence-close" type="button" autoFocus onClick={() => setSelection(null)} aria-label="Close evidence">Close</button></div>
        {activeEntry ? <>
          <div className="evidence-drawer-status"><span className={`evidence-status evidence-status-${status}`}>{status === "bound" ? "bound snapshot" : `${status} snapshot`}</span><span className="quiet">{activeEntry.authority.replaceAll("-", " ")}</span></div>
          {selection?.scope === "bound" && status === "bound" && activeEntry.snapshotHash !== workspace.assessment.inputFingerprint && <p className="inline-warning" role="status">This evidence is bound to an older investigation snapshot than the current assessment.</p>}
          <dl className="evidence-drawer-facts">
            <div><dt>Source</dt><dd>{safeHttpUrl(activeEntry.sourceURL) ? <a href={safeHttpUrl(activeEntry.sourceURL)!} target="_blank" rel="noopener noreferrer">Open source in new tab ↗</a> : <span className="mono break-word">{activeEntry.sourceURL}</span>}</dd></div>
            <div><dt>Version</dt><dd className="mono">{activeEntry.version}</dd></div>
            <div><dt>Retrieved</dt><dd className="mono">{activeEntry.retrievedAt}</dd></div>
            <div><dt>Authority</dt><dd>{activeEntry.authority.replaceAll("-", " ")}</dd></div>
            <div><dt>Source hash</dt><dd className="mono break-word">{activeEntry.sourceHash}</dd></div>
            <div><dt>Snapshot hash</dt><dd className="mono break-word">{activeEntry.snapshotHash}</dd></div>
            <div className="wide"><dt>Reference aliases</dt><dd className="evidence-aliases">{activeEntry.refs.map((ref) => <EvidenceRef key={ref} id={ref} scope={selection.scope} />)}</dd></div>
          </dl>
          <section className="evidence-content-section"><span className="eyebrow">Stored source content</span><pre className="evidence-content">{activeEntry.content}</pre></section>
          {selection?.claim && <section className="evidence-link-context"><span className="eyebrow">Linked statement</span><p>{selection.claim}</p>{selection.quote && <blockquote><q>{selection.quote}</q></blockquote>}<p className="fine-print">The stored source text above is the evidence for this linked statement.</p></section>}
          {activeEntry.support && <p className="fine-print">{activeEntry.support}</p>}
        </> : <div className="evidence-unknown" role="status"><strong>{selection.sourceHash ? "Evidence hash mismatch" : "Unknown evidence reference"}</strong><p>{selection.sourceHash ? <>No record for <code>{selection.id}</code> matches the requested source hash.</> : <>No source record resolves for <code>{selection.id}</code>.</>}</p>{selection.sourceHash && <p>Requested source hash: <code className="break-word">{selection.sourceHash}</code></p>}<span className={`evidence-status evidence-status-${selection.sourceHash ? "stale" : "unknown"}`}>{selection.sourceHash ? "stale source hash" : "unknown snapshot"}</span></div>}
      </aside>
    </div>}
  </EvidenceContext.Provider>;
}

function chooseEntry(entries: RegistryEntry[], selection: OpenRequest): RegistryEntry | undefined {
  const matches = entries.filter(({ entry, scope }) => (selection.scope === "bound" ? scope === "bound" : scope === "current") && (entry.id === selection.id || entry.refs.includes(selection.id)));
  if (selection.sourceHash) {
    return matches.find(({ entry }) => entry.sourceHash === selection.sourceHash);
  }
  return matches.find(({ entry }) => entry.id === selection.id) ?? matches[0];
}

export function EvidenceRef({ id, sourceHash, scope, claim, className }: { id: string; sourceHash?: string; scope?: EvidenceScope; claim?: string; className?: string }) {
  const context = useContext(EvidenceContext);
  return <button type="button" className={`evidence-ref ${className ?? ""}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); context?.open(id, sourceHash, scope, claim); }} title={`Inspect evidence reference ${id}`}>{id}</button>;
}

export function EvidenceCitation({ id, quote, sourceHash, claim }: { id: string; quote: string; sourceHash: string; claim: string }) {
  const context = useContext(EvidenceContext);
  return <button type="button" className="evidence-quote" onClick={() => context?.open(id, sourceHash, "bound", claim, quote)}><span className="evidence-quote-source">{id}</span><q>{quote}</q><span className="evidence-quote-action">Inspect source ↗</span></button>;
}
