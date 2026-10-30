// Shared Meta Model API plumbing: .env loading, auth, Chat Completions,
// sequential retry on 429, latency measurement, cost estimates.
//
// API contract (checked 2026-10-29 against https://dev.meta.ai/products/meta-model-api
// and https://dev.meta.ai/docs/overview, plus the meta-model-cookbook):
// - Base URL: https://api.meta.ai/v1
// - Auth: Authorization: Bearer <key> (dashboard calls it MODEL_API_KEY;
//   we read META_API_KEY first, MODEL_API_KEY as fallback)
// - Vision: POST /v1/chat/completions, OpenAI-compatible, model muse-spark-1.3
// - Pricing (standard tier): $1.25/1M input, $4.25/1M output, $0.15/1M cached input

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, TokenUsage } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_VISION_MODEL = "muse-spark-1.3";
export const DEFAULT_ASR_MODEL = "muse-voice-transcribe-1.0";

/** USD per 1M tokens. Standard tier covers muse-spark-1.3/1.2/1.1. */
const VISION_RATES = {
  standard: { input: 1.25, output: 4.25, cached: 0.15 },
  contributor: { input: 0.1, output: 0.2, cached: 0.002 },
};

const MAX_RETRIES = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/** Minimal .env parser (no dependency): KEY=VALUE, ignores blanks and # comments. */
export function loadDotEnv(dir: string): void {
  const path = join(dir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

export function getConfig(limit: number): RunContext {
  const apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "Missing API key: set META_API_KEY in .env (get one at https://dev.meta.ai/). " +
        "MODEL_API_KEY is also accepted."
    );
  }
  return {
    apiKey,
    baseUrl: (process.env.META_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    visionModel: process.env.META_VISION_MODEL || DEFAULT_VISION_MODEL,
    asrModel: process.env.META_ASR_MODEL || DEFAULT_ASR_MODEL,
    limit,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    if (/^\d+$/.test(header.trim())) return Math.min(Number(header) * 1000, 60000);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 60000));
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

export interface FetchOutcome {
  res: Response;
  attempts: number;
  /** ms of the final attempt's round-trip. */
  latencyMs: number;
}

/**
 * Sequential fetch with retry on 429 only. Honors Retry-After, else
 * exponential backoff (1s..16s). Throws on network errors, on 429 after
 * MAX_RETRIES, and on other non-2xx with a body snippet.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string
): Promise<FetchOutcome> {
  let lastLatency = 0;
  for (let attempt = 0; ; attempt++) {
    const start = Date.now();
    const res = await fetch(url, init);
    lastLatency = Date.now() - start;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = retryDelayMs(res, attempt);
      console.log(`  [429] ${label}: retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms`);
      await res.arrayBuffer().catch(() => undefined);
      await sleep(wait);
      continue;
    }
    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP 429 after ${attempt + 1} attempts: ${body.slice(0, 300)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return { res, attempts: attempt + 1, latencyMs: lastLatency };
  }
}

interface ChatMessage {
  role: "user";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
}

export interface ChatOutcome {
  text: string;
  usage?: TokenUsage;
  latencyMs: number;
  attempts: number;
}

/** One OpenAI-compatible Chat Completions call with an image + text. */
export async function chatCompletions(
  ctx: RunContext,
  prompt: string,
  dataUrl: string,
  opts: { maxTokens: number; jsonMode: boolean; label: string }
): Promise<ChatOutcome> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const body: Record<string, unknown> = {
    model: ctx.visionModel,
    messages,
    max_tokens: opts.maxTokens,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  const { res, attempts, latencyMs } = await fetchWithRetry(
    `${ctx.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    opts.label
  );
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const content = json.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
            .join("")
        : "";
  const u = json.usage;
  const usage: TokenUsage | undefined = u
    ? {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        cachedTokens: u.prompt_tokens_details?.cached_tokens,
      }
    : undefined;
  return { text, usage, latencyMs, attempts };
}

/** Docs-based cost estimate. The API does not return cost, so this is never billed cost. */
export function estimateVisionCost(model: string, usage?: TokenUsage): number | undefined {
  if (!usage) return undefined;
  const rates = model.includes("contributor")
    ? VISION_RATES.contributor
    : VISION_RATES.standard;
  const cached = usage.cachedTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - cached);
  return (fresh * rates.input + cached * rates.cached + usage.completionTokens * rates.output) / 1e6;
}

export function formatUsd(v: number | undefined): string {
  if (v === undefined) return "n/a";
  return `$${v.toFixed(v >= 1 ? 4 : 6)}`;
}
