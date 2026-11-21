// R7 turn tracing: one JSON line per turn in logs/turns-YYYY-MM-DD.jsonl.
// Answers "how often did he hear nothing, wrong, or late?" after a field
// session (see scripts/turn-report.mjs). A turn is begun when it starts,
// finished when the server is done with it; turns that spoke wait for the
// phone's spoken receipt (or the flush timeout) so the line carries the
// phone outcome + turn-start -> TTS-start latency. Turns that never spoke
// (earcon-only acks, superseded barge-ins) are written at finish: no
// receipt will ever arrive for them. Privacy: records hold text and
// timings only, never image bytes or audio.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SpokenMessage, SpokenOutcome } from "./protocol.js";
import type { AttemptOutcome } from "./adapters/fallback.js";
import type { TimeoutStage } from "./timeouts.js";

export type TurnKind = "utterance" | "command" | "proactive";

/**
 * R2 capture outcome for a turn (null when no capture was relevant):
 * ok = fresh capture used; failed = the phone reported capture_failed;
 * late = no capture but a usable (<1500 ms) last frame filled in;
 * stale_fallback = neither; camera_off = vision short-circuited, no
 * capture requested (R6).
 */
export type CaptureOutcome = "ok" | "late" | "failed" | "stale_fallback" | "camera_off";

export interface TurnAttempt {
  provider: string;
  stage: TimeoutStage;
  ms: number;
  outcome: AttemptOutcome;
}

export interface TurnSpoken {
  outcome: SpokenOutcome;
  startedAt: number;
  endedAt: number;
  /** Phone TTS start minus server turn start (clocks may skew; raw value). */
  latencyMs: number;
}

export interface TurnRecord {
  turnId: string;
  kind: TurnKind;
  /** routeIntent kind for user turns, DecisionEvent kind for proactive. */
  intent: string;
  startedAt: number;
  durationMs: number;
  capture: CaptureOutcome | null;
  attempts: TurnAttempt[];
  /** Final line spoken, or null when the turn spoke nothing. */
  text: string | null;
  /** R1: the TurnGuard fallback spoke for an otherwise-silent turn. */
  rescued: boolean;
  rescueReason: string | null;
  /** A newer turn barged in; this turn stayed silent on purpose. */
  superseded: boolean;
  /** Phone receipt; null when none arrived before the flush. */
  spoken: TurnSpoken | null;
}

export type SpokenStatus = "attached" | "early" | "duplicate" | "unknown";

export interface SpokenResult {
  status: SpokenStatus;
  /** Set when attached: the completed record and its TTS latency. */
  record?: TurnRecord;
  latencyMs?: number;
}

export interface TurnBeginOptions {
  kind: TurnKind;
  intent?: string;
  /** Connection owner; flushOwner writes its pending turns on disconnect. */
  owner?: string;
  startedAt?: number;
}

export interface TurnFinishOptions {
  rescued: boolean;
  rescueReason?: string;
  superseded?: boolean;
}

/** Pending spoken wait: covers the 20 s TTS watchdog plus queueing. */
export const TURN_SPOKEN_FLUSH_MS = 30_000;

/** Recently written turnIds remembered for duplicate spoken detection. */
export const TURN_RECENT_IDS = 200;

/**
 * Turn log directory. Unset means the default "logs/" (relative to the
 * server's working directory); the empty string disables file logging
 * (in-memory tracking still runs, so /stats keeps working).
 */
export function turnLogDirFromEnv(): string {
  const raw = process.env.TURN_LOG_DIR;
  if (raw === undefined) return "logs";
  return raw;
}

export interface TurnLoggerOptions {
  dir?: string;
  clock?: () => number;
  flushMs?: number;
}

interface ActiveTurn {
  turnId: string;
  kind: TurnKind;
  intent: string;
  owner: string | null;
  startedAt: number;
  capture: CaptureOutcome | null;
  attempts: TurnAttempt[];
  text: string | null;
  pendingTimer?: ReturnType<typeof setTimeout>;
}

export class TurnLogger {
  private readonly dir: string;
  private readonly clock: () => number;
  private readonly flushMs: number;
  private readonly active = new Map<string, ActiveTurn>();
  /** Spoken receipts that arrived before their turn finished (rare). */
  private readonly early = new Map<string, SpokenMessage>();
  /** Recently written turnIds, for duplicate spoken detection. */
  private readonly recent: string[] = [];
  private readonly recentSet = new Set<string>();
  private readonly madeDirs = new Set<string>();

