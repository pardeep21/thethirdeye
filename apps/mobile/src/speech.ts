// Speech-out queue over Android TTS (expo-speech, on-device).
// P1 interrupts lower priorities mid-sentence; P2/P3 wait their turn.
// bargeIn() is the push-to-talk path: it stops speech the moment listening
// starts, except a cash line that just began (MVP rule: a command answer
// waits for a cash phrase in progress, which lasts <= 1.5 s).
//
// Reliability: Android TTS sometimes drops the onDone/onStopped/onError
// callback (notably right after engine start or after stop()), which used
// to wedge the queue with `speaking` stuck true forever. Every utterance
// now has a watchdog (see watchdogTimeoutMs): if no callback arrives in
// time, the queue logs tts_watchdog_fired, stops the engine, and moves on.
// A settled flag guards against late callbacks double-driving the pump.
//
// Testability: the speech backend and the clock/timer are injected (default
// expo-speech + real timers). This module has no static expo-speech import
// on purpose: the native module cannot load under plain Node, so unit tests
// inject a fake backend and the real backend is require()d lazily (Metro
// provides require(); plain Node never reaches it with a fake injected).
import type { SpeakLang, SpeakMessage } from "../../server/src/protocol";

/** Subset of the expo-speech API the queue needs. */
export interface SpeakOptions {
  language?: string;
  rate?: number;
  onStart?: () => void;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (error?: unknown) => void;
}

export interface SpeechBackend {
  speak(text: string, opts: SpeakOptions): void;
  stop(): void | Promise<void>;
  getAvailableVoicesAsync?(): Promise<unknown>;
}

/** Clock + timers, injectable so tests can drive the watchdog exactly. */
export interface SpeakClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SpeakClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let cachedExpoSpeech: SpeechBackend | null = null;

/** Lazily loads expo-speech so plain-Node tests never touch the native module. */
function expoSpeechBackend(): SpeechBackend {
  if (!cachedExpoSpeech) {
    if (typeof require === "undefined") {
      throw new Error("expo-speech unavailable: inject a SpeechBackend");
    }
    cachedExpoSpeech = require("expo-speech") as SpeechBackend;
  }
  return cachedExpoSpeech;
}

export interface SpeakQueueDeps {
  backend?: SpeechBackend;
  clock?: SpeakClock;
  /** Log sink; defaults to console.log. Watchdog/warmup lines go here. */
  log?: (line: string) => void;
}

const LANG_VOICE: Record<SpeakLang, string> = {
  pa: "pa-IN",
  hi: "hi-IN",
  en: "en-IN",
};

/** A cash line younger than this is left to finish on barge-in. */
export const CASH_GRACE_MS = 1500;

/** Watchdog budget: base + per-char speech time at rate 1, hard-capped. */
export const WATCHDOG_BASE_MS = 1500;
export const WATCHDOG_PER_CHAR_MS = 90;
export const WATCHDOG_MAX_MS = 20_000;

/** Max wall time the first line waits for TTS warm-up before speaking anyway. */
export const WARMUP_TIMEOUT_MS = 5000;

/** How many finished lines the diagnostics history keeps. */
export const MAX_RECENT_LINES = 5;

export function watchdogTimeoutMs(chars: number, rate: number): number {
  return Math.min(WATCHDOG_MAX_MS, WATCHDOG_BASE_MS + (chars * WATCHDOG_PER_CHAR_MS) / rate);
}

export type SpokenOutcome = "done" | "stopped" | "error" | "watchdog" | "threw";

export interface SpokenLine {
  text: string;
  durationMs: number;
  outcome: SpokenOutcome;
}

export interface TtsDiagnostics {
  watchdogFires: number;
  recent: SpokenLine[];
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SpeakQueue {
  private readonly backend: SpeechBackend;
  private readonly clock: SpeakClock;
  private readonly logLine: (line: string) => void;
  private queue: SpeakMessage[] = [];
  private speaking = false;
  private current: { msg: SpeakMessage; startedAt: number } | null = null;
  private rate = 1;
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private diagnosticsListeners = new Set<() => void>();
  private fires = 0;
  private history: SpokenLine[] = [];
  private warmUpPromise: Promise<void> | null = null;
  private warmUpStartMs: number | null = null;
  private firstOnStartLogged = false;

  constructor(deps: SpeakQueueDeps = {}) {
    this.backend = deps.backend ?? expoSpeechBackend();
    this.clock = deps.clock ?? realClock;
    this.logLine = deps.log ?? ((line) => console.log(line));
  }

  /** TTS rate multiplier (Settings); clamped to 0.5..1.5. */
  setRate(rate: number): void {
    this.rate = Math.min(1.5, Math.max(0.5, rate));
  }

  /** True while an utterance is playing or queued. Drives the Talk tile. */
  isSpeakingNow(): boolean {
    return this.speaking || this.queue.length > 0;
  }

  /** How many utterances the watchdog has rescued (diagnostics). */
  get watchdogFires(): number {
    return this.fires;
  }

  /** Snapshot for the Settings diagnostics section. */
  getDiagnostics(): TtsDiagnostics {
    return { watchdogFires: this.fires, recent: [...this.history] };
  }

  /** Subscribe to speaking-state changes (for the speaking tile visual). */
  onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(cb);
    return () => {
      this.speakingListeners.delete(cb);
    };
  }

  /** Subscribe to diagnostics changes (utterance finished / watchdog fired). */
  onDiagnosticsChange(cb: () => void): () => void {
    this.diagnosticsListeners.add(cb);
    return () => {
      this.diagnosticsListeners.delete(cb);
    };
  }

