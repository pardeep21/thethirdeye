// FallbackChain (R4): one retry on a BACKUP real provider, never the mock.
// The primary answers when it can; on a retryable failure (timeout, network
// error, 5xx, 429, parse/validation error) the chain tries the next member
// once. The whole chain stays inside the stage total: the primary gets its
// per-attempt budget, the backup gets whatever time is left. Late primary
// answers resolve into the void (withTimeout discards them) so nothing is
// ever spoken twice. Per-attempt lines go to `model_attempt ...` and to the
// stats recorder; cash stability still applies downstream in decision.ts.
import type { Box, SceneTriage, TriageResult } from "../protocol.js";
import { ModelTimeoutError, withTimeout, type TimeoutStage } from "../timeouts.js";
import type { AgentBrain, AgentInput, AgentOutput } from "./agent.js";
import { MockAgentBrain } from "./agent.js";
import type {
  LocatedObject,
  NamedTriage,
  ObjectFinder,
  ProviderName,
  VisionAnswer,
} from "./index.js";
import { MockObjectFinder, MockVisionAnswer, MockVisionTriage } from "./mocks.js";

export type AttemptOutcome = "ok" | "timeout" | "error";

/** One chain member: a real-provider label plus the adapter to call. */
export interface ChainMember<T> {
  provider: string;
  impl: T;
}

/** Per-attempt details for the stats/turn-log sink (R7). */
export interface AttemptDetails {
  ms: number;
  stage: TimeoutStage;
  /** R7 turn this attempt belongs to (undefined outside a traced turn). */
  turnId?: string;
}

export interface ChainOptions {
  stage: TimeoutStage;
  /** First attempt budget; later attempts share the remaining total. */
  primaryMs: number;
  /** Whole-chain budget from the first attempt's start. */
  totalMs: number;
  log?: (msg: string) => void;
  /** Stats sink: one call per attempt (never throws the chain off). */
  record?: (provider: string, outcome: AttemptOutcome, details: AttemptDetails) => void;
  /** R7 turn id, carried into the attempt log line and record details. */
  turnId?: string;
}

/** True for the mock label or any mock adapter instance. Never chainable. */
export function isMockMember(provider: string, impl: unknown): boolean {
  if (provider.toLowerCase() === "mock") return true;
  return (
    impl instanceof MockAgentBrain ||
    impl instanceof MockVisionTriage ||
    impl instanceof MockVisionAnswer ||
    impl instanceof MockObjectFinder
  );
}

/** Startup guard: the mock speaks fixed denominations, a confident wrong answer. */
export function assertNoMock(members: Array<{ provider: string; impl: unknown }>): void {
  for (const m of members) {
    if (isMockMember(m.provider, m.impl)) {
      throw new Error(
        `fallback chain must not include the mock provider (got provider=${m.provider})`
      );
    }
  }
  if (members.length === 0) throw new Error("fallback chain needs at least one member");
}

function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  if (typeof rec.status === "number") return rec.status;
  const cause =
    err instanceof Error ? (err as { cause?: unknown }).cause : rec.cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as Record<string, unknown>).status === "number"
  ) {
    return (cause as Record<string, unknown>).status as number;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m = /(?:\bstatus\b|\bHTTP\b)[\s:]*(\d{3})/i.exec(msg);
  return m ? Number(m[1]) : undefined;
}

/**
 * Retryable: timeouts, network/parse failures (no HTTP status), 429 and 5xx.
 * Other 4xx (bad key, bad request, unknown model) fail fast on purpose: the
 * backup would likely reject the same call the same way.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ModelTimeoutError) return true;
  const status = errorStatus(err);
  if (status === undefined) return true;
  if (status === 429 || status >= 500) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/**
 * Run the members in order, at most once each. Returns the first success;
 * throws the last failure when the chain is exhausted or the error is not
 * retryable. Every attempt is timed, logged and recorded.
 */
