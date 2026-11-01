// Decision engine (MVP.md section 4): turns perception streams into events,
// applies stability, dedupe and priority, and decides speak vs silence.
// Pure logic with injectable clock and renderer; the M3 phrase builder plugs
// in as the renderer.

import type {
  Denomination,
  Priority,
  SpeakLang,
  TriagePerson,
  TriageResult,
} from "./protocol.js";

export const NOTE_ABSENT_REARM_MS = 3000;
export const NOTE_UNSURE_SILENCE_MS = 8000;
export const KNOWN_SILENCE_MS = 10 * 60 * 1000;
export const PERSON_SILENCE_MS = 2 * 60 * 1000;
export const PERSON_MIN_GAP_MS = 30 * 1000;
export const P2_MAX_AGE_MS = 5000;
export const P3_MAX_AGE_MS = 3000;
/**
 * Cosine-similarity match threshold. 0.75 was a pre-ArcFace guess; ArcFace
 * same-person pairs typically score ~0.4-0.7, so the default is 0.45 until
 * the photo-set calibration (apps/faces/calibrate.py) pins it.
 */
export const FACE_MATCH_THRESHOLD = 0.45;
/** A match must also clear the runner-up enrolled person by this margin. */
export const FACE_MATCH_MARGIN = 0.08;
export const P1_QUEUE_MAX = 10;

/** One spoken item in a look-around summary or update (clock pre-rendered). */
export type ScenePhraseItem =
  | { kind: "object"; label: string; clock: number }
  | { kind: "person"; gender?: "man" | "woman"; clock: number };

/**
 * What the known-person path needs from a face track. Tracks carry
 * knownPersonId/knownName only when the matcher cleared threshold +
 * margin, so no score filtering happens here.
 */
export interface KnownTrackSight {
  knownPersonId?: string;
  knownName?: string;
  clock: number;
}

export type DecisionEvent =
  | { kind: "NOTE_SEEN"; denominations: Denomination[]; confidences: number[] }
  | { kind: "NOTE_UNSURE" }
  | { kind: "KNOWN_ARRIVED"; personId: string; name: string; clock?: number }
  | { kind: "PERSON_ARRIVED"; count: number; people: TriagePerson[] }
  | { kind: "SCENE_SUMMARY"; items: ScenePhraseItem[] }
  | { kind: "SCENE_UPDATE"; items: ScenePhraseItem[] }
  | { kind: "COMMAND_ANSWER"; text: string; lang: SpeakLang };

export type ProactiveEvent = Exclude<DecisionEvent, { kind: "COMMAND_ANSWER" }>;

/** Look-around narration events (summary speaks P2, updates P3). */
export type SceneDecisionEvent = Extract<DecisionEvent, { kind: "SCENE_SUMMARY" | "SCENE_UPDATE" }>;

export interface RenderedPhrase {
  text: string;
  lang: SpeakLang;
}

export type PhraseRenderer = (event: ProactiveEvent) => RenderedPhrase;

export interface SpeakAction {
  text: string;
  lang: SpeakLang;
  priority: Priority;
  event: DecisionEvent;
  enqueuedAt: number;
}

interface Queued {
  event: DecisionEvent;
  priority: Priority;
  enqueuedAt: number;
}

/** Minimal English renderer for M2 wiring; M3 replaces it with real phrases. */
export function minimalRenderer(event: ProactiveEvent): RenderedPhrase {
  switch (event.kind) {
    case "NOTE_SEEN":
      return {
        text:
          event.denominations.length === 1
            ? `note ${event.denominations[0]}`
            : `notes ${event.denominations.join(" and ")}`,
        lang: "en",
      };
    case "NOTE_UNSURE":
      return { text: "not sure, show again", lang: "en" };
    case "KNOWN_ARRIVED":
      return { text: `${event.name} arrived`, lang: "en" };
    case "PERSON_ARRIVED":
      return { text: event.count === 1 ? "1 person" : `${event.count} people`, lang: "en" };
    case "SCENE_SUMMARY":
      return { text: `scene: ${event.items.length} items`, lang: "en" };
    case "SCENE_UPDATE":
      return { text: `update: ${event.items.length} items`, lang: "en" };
  }
}

interface NoteTrack {
  streak: number;
  confs: number[];
  spoken: boolean;
  absentSince: number | null;
}

