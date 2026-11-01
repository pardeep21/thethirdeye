// Look-around narration (prompt 03): a short summary on activation, then
// only new salient things (stationary scene = silence). Pure logic with an
// injected clock; the caller feeds emitted events to the decision engine,
// which speaks summaries as P2 and updates as P3. New people stay on the
// existing PERSON_ARRIVED/KNOWN_ARRIVED path and are never duplicated here.
import { toClock } from "./clock.js";
import type { SceneDecisionEvent, ScenePhraseItem } from "./decision.js";
import type { SceneObject, SceneTriage, TriagePerson, TriageResult } from "./protocol.js";

/** Summary speaks the top N candidates by salience, then nearness. */
export const NARRATOR_SUMMARY_TOP_N = 3;
/** "Hor ki hai?" pages this many unmentioned items at a time. */
export const NARRATOR_PAGE_SIZE = 3;
/** Max items in one scene update. */
export const NARRATOR_UPDATE_MAX_ITEMS = 2;
/** Min salience for summary/update/page candidates (1 is background clutter). */
export const NARRATOR_MIN_SALIENCE = 2;
/** A mentioned item stays quiet for this long. */
export const NARRATOR_RE_MENTION_MS = 60_000;
/** Min gap between two scene updates. */
export const NARRATOR_UPDATE_GAP_MS = 8_000;
/** An update candidate must appear in this many consecutive results. */
export const NARRATOR_STABILITY_FRAMES = 2;
/** People count as maximally salient inside summaries. */
const PERSON_SALIENCE = 3;

interface Candidate {
  key: string;
  salience: number;
  nearRank: number;
  item: ScenePhraseItem;
}

function distanceRank(d: string): number {
  return d === "near" ? 0 : d === "mid" ? 1 : 2;
}

function candidateKey(label: string, clock: number): string {
  return `${label.trim().toLowerCase()}@${clock}`;
}

function personNoun(p: TriagePerson): string {
  return p.gender === "woman" ? "aurat" : "banda";
}

/** Person clock: calibrated x when present, else the coarse position map. */
function personClock(p: TriagePerson, hfovDeg: number): number {
  if (typeof p.x === "number") return toClock(p.x, hfovDeg);
  return p.position === "left" ? 10 : p.position === "right" ? 2 : 12;
}

function readObjects(scene: TriageResult): SceneObject[] {
  const maybe = (scene as Partial<SceneTriage>).objects;
  return Array.isArray(maybe) ? maybe : [];
}

function bySalienceThenNearness(a: Candidate, b: Candidate): number {
  return b.salience - a.salience || a.nearRank - b.nearRank;
}

export class SceneNarrator {
  private active = false;
  private summarized = false;
  private mentioned = new Map<string, number>();
  private stability = new Map<string, number>();
  private lastUpdateTs = -Infinity;
  private lastObjects: Candidate[] = [];
  private seenScene = false;

  constructor(private readonly clock: () => number = Date.now) {}

  isActive(): boolean {
    return this.active;
  }

  /** True once at least one scene result arrived while active. */
  hasScene(): boolean {
    return this.seenScene;
  }

  /** Off clears everything: a fresh activation re-summarises from scratch. */
  setActive(on: boolean): void {
    this.active = on;
    this.summarized = false;
    this.mentioned.clear();
    this.stability.clear();
    this.lastUpdateTs = -Infinity;
    this.lastObjects = [];
    this.seenScene = false;
  }

  onScene(scene: TriageResult, hfovDeg: number, nowMs: number = this.clock()): SceneDecisionEvent[] {
    if (!this.active) return [];
    this.seenScene = true;
    this.lastObjects = readObjects(scene)
      .filter((o) => o.salience >= NARRATOR_MIN_SALIENCE)
      .map((o) => {
        const clock = toClock(o.x, hfovDeg);
        return {
          key: candidateKey(o.label, clock),
          salience: o.salience,
          nearRank: distanceRank(o.distance),
          item: { kind: "object", label: o.label, clock } as ScenePhraseItem,
        };
      })
      .sort(bySalienceThenNearness);
    // Stability counts consecutive appearances, including this frame.
    const present = new Set(this.lastObjects.map((c) => c.key));
    for (const key of [...this.stability.keys()]) {
      if (!present.has(key)) this.stability.delete(key);
    }
    for (const c of this.lastObjects) {
      this.stability.set(c.key, (this.stability.get(c.key) ?? 0) + 1);
    }
    if (!this.summarized) {
      this.summarized = true;
      return [this.summarise(scene.people, hfovDeg, nowMs)];
    }
    if (nowMs - this.lastUpdateTs < NARRATOR_UPDATE_GAP_MS) return [];
    const fresh = this.lastObjects.filter(
      (c) =>
        (this.stability.get(c.key) ?? 0) >= NARRATOR_STABILITY_FRAMES &&
        nowMs - (this.mentioned.get(c.key) ?? -Infinity) >= NARRATOR_RE_MENTION_MS
    );
    if (fresh.length === 0) return [];
    const picked = fresh.slice(0, NARRATOR_UPDATE_MAX_ITEMS);
    for (const c of picked) this.mentioned.set(c.key, nowMs);
    this.lastUpdateTs = nowMs;
    return [{ kind: "SCENE_UPDATE", items: picked.map((c) => c.item) }];
  }

  /**
   * "Hor ki hai?": the next unmentioned objects by salience, then
   * nearness, marked mentioned so a second ask pages further. Empty when
   * nothing unmentioned remains (the caller says "kujh khaas nahi").
   */
  requestMore(nowMs: number = this.clock()): ScenePhraseItem[] {
    const page = this.lastObjects
      .filter((c) => nowMs - (this.mentioned.get(c.key) ?? -Infinity) >= NARRATOR_RE_MENTION_MS)
      .slice(0, NARRATOR_PAGE_SIZE);
    for (const c of page) this.mentioned.set(c.key, nowMs);
    return page.map((c) => c.item);
  }

  private summarise(people: TriagePerson[], hfovDeg: number, nowMs: number): SceneDecisionEvent {
    const candidates: Candidate[] = [
      ...people.map((p) => {
        const clock = personClock(p, hfovDeg);
        return {
          key: candidateKey(personNoun(p), clock),
          salience: PERSON_SALIENCE,
          nearRank: distanceRank(p.distance),
          item: { kind: "person", gender: p.gender, clock } as ScenePhraseItem,
        };
      }),
      ...this.lastObjects,
    ].sort(bySalienceThenNearness);
    const picked = candidates.slice(0, NARRATOR_SUMMARY_TOP_N);
    for (const c of picked) this.mentioned.set(c.key, nowMs);
    return { kind: "SCENE_SUMMARY", items: picked.map((c) => c.item) };
  }
}
