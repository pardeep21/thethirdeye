// SpeakQueue tests: ordering, P1 interrupt, barge-in grace, the stuck-TTs
// watchdog, late-callback guard, sync-throw recovery, and TTS warm-up.
// Runs under plain Node with a fake speech backend + fake clock (the real
// expo-speech module needs a device and is never loaded here).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CASH_GRACE_MS,
  WARMUP_TIMEOUT_MS,
  SpeakQueue,
  watchdogTimeoutMs,
  type SpeakClock,
  type SpeakOptions,
  type SpeechBackend,
} from "./speech.ts";
import type { SpeakMessage } from "../../server/src/protocol.ts";

/** Yield to the macrotask queue so all pending promise chains flush. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface PendingUtterance {
  text: string;
  opts: SpeakOptions;
}

class FakeBackend implements SpeechBackend {
  speaks: PendingUtterance[] = [];
  stops = 0;
  /** When true, the next speak() throws synchronously (then resets). */
  throwNext = false;
  /** Deferred voices resolver; null until getAvailableVoicesAsync is called. */
  voicesCalls = 0;
  private voicesImpl: (() => Promise<unknown[]>) | null = null;

  withVoices(impl: () => Promise<unknown[]>): this {
    this.voicesImpl = impl;
    return this;
  }

  speak(text: string, opts: SpeakOptions): void {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("synthetic speak crash");
    }
    this.speaks.push({ text, opts });
  }

  stop(): void {
    this.stops++;
  }

  getAvailableVoicesAsync(): Promise<unknown[]> {
    this.voicesCalls++;
    if (!this.voicesImpl) return Promise.resolve([]);
    return this.voicesImpl();
  }

  last(): PendingUtterance {
    const utt = this.speaks[this.speaks.length - 1];
    assert.ok(utt, "expected at least one speak() call");
    return utt;
  }
}

