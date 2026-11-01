#!/usr/bin/env node
// Probe: does Muse Spark support native tool calling? Makes ONE live call
// with a trivial tools definition and reports whether the model returns
// tool_calls. JSON-action mode stays the default either way; native tools
// are only wired up if this probe passes (AGENT_TOOL_MODE=native).
// Usage (from apps/server): META_API_KEY=... node scripts/probe-tools.mjs
// Reads AGENT_MODEL (default muse-spark-1.3) and META_BASE_URL like the agent.
import OpenAI from "openai";

async function main() {
  const baseURL = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
  const model = process.env.AGENT_MODEL ?? process.env.META_MODEL ?? "muse-spark-1.3";
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    console.error("META_API_KEY is required for the live tool probe");
    process.exit(2);
  }
  const client = new OpenAI({ baseURL, apiKey });
  console.log(`probing model=${model} baseURL=${baseURL}`);
  const res = await client.chat.completions.create({
    model,
    max_tokens: 200,
    reasoning_effort: "minimal",
    messages: [{ role: "user", content: "What time is it? Use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Returns the current time.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: "auto",
  });
  const message = res.choices[0]?.message;
  const calls = message?.tool_calls ?? [];
  console.log(`finish_reason: ${res.choices[0]?.finish_reason ?? "?"}`);
  console.log(`content: ${JSON.stringify(message?.content)}`);
  console.log(`tool_calls: ${JSON.stringify(calls)}`);
  if (calls.length > 0) {
    console.log("REPORT: native tool_calls SUPPORTED by this endpoint");
  } else {
    console.log("REPORT: native tool_calls NOT returned (stay on AGENT_TOOL_MODE=json)");
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