  private notifySpeaking(): void {
    const active = this.isSpeakingNow();
    for (const cb of this.speakingListeners) cb(active);
  }

  private notifyDiagnostics(): void {
    for (const cb of this.diagnosticsListeners) cb();
  }

  /**
   * Warm the TTS engine before the first real line: querying voices binds
   * the engine without speaking anything audible. Idempotent; never rejects
   * (timeout / errors are logged and the queue proceeds anyway).
   */
  warmUp(): Promise<void> {
    if (!this.warmUpPromise) this.warmUpPromise = this.doWarmUp();
    return this.warmUpPromise;
  }

  private doWarmUp(): Promise<void> {
    this.warmUpStartMs = this.clock.now();
    const getVoices = this.backend.getAvailableVoicesAsync;
    if (!getVoices) {
      this.logLine("tts_warmup skipped (no voices API)");
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const timer = this.clock.setTimeout(() => {
        if (done) return;
        done = true;
        this.logLine(`tts_warmup_timeout ms=${WARMUP_TIMEOUT_MS}`);
        resolve();
      }, WARMUP_TIMEOUT_MS);
      void Promise.resolve()
        .then(() => this.backend.getAvailableVoicesAsync?.())
        .then(
          (voices) => {
            if (done) return;
            done = true;
            this.clock.clearTimeout(timer);
            const count = Array.isArray(voices) ? voices.length : -1;
            this.logLine(`tts_warmup_ms=${this.clock.now() - (this.warmUpStartMs ?? this.clock.now())} voices=${count}`);
            resolve();
          },
          (err: unknown) => {
            if (done) return;
            done = true;
            this.clock.clearTimeout(timer);
            this.logLine(`tts_warmup_error err=${describeErr(err)}`);
            resolve();
          }
        );
    });
  }

  private noteFirstOnStart(): void {
    if (this.firstOnStartLogged) return;
    this.firstOnStartLogged = true;
    if (this.warmUpStartMs !== null) {
      this.logLine(`tts_first_onstart_ms=${this.clock.now() - this.warmUpStartMs}`);
    }
  }

  enqueue(msg: SpeakMessage): void {
    if (msg.priority === "P1") {
      // Drop everything queued and stop the current utterance; the pump
      // picks up the P1 next via onStopped (or via the watchdog when the
      // engine drops that callback).
      this.queue = [msg];
      void this.safeStop("p1");
    } else {
      this.queue.push(msg);
    }
    this.notifySpeaking();
    void this.pump();
  }

  /**
   * Stop speech for barge-in. Clears the queue always; stops the current
   * utterance unless it is a cash line inside its grace window.
   */
  bargeIn(nowMs?: number): void {
    const now = nowMs ?? this.clock.now();
    this.queue = [];
    this.notifySpeaking();
    const cur = this.current;
    if (cur && cur.msg.kind === "cash" && now - cur.startedAt <= CASH_GRACE_MS) return;
    void this.safeStop("bargein");
  }

  private async safeStop(reason: string): Promise<void> {
    try {
      await this.backend.stop();
    } catch (err) {
      this.logLine(`tts_stop_error reason=${reason} err=${describeErr(err)}`);
    }
  }

  /**
   * Drain the queue one utterance at a time. `speaking` guards re-entry;
   * the first pass awaits TTS warm-up so the engine is bound before the
   * first real line (with a timeout, so warm-up can never wedge speech).
   */
  private async pump(): Promise<void> {
    if (this.speaking) return;
    this.speaking = true;
    this.notifySpeaking();
    try {
      for (;;) {
        await this.warmUp();
        const next = this.queue.shift();
        if (!next) return;
        await this.speakOne(next);
      }
    } finally {
      this.current = null;
      this.speaking = false;
      this.notifySpeaking();
    }
  }

  private speakOne(msg: SpeakMessage): Promise<void> {
    const startedAt = this.clock.now();
    this.current = { msg, startedAt };
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const finish = (outcome: SpokenOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clock.clearTimeout(timer);
        this.record(msg.text, this.clock.now() - startedAt, outcome);
        this.current = null;
        resolve();
      };
      const timeoutMs = watchdogTimeoutMs(msg.text.length, this.rate);
      // The timer is armed before speak() so a backend that calls back
      // synchronously still ends up with exactly one finish.
      timer = this.clock.setTimeout(() => {
        if (settled) return;
        this.fires++;
        this.logLine(`tts_watchdog_fired len=${msg.text.length} timeout_ms=${timeoutMs} rate=${this.rate}`);
        finish("watchdog");
        // Silence any wedged engine audio; the late onStopped this may (or
        // may not) produce is ignored via `settled`.
        void this.safeStop("watchdog");
      }, timeoutMs);
      try {
        this.backend.speak(msg.text, {
          language: LANG_VOICE[msg.lang],
          rate: this.rate,
          onStart: () => this.noteFirstOnStart(),
          onDone: () => finish("done"),
          onStopped: () => finish("stopped"),
          onError: () => finish("error"),
        });
      } catch (err) {
        this.logLine(`tts_speak_threw err=${describeErr(err)}`);
        finish("threw");
      }
    });
  }

  private record(text: string, durationMs: number, outcome: SpokenOutcome): void {
    this.history.push({ text, durationMs, outcome });
    while (this.history.length > MAX_RECENT_LINES) this.history.shift();
    this.notifyDiagnostics();
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    this.notifySpeaking();
    await this.backend.stop();
  }
}