class FakeClock implements SpeakClock {
  t = 100_000;
  private nextId = 1;
  private timers = new Map<number, { due: number; cb: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.t + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Advance time, firing due timers in due order (flushing promises between). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let best: number | null = null;
      let bestDue = Infinity;
      for (const [id, tm] of this.timers) {
        if (tm.due <= end && tm.due < bestDue) {
          best = id;
          bestDue = tm.due;
        }
      }
      if (best === null) break;
      const tm = this.timers.get(best);
      assert.ok(tm);
      this.timers.delete(best);
      this.t = tm.due;
      tm.cb();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

interface Harness {
  queue: SpeakQueue;
  backend: FakeBackend;
  clock: FakeClock;
  logs: string[];
}

function makeQueue(backend?: FakeBackend): Harness {
  const b = backend ?? new FakeBackend();
  const clock = new FakeClock();
  const logs: string[] = [];
  const queue = new SpeakQueue({ backend: b, clock, log: (line) => void logs.push(line) });
  return { queue, backend: b, clock, logs };
}

const line = (text: string, priority: SpeakMessage["priority"] = "P2"): SpeakMessage => ({
  type: "speak",
  text,
  lang: "pa",
  priority,
});

test("speaks queued lines in order; onDone advances with durations", async () => {
  const { queue, backend, clock } = makeQueue();
  queue.enqueue(line("pehla"));
  queue.enqueue(line("duja"));
  await tick();
  assert.equal(backend.speaks.length, 1);
  assert.equal(backend.speaks[0].text, "pehla");
  await clock.advance(800);
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(backend.speaks.length, 2);
  assert.equal(backend.speaks[1].text, "duja");
  await clock.advance(1200);
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(queue.isSpeakingNow(), false);
  const diag = queue.getDiagnostics();
  assert.equal(diag.watchdogFires, 0);
  assert.equal(diag.recent.length, 2);
  assert.equal(diag.recent[0].text, "pehla");
  assert.equal(diag.recent[0].durationMs, 800);
  assert.equal(diag.recent[0].outcome, "done");
  assert.equal(diag.recent[1].durationMs, 1200);
});

test("P1 drops the queue and is spoken after the current line stops", async () => {
  const { queue, backend } = makeQueue();
  queue.enqueue(line("normal"));
  queue.enqueue(line("waiting"));
  await tick();
  assert.equal(backend.speaks.length, 1);
  queue.enqueue(line("zaroori", "P1"));
  assert.equal(backend.stops, 1);
  // The interrupted line's onStopped hands the pump to the P1.
  backend.last().opts.onStopped?.();
  await tick();
  await tick();
  assert.equal(backend.speaks.length, 2);
  assert.equal(backend.speaks[1].text, "zaroori");
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(queue.isSpeakingNow(), false);
  // The dropped P2 never spoke.
  assert.ok(!backend.speaks.some((s) => s.text === "waiting"));
});

test("bargeIn keeps a young cash line but clears the queue", async () => {
  const { queue, backend, clock } = makeQueue();
  queue.enqueue({ ...line("sau rupaye", "P2"), kind: "cash" });
  queue.enqueue(line("waiting"));
  await tick();
  assert.equal(backend.speaks.length, 1);
  const startedAt = clock.now();
  await clock.advance(CASH_GRACE_MS - 100);
  queue.bargeIn(clock.now());
  assert.equal(backend.stops, 0);
  assert.ok(clock.now() - startedAt <= CASH_GRACE_MS);
  // Queued line was dropped; the cash line finishes on its own.
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(backend.speaks.length, 1);
  assert.equal(queue.isSpeakingNow(), false);
});

test("bargeIn stops a cash line older than the grace window", async () => {
  const { queue, backend, clock } = makeQueue();
  queue.enqueue({ ...line("sau rupaye", "P2"), kind: "cash" });
  await tick();
  await clock.advance(CASH_GRACE_MS + 1);
  queue.bargeIn(clock.now());
  assert.equal(backend.stops, 1);
});

test("watchdog fires at the expected time when no callback arrives", async () => {
  const { queue, backend, clock, logs } = makeQueue();
  const text = "x".repeat(100);
  const expected = watchdogTimeoutMs(text.length, 1);
  assert.equal(expected, 1500 + 100 * 90);
  queue.enqueue(line(text));
  queue.enqueue(line("next"));
  await tick();
  assert.equal(backend.speaks.length, 1);
  await clock.advance(expected - 1);
  assert.equal(backend.speaks.length, 1);
  assert.equal(queue.watchdogFires, 0);
  await clock.advance(1);
  assert.equal(queue.watchdogFires, 1);
  assert.equal(backend.stops, 1);
  assert.ok(logs.some((l) => l.includes("tts_watchdog_fired")), `logs: ${logs.join(" | ")}`);
  // The pump moved on to the next line without any callback.
  assert.equal(backend.speaks.length, 2);
  assert.equal(backend.speaks[1].text, "next");
  const diag = queue.getDiagnostics();
  assert.equal(diag.recent[0].outcome, "watchdog");
  backend.last().opts.onDone?.();
  await tick();
});

test("late onDone after the watchdog does not speak twice", async () => {
  const { queue, backend, clock } = makeQueue();
  queue.enqueue(line("stuck"));
  await tick();
  const stuckOpts = backend.last().opts;
  await clock.advance(watchdogTimeoutMs("stuck".length, 1));
  assert.equal(queue.watchdogFires, 1);
  assert.equal(backend.speaks.length, 1);
  // Late callbacks from the wedged utterance are ignored.
  stuckOpts.onDone?.();
  stuckOpts.onStopped?.();
  await tick();
  await tick();
  assert.equal(backend.speaks.length, 1);
  assert.equal(queue.watchdogFires, 1);
  assert.equal(queue.isSpeakingNow(), false);
});

test("synchronous speak throw is logged and the queue continues", async () => {
  const { queue, backend, logs } = makeQueue();
  backend.throwNext = true;
  queue.enqueue(line("crash"));
  queue.enqueue(line("after"));
  await tick();
  await tick();
  assert.ok(logs.some((l) => l.includes("tts_speak_threw")), `logs: ${logs.join(" | ")}`);
  assert.equal(backend.speaks.length, 1);
  assert.equal(backend.speaks[0].text, "after");
  const diag = queue.getDiagnostics();
  assert.equal(diag.recent[0].outcome, "threw");
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(queue.isSpeakingNow(), false);
});

test("watchdog timeout is 1500ms + chars*90/rate, capped at 20s", () => {
  assert.equal(watchdogTimeoutMs(0, 1), 1500);
  assert.equal(watchdogTimeoutMs(100, 1), 1500 + 9000);
  assert.equal(watchdogTimeoutMs(100, 0.5), 1500 + 18000);
  assert.equal(watchdogTimeoutMs(100, 1.5), 1500 + 6000);
  assert.equal(watchdogTimeoutMs(10_000, 1), 20_000);
  assert.equal(watchdogTimeoutMs(10_000, 0.5), 20_000);
});

test("warmUp resolves voices before the first line, logging timings", async () => {
  const backend = new FakeBackend();
  let releaseVoices!: (voices: unknown[]) => void;
  const voicesGate = new Promise<unknown[]>((r) => {
    releaseVoices = r;
  });
  backend.withVoices(() => voicesGate);
  const { queue, clock, logs } = makeQueue(backend);
  queue.enqueue(line("pehla"));
  await tick();
  await tick();
  // First line waits for engine warm-up.
  assert.equal(backend.speaks.length, 0);
  await clock.advance(250);
  releaseVoices([{}, {}, {}]);
  await tick();
  await tick();
  assert.equal(backend.speaks.length, 1);
  assert.ok(logs.some((l) => l.startsWith("tts_warmup_ms=")), `logs: ${logs.join(" | ")}`);
  // Time to first onStart is measured from warm-up start.
  await clock.advance(100);
  backend.last().opts.onStart?.();
  assert.ok(logs.some((l) => l.includes("tts_first_onstart_ms=")), `logs: ${logs.join(" | ")}`);
  // warmUp is idempotent: one voices query total.
  await queue.warmUp();
  assert.equal(backend.voicesCalls, 1);
  backend.last().opts.onDone?.();
  await tick();
});

test("warmUp timeout never wedges the queue", async () => {
  const backend = new FakeBackend().withVoices(() => new Promise<unknown[]>(() => {}));
  const { queue, clock, logs } = makeQueue(backend);
  queue.enqueue(line("pehla"));
  await tick();
  assert.equal(backend.speaks.length, 0);
  await clock.advance(WARMUP_TIMEOUT_MS);
  await tick();
  assert.equal(backend.speaks.length, 1);
  assert.ok(logs.some((l) => l.includes("tts_warmup_timeout")), `logs: ${logs.join(" | ")}`);
  backend.last().opts.onDone?.();
  await tick();
});

test("warmUp without a voices API resolves immediately", async () => {
  const backend = new FakeBackend();
  (backend as unknown as { getAvailableVoicesAsync?: unknown }).getAvailableVoicesAsync = undefined;
  const { queue, logs } = makeQueue(backend);
  await queue.warmUp();
  assert.ok(logs.some((l) => l.includes("tts_warmup skipped")), `logs: ${logs.join(" | ")}`);
});

test("diagnostics keep only the last 5 lines", async () => {
  const { queue, backend } = makeQueue();
  for (let i = 0; i < 7; i++) queue.enqueue(line(`line${i}`));
  await tick();
  for (let i = 0; i < 7; i++) {
    backend.last().opts.onDone?.();
    await tick();
  }
  const diag = queue.getDiagnostics();
  assert.equal(diag.recent.length, 5);
  assert.deepEqual(
    diag.recent.map((r) => r.text),
    ["line2", "line3", "line4", "line5", "line6"]
  );
});

test("onSpoken reports turnId lines with TTS-start/ended/outcome, skips local lines", async () => {
  const { queue, backend, clock } = makeQueue();
  const reports: Array<{ turnId: string; startedAt: number; endedAt: number; outcome: string }> = [];
  queue.onSpoken((r) => void reports.push(r));
  queue.enqueue({ ...line("server line"), turnId: "t7" });
  queue.enqueue(line("local line"));
  await tick();
  const t0 = clock.now();
  await clock.advance(100);
  backend.speaks[0].opts.onStart?.();
  const tStart = clock.now();
  await clock.advance(400);
  backend.speaks[0].opts.onDone?.();
  await tick();
  backend.speaks[1].opts.onDone?.();
  await tick();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], { turnId: "t7", startedAt: tStart, endedAt: tStart + 400, outcome: "done" });
  assert.ok(tStart > t0, "TTS start comes from onStart, not the speak call");
});

