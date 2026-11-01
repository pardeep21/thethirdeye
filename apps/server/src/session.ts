// Per-connection conversational session (prompt 02): answer language,
// spoken-output script, short history, look-around flag, last frame and
// the compact scene state the agent sees. In memory only; a disconnect
// drops it (a new WS connection starts a fresh session).
import type { FaceHit, SceneTriage, SpeakLang, SpokenScript, TriageResult } from "./protocol.js";
import { toClock } from "./clock.js";
import { FACE_MATCH_THRESHOLD } from "./decision.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** History keeps the last 10 turns (5 user/assistant pairs). */
export const HISTORY_MAX_TURNS = 10;

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

/**
 * Build the compact scene state from the latest perception. People clocks
 * come from calibrated x + the frame's hfov when the scene triage carries
 * coordinates, else the coarse position map (10/12/2); faces attach to
 * people positionally, exactly like the "who" path.
 */
export function sceneFromPerception(
  triage: TriageResult,
  faces: FaceHit[],
  lookAround: boolean,
  hfovDeg: number
): SceneState {
  const known = faces.filter((h) => h.personId && h.name && h.score >= FACE_MATCH_THRESHOLD);
  const people: ScenePerson[] = triage.people.map((p, i) => {
    const clock =
      typeof p.x === "number"
        ? toClock(p.x, hfovDeg)
        : p.position === "left"
          ? 10
          : p.position === "right"
            ? 2
            : 12;
    const desc = `${p.gender ?? "person"}${p.age_range ? ` around ${p.age_range}` : ""}${
      p.action ? `, ${p.action}` : ""
    }`;
    const person: ScenePerson = {
      ref: `P${i + 1}`,
      clock,
      distance: p.distance === "far" ? "far" : "near",
      desc,
    };
    const hit = known[i];
    if (hit?.name) person.knownName = hit.name;
    return person;
  });
  const recentNotes = triage.notes.slice(0, 3).map((n) =>
    n.denomination === null ? "unsure note" : `${n.denomination} (conf ${n.confidence.toFixed(1)})`
  );
  const sceneObjects = (triage as Partial<SceneTriage>).objects;
  const objects: SceneObjectView[] = Array.isArray(sceneObjects)
    ? sceneObjects.map((o) => ({ label: o.label, clock: toClock(o.x, hfovDeg), distance: o.distance }))
    : [];
  return { people, recentNotes, lookAround, objects };
}