export async function runWithFallback<T>(
  members: Array<ChainMember<() => Promise<T>>>,
  opts: ChainOptions
): Promise<T> {
  assertNoMock(members.map((m) => ({ provider: m.provider, impl: m.impl })));
  const log = opts.log ?? ((m: string) => console.log(m));
  const started = Date.now();
  const turnSuffix = opts.turnId !== undefined ? ` turn=${opts.turnId}` : "";
  let lastError: unknown = new ModelTimeoutError(opts.stage, opts.totalMs);
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    const remaining = opts.totalMs - (Date.now() - started);
    if (remaining <= 0) throw lastError;
    // First attempt keeps its cap; every later attempt takes what is left.
    const attemptMs = i === 0 ? Math.min(opts.primaryMs, remaining) : remaining;
    const attemptStart = Date.now();
    const details = (ms: number): AttemptDetails =>
      opts.turnId !== undefined
        ? { ms, stage: opts.stage, turnId: opts.turnId }
        : { ms, stage: opts.stage };
    try {
      const result = await withTimeout(member.impl(), attemptMs, opts.stage);
      const ms = Date.now() - attemptStart;
      log(`model_attempt provider=${member.provider} stage=${opts.stage} ok ms=${ms}${turnSuffix}`);
      opts.record?.(member.provider, "ok", details(ms));
      return result;
    } catch (err) {
      const ms = Date.now() - attemptStart;
      const outcome: AttemptOutcome = err instanceof ModelTimeoutError ? "timeout" : "error";
      log(`model_attempt provider=${member.provider} stage=${opts.stage} ${outcome} ms=${ms}${turnSuffix}`);
      opts.record?.(member.provider, outcome, details(ms));
      lastError = err;
      if (i === members.length - 1) throw err;
      if (!isRetryableError(err)) throw err;
      // Fall through to the backup; the primary's late answer (if any)
      // resolves into the void via withTimeout and is never consumed.
    }
  }
  throw lastError;
}

export interface AgentChainOptions {
  primaryMs: number;
  totalMs: number;
  log?: (msg: string) => void;
  record?: (provider: string, outcome: AttemptOutcome, details: AttemptDetails) => void;
}

/** AgentBrain over primary + backup real providers (usage follows the winner). */
export class FallbackAgentBrain implements AgentBrain {
  private lastWinner: AgentBrain | null = null;

  constructor(
    private readonly members: Array<ChainMember<AgentBrain>>,
    private readonly opts: AgentChainOptions
  ) {
    assertNoMock(members);
  }

  async respond(input: AgentInput): Promise<AgentOutput> {
    // The wrapper records the winner so usage/cost follow the backup on failover.
    const wrapped = this.members.map((m) => ({
      provider: m.provider,
      impl: async (): Promise<AgentOutput> => {
        const out = await m.impl.respond(input);
        this.lastWinner = m.impl;
        return out;
      },
    }));
    return runWithFallback(wrapped, { stage: "agent", ...this.opts, turnId: input.turnId });
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastWinner?.getLastUsage?.();
  }

  getLastCostUsd(): number | null {
    return this.lastWinner?.getLastCostUsd?.() ?? null;
  }
}

/** NamedTriage over primary + backup (stability still applies downstream). */
export class FallbackTriage implements NamedTriage {
  readonly name: string;
  private lastWinner: NamedTriage | null = null;

  constructor(
    private readonly members: Array<ChainMember<NamedTriage>>,
    private readonly opts: AgentChainOptions
  ) {
    assertNoMock(members);
    this.name = `fallback:${members.map((m) => m.provider).join("+")}`;
  }

  async triage(img: Buffer, debugLabel?: string, turnId?: string): Promise<TriageResult> {
    return runWithFallback(
      this.members.map((m) => ({
        provider: m.provider,
        impl: async (): Promise<TriageResult> => {
          const r = await m.impl.triage(img, debugLabel);
          this.lastWinner = m.impl;
          return r;
        },
      })),
      { stage: "triage", ...this.opts, turnId }
    );
  }

  async triageScene(img: Buffer, debugLabel?: string, turnId?: string): Promise<SceneTriage> {
    return runWithFallback(
      this.members.map((m) => ({
        provider: m.provider,
        impl: async (): Promise<SceneTriage> => {
          const r = await m.impl.triageScene(img, debugLabel);
          this.lastWinner = m.impl;
          return r;
        },
      })),
      { stage: "scene", ...this.opts, turnId }
    );
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastWinner?.getLastUsage();
  }
}