interface KnownTrack {
  window: boolean[];
  spokenAt: number;
}

export class DecisionEngine {
  private notes = new Map<Denomination, NoteTrack>();
  private nullStreak = 0;
  private unsureSpokenAt = -Infinity;
  private known = new Map<string, KnownTrack>();
  private prevCount = 0;
  private upStreak = 0;
  private upCount = 0;
  private personFiredAt = -Infinity;
  private personSpokenAt = -Infinity;
  private muted = false;
  private p1: Queued[] = [];
  private p2: Queued[] = [];
  private p3: Queued | null = null;

  constructor(
    private readonly render: PhraseRenderer = minimalRenderer,
    private readonly clock: () => number = Date.now
  ) {}

  onFrame(triage: TriageResult, tracks: KnownTrackSight[], nowMs: number = this.clock()): DecisionEvent[] {
    const fired: DecisionEvent[] = [];
    this.updateNotes(triage, nowMs, fired);
    const knownFired = this.updateKnown(tracks, nowMs, fired);
    this.updatePersonCount(triage, nowMs, fired, knownFired);
    return fired;
  }

  private trackFor(d: Denomination): NoteTrack {
    let t = this.notes.get(d);
    if (!t) {
      t = { streak: 0, confs: [], spoken: false, absentSince: null };
      this.notes.set(d, t);
    }
    return t;
  }

  private updateNotes(triage: TriageResult, nowMs: number, fired: DecisionEvent[]): void {
    const confByDenom = new Map<Denomination, number>();
    let nullPresent = false;
    for (const n of triage.notes) {
      if (n.denomination === null) {
        nullPresent = true;
        continue;
      }
      confByDenom.set(n.denomination, Math.max(confByDenom.get(n.denomination) ?? -1, n.confidence));
    }

    const newlyStable: { d: Denomination; conf: number }[] = [];
    let unclearValued = false;
    const keys = new Set<Denomination>([...this.notes.keys(), ...confByDenom.keys()]);
    for (const d of keys) {
      const t = this.trackFor(d);
      const conf = confByDenom.get(d);
      if (conf === undefined) {
        if ((t.streak > 0 || t.spoken) && t.absentSince === null) t.absentSince = nowMs;
        t.streak = 0;
        t.confs = [];
        continue;
      }
      if (t.absentSince !== null && nowMs - t.absentSince > NOTE_ABSENT_REARM_MS) t.spoken = false;
      t.absentSince = null;
      t.streak++;
      t.confs.push(conf);
      if (t.confs.length > 2) t.confs.shift();
      if (t.spoken) continue;
      if (conf >= 0.85 || t.streak >= 2) {
        const low2 = t.confs.length >= 2 && t.confs.every((c) => c < 0.6);
        if (low2) unclearValued = true;
        else newlyStable.push({ d, conf });
      }
    }

    if (nullPresent) this.nullStreak++;
    else this.nullStreak = 0;

    if (newlyStable.length > 0) {
      for (const s of newlyStable) this.trackFor(s.d).spoken = true;
      const ev: DecisionEvent = {
        kind: "NOTE_SEEN",
        denominations: newlyStable.map((s) => s.d),
        confidences: newlyStable.map((s) => s.conf),
      };
      this.enqueueP1(ev, nowMs);
      fired.push(ev);
    }
    if (
      (unclearValued || (nullPresent && this.nullStreak >= 2)) &&
      nowMs - this.unsureSpokenAt >= NOTE_UNSURE_SILENCE_MS
    ) {
      this.unsureSpokenAt = nowMs;
      const ev: DecisionEvent = { kind: "NOTE_UNSURE" };
      this.enqueueP1(ev, nowMs);
      fired.push(ev);
    }
  }

  private updateKnown(tracks: KnownTrackSight[], nowMs: number, fired: DecisionEvent[]): number {
    const matched = new Map<string, { name: string; clock: number }>();
    for (const t of tracks) {
      if (t.knownPersonId && t.knownName && !matched.has(t.knownPersonId)) {
        matched.set(t.knownPersonId, { name: t.knownName, clock: t.clock });
      }
    }
    let count = 0;
    const keys = new Set<string>([...this.known.keys(), ...matched.keys()]);
    for (const id of keys) {
      let t = this.known.get(id);
      if (!t) {
        t = { window: [], spokenAt: -Infinity };
        this.known.set(id, t);
      }
      t.window.push(matched.has(id));
      if (t.window.length > 3) t.window.shift();
      const hits = t.window.filter(Boolean).length;
      const m = matched.get(id);
      if (!this.muted && m && hits >= 2 && nowMs - t.spokenAt >= KNOWN_SILENCE_MS) {
        t.spokenAt = nowMs;
        const ev: DecisionEvent = { kind: "KNOWN_ARRIVED", personId: id, name: m.name, clock: m.clock };
        this.enqueueP2(ev, nowMs);
        fired.push(ev);
        count++;
      }
    }
    return count;
  }

