// Per-utterance latency instrumentation (prompt 02): one sample per
// agent turn, p50/p95 per stage over the last 50 (GET /stats).
// Overnight T1 adds a timeout count per model-call stage; R4 adds a
// per-provider ok/timeout/error count per fallback attempt; R7 adds
// turn-level reliability (turns, rescues, capture failures, timeout and
// fallback rates, phone TTS watchdog fires and TTS-start latency).
import type { TimeoutStage } from "./timeouts.js";
import type { CaptureOutcome } from "./turnLog.js";

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
  /** R7 turns finished (utterance + command + speaking proactive). */
  turns: number;
  /** R7 turns that needed the TurnGuard rescue fallback. */
  rescuedTurns: number;
  /** R7 failed/stale captures over captures attempted (camera_off excluded). */
  captureFailRate: number;
  /** R7 member-attempt timeout rate per stage (0 when no attempts). */
  timeoutRate: Record<TimeoutStage, number>;
  /** R7 turns where a backup provider was tried, over turns with attempts. */
  fallbackRate: number;
  /** R7 phone reports with outcome watchdog (orphans count too). */
  ttsWatchdogFires: number;
  /** R7 turn start -> phone TTS start (matched receipts only). */
  ttsLatencyMs: StageStats;
}

/** One model attempt as far as turn-level stats are concerned. */
export interface TurnAttemptInput {
  stage: TimeoutStage;
  outcome: "ok" | "timeout" | "error";
}

/** Turn summary for recordTurn (a TurnRecord subset; see turnLog.ts). */
export interface TurnRecordInput {
  capture: CaptureOutcome | null;
  attempts: TurnAttemptInput[];
  rescued: boolean;
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

const STAGES: TimeoutStage[] = ["triage", "scene", "agent", "answer", "find"];

export class UtteranceStats {
  private samples: UtteranceTiming[] = [];
  private triage: number[] = [];
  private timeouts: TimeoutCounts = { triage: 0, scene: 0, agent: 0, answer: 0, find: 0 };
  private rescued = 0;
  private providers = new Map<string, ProviderAttemptCounts>();
  // R7 turn-level reliability.
  private turns = 0;
  private rescuedTurns = 0;
  private captureTotal = 0;
  private captureFailed = 0;
  private attemptedTurns = 0;
  private fallbackTurns = 0;
  private stageAttempts: Record<TimeoutStage, { total: number; timeouts: number }> = {
    triage: { total: 0, timeouts: 0 },
    scene: { total: 0, timeouts: 0 },
    agent: { total: 0, timeouts: 0 },
    answer: { total: 0, timeouts: 0 },
    find: { total: 0, timeouts: 0 },
  };
  private ttsWatchdog = 0;
  private ttsLatency: number[] = [];

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

  /**
   * One model attempt outcome for a provider (R4 chains record each member;
   * R7 records single-provider calls too, so every model call counts once).
   * The stage feeds the per-stage timeout rate; calls without one (older
   * tests) only feed the per-provider counts.
   */
  recordAttempt(provider: string, outcome: "ok" | "timeout" | "error", stage?: TimeoutStage): void {
    let counts = this.providers.get(provider);
    if (!counts) {
      counts = { ok: 0, timeout: 0, error: 0 };
      this.providers.set(provider, counts);
    }
    if (outcome === "ok") counts.ok++;
    else if (outcome === "timeout") counts.timeout++;
    else counts.error++;
    if (stage !== undefined) {
      const cell = this.stageAttempts[stage];
      cell.total++;
      if (outcome === "timeout") cell.timeouts++;
    }
  }

  /** One finished R7 turn (called even when file logging is disabled). */
  recordTurn(turn: TurnRecordInput): void {
    this.turns++;
    if (turn.rescued) this.rescuedTurns++;
    if (turn.capture !== null && turn.capture !== "camera_off") {
      this.captureTotal++;
      if (turn.capture === "failed" || turn.capture === "stale_fallback") this.captureFailed++;
    }
    if (turn.attempts.length > 0) {
      this.attemptedTurns++;
      const perStage = new Map<TimeoutStage, number>();
      for (const a of turn.attempts) perStage.set(a.stage, (perStage.get(a.stage) ?? 0) + 1);
      if ([...perStage.values()].some((n) => n > 1)) this.fallbackTurns++;
    }
  }

  /**
   * One phone spoken receipt. Watchdog outcomes always count; latency is
   * sampled only for receipts matched to a turn (orphans pass null).
   */
  recordSpoken(latencyMs: number | null, outcome: "done" | "stopped" | "watchdog" | "error"): void {
    if (outcome === "watchdog") this.ttsWatchdog++;
    if (latencyMs !== null) {
      this.ttsLatency.push(latencyMs);
      if (this.ttsLatency.length > STATS_MAX_SAMPLES) this.ttsLatency.shift();
    }
  }

  get count(): number {
    return this.samples.length;
  }

  snapshot(): StatsSnapshot {
    const timeoutRate = {} as Record<TimeoutStage, number>;
    for (const s of STAGES) {
      const cell = this.stageAttempts[s];
      timeoutRate[s] = cell.total === 0 ? 0 : cell.timeouts / cell.total;
    }
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
      turns: this.turns,
      rescuedTurns: this.rescuedTurns,
      captureFailRate: this.captureTotal === 0 ? 0 : this.captureFailed / this.captureTotal,
      timeoutRate,
      fallbackRate: this.attemptedTurns === 0 ? 0 : this.fallbackTurns / this.attemptedTurns,
      ttsWatchdogFires: this.ttsWatchdog,
      ttsLatencyMs: stage(this.ttsLatency),
    };
  }
}
