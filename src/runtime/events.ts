export function textOf(message: unknown): string {
  if (typeof message === "string") return message.slice(0, 24_000);
  if (Array.isArray(message)) return message.map(textOf).filter(Boolean).join("\n").slice(0, 24_000);
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (m.type === "text" && typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) return textOf(m.content);
    if (Array.isArray(m.parts)) return textOf(m.parts);
  }
  return "";
}
export async function applyMessageEvent(event: {finishReason?: string; message?: unknown}, runId: string, target: {finishInvestigation(runId: string, summary: string, error?: string): Promise<void>}, finalize?: (raw: string) => Promise<void>) {
  if (event.finishReason === "stop") {
    if (finalize) await finalize(textOf(event.message));
    else await target.finishInvestigation(runId, textOf(event.message));
  }
  else if (event.finishReason === "length") await target.finishInvestigation(runId, textOf(event.message), "Model output reached its limit; the investigation did not finish.");
}

/** A completed turn without a terminal text block must not leave the run active. */
export async function applyTurnCompletedEvent(runId: string, target: {failUnfinalizedTurn(runId: string): Promise<boolean>}): Promise<boolean> {
  return target.failUnfinalizedTurn(runId);
}
