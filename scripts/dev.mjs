import { spawn } from "node:child_process";
if (Number(process.versions.node.split(".")[0]) !== 24) {
  console.error("RecallOps uses Node 24. Run with Node 24, or: npx --package=node@24 npm run dev"); process.exit(1);
}
const children = [
  spawn(process.execPath, ["node_modules/eve/bin/eve.js", "dev", "--no-ui", "--no-default-extensions", "--host", "127.0.0.1", "--port", "4317"], {stdio: "inherit"}),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4318"], {stdio: "inherit"}),
];
let stopping = false;
function stop(code = 0) {if (stopping) return; stopping = true; process.exitCode = code; for (const child of children) child.kill("SIGTERM"); setTimeout(() => process.exit(code), 300).unref();}
process.on("SIGINT", () => stop()); process.on("SIGTERM", () => stop());
for (const child of children) {child.on("error", error => {console.error(error.message); stop(1);}); child.on("exit", code => stop(code ?? 0));}
