// Per-connection conversational session (prompt 02): answer language,
// spoken-output script, short history, look-around flag, last frame and
// the compact scene state the agent sees. In memory only; a disconnect
// drops it (a new WS connection starts a fresh session).
import type { SceneTriage, SpeakLang, SpokenScript, TriagePerson, TriageResult } from "./protocol.js";
import { toClock } from "./clock.js";
import type { FaceTrack } from "./faces/tracker.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * History keeps the last 4 turns (2 user/assistant pairs). Deliberately
 * short: every turn costs prompt tokens and latency, and stale turns make
 * the model slower and more ramble-prone (field log: 1267 -> 1858 tokens
 * across one session, ending in timeouts and truncated JSON).
 */
export const HISTORY_MAX_TURNS = 4;

/** A voice-enrollment/forget flow waiting on the user (all expire quickly). */
export type PendingAction =
  | { kind: "remember-ask"; name: string; askedTs: number }
  | { kind: "remember-retry"; name: string; ref: string; collectUntilTs: number }
  | { kind: "duplicate-confirm"; name: string; ref: string; existing: string; askedTs: number }
  | { kind: "consent"; name: string; ref: string; askedTs: number; repeats: number }
  | { kind: "forget-confirm"; name: string; personId: number; askedTs: number };

/** How long disambiguation/consent/confirm questions stay answerable. */
export const PENDING_TTL_MS = 30_000;

/** Words per label-read chunk (the model speaks chunk 0, "hor" pages on). */
export const READ_CHUNK_WORDS = 20;
/** A label read older than this no longer answers "hor". */
export const READ_FRESH_MS = 60_000;

/** A label read with unspoken words: "hor" continues where it stopped. */
export interface LastRead {
  text: string;
  /** Next chunk index (0 = from the start; the model already spoke 0). */
  page: number;
  ts: number;
}

/** Words [page*20, page*20+20) of a label text, or null when exhausted. */
export function readChunk(
  text: string,
  page: number
): { chunk: string; hasMore: boolean } | null {
  const words = text.split(/\s+/).filter(Boolean);
  const start = page * READ_CHUNK_WORDS;
  if (start >= words.length) return null;
  const slice = words.slice(start, start + READ_CHUNK_WORDS);
  return { chunk: slice.join(" "), hasMore: start + READ_CHUNK_WORDS < words.length };
}

export interface ScenePerson {
  /** Stable-within-a-scene reference the agent uses ("P1", "P2", ...). */
  ref: string;
  /** Clock hour: calibrated x + hfov when scene coords exist, else 10/12/2. */
  clock: number;
  distance: "near" | "mid" | "far";
  /** Short generic description, e.g. "man around 30s". Never a name. */
  desc: string;
  /** Set only for enrolled people matched above threshold. */
  knownName?: string;
  /** From the nearest Spark person; feeds the "kaun hai" answer. */
  gender?: "man" | "woman";
}

/** One current scene object, clock-rendered for the agent block. */
export interface SceneObjectView {
  label: string;
  clock: number;
  distance: "near" | "mid" | "far";
}

export interface SceneState {
  people: ScenePerson[];
  /** Short recent-note lines, e.g. "500 (conf 0.9)". */
  recentNotes: string[];
  lookAround: boolean;
  /** Current look-around objects (empty unless a scene result arrived). */
  objects: SceneObjectView[];
}

export function emptyScene(): SceneState {
  return { people: [], recentNotes: [], lookAround: false, objects: [] };
}

export interface SessionFrame {
  jpeg: Buffer;
  hfovDeg: number;
  ts: number;
  receivedAt: number;
}

let nextSessionId = 1;

export class Session {
  readonly id: string;
  lang: SpeakLang = "pa";
  script: SpokenScript = "gurmukhi";
  history: Turn[] = [];
  lookAround = false;
  muted = false;
  agentBusy = false;
  lastFrame: SessionFrame | null = null;
  sceneState: SceneState = emptyScene();
  pendingAction: PendingAction | null = null;
  lastRead: LastRead | null = null;

  constructor() {
    this.id = `s${nextSessionId++}`;
  }

  pushTurn(turn: Turn): void {
    this.history.push(turn);
    if (this.history.length > HISTORY_MAX_TURNS) {
      this.history.splice(0, this.history.length - HISTORY_MAX_TURNS);
    }
  }
}

/** Coarse x for Spark people without coordinates (nearest-track matching). */
function personX(p: TriagePerson): number {
  if (typeof p.x === "number") return p.x;
  return p.position === "left" ? 0.15 : p.position === "right" ? 0.85 : 0.5;
}

function personDesc(p: TriagePerson): string {
  return `${p.gender ?? "person"}${p.age_range ? ` around ${p.age_range}` : ""}${
    p.action ? `, ${p.action}` : ""
  }`;
}

function personClock(p: TriagePerson, hfovDeg: number): number {
  return typeof p.x === "number"
    ? toClock(p.x, hfovDeg)
    : p.position === "left"
      ? 10
      : p.position === "right"
        ? 2
        : 12;
}

/**
 * Build the compact scene state from the latest perception. People come
 * from live face tracks (stable refs, track clocks, Spark attributes from
 * the nearest person by x, known names from matches). Without tracks
 * (no sidecar, or a genuinely empty frame) Spark people fill in with
 * positional S-refs, which never collide with track P-refs.
 */
export function sceneFromPerception(
  triage: TriageResult,
  tracks: FaceTrack[],
  lookAround: boolean,
  hfovDeg: number
): SceneState {
  let people: ScenePerson[];
  if (tracks.length > 0) {
    people = tracks.map((t) => {
      const cx = t.lastBoxNorm[0] + t.lastBoxNorm[2] / 2;
      let nearest: TriagePerson | null = null;
      let nearestDx = Infinity;
      for (const p of triage.people) {
        const dx = Math.abs(personX(p) - cx);
        if (dx < nearestDx) {
          nearestDx = dx;
          nearest = p;
        }
      }
      const person: ScenePerson = {
        ref: t.ref,
        clock: t.clock,
        distance: nearest ? nearest.distance : t.lastBoxNorm[2] >= 0.2 ? "near" : "far",
        desc: nearest ? personDesc(nearest) : "person",
      };
      if (t.knownName) person.knownName = t.knownName;
      if (nearest?.gender) person.gender = nearest.gender;
      return person;
    });
  } else {
    people = triage.people.map((p, i) => {
      const person: ScenePerson = {
        ref: `S${i + 1}`,
        clock: personClock(p, hfovDeg),
        distance: p.distance,
        desc: personDesc(p),
      };
      if (p.gender) person.gender = p.gender;
      return person;
    });
  }
  const recentNotes = triage.notes.slice(0, 3).map((n) =>
    n.denomination === null ? "unsure note" : `${n.denomination} (conf ${n.confidence.toFixed(1)})`
  );
  const sceneObjects = (triage as Partial<SceneTriage>).objects;
  const objects: SceneObjectView[] = Array.isArray(sceneObjects)
    ? sceneObjects.map((o) => ({ label: o.label, clock: toClock(o.x, hfovDeg), distance: o.distance }))
    : [];
  return { people, recentNotes, lookAround, objects };
}
