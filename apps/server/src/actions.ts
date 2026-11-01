// Agent action dispatch (prompt 02, people flows in prompt 06, find in
// prompt 07): executes the tools the JSON-action agent returns.
// remember/consent/forget run the voice-enrollment state machine
// against the session's pending action; find locates one noun on the
// utterance's fresh frame. Executor-spoken tools return their line so
// the caller skips the model's say for that turn (no double-speak).
import type { DownMessage, SpeakLang } from "./protocol.js";
import type { AgentAction } from "./adapters/agent.js";
import type { FaceMatcher, ObjectFinder } from "./adapters/index.js";
import type { DecisionEngine } from "./decision.js";
import { PENDING_TTL_MS, type PendingAction, type Session } from "./session.js";
import type { PeopleStore } from "./faces/store.js";
import {
  FaceTracker,
  TRACK_TTL_MS,
  passingSamples,
  selectDiverseSamples,
  type FaceTrack,
} from "./faces/tracker.js";
import {
  renderAgentUnsure,
  renderConsentDenied,
  renderEnrollAsk,
  renderEnrollDuplicate,
  renderEnrollGone,
  renderEnrollKnown,
  renderEnrollNoFace,
  renderEnrollQuality,
  renderEnrollSaved,
  renderEnrollWhich,
  renderFindLocated,
  renderForgetAsk,
  renderForgot,
  renderForgetUnknown,
  renderForgetWhich,
  renderOkay,
  renderRenamed,
} from "./phrases.js";

/** Passing track samples needed before the consent question. */
export const ENROLL_MIN_SAMPLES = 3;
/** Enrolled embeddings kept per person (diverse best-first). */
export const ENROLL_KEEP_SAMPLES = 5;

export interface PeopleActions {
  store: PeopleStore;
  tracker: FaceTracker;
  faces: FaceMatcher;
  now?: () => number;
}

export interface FindActions {
  finder: ObjectFinder;
  /** The utterance's fresh frame (absent when the capture missed). */
  frame?: { jpeg: Buffer; hfovDeg: number };
}

