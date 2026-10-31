// Push-to-talk state machine (pure, no RN imports): idle -> listening ->
// sending -> idle. Volume-key/Talk presses, recognizer callbacks and the WS
// send all flow through here with explicit timestamps (no real timers), so
// the hook stays thin and every path is unit-testable.
//
// Effects are returned, not performed: the hook interprets them
// (start/stop the recognizer, send WS messages, play earcons).

/** Min ms between accepted volume-key/Talk presses. */
export const PTT_DEBOUNCE_MS = 300;

export type PttPhase = "idle" | "listening" | "sending";

export interface PttState {
  phase: PttPhase;
  /** Timestamp of the last accepted press, or null before the first. */
  lastPressAt: number | null;
  /** Latest partial transcript while listening. */
  partial: string;
}

export function createPttState(): PttState {
  return { phase: "idle", lastPressAt: null, partial: "" };
}

export type PttEvent =
  | { type: "press" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; confidence?: number }
  | { type: "end" }
  | { type: "error"; code: string }
  | { type: "nomatch" }
  | { type: "sent" }
  | { type: "reset" };

export type PttEffect =
  | { type: "startListening" }
  | { type: "stopListening" }
  | { type: "sendUtterance"; text: string; confidence?: number }
  | { type: "thinkingEarcon" }
  | { type: "errorEarcon" }
  | { type: "listeningStarted" }
  | { type: "listeningStopped" };

export interface PttStep {
  state: PttState;
  effects: PttEffect[];
}

const NO_FX: PttEffect[] = [];

function idleStop(): PttStep {
  return {
    state: { phase: "idle", lastPressAt: null, partial: "" },
    effects: [{ type: "errorEarcon" }, { type: "listeningStopped" }],
  };
}

export function pttTransition(state: PttState, event: PttEvent, nowMs: number): PttStep {
  switch (event.type) {
    case "reset":
      return { state: createPttState(), effects: NO_FX };
    case "press": {
      if (state.phase === "sending") return { state, effects: NO_FX };
      if (state.lastPressAt !== null && nowMs - state.lastPressAt < PTT_DEBOUNCE_MS) {
        return { state, effects: NO_FX };
      }
      if (state.phase === "idle") {
        return {
          state: { phase: "listening", lastPressAt: nowMs, partial: "" },
          effects: [{ type: "listeningStarted" }, { type: "startListening" }],
        };
      }
      // Second press: ask the recognizer to stop; the final result (or an
      // end/error) that follows drives the transition back to idle.
      return {
        state: { ...state, lastPressAt: nowMs },
        effects: [{ type: "stopListening" }],
      };
    }
    case "partial":
      if (state.phase !== "listening") return { state, effects: NO_FX };
      return { state: { ...state, partial: event.text }, effects: NO_FX };
    case "final": {
      if (state.phase !== "listening") return { state, effects: NO_FX };
      const text = event.text.trim();
      if (!text) return withPress(state, idleStop());
      return {
        state: { ...state, phase: "sending", partial: "" },
        effects: [{ type: "sendUtterance", text, confidence: event.confidence }],
      };
    }
    case "end": {
      if (state.phase !== "listening") return { state, effects: NO_FX };
      const text = state.partial.trim();
      if (!text) return withPress(state, idleStop());
      return {
        state: { ...state, phase: "sending", partial: "" },
        effects: [{ type: "sendUtterance", text, confidence: undefined }],
      };
    }
    case "error":
    case "nomatch":
      if (state.phase !== "listening") return { state, effects: NO_FX };
      return withPress(state, idleStop());
    case "sent":
      if (state.phase !== "sending") return { state, effects: NO_FX };
      return {
        state: { ...state, phase: "idle", partial: "" },
        effects: [{ type: "thinkingEarcon" }, { type: "listeningStopped" }],
      };
  }
}

/** Keep the debounce clock across the transition to idle. */
function withPress(before: PttState, step: PttStep): PttStep {
  return { state: { ...step.state, lastPressAt: before.lastPressAt }, effects: step.effects };
}
