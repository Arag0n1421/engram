import { defineAgent, defineDynamic } from "eve";
import { meterlessConfig, store } from "../src/runtime/app.ts";
import { boundMeterlessModel } from "../src/runtime/model.ts";

export default defineAgent({
  model: defineDynamic({events: {
    "step.started": (_event, ctx) => {
      const runId = ctx.channel.metadata?.runId;
      if (ctx.channel.kind !== "channel:ops" || typeof runId !== "string" || !meterlessConfig) throw new Error("A configured model and trusted operations investigation are required");
      return {model: boundMeterlessModel(runId, meterlessConfig, store), modelContextWindowTokens: Number(process.env.METERLESS_CONTEXT_TOKENS ?? 32_768)};
    },
  }}),
  defaultTools: false, tool: false,
  limits: {sessionUsage: ({window}) => window.inputTokens >= 256_000 || window.outputTokens >= 48_000},
});
