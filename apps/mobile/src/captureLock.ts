// Serialises camera takePhoto calls (R2): vision-camera rejects a second
// concurrent takePhoto, so gate uploads and capture_now share this mutex.
// capture_now jumps ahead of waiting gate uploads; a gate upload that is
// still waiting when a capture_now arrives is dropped (resolves null).
// Pure TS, no RN imports, so node:test can cover it.
export type CaptureKind = "gate" | "capture";

/** Release the lock; must be called exactly once per acquire. */
export type ReleaseFn = () => void;

interface Waiter {
  kind: CaptureKind;
  resolve: (release: ReleaseFn | null) => void;
}

export class CaptureLock {
  private busy = false;
  private readonly queue: Waiter[] = [];

  /**
   * Take the lock. Resolves with a release fn, or null when a gate
   * request is dropped (a capture_now arrived while it waited, a gate
   * was already waiting, or a newer gate replaced it).
   */
  acquire(kind: CaptureKind): Promise<ReleaseFn | null> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(() => this.release());
    }
    if (kind === "capture") {
      // Priority: drop every waiting gate, then queue behind any
      // captures already waiting (FIFO among captures).
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const entry = this.queue[i];
        if (entry && entry.kind === "gate") {
          this.queue.splice(i, 1);
          entry.resolve(null);
        }
      }
      return new Promise<ReleaseFn | null>((resolve) => {
        this.queue.push({ kind, resolve });
      });
    }
    // Gate: at most one may wait; a newer gate replaces it so the queue
    // never piles up faster than the camera drains it.
    const waiting = this.queue.findIndex((e) => e.kind === "gate");
    if (waiting !== -1) {
      const stale = this.queue[waiting];
      if (stale) stale.resolve(null);
      return new Promise<ReleaseFn | null>((resolve) => {
        this.queue[waiting] = { kind, resolve };
      });
    }
    return new Promise<ReleaseFn | null>((resolve) => {
      this.queue.push({ kind, resolve });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.busy = false;
      return;
    }
    next.resolve(() => this.release());
  }
}
