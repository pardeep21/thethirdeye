// Device-keyed session cache (R5): when a phone reconnects within
// SESSION_RESUME_MS it keeps its conversation context (history, scene
// people, mute, language) instead of starting blank. Pure + clock-free:
// callers pass Date.now(), tests pass a fake clock.
import { Session } from "./session.js";

/** A reconnect gap shorter than this resumes the old session. */
export const SESSION_RESUME_MS = 60_000;

interface KeptSession {
  session: Session;
  disconnectedAt: number;
}

export class SessionStore {
  private readonly kept = new Map<string, KeptSession>();

  /** Park a session on disconnect, keyed by the hello device string. */
  keep(device: string, session: Session, now: number): void {
    this.evictExpired(now);
    this.kept.set(device, { session, disconnectedAt: now });
  }

  /**
   * Take a parked session back if the gap is under SESSION_RESUME_MS.
   * Consumes the entry either way (expired entries are dropped).
   */
  resume(device: string, now: number): Session | null {
    const entry = this.kept.get(device);
    if (!entry) return null;
    this.kept.delete(device);
    if (now - entry.disconnectedAt >= SESSION_RESUME_MS) return null;
    return entry.session;
  }

  private evictExpired(now: number): void {
    for (const [device, entry] of this.kept) {
      if (now - entry.disconnectedAt >= SESSION_RESUME_MS) this.kept.delete(device);
    }
  }
}
