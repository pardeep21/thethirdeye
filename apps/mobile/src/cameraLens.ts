// One-shot capture lens for capture_now (prompt 07): reads ask for the
// sharper main lens even in look-around. Pure decision helper; the zoom
// switch + settle + restore lives in App.tsx.
import type { LensId } from "../../server/src/protocol";

/** Zoom settle before the one-shot capture (server waits 800 ms). */
export const LENS_SETTLE_MS = 300;

export interface CaptureLens {
  /** Lens to capture with. */
  lens: LensId;
  /** True when the zoom must switch away and back for this capture. */
  switched: boolean;
}

/**
 * Resolve the capture lens: the server's request wins, else the current
 * lens (including an in-flight override, so overlapping captures agree).
 */
export function resolveCaptureLens(
  requested: LensId | undefined,
  current: LensId
): CaptureLens {
  const lens = requested ?? current;
  return { lens, switched: lens !== current };
}
