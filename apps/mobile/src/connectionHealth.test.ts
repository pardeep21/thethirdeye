// ConnectionHealth tests with a fake clock: backoff sequence + jitter,
// dead-socket detection, announce-once rules, reset on success, auth stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelayMs,
  ConnectionHealth,
  type AnnounceKind,
} from "./connectionHealth.ts";

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; cb: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Advance time, firing due timers in due order (re-arms included). */
  advance(ms: number): void {
    const end = this.nowMs + ms;
    for (;;) {
      let first: number | null = null;
      let firstAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= end && t.at < firstAt) {
          first = id;
          firstAt = t.at;
        }
      }
      if (first === null) break;
      const t = this.timers.get(first);
      if (!t) break;
      this.timers.delete(first);
      this.nowMs = t.at;
      t.cb();
    }
    this.nowMs = end;
  }
}

interface Harness {
  health: ConnectionHealth;
  clock: FakeClock;
  pings: number[];
  kills: number;
  reconnects: number[];
  announces: AnnounceKind[];
  statuses: boolean[];
  rtts: number[];
}

function setup(rand = 0.5): Harness {
  const clock = new FakeClock();
  const h = {
    clock,
    pings: [] as number[],
    kills: 0,
    reconnects: [] as number[],
    announces: [] as AnnounceKind[],
    statuses: [] as boolean[],
    rtts: [] as number[],
  } as Harness;
  h.health = new ConnectionHealth(
    {
      sendPing: (t) => void h.pings.push(t),
      // Like EyeWs: killing the dead socket ends in onClosed() exactly once.
      killSocket: () => {
        h.kills++;
        h.health.onClosed();
      },
      reconnect: () => void h.reconnects.push(clock.now()),
      announce: (kind) => void h.announces.push(kind),
      onStatus: (connected) => void h.statuses.push(connected),
      onRtt: (rttMs) => void h.rtts.push(rttMs),
    },
    { clock, random: () => rand }
  );
  return h;
}

test("backoff sequence is 500/1000/2000/4000 then capped at 8000", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 10].map((a) => backoffDelayMs(a, 0.5)),
    [500, 1000, 2000, 4000, 8000, 8000, 8000]
  );
});

test("jitter scales the base by 0.8x..1.2x", () => {
  assert.equal(backoffDelayMs(0, 0), 400);
  assert.equal(backoffDelayMs(0, 1), 600);
  assert.equal(backoffDelayMs(2, 0), 1600);
  assert.equal(backoffDelayMs(2, 1), 2400);
  assert.equal(backoffDelayMs(4, 1), 9600);
});

test("each failed attempt waits longer", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(500);
  assert.deepEqual(h.reconnects, [500]);
  h.health.onClosed();
  h.clock.advance(1000);
  assert.deepEqual(h.reconnects, [500, 1500]);
  h.health.onClosed();
  h.clock.advance(2000);
  assert.deepEqual(h.reconnects, [500, 1500, 3500]);
  h.health.onClosed();
  h.clock.advance(4000);
  assert.deepEqual(h.reconnects, [500, 1500, 3500, 7500]);
  h.health.onClosed();
  h.clock.advance(8000);
  assert.deepEqual(h.reconnects, [500, 1500, 3500, 7500, 15500]);
});

test("a successful hello resets the backoff", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onClosed();
  h.health.onClosed();
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(499);
  assert.deepEqual(h.reconnects, []);
  h.clock.advance(1);
  assert.deepEqual(h.reconnects, [500]);
});

test("a silent socket is killed after 12 s without any down-message", () => {
  const h = setup();
  h.health.onOpened();
  h.clock.advance(5000);
  assert.deepEqual(h.pings, [5000]);
  h.clock.advance(5000);
  assert.deepEqual(h.pings, [5000, 10000]);
  assert.equal(h.kills, 0);
  // The dead check runs on the 5 s tick: the first tick past 12 s kills.
  h.clock.advance(5000);
  assert.equal(h.kills, 1);
  assert.deepEqual(h.pings, [5000, 10000]);
  assert.deepEqual(h.statuses, [true, false]);
  // The kill ends in onClosed: backoff rearms from the first step.
  h.clock.advance(500);
  assert.deepEqual(h.reconnects, [15500]);
});

test("any down-message proves liveness and delays the kill", () => {
  const h = setup();
  h.health.onOpened();
  h.clock.advance(10000);
  h.health.onDownMessage();
  h.clock.advance(5000);
  assert.equal(h.kills, 0);
  assert.deepEqual(h.pings, [5000, 10000, 15000]);
  h.clock.advance(5000);
  assert.equal(h.kills, 0);
  h.clock.advance(5000);
  assert.equal(h.kills, 1);
});

test("a pong reports RTT and proves liveness", () => {
  const h = setup();
  h.health.onOpened();
  h.clock.advance(5000);
  h.clock.advance(120);
  h.health.onPong(5000);
  assert.deepEqual(h.rtts, [120]);
  // Last Rx is now 5120: the 10 s tick still pings, nothing is killed.
  h.clock.advance(4880);
  assert.equal(h.kills, 0);
  assert.deepEqual(h.pings, [5000, 10000]);
});

test("drop announced once after 3 s, back once on recovery", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(2999);
  assert.deepEqual(h.announces, []);
  h.clock.advance(1);
  assert.deepEqual(h.announces, ["lost"]);
  // Retries while down never re-announce or re-fire status.
  h.health.onClosed();
  h.health.onClosed();
  h.clock.advance(20000);
  assert.deepEqual(h.announces, ["lost"]);
  assert.deepEqual(h.statuses, [true, false]);
  // Recovery after an announced drop speaks "back" exactly once.
  h.health.onOpened();
  assert.deepEqual(h.announces, ["lost", "back"]);
  assert.deepEqual(h.statuses, [true, false, true]);
});

test("a drop under 3 s stays silent both ways", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(1000);
  h.health.onOpened();
  h.clock.advance(10000);
  assert.deepEqual(h.announces, []);
  assert.deepEqual(h.statuses, [true, false, true]);
});

test("a second long drop announces again", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(3000);
  h.health.onOpened();
  h.health.onClosed();
  h.clock.advance(3000);
  assert.deepEqual(h.announces, ["lost", "back", "lost"]);
});

test("auth failure stops everything silently", () => {
  const h = setup();
  h.health.onOpened();
  h.health.onAuthFailed();
  assert.deepEqual(h.statuses, [true, false]);
  h.clock.advance(60000);
  assert.deepEqual(h.reconnects, []);
  assert.deepEqual(h.announces, []);
  assert.deepEqual(h.pings, []);
});

test("shutdown stops all timers", () => {
  const h = setup();
  h.health.onOpened();
  h.health.shutdown();
  assert.equal(h.health.connected, false);
  h.clock.advance(60000);
  assert.deepEqual(h.pings, []);
  assert.deepEqual(h.reconnects, []);
  assert.deepEqual(h.announces, []);
});