test("onSpoken maps threw to error and watchdog stays watchdog", async () => {
  const { queue, backend, clock } = makeQueue();
  const reports: Array<{ turnId: string; outcome: string }> = [];
  queue.onSpoken((r) => void reports.push(r));
  backend.throwNext = true;
  queue.enqueue({ ...line("crash"), turnId: "t1" });
  queue.enqueue({ ...line("stuck"), turnId: "t2" });
  await tick();
  await tick();
  assert.deepEqual(
    reports.map((r) => [r.turnId, r.outcome]),
    [["t1", "error"]]
  );
  // The stuck line's receipt falls back to the speak-call start time.
  await clock.advance(watchdogTimeoutMs("stuck".length, 1));
  assert.deepEqual(
    reports.map((r) => [r.turnId, r.outcome]),
    [
      ["t1", "error"],
      ["t2", "watchdog"],
    ]
  );
  backend.last().opts.onDone?.();
  await tick();
});

test("onSpoken unsubscribe stops receipts", async () => {
  const { queue, backend } = makeQueue();
  let n = 0;
  const unsub = queue.onSpoken(() => void n++);
  queue.enqueue({ ...line("one"), turnId: "t1" });
  await tick();
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(n, 1);
  unsub();
  queue.enqueue({ ...line("two"), turnId: "t2" });
  await tick();
  backend.last().opts.onDone?.();
  await tick();
  assert.equal(n, 1);
});
