// Conversational agent brain (prompt 02, Track B): one utterance becomes
// one spoken answer. JSON-action mode is the default; native tool calling
// only if scripts/probe-tools.mjs passes on Spark (AGENT_TOOL_MODE).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import sharp from "sharp";
import type { AgentPosition } from "../clock.js";
import type { SpeakLang, SpokenScript } from "../protocol.js";
import type { SceneState, Turn } from "../session.js";
import { AGENT_PROMPT_VERSION, buildAgentSystemPrompt, buildSceneBlock } from "../prompts/agent.js";
import { extractJsonObject, isJsonModeError, sanitizeLabel } from "./openaiCompat.js";

export type AgentAction =
  | { tool: "look_around"; on: boolean }
  | { tool: "remember_person"; ref: string | null; name: string }
  | { tool: "confirm_consent"; name: string; granted: boolean }
  | { tool: "forget_person"; name: string }
  | { tool: "mute"; on: boolean }
  | { tool: "cash_check" }
  | { tool: "find"; noun: string };

export interface AgentInput {
  history: Turn[];
  utterance: string;
  /** Absent when no fresh frame arrived and the last frame is stale. */
  image?: { jpeg: Buffer; hfovDeg: number };
  scene: SceneState;
  lang: SpeakLang;
  script: SpokenScript;
}

export interface AgentOutput {
  /** Spoken line; may contain {pos:N} placeholders. Null = action only. */
  say: string | null;
  positions: AgentPosition[];
  actions: AgentAction[];
  /** Full label text when reading (key text first); "hor" continues it. */
  readText?: string;
}

export interface AgentBrain {
  respond(input: AgentInput): Promise<AgentOutput>;
  getLastUsage?: () => { promptTokens: number; completionTokens: number } | undefined;
  /** Cost of the last call in USD, or null when unknown (mock). */
  getLastCostUsd?: () => number | null;
}

/** Strict validation of parsed model JSON against AgentOutput; throws. */
export function parseAgentOutput(text: string): AgentOutput {
  let obj: unknown;
  try {
    obj = extractJsonObject(text);
  } catch {
    throw new Error("agent output is not JSON");
  }
  if (typeof obj !== "object" || obj === null) throw new Error("agent output must be an object");
  const root = obj as Record<string, unknown>;

  const say = root.say === undefined ? null : root.say;
  if (say !== null && typeof say !== "string") throw new Error("agent.say must be a string or null");

  const positionsRaw = root.positions === undefined ? [] : root.positions;
  if (!Array.isArray(positionsRaw)) throw new Error("agent.positions must be an array");
  const positions: AgentPosition[] = positionsRaw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`agent.positions[${i}] must be an object`);
    const rec = p as Record<string, unknown>;
    if (typeof rec.x !== "number" || !Number.isFinite(rec.x)) {
      throw new Error(`agent.positions[${i}].x must be a number`);
    }
    if (typeof rec.y !== "number" || !Number.isFinite(rec.y)) {
      throw new Error(`agent.positions[${i}].y must be a number`);
    }
    const pos: AgentPosition = {
      x: Math.min(1, Math.max(0, rec.x)),
      y: Math.min(1, Math.max(0, rec.y)),
    };
    if (rec.distance !== undefined && rec.distance !== null) {
      if (rec.distance !== "near" && rec.distance !== "mid" && rec.distance !== "far") {
        throw new Error(`agent.positions[${i}].distance must be near|mid|far`);
      }
      pos.distance = rec.distance;
    }
    return pos;
  });

  const actionsRaw = root.actions === undefined ? [] : root.actions;
  if (!Array.isArray(actionsRaw)) throw new Error("agent.actions must be an array");
  const actions: AgentAction[] = actionsRaw.map((a, i) => parseAction(a, i));

  const readText = root.readText === undefined ? undefined : root.readText;
  if (readText !== undefined && typeof readText !== "string") {
    throw new Error("agent.readText must be a string");
  }
  return readText === undefined ? { say, positions, actions } : { say, positions, actions, readText };
}

