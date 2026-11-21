// Per-utterance latency instrumentation (prompt 02): one sample per
// agent turn, p50/p95 per stage over the last 50 (GET /stats).
// Overnight T1 adds a timeout count per model-call stage; R4 adds a
// per-provider ok/timeout/error count per fallback attempt.
import type { TimeoutStage } from "./timeouts.js";

export type TimeoutCounts = Record<TimeoutStage, number>;

/** One fallback-chain attempt outcome per provider (R4 model_attempt log). */
export interface ProviderAttemptCounts {
  ok: number;
  timeout: number;
  error: number;
}

export type ProviderStats = Record<string, ProviderAttemptCounts>;

export interface UtteranceTiming {
  /** utterance_rx -> frame_rx: capture_now round trip (or timeout). */
  frameWaitMs: number;
  /** model_start -> model_end: the agent call. */
  modelMs: number;
  /** utterance_rx -> speak_tx: end to end. */
  totalMs: number;
}

export interface StageStats {
  p50: number;
  p95: number;
}

export interface StatsSnapshot {
  utterances: number;
  frameWaitMs: StageStats;
  modelMs: StageStats;
  totalMs: StageStats;
  timeouts: TimeoutCounts;
  /** Proactive perception (triage/scene) round trips completed. */
  triageSamples: number;
  /** Proactive perception round-trip time (timeouts excluded). */
  triageMs: StageStats;
  /** User turns that produced nothing and got the TurnGuard fallback. */
  silentTurnsRescued: number;
  /** Per-provider attempt outcomes (populated when a fallback chain runs). */
  providers: ProviderStats;
}

export const STATS_MAX_SAMPLES = 50;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function stage(values: number[]): StageStats {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

export class UtteranceStats {
  private samples: UtteranceTiming[] = [];
  private triage: number[] = [];
  private timeouts: TimeoutCounts = { triage: 0, scene: 0, agent: 0, answer: 0, find: 0 };
  private rescued = 0;
  private providers = new Map<string, ProviderAttemptCounts>();

  record(t: UtteranceTiming): void {
    this.samples.push(t);
    if (this.samples.length > STATS_MAX_SAMPLES) this.samples.shift();
  }

  /** One proactive triage/scene round trip (callers skip timeouts). */
  recordTriage(ms: number): void {
    this.triage.push(ms);
    if (this.triage.length > STATS_MAX_SAMPLES) this.triage.shift();
  }

  recordTimeout(stage: TimeoutStage): void {
    this.timeouts[stage]++;
  }

  /** One TurnGuard fallback spoken for an otherwise-silent user turn. */
  recordSilentRescue(): void {
    this.rescued++;
  }

  /** One fallback-chain attempt outcome for a provider (R4). */
  recordAttempt(provider: string, outcome: "ok" | "timeout" | "error"): void {
    let counts = this.providers.get(provider);
    if (!counts) {
      counts = { ok: 0, timeout: 0, error: 0 };
      this.providers.set(provider, counts);
    }
    if (outcome === "ok") counts.ok++;
    else if (outcome === "timeout") counts.timeout++;
    else counts.error++;
  }

  get count(): number {
    return this.samples.length;
  }

  snapshot(): StatsSnapshot {
    return {
      utterances: this.samples.length,
      frameWaitMs: stage(this.samples.map((s) => s.frameWaitMs)),
      modelMs: stage(this.samples.map((s) => s.modelMs)),
      totalMs: stage(this.samples.map((s) => s.totalMs)),
      timeouts: { ...this.timeouts },
      triageSamples: this.triage.length,
      triageMs: stage(this.triage),
      silentTurnsRescued: this.rescued,
      providers: Object.fromEntries(this.providers),
    };
  }
}
