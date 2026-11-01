// Per-utterance latency instrumentation (prompt 02): one sample per
// agent turn, p50/p95 per stage over the last 50 (GET /stats).
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

  record(t: UtteranceTiming): void {
    this.samples.push(t);
    if (this.samples.length > STATS_MAX_SAMPLES) this.samples.shift();
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
    };
  }
}
