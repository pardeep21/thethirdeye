// Chaos provider (R8 soak): seeded random faults over the mock adapters.
//
// PROVIDER=chaos runs the full server loop without keys while triage,
// answer, finder and agent calls randomly stall (0-8 s), fail with network
// errors, or return malformed/empty model output. Every fault is one the
// server must already survive: timeouts drop (proactive) or speak a
// deterministic line (turns), the TurnGuard rescues silent turns, and late
// losers are discarded by withTimeout. Seeded (CHAOS_SEED) so a soak
// failure reproduces; fault rates via CHAOS_*_P env. STT and faces are
// never wrapped: the soak phone sends utterance text, and face recognition
// stays deterministic.
import type {
  Box,
  SceneTriage,
  TriageResult,
} from "../protocol.js";
import type {
  AdapterSet,
  LocatedObject,
  NamedTriage,
  ObjectFinder,
  VisionAnswer,
} from "./index.js";
import type { AgentBrain, AgentInput, AgentOutput } from "./agent.js";
import { MockAgentBrain } from "./agent.js";
import { MockObjectFinder, MockVisionAnswer, MockVisionTriage } from "./mocks.js";

export interface ChaosConfig {
  /** Seed for all fault streams (each adapter derives its own stream). */
  seed: number;
  /** P(each call sleeps uniform 0..latencyMaxMs before running). */
  latencyP: number;
  latencyMaxMs: number;
  /** P(throwing a network-style error). */
  errorP: number;
  /** P(throwing a malformed-model-output error). */
  invalidP: number;
  /** P(agent answers {say: null}, the action-only shape). Agent only. */
  nullSayP: number;
  /** P(agent answers an empty say / describe-read returns ""). Agent+answer. */
  emptyP: number;
}

export const DEFAULT_CHAOS_LATENCY_P = 0.25;
export const DEFAULT_CHAOS_LATENCY_MAX_MS = 8000;
export const DEFAULT_CHAOS_ERROR_P = 0.08;
export const DEFAULT_CHAOS_INVALID_P = 0.08;
export const DEFAULT_CHAOS_NULL_SAY_P = 0.05;
export const DEFAULT_CHAOS_EMPTY_P = 0.05;

function rateFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name}=${raw} must be a number in [0,1]`);
  }
  return n;
}

function uintFromEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`${name}=${raw} must be an integer in [0,${max}]`);
  }
  return n;
}

export function chaosConfigFromEnv(): ChaosConfig {
  return {
    seed: uintFromEnv(
      "CHAOS_SEED",
      (Date.now() ^ (process.pid * 2654435761)) >>> 0,
      0xffffffff
    ),
    latencyP: rateFromEnv("CHAOS_LATENCY_P", DEFAULT_CHAOS_LATENCY_P),
    latencyMaxMs: uintFromEnv("CHAOS_LATENCY_MAX_MS", DEFAULT_CHAOS_LATENCY_MAX_MS, 120000),
    errorP: rateFromEnv("CHAOS_ERROR_P", DEFAULT_CHAOS_ERROR_P),
    invalidP: rateFromEnv("CHAOS_INVALID_P", DEFAULT_CHAOS_INVALID_P),
    nullSayP: rateFromEnv("CHAOS_NULL_SAY_P", DEFAULT_CHAOS_NULL_SAY_P),
    emptyP: rateFromEnv("CHAOS_EMPTY_P", DEFAULT_CHAOS_EMPTY_P),
  };
}

/** FNV-1a over the stream label, so each adapter gets its own sequence. */
function streamHash(stream: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < stream.length; i++) {
    h ^= stream.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded uniform [0,1) stream (mulberry32). Same seed+stream replays. */
export function makeChaosRng(seed: number, stream = ""): () => number {
  let a = (seed ^ streamHash(stream)) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fault = "none" | "error" | "invalid" | "nullSay" | "empty";

/**
 * Roll one fault. Weights come from the config in fixed priority order
 * (error, invalid, nullSay, empty); adapters that cannot produce a fault
 * pass a smaller set and the leftover weight stays clean.
 */
function rollFault(rng: () => number, cfg: ChaosConfig, allowed: Fault[]): Fault {
  const weights: Array<[Fault, number]> = [
    ["error", cfg.errorP],
    ["invalid", cfg.invalidP],
    ["nullSay", cfg.nullSayP],
    ["empty", cfg.emptyP],
  ];
  const r = rng();
  let acc = 0;
  for (const [fault, w] of weights) {
    if (!allowed.includes(fault)) continue;
    acc += w;
    if (r < acc) return fault;
  }
  return "none";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeLatency(rng: () => number, cfg: ChaosConfig): Promise<void> {
  if (cfg.latencyMaxMs > 0 && rng() < cfg.latencyP) {
    await sleep(Math.floor(rng() * (cfg.latencyMaxMs + 1)));
  }
}

function networkError(): Error {
  return new Error("chaos: network error (ECONNRESET reading the model response)");
}

export const CHAOS_NULL_SAY: AgentOutput = { say: null, positions: [], actions: [] };

/** Agent faults: latency, network error, malformed JSON, null say, empty say. */
export class ChaosAgentBrain implements AgentBrain {
  private readonly rng: () => number;

  constructor(
    private readonly inner: AgentBrain = new MockAgentBrain(),
    private readonly cfg: ChaosConfig = chaosConfigFromEnv(),
    stream = "agent"
  ) {
    this.rng = makeChaosRng(cfg.seed, stream);
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.inner.getLastUsage?.();
  }

  getLastCostUsd(): number | null {
    return this.inner.getLastCostUsd?.() ?? null;
  }

  async respond(input: AgentInput): Promise<AgentOutput> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid", "nullSay", "empty"]);
    switch (fault) {
      case "error":
        throw networkError();
      case "invalid":
        throw new Error("agent output is not JSON");
      case "nullSay":
        return structuredClone(CHAOS_NULL_SAY);
      case "empty":
        return { say: "", positions: [], actions: [] };
      case "none":
        return this.inner.respond(input);
    }
  }
}

/** Triage faults: latency, network error, malformed JSON. Values stay mock's. */
export class ChaosTriage implements NamedTriage {
  readonly name: string;
  private readonly rng: () => number;

  constructor(
    private readonly inner: NamedTriage = new MockVisionTriage(),
    private readonly cfg: ChaosConfig = chaosConfigFromEnv(),
    stream = "triage"
  ) {
    this.name = `chaos:${inner.name}`;
    this.rng = makeChaosRng(cfg.seed, stream);
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.inner.getLastUsage();
  }

  async triage(img: Buffer, debugLabel?: string, turnId?: string): Promise<TriageResult> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid"]);
    if (fault === "error") throw networkError();
    if (fault === "invalid") throw new Error("triage output is not JSON");
    return this.inner.triage(img, debugLabel, turnId);
  }

  async triageScene(img: Buffer, debugLabel?: string, turnId?: string): Promise<SceneTriage> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid"]);
    if (fault === "error") throw networkError();
    if (fault === "invalid") throw new Error("triage output is not JSON");
    return this.inner.triageScene(img, debugLabel, turnId);
  }
}

/** Answer faults: latency, failure, empty text (the empty-model path). */
export class ChaosAnswer implements VisionAnswer {
  private readonly rng: () => number;

  constructor(
    private readonly inner: VisionAnswer = new MockVisionAnswer(),
    private readonly cfg: ChaosConfig = chaosConfigFromEnv(),
    stream = "answer"
  ) {
    this.rng = makeChaosRng(cfg.seed, stream);
  }

  async describe(img: Buffer, q: string): Promise<string> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid", "empty"]);
    if (fault === "error" || fault === "invalid") throw networkError();
    if (fault === "empty") return "";
    return this.inner.describe(img, q);
  }

  async read(img: Buffer): Promise<string> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid", "empty"]);
    if (fault === "error" || fault === "invalid") throw networkError();
    if (fault === "empty") return "";
    return this.inner.read(img);
  }
}

/** Finder faults: latency and failure (locate misses stay the inner's null). */
export class ChaosFinder implements ObjectFinder {
  private readonly rng: () => number;

  constructor(
    private readonly inner: ObjectFinder = new MockObjectFinder(),
    private readonly cfg: ChaosConfig = chaosConfigFromEnv(),
    stream = "finder"
  ) {
    this.rng = makeChaosRng(cfg.seed, stream);
  }

  async find(img: Buffer, noun: string): Promise<Box[]> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid"]);
    if (fault !== "none") throw networkError();
    return this.inner.find(img, noun);
  }

  async locate(img: Buffer, noun: string): Promise<LocatedObject | null> {
    await maybeLatency(this.rng, this.cfg);
    const fault = rollFault(this.rng, this.cfg, ["error", "invalid"]);
    if (fault !== "none") throw networkError();
    return this.inner.locate(img, noun);
  }
}

/** Wrap the model adapters of a set (triage/answer/finder/agent) in chaos. */
export function wrapAdaptersWithChaos(set: AdapterSet, cfg: ChaosConfig = chaosConfigFromEnv()): AdapterSet {
  return {
    ...set,
    triage: new ChaosTriage(set.triage, cfg),
    answer: new ChaosAnswer(set.answer, cfg),
    finder: new ChaosFinder(set.finder, cfg),
    agent: new ChaosAgentBrain(set.agent, cfg),
  };
}
