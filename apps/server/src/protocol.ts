// Phone <-> server protocol plus perception result types (MVP.md section 2).
//
// IMPORTANT: this file has zero imports on purpose. apps/mobile imports it
// relatively (../../server/src/protocol) so both sides share one definition.
// Keep it dependency-free.

export type Priority = "P1" | "P2" | "P3";
export type SpeakLang = "pa" | "hi" | "en";

/** Server -> phone: say this. */
export interface SpeakMessage {
  type: "speak";
  text: string;
  lang: SpeakLang;
  priority: Priority;
}

/** Phone -> server: one gated camera frame (768px JPEG, base64). */
export interface FrameMessage {
  type: "frame";
  jpegBase64: string;
  width: number;
  height: number;
  ts: number;
}

/**
 * Phone -> server: push-to-talk utterance (base64). Android's recorder
 * cannot produce PCM, so the phone sends its native m4a/AAC file and the
 * server transcribes from that (real STT needs an m4a->wav step; the mock
 * ignores bytes).
 */
export interface AudioMessage {
  type: "audio";
  audioBase64: string;
  encoding: "pcm16" | "m4a";
  sampleRate: number;
  ts: number;
}

/** Phone -> server: local UI command. */
export interface CommandMessage {
  type: "command";
  name: "mute" | "unmute" | "cancel";
}

/** Phone -> server: settings that affect answers (from the settings screen). */
export interface SettingsMessage {
  type: "settings";
  lang: SpeakLang;
}

export type UpMessage = FrameMessage | AudioMessage | CommandMessage | SettingsMessage;
export type DownMessage = SpeakMessage;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isSpeakMessage(v: unknown): v is SpeakMessage {
  if (!isRecord(v) || v.type !== "speak") return false;
  return (
    typeof v.text === "string" &&
    (v.lang === "pa" || v.lang === "hi" || v.lang === "en") &&
    (v.priority === "P1" || v.priority === "P2" || v.priority === "P3")
  );
}

export function isFrameMessage(v: unknown): v is FrameMessage {
  if (!isRecord(v) || v.type !== "frame") return false;
  return (
    typeof v.jpegBase64 === "string" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.ts === "number"
  );
}

export function isAudioMessage(v: unknown): v is AudioMessage {
  if (!isRecord(v) || v.type !== "audio") return false;
  return (
    typeof v.audioBase64 === "string" &&
    (v.encoding === "pcm16" || v.encoding === "m4a") &&
    typeof v.sampleRate === "number" &&
    typeof v.ts === "number"
  );
}

export function isSettingsMessage(v: unknown): v is SettingsMessage {
  if (!isRecord(v) || v.type !== "settings") return false;
  return v.lang === "pa" || v.lang === "hi" || v.lang === "en";
}

export function isCommandMessage(v: unknown): v is CommandMessage {
  if (!isRecord(v) || v.type !== "command") return false;
  return v.name === "mute" || v.name === "unmute" || v.name === "cancel";
}

// --- Perception results (MVP.md section 2, adapter layer) ---

export type Denomination = 10 | 20 | 50 | 100 | 200 | 500;

export interface TriageNote {
  denomination: Denomination | null;
  confidence: number;
}

export interface TriagePerson {
  position: "left" | "centre" | "right";
  distance: "near" | "far";
  gender?: "man" | "woman";
  age_range?: string;
  action?: string;
}

export type TriageResult = {
  notes: TriageNote[];
  people: TriagePerson[];
};

export interface Box {
  /** Normalised 0..1 coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceHit {
  /** Enrolled person id, or null when no enrolled person matched. */
  personId: string | null;
  name: string | null;
  /** Cosine similarity 0..1 against the stored embedding. */
  score: number;
}
