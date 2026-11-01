// Agent action dispatch tests: each tool's effect on the session, the
// engine and the messages pushed to the phone. People-flow tests drive
// the voice-enrollment state machine with a memory store, a seeded
// tracker and a scripted face matcher (fake clock, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentActions, type ActionContext } from "./actions.js";
import { DecisionEngine } from "./decision.js";
import type { DownMessage } from "./protocol.js";
import { PENDING_TTL_MS, Session } from "./session.js";
import { MockFaceMatcher, MockObjectFinder } from "./adapters/mocks.js";
import type { DetectedFace, FaceQuality } from "./faces/embed.js";
import { PeopleStore } from "./faces/store.js";
import { FaceTracker, TRACK_TTL_MS } from "./faces/tracker.js";

function makeCtx(): ActionContext & { sent: DownMessage[]; cashChecks: number } {
  const ctx = {
    session: new Session(),
    engine: new DecisionEngine(),
    sent: [] as DownMessage[],
    cashChecks: 0,
    send(msg: DownMessage): void {
      ctx.sent.push(msg);
    },
    async cashCheck(): Promise<string> {
      ctx.cashChecks++;
      return "MOCK CASH";
    },
  };
  return ctx;
}

function quality(overrides: Partial<FaceQuality> = {}): FaceQuality {
  return { blur: 200, yawDeg: 0, sizePx: 100, ...overrides };
}

function det(
  boxNorm: [number, number, number, number],
  embedding: number[],
  q: FaceQuality = quality()
): DetectedFace {
  return { box: [0, 0, 10, 10], boxNorm, score: 0.9, quality: q, embedding };
}

interface PeopleCtx extends ActionContext {
  store: PeopleStore;
  tracker: FaceTracker;
  faces: MockFaceMatcher;
  now: number;
  advance(ms: number): void;
  /** Last P1 line spoken, drained. */
  said(): string | undefined;
}

function makePeopleCtx(): PeopleCtx {
  const base = makeCtx();
  let now = 1_000_000;
  const store = new PeopleStore(":memory:");
  const tracker = new FaceTracker(() => now);
  const faces = new MockFaceMatcher();
  const ctx: PeopleCtx = {
    ...base,
    store,
    tracker,
    faces,
    people: { store, tracker, faces, now: () => now },
    utterance: "haan",
    now,
    advance: (ms: number): void => {
      now += ms;
      ctx.now = now;
    },
    said: (): string | undefined => {
      const speaks = ctx.engine.takeSpeak(now);
      return speaks.length > 0 ? speaks[speaks.length - 1].text : undefined;
    },
  };
  return ctx;
}

/** Feed one faces frame; returns the live refs. */
function frame(
  ctx: PeopleCtx,
  faces: Array<{ face: DetectedFace; hit: null }>,
  hfov = 100
): string[] {
  return ctx.tracker.update(faces, hfov, ctx.now).map((t) => t.ref);
}

function seedTrack(
  ctx: PeopleCtx,
  box: [number, number, number, number],
  embedding: number[],
  n = 3,
  q: FaceQuality = quality()
): string {
  let ref = "";
  for (let i = 0; i < n; i++) {
    const refs = frame(ctx, [{ face: det(box, embedding, q), hit: null }]);
    ref = refs[refs.length - 1];
    ctx.advance(500);
  }
  return ref;
}

test("look_around toggles the session and pushes state", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "look_around", on: true }], ctx);
  assert.equal(ctx.session.lookAround, true);
  assert.equal(ctx.session.sceneState.lookAround, true);
  assert.deepEqual(ctx.sent, [
    { type: "state", lookAround: true, muted: false, agentBusy: false, lang: "pa" },
  ]);
  await applyAgentActions([{ tool: "look_around", on: false }], ctx);
  assert.equal(ctx.session.lookAround, false);
});

test("look_around drives the narrator when one is attached", async () => {
  const ctx = makeCtx();
  const states: boolean[] = [];
  ctx.narrator = { setActive: (on: boolean) => states.push(on) };
  await applyAgentActions([{ tool: "look_around", on: true }], ctx);
  await applyAgentActions([{ tool: "look_around", on: false }], ctx);
  assert.deepEqual(states, [true, false]);
});