  constructor(opts: TurnLoggerOptions = {}) {
    this.dir = opts.dir ?? turnLogDirFromEnv();
    this.clock = opts.clock ?? Date.now;
    this.flushMs = opts.flushMs ?? TURN_SPOKEN_FLUSH_MS;
  }

  /** File logging enabled (empty dir means disabled). */
  get enabled(): boolean {
    return this.dir !== "";
  }

  begin(turnId: string, opts: TurnBeginOptions): void {
    this.active.set(turnId, {
      turnId,
      kind: opts.kind,
      intent: opts.intent ?? "unknown",
      owner: opts.owner ?? null,
      startedAt: opts.startedAt ?? this.clock(),
      capture: null,
      attempts: [],
      text: null,
    });
  }

  setIntent(turnId: string, intent: string): void {
    const t = this.active.get(turnId);
    if (t) t.intent = intent;
  }

  setCapture(turnId: string, capture: CaptureOutcome): void {
    const t = this.active.get(turnId);
    if (t) t.capture = capture;
  }

  /** Last set wins: the final line is what the turn spoke. */
  setText(turnId: string, text: string): void {
    const t = this.active.get(turnId);
    if (t) t.text = text;
  }

  /**
   * One model attempt for a turn. Unknown/finished turnIds are ignored:
   * discarded silent proactive turns still count in global /stats via the
   * stats recorder, which listens separately.
   */
  recordAttempt(turnId: string, attempt: TurnAttempt): void {
    this.active.get(turnId)?.attempts.push(attempt);
  }

  /** Attempts recorded so far for one turn+stage (outer-call skip logic). */
  attemptCount(turnId: string, stage: TimeoutStage): number {
    return this.active.get(turnId)?.attempts.filter((a) => a.stage === stage).length ?? 0;
  }

  /** Drop a provisional proactive turn that stayed silent (never logged). */
  discard(turnId: string): void {
    const t = this.active.get(turnId);
    if (!t) return;
    if (t.pendingTimer !== undefined) clearTimeout(t.pendingTimer);
    this.active.delete(turnId);
    this.early.delete(turnId);
  }

  /**
   * Finish a turn. Returns the record (spoken attached when it already
   * arrived early, else null until the receipt lands). Turns with no text
   * are written immediately; speaking turns wait for the phone receipt up
   * to flushMs, then are written with spoken=null.
   */
  finish(turnId: string, opts: TurnFinishOptions): TurnRecord | null {
    const t = this.active.get(turnId);
    if (!t) return null;
    const now = this.clock();
    const earlySpoken = this.early.get(turnId);
    this.early.delete(turnId);
    const record: TurnRecord = {
      turnId: t.turnId,
      kind: t.kind,
      intent: t.intent,
      startedAt: t.startedAt,
      durationMs: now - t.startedAt,
      capture: t.capture,
      attempts: [...t.attempts],
      text: t.text,
      rescued: opts.rescued,
      rescueReason: opts.rescueReason ?? null,
      superseded: opts.superseded ?? false,
      spoken: earlySpoken
        ? {
            outcome: earlySpoken.outcome,
            startedAt: earlySpoken.startedAt,
            endedAt: earlySpoken.endedAt,
            latencyMs: earlySpoken.startedAt - t.startedAt,
          }
        : null,
    };
    if (t.text === null || earlySpoken) {
      this.active.delete(turnId);
      this.write(record);
      return record;
    }
    // Speaking turn: stash the rescue flags so the receipt-time write and
    // the flush-time write carry the same values finish() returned.
    this.finishStash.set(turnId, {
      rescued: record.rescued,
      rescueReason: record.rescueReason,
      durationMs: record.durationMs,
    });
    const stashedDurationMs = record.durationMs;
    t.pendingTimer = setTimeout(() => {
      this.active.delete(turnId);
      this.finishStash.delete(turnId);
      this.write({ ...record, durationMs: stashedDurationMs, spoken: null });
    }, this.flushMs);
    if (typeof (t.pendingTimer as unknown as { unref?: unknown }).unref === "function") {
      (t.pendingTimer as unknown as { unref: () => void }).unref();
    }
    return record;
  }

