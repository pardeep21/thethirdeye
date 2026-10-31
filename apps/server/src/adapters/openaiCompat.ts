// OpenAI-compatible vision provider: one client for the Meta Model API,
// OpenRouter-served Muse, plain OpenAI, or a local Ollama server.
// Base URL, model and key come from env (see factory). Debug files (eval)
// capture the raw request/response of every call for diagnosis.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { Denomination, TriagePerson, TriageResult } from "../protocol.js";
import type { NamedTriage, VisionAnswer } from "./index.js";

/** Triage token budget: 400 leaves room for reasoning + JSON (was 80). */
export const DEFAULT_TRIAGE_MAX_TOKENS = 400;
export const ANSWER_MAX_TOKENS = 150;

export function triageMaxTokensFromEnv(): number {
  const raw = process.env.TRIAGE_MAX_TOKENS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    throw new Error(`TRIAGE_MAX_TOKENS=${raw} must be a positive integer`);
  }
  return DEFAULT_TRIAGE_MAX_TOKENS;
}

export const TRIAGE_SYSTEM_PROMPT = [
  "You are a vision module for a blind shopkeeper's assistant.",
  "Look at the image and return ONLY a JSON object with this exact shape, no other text:",
  '{"notes":[{"denomination":10|20|50|100|200|500|null,"confidence":0-1}],"people":[{"position":"left"|"centre"|"right","distance":"near"|"far","gender":"man"|"woman"|null,"age_range":"<like 20s or 60+ or null>","action":"<short, e.g. handing a note, or null>"}]}',
  "Rules: Indian rupee notes only, both old Mahatma Gandhi series and new series; use null denomination with confidence below 0.6 when a note-like object is unclear (never guess the value); confidence is your certainty 0..1; omit people you cannot see; never name anyone.",
].join(" ");

const DENOMS: Denomination[] = [10, 20, 50, 100, 200, 500];

/**
 * Extract the first JSON object from model output: direct parse, then
 * ```json/``` fences, then a balanced-brace scan from the first '{'
 * (string- and escape-aware). Throws when nothing parses.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to fence/scan extraction.
    }
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // Fall through to the brace scan on the fenced body.
      const inner = scanFirstObject(fence[1]);
      if (inner !== null) return JSON.parse(inner);
      throw new Error("triage output is not JSON");
    }
  }
  const scanned = scanFirstObject(trimmed);
  if (scanned === null) throw new Error("triage output is not JSON");
  try {
    return JSON.parse(scanned);
  } catch {
    throw new Error("triage output is not JSON");
  }
}

function scanFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Strict validation of parsed JSON against TriageResult; throws on violation. */
export function validateTriageResult(obj: unknown): TriageResult {
  if (typeof obj !== "object" || obj === null) throw new Error("triage output must be an object");
  const root = obj as Record<string, unknown>;
  const notesRaw = root.notes ?? [];
  const peopleRaw = root.people ?? [];
  if (!Array.isArray(notesRaw)) throw new Error("triage.notes must be an array");
  if (!Array.isArray(peopleRaw)) throw new Error("triage.people must be an array");

  const notes = notesRaw.map((n, i) => {
    if (typeof n !== "object" || n === null) throw new Error(`triage.notes[${i}] must be an object`);
    const rec = n as Record<string, unknown>;
    const d = rec.denomination;
    if (d !== null && (typeof d !== "number" || !DENOMS.includes(d as Denomination))) {
      throw new Error(`triage.notes[${i}].denomination must be 10|20|50|100|200|500|null`);
    }
    const c = rec.confidence;
    if (typeof c !== "number" || Number.isNaN(c)) {
      throw new Error(`triage.notes[${i}].confidence must be a number`);
    }
    return { denomination: d as Denomination | null, confidence: Math.min(1, Math.max(0, c)) };
  });

  const people: TriagePerson[] = peopleRaw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`triage.people[${i}] must be an object`);
    const rec = p as Record<string, unknown>;
    if (rec.position !== "left" && rec.position !== "centre" && rec.position !== "right") {
      throw new Error(`triage.people[${i}].position must be left|centre|right`);
    }
    if (rec.distance !== "near" && rec.distance !== "far") {
      throw new Error(`triage.people[${i}].distance must be near|far`);
    }
    const person: TriagePerson = { position: rec.position, distance: rec.distance };
    if (rec.gender !== undefined && rec.gender !== null) {
      if (rec.gender !== "man" && rec.gender !== "woman") {
        throw new Error(`triage.people[${i}].gender must be man|woman|null`);
      }
      person.gender = rec.gender;
    }
    if (rec.age_range !== undefined && rec.age_range !== null) {
      if (typeof rec.age_range !== "string") throw new Error(`triage.people[${i}].age_range must be a string`);
      person.age_range = rec.age_range;
    }
    if (rec.action !== undefined && rec.action !== null) {
      if (typeof rec.action !== "string") throw new Error(`triage.people[${i}].action must be a string`);
      person.action = rec.action;
    }
    return person;
  });

  return { notes, people };
}

/** Extract + validate in one step (kept for callers and tests). */
export function parseTriageResult(text: string): TriageResult {
  return validateTriageResult(extractJsonObject(text));
}

export interface OpenAICompatOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** Flat reasoning_effort (Meta docs); omitted when undefined. */
  reasoningEffort?: string;
  /** When set, every call writes a raw request/response log here. */
  debugDir?: string;
}