  private updatePersonCount(
    triage: TriageResult,
    nowMs: number,
    fired: DecisionEvent[],
    knownFired: number
  ): void {
    const count = triage.people.length;
    if (count > this.prevCount) {
      this.upStreak = 1;
      this.upCount = count;
    } else if (this.upStreak >= 1 && count >= this.upCount) {
      this.upStreak++;
    } else if (count < this.upCount) {
      this.upStreak = 0;
    }
    this.prevCount = count;
    if (
      !this.muted &&
      this.upStreak === 2 &&
      knownFired === 0 &&
      nowMs - this.personFiredAt >= PERSON_SILENCE_MS &&
      nowMs - this.personSpokenAt >= PERSON_MIN_GAP_MS
    ) {
      this.personFiredAt = nowMs;
      this.personSpokenAt = nowMs;
      const ev: DecisionEvent = { kind: "PERSON_ARRIVED", count, people: triage.people };
      this.enqueueP3(ev, nowMs);
      fired.push(ev);
    }
  }

  /** User asked something: answer speaks as P1 behind any cash already queued. */
  answer(text: string, lang: SpeakLang, nowMs: number = this.clock()): void {
    this.enqueueP1({ kind: "COMMAND_ANSWER", text, lang }, nowMs);
  }

  /**
   * Look-around narration in: summary speaks as P2, updates as P3 (stale
   * drops and P1 yielding come from the queues). Muted drops both.
   */
  announceScene(event: SceneDecisionEvent, nowMs: number = this.clock()): void {
    if (this.muted) return;
    if (event.kind === "SCENE_SUMMARY") this.enqueueP2(event, nowMs);
    else this.enqueueP3(event, nowMs);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.p2 = [];
      this.p3 = null;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** A user command interrupts everything except cash already speaking. */
  cancel(): void {
    this.p2 = [];
    this.p3 = null;
  }

  /**
   * Drain due speaks in priority order: all P1 (never stale), fresh P2
   * (<= 5 s), P3 only if fresh (<= 3 s) and no P1 is speaking. Drained and
   * stale items leave the queue.
   */
  takeSpeak(nowMs: number = this.clock()): SpeakAction[] {
    const out: SpeakAction[] = [];
    for (const q of this.p1.splice(0)) out.push(this.renderQueued(q));
    for (const q of this.p2.splice(0)) {
      if (nowMs - q.enqueuedAt <= P2_MAX_AGE_MS) out.push(this.renderQueued(q));
    }
    const p3 = this.p3;
    this.p3 = null;
    if (
      p3 &&
      nowMs - p3.enqueuedAt <= P3_MAX_AGE_MS &&
      !out.some((a) => a.priority === "P1")
    ) {
      out.push(this.renderQueued(p3));
    }
    return out;
  }

  private renderQueued(q: Queued): SpeakAction {
    if (q.event.kind === "COMMAND_ANSWER") {
      return { text: q.event.text, lang: q.event.lang, priority: q.priority, event: q.event, enqueuedAt: q.enqueuedAt };
    }
    const r = this.render(q.event);
    return { text: r.text, lang: r.lang, priority: q.priority, event: q.event, enqueuedAt: q.enqueuedAt };
  }

  private enqueueP1(event: DecisionEvent, nowMs: number): void {
    this.p1.push({ event, priority: "P1", enqueuedAt: nowMs });
    if (this.p1.length > P1_QUEUE_MAX) this.p1.shift();
  }

  private enqueueP2(event: DecisionEvent, nowMs: number): void {
    this.p2.push({ event, priority: "P2", enqueuedAt: nowMs });
  }

  private enqueueP3(event: DecisionEvent, nowMs: number): void {
    this.p3 = { event, priority: "P3", enqueuedAt: nowMs };
  }
}
