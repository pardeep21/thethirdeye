// Camera frame-liveness monitor (R6): pure module, no React Native
// imports, so it runs under node --test. The app feeds it the gate frame
// processor's last output time plus whether the camera should run; it
// reports ok/stalled/off, and the transition helper keeps the "camera band
// hai"/"camera chalu" lines and the camera_state uplink to speak-once.
export const CAMERA_STALL_MS = 4000;

/** Mirrors the protocol CameraState ("ok" | "stalled" | "off"). */
export type CameraLiveness = "ok" | "stalled" | "off";

export interface LivenessSample {
  /** The app believes the camera should run (foreground + device + permission). */
  shouldRun: boolean;
  /** Last gate frame-processor output, or null when none arrived yet. */
  lastFrameAt: number | null;
  /** When shouldRun last became true, or null while the camera is off. */
  activeSinceMs: number | null;
  nowMs: number;
  /** A Camera onError fired and no frame arrived since: stalled now. */
  cameraError?: boolean;
  stallMs?: number;
}

/**
 * Liveness from one sample: "off" while the camera should not run,
 * "stalled" once the gate path went quiet for stallMs (or a camera error
 * is outstanding), else "ok". A camera that only just started gets the
 * full stall window before it can read stalled.
 */
export function cameraLiveness(s: LivenessSample): CameraLiveness {
  if (!s.shouldRun) return "off";
  if (s.cameraError) return "stalled";
  const stallMs = s.stallMs ?? CAMERA_STALL_MS;
  const since = s.lastFrameAt ?? s.activeSinceMs ?? s.nowMs;
  return s.nowMs - since >= stallMs ? "stalled" : "ok";
}

/** "off" speaks CAMERA_OFF, "back" speaks CAMERA_BACK. */
export type LivenessSpeech = "off" | "back" | null;

export interface LivenessTransition {
  speak: LivenessSpeech;
  /** True on every change: the phone uplinks each new state. */
  sendState: boolean;
}

/**
 * Speak-once transitions: leaving ok announces "camera band hai" once,
 * returning to ok announces "camera chalu" once, and moves between the
 * two down states stay silent (he was already told).
 */
export function livenessTransition(prev: CameraLiveness, next: CameraLiveness): LivenessTransition {
  if (prev === next) return { speak: null, sendState: false };
  if (next === "ok") return { speak: "back", sendState: true };
  if (prev === "ok") return { speak: "off", sendState: true };
  return { speak: null, sendState: true };
}
