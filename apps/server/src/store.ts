// Latest-frame store: keeps only the most recent frame per client (MVP.md
// section 2 component 7). Frames are processed and discarded, never recorded.
import type { LensId } from "./protocol.js";

export interface StoredFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  ts: number;
  receivedAt: number;
  /** Which lens captured it (the UW cash crop keys off this). */
  lens?: LensId;
}

export class LatestFrameStore {
  private latest: StoredFrame | null = null;

  set(frame: StoredFrame): void {
    this.latest = frame;
  }

  get(): StoredFrame | null {
    return this.latest;
  }

  clear(): void {
    this.latest = null;
  }
}