test("mute toggles the engine and the session, and pushes state", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "mute", on: true }], ctx);
  assert.equal(ctx.engine.isMuted(), true);
  assert.equal(ctx.session.muted, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal((ctx.sent[0] as { muted: boolean }).muted, true);
});

test("cash_check speaks the fresh read as P1", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "cash_check" }], ctx);
  assert.equal(ctx.cashChecks, 1);
  const speaks = ctx.engine.takeSpeak();
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0]?.text, "MOCK CASH");
  assert.equal(speaks[0]?.priority, "P1");
});

test("find locates the noun on the fresh frame and speaks the clock", async () => {
  const ctx = makeCtx();
  ctx.find = {
    finder: new MockObjectFinder([{ x: 0.9, y: 0.6, distance: "near", confidence: 0.9 }]),
    frame: { jpeg: Buffer.alloc(0), hfovDeg: 100 },
  };
  const said = await applyAgentActions([{ tool: "find", noun: "Kainchi" }], ctx);
  assert.equal(said, "Kainchi, 1 o'clock, nede");
  assert.equal(ctx.engine.takeSpeak()[0]?.text, "Kainchi, 1 o'clock, nede");
});

test("find miss says Nahi labhi, low confidence hedges", async () => {
  const miss = makeCtx();
  miss.find = { finder: new MockObjectFinder([null]), frame: { jpeg: Buffer.alloc(0), hfovDeg: 100 } };
  assert.equal(await applyAgentActions([{ tool: "find", noun: "Kainchi" }], miss), "Nahi labhi");

  const unsure = makeCtx();
  unsure.find = {
    finder: new MockObjectFinder([{ x: 0.9, y: 0.6, distance: "near", confidence: 0.5 }]),
    frame: { jpeg: Buffer.alloc(0), hfovDeg: 100 },
  };
  assert.equal(
    await applyAgentActions([{ tool: "find", noun: "Kainchi" }], unsure),
    "Shayad Kainchi, 1 o'clock"
  );
});

test("find without a frame or wiring says unsure", async () => {
  const noFrame = makeCtx();
  noFrame.find = { finder: new MockObjectFinder() };
  assert.equal(
    await applyAgentActions([{ tool: "find", noun: "Kainchi" }], noFrame),
    "pakka nahi, dobara bolo"
  );
  const unwired = makeCtx();
  assert.equal(
    await applyAgentActions([{ tool: "find", noun: "Kainchi" }], unwired),
    "pakka nahi, dobara bolo"
  );
});

test("non-people tools return null (the model say still speaks)", async () => {
  const ctx = makeCtx();
  assert.equal(await applyAgentActions([{ tool: "look_around", on: true }], ctx), null);
  assert.equal(await applyAgentActions([{ tool: "mute", on: true }], ctx), null);
  assert.equal(await applyAgentActions([{ tool: "cash_check" }], ctx), null);
});

test("people tools without wiring speak unsure", async () => {
  const ctx = makeCtx();
  const said = await applyAgentActions([{ tool: "remember_person", ref: "P1", name: "Ravi" }], ctx);
  assert.equal(said, "pakka nahi, dobara bolo");
  assert.equal(ctx.engine.takeSpeak()[0]?.text, "pakka nahi, dobara bolo");
});

test("remember with a good track asks consent and pends it", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Ravi nu yaad rakhaan? Haan ya na dasso");
  assert.equal(ctx.said(), "Ravi nu yaad rakhaan? Haan ya na dasso");
  assert.deepEqual(ctx.session.pendingAction, {
    kind: "consent",
    name: "Ravi",
    ref,
    askedTs: ctx.now,
    repeats: 0,
  });
  ctx.store.close();
});

test("remember with too few samples asks for a clearer face", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0], 2);
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Chehra saaf dikhao, phir dasso");
  assert.equal(ctx.session.pendingAction?.kind, "remember-retry");
  ctx.store.close();
});

