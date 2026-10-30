// Latest-frame store: keeps only the most recent frame per client (MVP.md
// section 2 component 7). Frames are processed and discarded, never recorded.

export interface StoredFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  ts: number;
  receivedAt: number;
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
