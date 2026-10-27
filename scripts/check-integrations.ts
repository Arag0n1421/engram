import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configurationSummary, loadIntegrationConfig, MeterlessClient, safeError, ZetarisClient,
  type MeterlessCallEvidence,
} from "../src/integrations/index.ts";

export interface CheckOptions {
  checkReadOnly: boolean;
  allowInference: boolean;
  requireNemotronEvidence?: boolean;
  output: string;
}

export function parseCheckArguments(args: string[]): CheckOptions {
  const options: CheckOptions = { checkReadOnly: false, allowInference: false, output: resolve("work/integration-evidence.json") };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check-read-only") options.checkReadOnly = true;
    else if (arg === "--allow-inference") options.allowInference = true;
    else if (arg === "--require-nemotron-evidence") options.requireNemotronEvidence = true;
    else if (arg === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) options.output = resolve(args[++index]);
    else throw new Error("Usage: check-integrations.ts [--check-read-only] [--allow-inference] [--require-nemotron-evidence] [--output path]");
  }
  if (options.requireNemotronEvidence && !options.allowInference) throw new Error("--require-nemotron-evidence requires --allow-inference");
  return options;
}

/** Config-only by default. --allow-inference explicitly authorizes exactly the two-call smoke check. */
export async function checkIntegrations(options: CheckOptions, env: NodeJS.ProcessEnv = process.env) {
  const configuration = loadIntegrationConfig(env);
  const checks: Record<string, unknown> = {};
  let failed = configuration.meterless.status !== "ready" || configuration.zetaris.status !== "ready";
  if (options.checkReadOnly) {
    if (configuration.meterless.status === "ready") {
      try {
        const result = await new MeterlessClient(configuration.meterless.config).listModels();
        const listed = result.modelIds.includes(configuration.meterless.config.model);
        if (!listed || result.runtimeStatus !== "online") failed = true;
        checks.meterlessCatalog = { status: listed && result.runtimeStatus === "online" ? "passed" : "not_verified", runtimeStatus: result.runtimeStatus, modelCount: result.modelIds.length, configuredModelListed: listed, evidence: result.evidence, limitation: "Routing IDs do not establish an underlying Nemotron model, inference capability or quota" };
      } catch (error) { failed = true; checks.meterlessCatalog = { status: "failed", error: safeError(error) }; }
    } else checks.meterlessCatalog = { status: "skipped", reason: configuration.meterless.status };
    if (configuration.zetaris.status === "ready") {
      const client = new ZetarisClient(configuration.zetaris.config);
      try { checks.zetarisDatasources = { status: "passed", ...await client.listDatasources() }; }
      catch (error) { failed = true; checks.zetarisDatasources = { status: "failed", error: safeError(error) }; }
      try { checks.zetarisSelectOne = await client.checkConnection(); }
      catch (error) { failed = true; checks.zetarisSelectOne = { status: "failed", error: safeError(error) }; }
    } else checks.zetarisSelectOne = { status: "skipped", reason: configuration.zetaris.status };
  }
  if (options.allowInference) {
    if (configuration.meterless.status === "ready") {
      const calls: MeterlessCallEvidence[] = [];
      try { checks.meterlessToolRoundTrip = await new MeterlessClient(configuration.meterless.config).smokeToolRoundTrip({ onCallEvidence: (entry) => calls.push(entry), requireNemotronEvidence: options.requireNemotronEvidence }); }
      catch (error) { failed = true; checks.meterlessToolRoundTrip = { status: "failed", calls, error: safeError(error) }; }
    } else checks.meterlessToolRoundTrip = { status: "skipped", reason: configuration.meterless.status };
  } else checks.meterlessToolRoundTrip = { status: "not_run", reason: "Inference is disabled unless --allow-inference is passed; no successful model call is claimed" };
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: failed ? "incomplete" : options.checkReadOnly || options.allowInference ? "checks_passed" : "configuration_ready_only",
    mode: { checkReadOnly: options.checkReadOnly, inferenceAllowed: options.allowInference, requireNemotronEvidence: options.requireNemotronEvidence ?? false },
    configuration: configurationSummary(configuration),
    checks,
    limitation: "This evidence covers only the checks explicitly requested; it is not a workflow, account-identity, award-eligibility or full-dataset verification",
  };
}

async function main(): Promise<void> {
  const options = parseCheckArguments(process.argv.slice(2));
  const evidence = await checkIntegrations(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status === "incomplete") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("Integration checker could not complete or save its evidence. Provider details and credentials are omitted.\n");
    process.exitCode = 1;
  });
}