/** VisionAnswer over primary + backup (command describe/read path). */
export class FallbackAnswer implements VisionAnswer {
  constructor(
    private readonly members: Array<ChainMember<VisionAnswer>>,
    private readonly opts: AgentChainOptions
  ) {
    assertNoMock(members);
  }

  async describe(img: Buffer, q: string, turnId?: string): Promise<string> {
    return runWithFallback(
      this.members.map((m) => ({ provider: m.provider, impl: () => m.impl.describe(img, q) })),
      { stage: "answer", ...this.opts, turnId }
    );
  }

  async read(img: Buffer, turnId?: string): Promise<string> {
    return runWithFallback(
      this.members.map((m) => ({ provider: m.provider, impl: () => m.impl.read(img) })),
      { stage: "answer", ...this.opts, turnId }
    );
  }
}

/** ObjectFinder over primary + backup (command find + agent locate). */
export class FallbackFinder implements ObjectFinder {
  constructor(
    private readonly members: Array<ChainMember<ObjectFinder>>,
    private readonly opts: AgentChainOptions
  ) {
    assertNoMock(members);
  }

  async find(img: Buffer, noun: string, turnId?: string): Promise<Box[]> {
    return runWithFallback(
      this.members.map((m) => ({ provider: m.provider, impl: () => m.impl.find(img, noun) })),
      { stage: "find", ...this.opts, turnId }
    );
  }

  async locate(img: Buffer, noun: string, turnId?: string): Promise<LocatedObject | null> {
    return runWithFallback(
      this.members.map((m) => ({ provider: m.provider, impl: () => m.impl.locate(img, noun) })),
      { stage: "find", ...this.opts, turnId }
    );
  }
}

export interface FallbackProviderConfig {
  provider: Exclude<ProviderName, "mock">;
  model: string;
  baseURL: string;
  apiKey: string;
}

const FALLBACK_DEFAULTS: Record<
  Exclude<ProviderName, "mock">,
  { model: string; baseURL: string; apiKey: string | undefined }
> = {
  meta: { model: "muse-spark-1.3", baseURL: "https://api.meta.ai/v1", apiKey: undefined },
  openrouter: {
    model: "meta/muse-spark-1.3",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: undefined,
  },
  openai: { model: "gpt-4o-mini", baseURL: "https://api.openai.com/v1", apiKey: undefined },
  local: { model: "muse-glimmer", baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
};

function fallbackFromEnv(prefix: "AGENT_FALLBACK" | "TRIAGE_FALLBACK"): FallbackProviderConfig | undefined {
  const rawProvider = process.env[`${prefix}_PROVIDER`];
  if (rawProvider === undefined || rawProvider === "") return undefined;
  const provider = rawProvider.toLowerCase();
  if (provider === "mock") {
    throw new Error(`${prefix}_PROVIDER=mock is not allowed in a fallback chain`);
  }
  const defaults = FALLBACK_DEFAULTS[provider as Exclude<ProviderName, "mock">];
  if (!defaults) {
    throw new Error(`${prefix}_PROVIDER=${rawProvider} unknown (expected meta|openrouter|openai|local)`);
  }
  const apiKey = process.env[`${prefix}_API_KEY`] ?? defaults.apiKey;
  if (!apiKey) throw new Error(`${prefix}_API_KEY is required for fallback provider ${provider}`);
  return {
    provider: provider as Exclude<ProviderName, "mock">,
    model: process.env[`${prefix}_MODEL`] ?? defaults.model,
    baseURL: process.env[`${prefix}_BASE_URL`] ?? defaults.baseURL,
    apiKey,
  };
}

/** Agent backup (AGENT_FALLBACK_*); undefined keeps single-provider behaviour. */
export function agentFallbackFromEnv(): FallbackProviderConfig | undefined {
  return fallbackFromEnv("AGENT_FALLBACK");
}

/** Triage backup (TRIAGE_FALLBACK_*); undefined keeps single-provider behaviour. */
export function triageFallbackFromEnv(): FallbackProviderConfig | undefined {
  return fallbackFromEnv("TRIAGE_FALLBACK");
}