export interface DebugAttempt {
  request: Record<string, unknown>;
  latencyMs: number;
  response: {
    content: string;
    reasoningContent: unknown;
    finishReason: unknown;
    usage: unknown;
  } | null;
  error: string | null;
}

export interface DebugFile {
  label: string;
  model: string;
  at: string;
  attempts: DebugAttempt[];
  parsed: boolean;
  parseError: string | null;
  usage: unknown;
}

export function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "call";
}

export class OpenAICompatTriage implements NamedTriage {
  readonly name: string;
  readonly maxTokens: number;
  readonly reasoningEffort: string | undefined;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly debugDir: string | undefined;
  private lastUsage: { promptTokens: number; completionTokens: number } | undefined;

  constructor(opts: OpenAICompatOptions, client?: OpenAI) {
    this.client = client ?? new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.name = `openai-compat:${opts.model}`;
    this.maxTokens = opts.maxTokens ?? DEFAULT_TRIAGE_MAX_TOKENS;
    this.reasoningEffort = opts.reasoningEffort;
    this.debugDir = opts.debugDir;
    this.lastUsage = undefined;
  }

  async triage(img: Buffer, debugLabel?: string): Promise<TriageResult> {
    const dataUrl = toDataUrl(img);
    const attempts: DebugAttempt[] = [];
    const baseRequest = {
      model: this.model,
      max_tokens: this.maxTokens,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRIAGE_SYSTEM_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    } as Record<string, unknown>;

    const runOnce = async (withJsonMode: boolean): Promise<string> => {
      const params = withJsonMode
        ? { ...baseRequest, response_format: { type: "json_object" } }
        : baseRequest;
      const start = Date.now();
      try {
        // Non-streaming (stream unset): narrow the overloaded union result.
        const res = (await this.client.chat.completions.create(
          params as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0]
        )) as ChatCompletion;
        const message = res.choices[0]?.message as
          | { content?: unknown; reasoning_content?: unknown }
          | undefined;
        const finish = res.choices[0]?.finish_reason ?? null;
        const content = typeof message?.content === "string" ? message.content : "";
        const u = res.usage as unknown;
        this.lastUsage = res.usage
          ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
          : undefined;
        attempts.push({
          request: debugRequest(params, img.length, dataUrl),
          latencyMs: Date.now() - start,
          response: {
            content,
            reasoningContent: message?.reasoning_content ?? null,
            finishReason: finish,
            usage: u ?? null,
          },
          error: null,
        });
        return content;
      } catch (err) {
        attempts.push({
          request: debugRequest(params, img.length, dataUrl),
          latencyMs: Date.now() - start,
          response: null,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    let text: string;
    try {
      try {
        text = await runOnce(true);
      } catch (err) {
        // Fall back to prompt-only JSON when the endpoint rejects json_object.
        if (isJsonModeError(err)) {
          text = await runOnce(false);
        } else {
          throw err;
        }
      }
      const result = parseTriageResult(text);
      this.writeDebug(debugLabel, attempts, true, null);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeDebug(debugLabel, attempts, false, message);
      throw err;
    }
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastUsage;
  }

  private writeDebug(
    debugLabel: string | undefined,
    attempts: DebugAttempt[],
    parsed: boolean,
    parseError: string | null
  ): void {
    if (!this.debugDir || !debugLabel) return;
    const last = [...attempts].reverse().find((a) => a.response);
    const file: DebugFile = {
      label: debugLabel,
      model: this.model,
      at: new Date().toISOString(),
      attempts,
      parsed,
      parseError,
      usage: last?.response?.usage ?? null,
    };
    mkdirSync(this.debugDir, { recursive: true });
    writeFileSync(join(this.debugDir, `${sanitizeLabel(debugLabel)}.json`), JSON.stringify(file, null, 2));
  }
}

function isJsonModeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json mode/i.test(msg);
}

function toDataUrl(img: Buffer): string {
  return `data:image/jpeg;base64,${img.toString("base64")}`;
}

function debugRequest(params: Record<string, unknown>, imgBytes: number, dataUrl: string): Record<string, unknown> {
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    response_format: params.response_format ?? null,
    reasoning_effort: params.reasoning_effort ?? null,
    prompt: TRIAGE_SYSTEM_PROMPT,
    image: { bytes: imgBytes, dataUrlLength: dataUrl.length, dataUrlPrefix: dataUrl.slice(0, 80) },
  };
}

export class OpenAICompatAnswer implements VisionAnswer {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAICompatOptions, client?: OpenAI) {
    this.client = client ?? new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
  }

  private async ask(img: Buffer, prompt: string, maxTokens: number): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: toDataUrl(img) } },
          ],
        },
      ],
    });
    return (res.choices[0]?.message?.content ?? "").trim();
  }

  async describe(img: Buffer, q: string): Promise<string> {
    return this.ask(
      img,
      `Describe this shop photo for a blind shopkeeper in under 15 words. Question: ${q}`,
      ANSWER_MAX_TOKENS
    );
  }

  async read(img: Buffer): Promise<string> {
    return this.ask(
      img,
      "Read the key text on this label: product name, price, expiry date first. Short answer.",
      ANSWER_MAX_TOKENS
    );
  }
}