function parseAction(a: unknown, i: number): AgentAction {
  if (typeof a !== "object" || a === null) throw new Error(`agent.actions[${i}] must be an object`);
  const rec = a as Record<string, unknown>;
  const at = `agent.actions[${i}]`;
  switch (rec.tool) {
    case "look_around":
      if (typeof rec.on !== "boolean") throw new Error(`${at}.on must be a boolean`);
      return { tool: "look_around", on: rec.on };
    case "remember_person":
      if (rec.ref !== null && typeof rec.ref !== "string") {
        throw new Error(`${at}.ref must be a string or null`);
      }
      if (typeof rec.name !== "string" || !rec.name.trim()) {
        throw new Error(`${at}.name must be a non-empty string`);
      }
      return { tool: "remember_person", ref: rec.ref, name: rec.name };
    case "confirm_consent":
      if (typeof rec.name !== "string" || !rec.name.trim()) {
        throw new Error(`${at}.name must be a non-empty string`);
      }
      if (typeof rec.granted !== "boolean") throw new Error(`${at}.granted must be a boolean`);
      return { tool: "confirm_consent", name: rec.name, granted: rec.granted };
    case "forget_person":
      if (typeof rec.name !== "string" || !rec.name.trim()) {
        throw new Error(`${at}.name must be a non-empty string`);
      }
      return { tool: "forget_person", name: rec.name };
    case "mute":
      if (typeof rec.on !== "boolean") throw new Error(`${at}.on must be a boolean`);
      return { tool: "mute", on: rec.on };
    case "cash_check":
      return { tool: "cash_check" };
    case "find":
      if (typeof rec.noun !== "string" || !rec.noun.trim()) {
        throw new Error(`${at}.noun must be a non-empty string`);
      }
      return { tool: "find", noun: rec.noun };
    default:
      throw new Error(`${at}.tool is unknown: ${JSON.stringify(rec.tool)}`);
  }
}

export type MockAgentScript = Array<AgentOutput | Error>;

export const DEFAULT_MOCK_AGENT_OUTPUT: AgentOutput = {
  say: "Mock saamne: counter te samaan {pos:0}",
  positions: [{ x: 0.5, y: 0.5 }],
  actions: [],
};

export class MockAgentBrain implements AgentBrain {
  private i = 0;
  /** Every input received, for integration tests. Buffers stay in memory. */
  readonly inputs: AgentInput[] = [];

  constructor(private readonly script: MockAgentScript = [DEFAULT_MOCK_AGENT_OUTPUT]) {}

  async respond(input: AgentInput): Promise<AgentOutput> {
    this.inputs.push(input);
    const next = this.script[this.i % this.script.length] ?? DEFAULT_MOCK_AGENT_OUTPUT;
    this.i++;
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }

  getLastUsage(): undefined {
    return undefined;
  }

  getLastCostUsd(): null {
    return null;
  }
}