  /**
   * Join a phone spoken receipt to its turn. First receipt wins; later
   * duplicates and receipts for unknown turns report their status so the
   * caller can still count watchdog fires without a latency sample.
   */
  onSpoken(msg: SpokenMessage): SpokenResult {
    const t = this.active.get(msg.turnId);
    if (t) {
      if (t.pendingTimer === undefined) {
        // Turn begun but not finished yet: hold for finish().
        this.early.set(msg.turnId, msg);
        return { status: "early" };
      }
      clearTimeout(t.pendingTimer);
      this.active.delete(msg.turnId);
      const latencyMs = msg.startedAt - t.startedAt;
      const finished = this.finishStash.get(msg.turnId);
      this.finishStash.delete(msg.turnId);
      const record: TurnRecord = {
        turnId: t.turnId,
        kind: t.kind,
        intent: t.intent,
        startedAt: t.startedAt,
        durationMs: finished?.durationMs ?? this.clock() - t.startedAt,
        capture: t.capture,
        attempts: [...t.attempts],
        text: t.text,
        rescued: finished?.rescued ?? false,
        rescueReason: finished?.rescueReason ?? null,
        superseded: false,
        spoken: {
          outcome: msg.outcome,
          startedAt: msg.startedAt,
          endedAt: msg.endedAt,
          latencyMs,
        },
      };
      this.write(record);
      return { status: "attached", record, latencyMs };
    }
    if (this.recentSet.has(msg.turnId)) return { status: "duplicate" };
    return { status: "unknown" };
  }

  private readonly finishStash = new Map<string, { rescued: boolean; rescueReason: string | null; durationMs: number }>();

  /** Write one connection's pending turns (spoken=null) on disconnect. */
  flushOwner(owner: string): void {
    for (const [id, t] of [...this.active]) {
      if (t.owner === owner && t.pendingTimer !== undefined) {
        clearTimeout(t.pendingTimer);
        this.active.delete(id);
        const finished = this.finishStash.get(id);
        this.finishStash.delete(id);
        this.write({
          turnId: t.turnId,
          kind: t.kind,
          intent: t.intent,
          startedAt: t.startedAt,
          durationMs: finished?.durationMs ?? this.clock() - t.startedAt,
          capture: t.capture,
          attempts: [...t.attempts],
          text: t.text,
          rescued: finished?.rescued ?? false,
          rescueReason: finished?.rescueReason ?? null,
          superseded: false,
          spoken: null,
        });
      }
    }
  }

  /** Write every pending turn (spoken=null). Used by tests and shutdown. */
  flushAll(): void {
    for (const [id, t] of [...this.active]) {
      if (t.pendingTimer !== undefined) {
        clearTimeout(t.pendingTimer);
        this.active.delete(id);
        const finished = this.finishStash.get(id);
        this.finishStash.delete(id);
        this.write({
          turnId: t.turnId,
          kind: t.kind,
          intent: t.intent,
          startedAt: t.startedAt,
          durationMs: finished?.durationMs ?? this.clock() - t.startedAt,
          capture: t.capture,
          attempts: [...t.attempts],
          text: t.text,
          rescued: finished?.rescued ?? false,
          rescueReason: finished?.rescueReason ?? null,
          superseded: false,
          spoken: null,
        });
      }
    }
  }

  /** Flush pending turns and drop all state (server shutdown). */
  close(): void {
    this.flushAll();
    for (const t of this.active.values()) {
      if (t.pendingTimer !== undefined) clearTimeout(t.pendingTimer);
    }
    this.active.clear();
    this.early.clear();
    this.finishStash.clear();
  }

  private write(record: TurnRecord): void {
    this.recent.push(record.turnId);
    this.recentSet.add(record.turnId);
    while (this.recent.length > TURN_RECENT_IDS) {
      const old = this.recent.shift();
      if (old !== undefined && !this.recent.includes(old)) this.recentSet.delete(old);
    }
    if (!this.enabled) return;
    const day = new Date(record.startedAt).toISOString().slice(0, 10);
    const line = `${JSON.stringify(record)}\n`;
    try {
      this.appendLine(day, line);
    } catch (err) {
      // The directory may have been removed under us (rotation, cleanup):
      // recreate it once and retry before giving up on the line.
      if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
        this.madeDirs.delete(this.dir);
        try {
          this.appendLine(day, line);
          return;
        } catch (retryErr) {
          console.error(`turn log write failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
          return;
        }
      }
      console.error(`turn log write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private appendLine(day: string, line: string): void {
    if (!this.madeDirs.has(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.madeDirs.add(this.dir);
    }
    appendFileSync(join(this.dir, `turns-${day}.jsonl`), line, "utf8");
  }
}