test("remember with poor samples asks for a clearer face", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0], 5, quality({ blur: 5, sizePx: 20 }));
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Chehra saaf dikhao, phir dasso");
  assert.equal(ctx.session.pendingAction?.kind, "remember-retry");
  ctx.store.close();
});

test("remember with a null ref resolves the single unknown track", async () => {
  const ctx = makePeopleCtx();
  seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  const said = await applyAgentActions([{ tool: "remember_person", ref: null, name: "Ravi" }], ctx);
  assert.equal(said, "Ravi nu yaad rakhaan? Haan ya na dasso");
  assert.equal(ctx.session.pendingAction?.kind, "consent");
  ctx.store.close();
});

test("remember with no tracks says nobody is in front", async () => {
  const ctx = makePeopleCtx();
  const said = await applyAgentActions([{ tool: "remember_person", ref: null, name: "Ravi" }], ctx);
  assert.equal(said, "Saamne koi chehra nahi");
  assert.equal(ctx.session.pendingAction, null);
  ctx.store.close();
});

test("remember with several unknowns asks which clock", async () => {
  const ctx = makePeopleCtx();
  seedTrack(ctx, [0.1, 0.4, 0.15, 0.2], [1, 0]);
  seedTrack(ctx, [0.7, 0.4, 0.15, 0.2], [0, 1]);
  const said = await applyAgentActions([{ tool: "remember_person", ref: null, name: "Ravi" }], ctx);
  assert.equal(said, "Kaun wala? Clock dasso");
  assert.equal(ctx.session.pendingAction?.kind, "remember-ask");
  ctx.store.close();
});

test("remember for a gone ref says the person left", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.advance(TRACK_TTL_MS + 1);
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Oh banda hun nahi dikhda");
  ctx.store.close();
});

test("remember for an already-known track names the known person", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.tracker.markKnown(ref, "7", "Simran");
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Simran pehlan ton yaad hai");
  ctx.store.close();
});

test("remember for a duplicate face asks to rename", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.faces.embeddingHit = { personId: "3", name: "Raj", score: 0.9 };
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Eh taan Raj hai. Ravi naa rakhaan?");
  assert.equal(ctx.session.pendingAction?.kind, "duplicate-confirm");
  ctx.store.close();
});

test("remember for the same enrolled name says already saved", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.faces.embeddingHit = { personId: "3", name: "Ravi", score: 0.9 };
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "ravi " }], ctx);
  assert.equal(said, "Ravi pehlan ton yaad hai");
  assert.equal(ctx.session.pendingAction, null);
  ctx.store.close();
});

test("repeating remember while consent pends re-asks", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  assert.equal(said, "Ravi nu yaad rakhaan? Haan ya na dasso");
  assert.equal(
    (ctx.session.pendingAction as { repeats: number } | null)?.repeats,
    1
  );
  ctx.store.close();
});

test("consent granted enrolls with voice consent and marks the track", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0], 4);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: true }],
    ctx
  );
  assert.equal(said, "Ravi yaad ho gaya");
  assert.equal(ctx.session.pendingAction, null);
  const rows = ctx.store.listPeople();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ravi");
  assert.equal(rows[0].faces, 4);
  assert.equal(rows[0].consent_method, "voice");
  assert.equal(rows[0].consent_text, "haan");
  assert.equal(ctx.tracker.getTrack(ref)?.knownName, "Ravi");
  ctx.store.close();
});

test("consent denied saves nothing", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: false }],
    ctx
  );
  assert.equal(said, "Theek hai, Ravi nahi yaad kita");
  assert.equal(ctx.session.pendingAction, null);
  assert.deepEqual(ctx.store.listPeople(), []);
  ctx.store.close();
});

test("stale consent says unsure and saves nothing", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  ctx.advance(PENDING_TTL_MS + 1);
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: true }],
    ctx
  );
  assert.equal(said, "pakka nahi, dobara bolo");
  assert.deepEqual(ctx.store.listPeople(), []);
  ctx.store.close();
});

