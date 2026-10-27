import { WorkspaceError } from "./store.ts";
const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function guardLocal(request: Request): void {
  const url = new URL(request.url);
  if (!hosts.has(url.hostname)) throw new WorkspaceError("Engram is a local demo. Remote access is disabled.", 403);
  const origin = request.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {parsed = new URL(origin);} catch {throw new WorkspaceError("Invalid origin", 403);}
    if (!hosts.has(parsed.hostname) || !["4317", "4318"].includes(parsed.port)) throw new WorkspaceError("Origin is not permitted", 403);
  }
  if (request.method === "POST" && !request.headers.get("content-type")?.startsWith("application/json")) throw new WorkspaceError("Send application/json", 415);
}
export async function readBody(request: Request): Promise<unknown> {
  guardLocal(request);
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) throw new WorkspaceError("Request too large", 413);
  const reader = request.body?.getReader(); let text = ""; let size = 0; const decoder = new TextDecoder();
  if (!reader) return {};
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 16_384) {await reader.cancel(); throw new WorkspaceError("Request too large", 413);}
    text += decoder.decode(chunk.value, {stream: true});
  }
  text += decoder.decode();
  try {return JSON.parse(text);} catch {throw new WorkspaceError("Invalid JSON body", 400);}
}
export async function respond(operation: () => Promise<unknown>): Promise<Response> {
  try {return Response.json(await operation(), {headers: {"cache-control": "no-store"}});}
  catch (error) {
    if (error instanceof WorkspaceError) return Response.json({error: error.message}, {status: error.status});
    if (error instanceof Error && error.name === "ZodError") return Response.json({error: "Request fields do not match the expected schema."}, {status: 400});
    // Server-side diagnostics only: bounded name/message, never request bodies or credentials.
    console.error("[engram] unhandled operation error:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 500)}` : typeof error);
    return Response.json({error: "The operation failed. Check local configuration and server diagnostics; no success is assumed."}, {status: 500});
  }
}
