// Change-detection gate (MVP.md section 2 component 2): pure module, no
// React Native imports, so it runs under node --test. The phone feeds it
// 32x32 grayscale pixels from the frame processor; it decides send vs drop.
// This module also hosts downsampleGrayPlane, which produces that 32x32
// input from a camera Y-plane buffer (called from a worklet in camera.ts).

export const GATE_SIZE = 32;
export const GATE_PIXELS = GATE_SIZE * GATE_SIZE;
/** Mean absolute per-pixel difference (0..255) above which the scene changed. */
export const GATE_THRESHOLD = 10;
/** Heartbeat: send at least this often even when nothing changed. */
export const GATE_HEARTBEAT_MS = 5000;

export interface GateState {
  lastSent: Uint8Array | null;
  lastSentAt: number;
}

export function createGate(): GateState {
  return { lastSent: null, lastSentAt: 0 };
}

function checkFrame(gray: Uint8Array): void {
  if (!(gray instanceof Uint8Array) || gray.length !== GATE_PIXELS) {
    throw new Error(`gate frame must be a ${GATE_PIXELS}-byte Uint8Array`);
  }
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  checkFrame(a);
  checkFrame(b);
  let sum = 0;
  for (let i = 0; i < GATE_PIXELS; i++) sum += Math.abs(a[i] - b[i]);
  return sum / GATE_PIXELS;
}

export type GateReason = "first" | "changed" | "heartbeat" | "no-change";

export function shouldSendGate(
  state: GateState,
  gray: Uint8Array,
  nowMs: number
): { send: boolean; reason: GateReason } {
  checkFrame(gray);
  if (state.lastSent === null) {
    state.lastSent = Uint8Array.from(gray);
    state.lastSentAt = nowMs;
    return { send: true, reason: "first" };
  }
  if (meanAbsDiff(state.lastSent, gray) > GATE_THRESHOLD) {
    state.lastSent = Uint8Array.from(gray);
    state.lastSentAt = nowMs;
    return { send: true, reason: "changed" };
  }
  if (nowMs - state.lastSentAt >= GATE_HEARTBEAT_MS) {
    state.lastSent = Uint8Array.from(gray);
    state.lastSentAt = nowMs;
    return { send: true, reason: "heartbeat" };
  }
  return { send: false, reason: "no-change" };
}

/**
 * Nearest-neighbor downsample of one grayscale plane (e.g. a YUV Y-plane)
 * to GATE_SIZE x GATE_SIZE. `srcStride` is bytes per source row and may be
 * larger than `srcWidth` (row padding). Returns a fresh buffer.
 */
export function downsampleGrayPlane(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  srcStride: number
): Uint8Array {
  "worklet";
  if (!(src instanceof Uint8Array)) {
    throw new Error("gate plane must be a Uint8Array");
  }
  if (
    !Number.isInteger(srcWidth) ||
    !Number.isInteger(srcHeight) ||
    srcWidth <= 0 ||
    srcHeight <= 0
  ) {
    throw new Error(`gate plane dimensions must be positive integers (got ${srcWidth}x${srcHeight})`);
  }
  if (!Number.isInteger(srcStride) || srcStride < srcWidth) {
    throw new Error(`gate plane stride ${srcStride} is smaller than width ${srcWidth}`);
  }
  if (src.length < srcStride * (srcHeight - 1) + srcWidth) {
    throw new Error(
      `gate plane buffer too small: ${src.length} bytes for ${srcWidth}x${srcHeight} @ stride ${srcStride}`
    );
  }
  const out = new Uint8Array(GATE_PIXELS);
  for (let y = 0; y < GATE_SIZE; y++) {
    const srcY = Math.min(srcHeight - 1, Math.floor((y * srcHeight) / GATE_SIZE));
    const rowOff = srcY * srcStride;
    for (let x = 0; x < GATE_SIZE; x++) {
      const srcX = Math.min(srcWidth - 1, Math.floor((x * srcWidth) / GATE_SIZE));
      out[y * GATE_SIZE + x] = src[rowOff + srcX];
    }
  }
  return out;
}