test("consent for the wrong name says unsure and saves nothing", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Simran", granted: true }],
    ctx
  );
  assert.equal(said, "pakka nahi, dobara bolo");
  assert.deepEqual(ctx.store.listPeople(), []);
  ctx.store.close();
});

test("consent after the track left says gone and saves nothing", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  ctx.advance(TRACK_TTL_MS + 1);
  // Keep the consent fresh while the track dies: re-ask first.
  ctx.session.pendingAction = { kind: "consent", name: "Ravi", ref, askedTs: ctx.now, repeats: 0 };
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: true }],
    ctx
  );
  assert.equal(said, "Oh banda hun nahi dikhda");
  assert.deepEqual(ctx.store.listPeople(), []);
  ctx.store.close();
});

test("duplicate-confirm granted renames the enrollment", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  const row = ctx.store.addPerson("Raj", [[1, 0]]);
  ctx.faces.embeddingHit = { personId: String(row.id), name: "Raj", score: 0.9 };
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: true }],
    ctx
  );
  assert.equal(said, "Naa Ravi kar ditta");
  assert.equal(ctx.store.listPeople()[0]?.name, "Ravi");
  ctx.store.close();
});

test("duplicate-confirm denied keeps the old name", async () => {
  const ctx = makePeopleCtx();
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.store.addPerson("Raj", [[1, 0]]);
  ctx.faces.embeddingHit = { personId: "1", name: "Raj", score: 0.9 };
  await applyAgentActions([{ tool: "remember_person", ref, name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: false }],
    ctx
  );
  assert.equal(said, "Theek hai, Ravi nahi yaad kita");
  assert.equal(ctx.store.listPeople()[0]?.name, "Raj");
  ctx.store.close();
});

test("forget asks, then deletes and clears the track on yes", async () => {
  const ctx = makePeopleCtx();
  const row = ctx.store.addPerson("Ravi", [[1, 0]]);
  const ref = seedTrack(ctx, [0.4, 0.4, 0.2, 0.2], [1, 0]);
  ctx.tracker.markKnown(ref, String(row.id), "Ravi");
  const asked = await applyAgentActions([{ tool: "forget_person", name: "ravi" }], ctx);
  assert.equal(asked, "Ravi nu bhul jaan?");
  assert.deepEqual(ctx.session.pendingAction, {
    kind: "forget-confirm",
    name: "Ravi",
    personId: row.id,
    askedTs: ctx.now,
  });
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: true }],
    ctx
  );
  assert.equal(said, "Ravi bhul gaya");
  assert.deepEqual(ctx.store.listPeople(), []);
  assert.equal(ctx.tracker.getTrack(ref)?.knownName, undefined);
  ctx.store.close();
});

test("forget denied keeps the enrollment", async () => {
  const ctx = makePeopleCtx();
  ctx.store.addPerson("Ravi", [[1, 0]]);
  await applyAgentActions([{ tool: "forget_person", name: "Ravi" }], ctx);
  ctx.said();
  const said = await applyAgentActions(
    [{ tool: "confirm_consent", name: "Ravi", granted: false }],
    ctx
  );
  assert.equal(said, "Theek hai");
  assert.equal(ctx.store.listPeople().length, 1);
  ctx.store.close();
});

test("forget for an unknown name says so", async () => {
  const ctx = makePeopleCtx();
  const said = await applyAgentActions([{ tool: "forget_person", name: "Ravi" }], ctx);
  assert.equal(said, "Ravi taan yaad hi nahi si");
  assert.equal(ctx.session.pendingAction, null);
  ctx.store.close();
});

test("forget matching several people asks for the full name", async () => {
  const ctx = makePeopleCtx();
  ctx.store.addPerson("Ravi Kumar", [[1, 0]]);
  ctx.store.addPerson("Ravi Singh", [[0, 1]]);
  const said = await applyAgentActions([{ tool: "forget_person", name: "Ravi" }], ctx);
  assert.equal(said, "Naam poora dasso");
  assert.equal(ctx.session.pendingAction, null);
  ctx.store.close();
});