export const DEFAULT_AGENT_MODEL = "muse-spark-1.3";
export const DEFAULT_AGENT_MAX_TOKENS = 600;
export const DEFAULT_AGENT_IMAGE_PX = 640;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}=${raw} must be a positive integer`);
  return n;
}

export function agentModelFromEnv(fallback: string = DEFAULT_AGENT_MODEL): string {
  return process.env.AGENT_MODEL ?? fallback;
}

export function agentMaxTokensFromEnv(): number {
  return positiveIntFromEnv("AGENT_MAX_TOKENS", DEFAULT_AGENT_MAX_TOKENS);
}

export function agentImagePxFromEnv(): number {
  return positiveIntFromEnv("AGENT_IMAGE_PX", DEFAULT_AGENT_IMAGE_PX);
}

export type AgentToolMode = "json" | "native";

export function agentToolModeFromEnv(): AgentToolMode {
  const raw = (process.env.AGENT_TOOL_MODE ?? "json").toLowerCase();
  if (raw === "json" || raw === "native") return raw;
  throw new Error(`AGENT_TOOL_MODE=${raw} unknown (expected json|native)`);
}

export function agentReasoningEffortFromEnv(): string | undefined {
  const raw = (process.env.AGENT_REASONING_EFFORT ?? "minimal").toLowerCase();
  if (raw === "off" || raw === "unset") return undefined;
  return process.env.AGENT_REASONING_EFFORT ?? "minimal";
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default debug dir: the eval debug folder next to the server checkout. */
export function defaultAgentDebugDir(): string {
  return join(HERE, "..", "..", "..", "eval", "debug");
}

export function agentDebugDirFromEnv(): string | undefined {
  const raw = process.env.AGENT_DEBUG_DIR;
  if (raw === "") return undefined; // explicit opt-out
  return raw ?? defaultAgentDebugDir();
}

/** USD per 1M tokens (standard tier; contributor is dev-only per MVP.md). */
const AGENT_PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "muse-spark-1.3": { in: 1.25, out: 4.25 },
  "muse-spark-1.3-contributor": { in: 0.1, out: 0.2 },
};

export function agentCostUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number } | undefined
): number | null {
  const price = AGENT_PRICE_PER_MTOK[model];
  if (!price || !usage) return null;
  return (usage.promptTokens * price.in + usage.completionTokens * price.out) / 1e6;
}

export interface AgentOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  reasoningEffort?: string;
  imagePx?: number;
  toolMode?: AgentToolMode;
  /** When set, every call writes a raw request/response log here. */
  debugDir?: string;
}

export interface AgentDebugFile {
  label: string;
  model: string;
  promptVersion: number;
  at: string;
  utterance: string;
  historyTurns: number;
  hadImage: boolean;
  attempts: Array<{
    jsonMode: boolean;
    latencyMs: number;
    content: string;
    finishReason: unknown;
    usage: unknown;
    error: string | null;
  }>;
  parsed: boolean;
  parseError: string | null;
  usage: unknown;
}

export class OpenAICompatAgentBrain implements AgentBrain {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly reasoningEffort: string | undefined;
  private readonly imagePx: number;
  private readonly debugDir: string | undefined;
  private lastUsage: { promptTokens: number; completionTokens: number } | undefined;

  constructor(opts: AgentOptions, client?: OpenAI) {
    if (opts.toolMode === "native") {
      throw new Error(
        "AGENT_TOOL_MODE=native is not supported yet (the Spark tool probe has not passed; see scripts/probe-tools.mjs)"
      );
    }
    this.client = client ?? new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS;
    this.reasoningEffort = opts.reasoningEffort;
    this.imagePx = opts.imagePx ?? DEFAULT_AGENT_IMAGE_PX;
    this.debugDir = opts.debugDir;
    this.lastUsage = undefined;
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastUsage;
  }

  getLastCostUsd(): number | null {
    return agentCostUsd(this.model, this.lastUsage);
  }

  async respond(input: AgentInput): Promise<AgentOutput> {
    const system = `${buildAgentSystemPrompt({ lang: input.lang, script: input.script })}\n\n${buildSceneBlock(input.scene)}`;
    const history: Array<{ role: "user" | "assistant"; content: string }> = input.history
      .filter((t) => t.text.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.text }));

    let imageDataUrl: string | null = null;
    if (input.image) {
      const small = await sharp(input.image.jpeg)
        .resize({ width: this.imagePx, height: this.imagePx, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      imageDataUrl = `data:image/jpeg;base64,${small.toString("base64")}`;
    }

    const userContent: unknown = imageDataUrl
      ? [
          { type: "text", text: input.utterance },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : input.utterance;
    const baseRequest = {
      model: this.model,
      max_tokens: this.maxTokens,
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      messages: [{ role: "system", content: system }, ...history, { role: "user", content: userContent }],
    } as Record<string, unknown>;

    const attempts: AgentDebugFile["attempts"] = [];
    const runOnce = async (withJsonMode: boolean): Promise<string> => {
      const params = withJsonMode ? { ...baseRequest, response_format: { type: "json_object" } } : baseRequest;
      const start = Date.now();
      try {
        const res = (await this.client.chat.completions.create(
          params as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0]
        )) as ChatCompletion;
        const message = res.choices[0]?.message;
        const content = typeof message?.content === "string" ? message.content : "";
        this.lastUsage = res.usage
          ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens }
          : undefined;
        attempts.push({
          jsonMode: withJsonMode,
          latencyMs: Date.now() - start,
          content,
          finishReason: res.choices[0]?.finish_reason ?? null,
          usage: (res.usage as unknown) ?? null,
          error: null,
        });
        return content;
      } catch (err) {
        attempts.push({
          jsonMode: withJsonMode,
          latencyMs: Date.now() - start,
          content: "",
          finishReason: null,
          usage: null,
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
        if (isJsonModeError(err)) text = await runOnce(false);
        else throw err;
      }
      const output = parseAgentOutput(text);
      this.writeDebug(input, attempts, true, null, imageDataUrl?.length ?? 0);
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeDebug(input, attempts, false, message, imageDataUrl?.length ?? 0);
      throw err;
    }
  }

  private writeDebug(
    input: AgentInput,
    attempts: AgentDebugFile["attempts"],
    parsed: boolean,
    parseError: string | null,
    imageDataUrlLength: number
  ): void {
    if (!this.debugDir) return;
    // Privacy: never persist image bytes, only sizes (shop-mode safe).
    const last = [...attempts].reverse().find((a) => !a.error);
    const file: AgentDebugFile & { image: { bytes: number; dataUrlLength: number } } = {
      label: "",
      model: this.model,
      promptVersion: AGENT_PROMPT_VERSION,
      at: new Date().toISOString(),
      utterance: input.utterance,
      historyTurns: input.history.length,
      hadImage: !!input.image,
      image: { bytes: input.image?.jpeg.length ?? 0, dataUrlLength: imageDataUrlLength },
      attempts,
      parsed,
      parseError,
      usage: last?.usage ?? null,
    };
    const label = `agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    file.label = label;
    mkdirSync(this.debugDir, { recursive: true });
    writeFileSync(join(this.debugDir, `${sanitizeLabel(label)}.json`), JSON.stringify(file, null, 2));
  }
}