export interface ActionContext {
  session: Session;
  engine: DecisionEngine;
  send: (msg: DownMessage) => void;
  /** Fresh cash read; reuses the howmuch path. */
  cashCheck: () => Promise<string>;
  /** Look-around narrator; the look_around action drives it when present. */
  narrator?: { setActive(on: boolean): void };
  /** Voice-enrollment handles; absent in tests that predate prompt 06. */
  people?: PeopleActions;
  /** The user's words this turn (recorded as voice-consent evidence). */
  utterance?: string;
  /** Find handles; absent in tests that predate prompt 07. */
  find?: FindActions;
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

function pendingAskedTs(p: PendingAction): number {
  return p.kind === "remember-retry" ? p.collectUntilTs - PENDING_TTL_MS : p.askedTs;
}

function pendingFresh(p: PendingAction, now: number): boolean {
  return now - pendingAskedTs(p) <= PENDING_TTL_MS;
}

function liveTrack(tracker: FaceTracker, ref: string, now: number): FaceTrack | undefined {
  const t = tracker.getTrack(ref);
  if (!t || now - t.lastSeen > TRACK_TTL_MS) return undefined;
  return t;
}

function rememberPerson(
  ctx: ActionContext,
  p: PeopleActions,
  ref: string | null,
  name: string,
  now: number
): string {
  const lang: SpeakLang = ctx.session.lang;
  const clean = name.trim();
  const pending = ctx.session.pendingAction;

  // Re-ask: the user repeats "yaad rakh" while consent is pending.
  if (
    pending?.kind === "consent" &&
    pendingFresh(pending, now) &&
    sameName(pending.name, clean) &&
    (ref === null || pending.ref === ref)
  ) {
    pending.repeats++;
    return renderEnrollAsk(pending.name, lang);
  }

  let track: FaceTrack | undefined;
  if (ref !== null) {
    track = liveTrack(p.tracker, ref, now);
    if (!track) {
      ctx.session.pendingAction = null;
      return renderEnrollGone(lang);
    }
    if (track.knownName) {
      ctx.session.pendingAction = null;
      return renderEnrollKnown(track.knownName, lang);
    }
  } else {
    const unknowns = p.tracker
      .liveTracks()
      .filter((t) => now - t.lastSeen <= TRACK_TTL_MS && !t.knownPersonId);
    if (unknowns.length === 0) {
      ctx.session.pendingAction = null;
      return renderEnrollNoFace(lang);
    }
    if (unknowns.length > 1) {
      ctx.session.pendingAction = { kind: "remember-ask", name: clean, askedTs: now };
      return renderEnrollWhich(lang);
    }
    track = unknowns[0];
  }

  // Duplicate check: this face may already be enrolled under another name.
  const best = selectDiverseSamples(track.samples, 1)[0] ?? track.samples[0];
  if (best) {
    const hit = p.faces.matchEmbedding(best.embedding);
    if (hit?.name) {
      if (sameName(hit.name, clean)) {
        ctx.session.pendingAction = null;
        return renderEnrollKnown(hit.name, lang);
      }
      ctx.session.pendingAction = {
        kind: "duplicate-confirm",
        name: clean,
        ref: track.ref,
        existing: hit.name,
        askedTs: now,
      };
      return renderEnrollDuplicate(clean, hit.name, lang);
    }
  }

  if (passingSamples(track).length < ENROLL_MIN_SAMPLES) {
    ctx.session.pendingAction = {
      kind: "remember-retry",
      name: clean,
      ref: track.ref,
      collectUntilTs: now + PENDING_TTL_MS,
    };
    return renderEnrollQuality(lang);
  }

  ctx.session.pendingAction = { kind: "consent", name: clean, ref: track.ref, askedTs: now, repeats: 0 };
  return renderEnrollAsk(clean, lang);
}

function confirmConsent(
  ctx: ActionContext,
  p: PeopleActions,
  name: string,
  granted: boolean,
  now: number
): string {
  const lang: SpeakLang = ctx.session.lang;
  const clean = name.trim();
  const pending = ctx.session.pendingAction;
  if (!pending || !sameName(pending.name, clean) || !pendingFresh(pending, now)) {
    ctx.session.pendingAction = null;
    return renderAgentUnsure(lang);
  }

  if (pending.kind === "forget-confirm") {
    ctx.session.pendingAction = null;
    if (!granted) return renderOkay(lang);
    p.store.removePerson(pending.personId);
    p.tracker.forgetPerson(String(pending.personId));
    console.log(`forgot person id=${pending.personId} name=${pending.name}`);
    return renderForgot(pending.name, lang);
  }

  if (pending.kind === "duplicate-confirm") {
    ctx.session.pendingAction = null;
    if (!granted) return renderConsentDenied(clean, lang);
    const rows = p.store.findByName(pending.existing);
    const row = rows.find((r) => sameName(r.name, pending.existing)) ?? rows[0];
    if (!row) return renderAgentUnsure(lang);
    p.store.renamePerson(row.id, clean);
    // Tracks re-mark with the new name on the next matched frame.
    p.tracker.forgetPerson(String(row.id));
    console.log(`renamed person id=${row.id} to ${clean}`);
    return renderRenamed(clean, lang);
  }

  if (pending.kind !== "consent") {
    // remember-ask / remember-retry cannot consume a yes/no.
    ctx.session.pendingAction = null;
    return renderAgentUnsure(lang);
  }
  ctx.session.pendingAction = null;
  if (!granted) return renderConsentDenied(clean, lang);

  const track = liveTrack(p.tracker, pending.ref, now);
  if (!track) return renderEnrollGone(lang);
  if (track.knownName) return renderEnrollKnown(track.knownName, lang);
  const passing = passingSamples(track);
  if (passing.length < ENROLL_MIN_SAMPLES) {
    ctx.session.pendingAction = {
      kind: "remember-retry",
      name: clean,
      ref: track.ref,
      collectUntilTs: now + PENDING_TTL_MS,
    };
    return renderEnrollQuality(lang);
  }
  const embeddings = selectDiverseSamples(passing, ENROLL_KEEP_SAMPLES).map((s) => s.embedding);
  const row = p.store.addPerson(clean, embeddings, {
    method: "voice",
    ts: now,
    text: ctx.utterance ?? "haan",
  });
  p.tracker.markKnown(track.ref, String(row.id), row.name);
  console.log(`enrolled ${row.name} id=${row.id} from track ${track.ref} (${embeddings.length} embeddings)`);
  return renderEnrollSaved(row.name, lang);
}

function forgetPerson(ctx: ActionContext, p: PeopleActions, name: string, now: number): string {
  const lang: SpeakLang = ctx.session.lang;
  const clean = name.trim();
  const rows = p.store.findByName(clean);
  const exact = rows.filter((r) => sameName(r.name, clean));
  const pick = exact[0] ?? (rows.length === 1 ? rows[0] : undefined);
  if (!pick) {
    ctx.session.pendingAction = null;
    return rows.length > 1 ? renderForgetWhich(lang) : renderForgetUnknown(clean, lang);
  }
  ctx.session.pendingAction = { kind: "forget-confirm", name: pick.name, personId: pick.id, askedTs: now };
  return renderForgetAsk(pick.name, lang);
}

async function findObject(ctx: ActionContext, f: FindActions, noun: string): Promise<string> {
  const lang: SpeakLang = ctx.session.lang;
  const clean = noun.trim();
  if (!f.frame) return renderAgentUnsure(lang);
  let loc;
  try {
    loc = await f.finder.locate(f.frame.jpeg, clean);
  } catch (err) {
    console.error("find failed:", err instanceof Error ? err.message : err);
    return renderAgentUnsure(lang);
  }
  return renderFindLocated(clean, loc, f.frame.hfovDeg, lang);
}

function pushState(ctx: ActionContext): void {
  ctx.send({
    type: "state",
    lookAround: ctx.session.lookAround,
    muted: ctx.session.muted,
    agentBusy: ctx.session.agentBusy,
    lang: ctx.session.lang,
  });
}

/**
 * Execute agent actions. Returns the deterministic people-flow line when
 * one was spoken (the caller then skips the model's say), else null.
 */
export async function applyAgentActions(
  actions: AgentAction[],
  ctx: ActionContext
): Promise<string | null> {
  let said: string | null = null;
  const sayPeople = (text: string): void => {
    said = text;
    ctx.engine.answer(text, ctx.session.lang);
  };
  for (const a of actions) {
    switch (a.tool) {
      case "look_around":
        ctx.session.lookAround = a.on;
        ctx.session.sceneState.lookAround = a.on;
        ctx.narrator?.setActive(a.on);
        pushState(ctx);
        break;
      case "mute":
        ctx.engine.setMuted(a.on);
        ctx.session.muted = a.on;
        pushState(ctx);
        break;
      case "cash_check":
        ctx.engine.answer(await ctx.cashCheck(), ctx.session.lang);
        break;
      case "find": {
        const f = ctx.find;
        if (!f) {
          console.log(`find ignored: finder not wired (noun=${a.noun})`);
          sayPeople(renderAgentUnsure(ctx.session.lang));
          break;
        }
        sayPeople(await findObject(ctx, f, a.noun));
        break;
      }
      case "remember_person":
      case "confirm_consent":
      case "forget_person": {
        const p = ctx.people;
        if (!p) {
          console.log(`${a.tool} ignored: people actions not wired`);
          sayPeople(renderAgentUnsure(ctx.session.lang));
          break;
        }
        const now = p.now?.() ?? Date.now();
        if (a.tool === "remember_person") sayPeople(rememberPerson(ctx, p, a.ref, a.name, now));
        else if (a.tool === "confirm_consent") sayPeople(confirmConsent(ctx, p, a.name, a.granted, now));
        else sayPeople(forgetPerson(ctx, p, a.name, now));
        break;
      }
    }
  }
  return said;
}
