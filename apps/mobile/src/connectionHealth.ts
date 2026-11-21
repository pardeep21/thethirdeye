// Connection health: heartbeat, dead-socket kill, reconnect backoff and
// speak-once drop/back announcements. Pure: the clock, timers and random
// source are injected, EyeWs provides the socket side (sendPing/killSocket/
// reconnect) and App speaks the announcements through SpeakQueue.
export const PING_INTERVAL_MS = 5000;
/** No down-message for this long => the socket is half-open; kill it. */
export const DEAD_AFTER_MS = 12000;
/** Down this long before "network nahi" speaks (brief blips stay silent). */
export const LOST_ANNOUNCE_AFTER_MS = 3000;
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8000;

export interface HealthClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realHealthClock: HealthClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type AnnounceKind = "lost" | "back";

export interface HealthEvents {
  /** Send a ping carrying t (the phone's clock). */
  sendPing(t: number): void;
  /** Close the dead socket now; ends in onClosed() (no double count). */
  killSocket(): void;
  /** A backoff delay elapsed: open the socket again. */
  reconnect(): void;
  /** Speak once: "lost" after 3 s down, "back" on recovery from one. */
  announce(kind: AnnounceKind): void;
  onStatus(connected: boolean): void;
  /** RTT sample from a pong (now - echoed t). */
  onRtt(rttMs: number): void;
}

export interface HealthDeps {
  clock?: HealthClock;
  /** Jitter source in [0, 1); 0.5 reproduces the base sequence exactly. */
  random?: () => number;
}

/**
 * Reconnect delay for attempt N (0-based): 500, 1000, 2000, 4000, then
 * capped at 8000, with +/-20% jitter so clients don't retry in lockstep.
 */
export function backoffDelayMs(attempt: number, rand: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.8 + 0.4 * rand));
}

export class ConnectionHealth {
  private readonly events: HealthEvents;
  private readonly clock: HealthClock;
  private readonly random: () => number;
  private up = false;
  private stopped = false;
  private attempt = 0;
  private lastRx = 0;
  private announcedLost = false;
  private pingTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private lostTimer: unknown = null;

  constructor(events: HealthEvents, deps: HealthDeps = {}) {
    this.events = events;
    this.clock = deps.clock ?? realHealthClock;
    this.random = deps.random ?? Math.random;
  }

  get connected(): boolean {
    return this.up;
  }

  /** The socket opened and hello went up: reset backoff, start the heartbeat. */
  onOpened(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.up = true;
    this.lastRx = this.clock.now();
    this.clearReconnect();
    this.clearLost();
    this.events.onStatus(true);
    this.schedulePing();
    if (this.announcedLost) {
      this.announcedLost = false;
      this.events.announce("back");
    }
  }

  /** The socket closed (not auth): go down, arm backoff, maybe announce. */
  onClosed(): void {
    if (this.stopped) return;
    this.clearPing();
    if (this.up) {
      this.up = false;
      this.events.onStatus(false);
      // One 3 s timer per drop: retries while down must not push it out,
      // or a flapping socket would suppress the announcement forever.
      if (!this.announcedLost) {
        this.clearLost();
        this.lostTimer = this.clock.setTimeout(() => {
          this.lostTimer = null;
          if (!this.up && !this.stopped && !this.announcedLost) {
            this.announcedLost = true;
            this.events.announce("lost");
          }
        }, LOST_ANNOUNCE_AFTER_MS);
      }
    }
    // Every close rearms the backoff: each failed attempt waits longer.
    this.clearReconnect();
    const delay = backoffDelayMs(this.attempt, this.random());
    this.attempt++;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.events.reconnect();
    }, delay);
  }

  /** The server rejected the app token: stay down, no retry, no announcement. */
  onAuthFailed(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.up = false;
    this.clearAll();
    this.events.onStatus(false);
  }

  /** Any valid down-message proves the socket is alive. */
  onDownMessage(): void {
    this.lastRx = this.clock.now();
  }

  /** A pong proves liveness and yields an RTT sample. */
  onPong(sentT: number): void {
    const now = this.clock.now();
    this.lastRx = now;
    this.events.onRtt(now - sentT);
  }

  shutdown(): void {
    this.stopped = true;
    this.up = false;
    this.clearAll();
  }

  private schedulePing(): void {
    this.clearPing();
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null;
      if (this.stopped || !this.up) return;
      if (this.clock.now() - this.lastRx >= DEAD_AFTER_MS) {
        this.events.killSocket();
        return;
      }
      this.events.sendPing(this.clock.now());
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      this.clock.clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearLost(): void {
    if (this.lostTimer !== null) {
      this.clock.clearTimeout(this.lostTimer);
      this.lostTimer = null;
    }
  }

  private clearAll(): void {
    this.clearPing();
    this.clearReconnect();
    this.clearLost();
  }
}
