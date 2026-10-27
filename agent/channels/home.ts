import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineChannel, GET } from "eve/channels";
import { guardLocal } from "../../src/runtime/http.ts";

const headers = {"content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff"};
export default defineChannel({routes: [
  GET("/", async request => {
    guardLocal(request);
    try {return new Response(await readFile(resolve("web/dist/index.html"), "utf8"), {headers: {...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});}
    catch {return new Response("Build the interface with npm run build before opening this URL, or use the Vite development URL on port4318.", {status: 503});}
  }),
  GET("/assets/:file", async (request, {params}) => {
    guardLocal(request); const file = params.file;
    if (!/^[A-Za-z0-9_.-]+\.(js|css|svg)$/.test(file)) return new Response("Not found", {status: 404});
    try {
      const mime = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "image/svg+xml";
      return new Response(await readFile(resolve("web/dist/assets", file)), {headers: {...headers, "content-type": mime, "cache-control": "public, max-age=31536000, immutable"}});
    } catch {return new Response("Not found", {status: 404});}
  }),
]});
