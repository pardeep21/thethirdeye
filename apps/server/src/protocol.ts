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
  /** V2: server-assigned id for caption tracking (absent on older servers). */
  id?: string;
  /** V2: what kind of line this is (absent on older servers). */
  kind?: SpeakKind;
}

/** Phone -> server: one gated camera frame (768px JPEG, base64). */
export interface FrameMessage {
  type: "frame";
  jpegBase64: string;
  width: number;
  height: number;
  ts: number;
  /** V2: which lens captured this frame. */
  lens?: LensId;
  /** V2: horizontal field of view in degrees (for clock positions). */
  hfovDeg?: number;
  /** V2: present when this frame answers a capture_now request. */
  reqId?: string;
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

/** Spoken-output script (TTS voice test pending, prompt 02 default gurmukhi). */
export type SpokenScript = "gurmukhi" | "devanagari" | "latin";

/** Phone -> server: settings that affect answers (from the settings screen). */
export interface SettingsMessage {
  type: "settings";
  script?: SpokenScript;
  lang: SpeakLang;
}

// --- Protocol v2 (DEV-PLAN.md section 3) ---

/** Which camera lens captured a frame. */
export type LensId = "main" | "ultrawide";

/** What kind of line a speak message is. */
/** "heard" is phone-local (heard-transcript captions); the server never sends it. */
export type SpeakKind = "cash" | "answer" | "people" | "scene" | "system" | "heard";

/** Short UI blips the phone can play (locally or on server request). */
export type EarconName = "ack" | "thinking" | "error" | "saved";

/** On-device speech-recognition locale tag. */
export type UtteranceLang = "pa-IN" | "hi-IN" | "en-IN";

/** Phone -> server: sent once on every (re)connect. */
export interface HelloMessage {
  type: "hello";
  appVersion: string;
  device: string;
  /** Shared WS token; required when the server sets APP_TOKEN. */
  token?: string;
}

/** Phone -> server: recognised push-to-talk text (on-device STT path). */
export interface UtteranceMessage {
  type: "utterance";
  text: string;
  lang: UtteranceLang;
  confidence?: number;
  ts: number;
}

/** Phone -> server: listening state. start => server cancels P2/P3. */
export interface ListeningMessage {
  type: "listening";
  state: "start" | "stop";
}

/** Phone -> server: look-around mode switch (prompt 03 owns the server side). */
export interface ModeMessage {
  type: "mode";
  lookAround: boolean;
}

/** Server -> phone: play a bundled earcon. */
export interface EarconMessage {
  type: "earcon";
  name: EarconName;
}

/** Server -> phone: capture a frame now (the agent needs a fresh view). */
export interface CaptureNowMessage {
  type: "capture_now";
  reqId: string;
  lens?: LensId;
}

/** Server -> phone: mode/state snapshot for the home screen. */
export interface StateMessage {
  type: "state";
  lookAround: boolean;
  muted: boolean;
  agentBusy: boolean;
  lang: string;
  /** People-store revision: phones refetch /people when it changes. */
  peopleRev: number;
}

export type UpMessage =
  | FrameMessage
  | AudioMessage
  | CommandMessage
  | SettingsMessage
  | HelloMessage
  | UtteranceMessage
  | ListeningMessage
  | ModeMessage;
export type DownMessage = SpeakMessage | EarconMessage | CaptureNowMessage | StateMessage;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isOptString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isOptNumber(v: unknown): boolean {
  return v === undefined || typeof v === "number";
}

export function isSpeakMessage(v: unknown): v is SpeakMessage {
  if (!isRecord(v) || v.type !== "speak") return false;
  return (
    typeof v.text === "string" &&
    (v.lang === "pa" || v.lang === "hi" || v.lang === "en") &&
    (v.priority === "P1" || v.priority === "P2" || v.priority === "P3") &&
    isOptString(v.id) &&
    (v.kind === undefined ||
      v.kind === "cash" ||
      v.kind === "answer" ||
      v.kind === "people" ||
      v.kind === "scene" ||
      v.kind === "system")
  );
}

export function isFrameMessage(v: unknown): v is FrameMessage {
  if (!isRecord(v) || v.type !== "frame") return false;
  return (
    typeof v.jpegBase64 === "string" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.ts === "number" &&
    (v.lens === undefined || v.lens === "main" || v.lens === "ultrawide") &&
    isOptNumber(v.hfovDeg) &&
    isOptString(v.reqId)
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
  if (v.lang !== "pa" && v.lang !== "hi" && v.lang !== "en") return false;
  return v.script === undefined || v.script === "gurmukhi" || v.script === "devanagari" || v.script === "latin";
}

export function isCommandMessage(v: unknown): v is CommandMessage {
  if (!isRecord(v) || v.type !== "command") return false;
  return v.name === "mute" || v.name === "unmute" || v.name === "cancel";
}

export function isHelloMessage(v: unknown): v is HelloMessage {
  if (!isRecord(v) || v.type !== "hello") return false;
  return (
    typeof v.appVersion === "string" &&
    typeof v.device === "string" &&
    (v.token === undefined || typeof v.token === "string")
  );
}

export function isUtteranceMessage(v: unknown): v is UtteranceMessage {
  if (!isRecord(v) || v.type !== "utterance") return false;
  return (
    typeof v.text === "string" &&
    (v.lang === "pa-IN" || v.lang === "hi-IN" || v.lang === "en-IN") &&
    isOptNumber(v.confidence) &&
    typeof v.ts === "number"
  );
}

export function isListeningMessage(v: unknown): v is ListeningMessage {
  if (!isRecord(v) || v.type !== "listening") return false;
  return v.state === "start" || v.state === "stop";
}

export function isModeMessage(v: unknown): v is ModeMessage {
  if (!isRecord(v) || v.type !== "mode") return false;
  return typeof v.lookAround === "boolean";
}

export function isEarconMessage(v: unknown): v is EarconMessage {
  if (!isRecord(v) || v.type !== "earcon") return false;
  return v.name === "ack" || v.name === "thinking" || v.name === "error" || v.name === "saved";
}

export function isCaptureNowMessage(v: unknown): v is CaptureNowMessage {
  if (!isRecord(v) || v.type !== "capture_now") return false;
  return (
    typeof v.reqId === "string" &&
    (v.lens === undefined || v.lens === "main" || v.lens === "ultrawide")
  );
}

export function isStateMessage(v: unknown): v is StateMessage {
  if (!isRecord(v) || v.type !== "state") return false;
  return (
    typeof v.lookAround === "boolean" &&
    typeof v.muted === "boolean" &&
    typeof v.agentBusy === "boolean" &&
    typeof v.lang === "string" &&
    typeof v.peopleRev === "number"
  );
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
  /** Normalised 0..1 from the image's top-left (scene triage only). */
  x?: number;
  y?: number;
}

/** One salient thing in a look-around scene result. */
export interface SceneObject {
  /** Short noun in the user's code-mix ("thaila", "phone", "kursi"). */
  label: string;
  /** Normalised 0..1 from the image's top-left. */
  x: number;
  y: number;
  distance: "near" | "mid" | "far";
  /**
   * 3 = useful for a blind person (doors, steps, obstacles, counter
   * things, bags), 1 = background clutter. Max 8 per result.
   */
  salience: 1 | 2 | 3;
}

/** Look-around triage: cash + people (with coordinates) + scene objects. */
export type SceneTriage = TriageResult & {
  objects: SceneObject[];
};

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
