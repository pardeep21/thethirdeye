// TurnGuard (R1 silence fix): every user turn ends with something heard.
// begin() when a turn starts, markSpoken() when it sends a speak or an
// intentional ack earcon, finish() in a finally. A turn that produced
// nothing and was not superseded by a newer turn gets one fallback line.
// Pure logic with an injected clock and log; the caller owns speaking.
export interface TurnGuardOptions {
  clock?: () => number;
  log?: (msg: string) => void;
}

interface TurnState {
  spoken: boolean;
  finished: boolean;
  superseded: boolean;
  startedAt: number;
}

export class TurnGuard {
  private readonly clock: () => number;
  private readonly log: (msg: string) => void;
  private readonly turns = new Map<string, TurnState>();
  private latest: string | null = null;
  private rescued = 0;

  constructor(opts?: TurnGuardOptions) {
    this.clock = opts?.clock ?? Date.now;
    this.log = opts?.log ?? ((m) => console.log(m));
  }

  /** A new user turn starts; any unfinished earlier turn is superseded (barge-in). */
  begin(turnId: string): void {
    for (const [id, st] of this.turns) {
      if (id !== turnId && !st.finished) st.superseded = true;
    }
    this.latest = turnId;
    this.turns.set(turnId, { spoken: false, finished: false, superseded: false, startedAt: this.clock() });
  }

  /** The turn sent a non-empty speak or an intentional ack earcon. */
  markSpoken(turnId: string): void {
    const st = this.turns.get(turnId);
    if (st) st.spoken = true;
  }

  isSuperseded(turnId: string): boolean {
    return this.turns.get(turnId)?.superseded ?? false;
  }

  isSpoken(turnId: string): boolean {
    return this.turns.get(turnId)?.spoken ?? false;
  }

  get rescuedCount(): number {
    return this.rescued;
  }

  /**
   * End a turn. Returns true and runs speak() exactly once when the turn
   * produced nothing audible and was not superseded. Always safe in a
   * finally: thrown errors still rescue, double finish is a no-op.
   */
  finish(turnId: string, reason = "silent", speak?: () => void): boolean {
    const st = this.turns.get(turnId);
    if (!st || st.finished) return false;
    st.finished = true;
    if (st.spoken) return false;
    if (st.superseded) return false;
    if (this.latest !== turnId) return false;
    this.rescued++;
    this.log(`silent_turn_rescued reason=${reason}`);
    speak?.();
    return true;
  }
}
