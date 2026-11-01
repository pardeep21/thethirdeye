// Decision engine tests: sequences of fake TriageResults with explicit
// timestamps. Renderer is a stub so these assert engine behavior only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DecisionEngine, type DecisionEvent } from "./decision.js";
import type { Denomination, FaceHit, TriageResult } from "./protocol.js";

function note(d: Denomination | null, c: number): TriageResult {
  return { notes: [{ denomination: d, confidence: c }], people: [] };
}

const EMPTY: TriageResult = { notes: [], people: [] };

function people(n: number): TriageResult {
  return {
    notes: [],
    people: Array.from({ length: n }, () => ({ position: "centre" as const, distance: "near" as const })),
  };
}

function hits(id: string, name: string, score: number): FaceHit[] {
  return [{ personId: id, name, score }];
}

function makeEngine(): { eng: DecisionEngine; rendered: DecisionEvent[] } {
  const rendered: DecisionEvent[] = [];
  const eng = new DecisionEngine((e) => {
    rendered.push(e);
    return { text: e.kind, lang: "en" };
  });
  return { eng, rendered };
}

function kinds(evs: DecisionEvent[]): string[] {
  return evs.map((e) => e.kind);
}

test("note seen on 2 consecutive frames fires once, at the second", () => {
  const { eng } = makeEngine();
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.7), [], 0)), []);
  const fired = eng.onFrame(note(500, 0.7), [], 500);
  assert.deepEqual(kinds(fired), ["NOTE_SEEN"]);
  assert.deepEqual((fired[0] as { denominations: number[] }).denominations, [500]);
  const speaks = eng.takeSpeak(500);
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0].priority, "P1");
  assert.deepEqual(eng.takeSpeak(600), []);
});

test("single frame with conf >= 0.85 fires immediately", () => {
  const { eng } = makeEngine();
  assert.deepEqual(kinds(eng.onFrame(note(100, 0.9), [], 0)), ["NOTE_SEEN"]);
});

test("same note held steady is not re-announced", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(50, 0.9), [], 0);
  eng.takeSpeak(0);
  for (const t of [500, 1000, 1500, 2000]) {
    assert.deepEqual(kinds(eng.onFrame(note(50, 0.9), [], t)), [], `t=${t}`);
  }
  assert.deepEqual(eng.takeSpeak(2000), []);
});

test("note that leaves >3s and returns is re-announced", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(20, 0.9), [], 0);
  eng.takeSpeak(0);
  eng.onFrame(EMPTY, [], 1000);
  eng.onFrame(EMPTY, [], 2000);
  eng.onFrame(EMPTY, [], 3000);
  eng.onFrame(EMPTY, [], 4500); // absent since t=1000: 3.5s gap
  assert.deepEqual(kinds(eng.onFrame(note(20, 0.9), [], 4600)), ["NOTE_SEEN"]);
});

test("note that leaves briefly (<3s) is not re-announced", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(20, 0.9), [], 0);
  eng.takeSpeak(0);
  eng.onFrame(EMPTY, [], 1000);
  assert.deepEqual(kinds(eng.onFrame(note(20, 0.9), [], 2000)), []);
});

test("a different denomination fires independently", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(500, 0.9), [], 0);
  assert.deepEqual(kinds(eng.onFrame(note(100, 0.9), [], 500)), ["NOTE_SEEN"]);
});

test("two stable notes in one frame fire a single combined event", () => {
  const { eng } = makeEngine();
  const two: TriageResult = {
    notes: [
      { denomination: 100, confidence: 0.7 },
      { denomination: 50, confidence: 0.7 },
    ],
    people: [],
  };
  assert.deepEqual(kinds(eng.onFrame(two, [], 0)), []);
  const fired = eng.onFrame(two, [], 500);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].kind, "NOTE_SEEN");
  assert.deepEqual((fired[0] as { denominations: number[] }).denominations, [100, 50]);
});

test("unclear note for 2 frames fires NOTE_UNSURE, then silent 8s", () => {
  const { eng } = makeEngine();
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.5), [], 0)), []);
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.5), [], 500)), ["NOTE_UNSURE"]);
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.4), [], 1000)), []);
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.4), [], 8000)), []); // 7.5s after fire
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.4), [], 8600)), ["NOTE_UNSURE"]); // 8.1s after
});

test("null-denomination note for 2 frames fires NOTE_UNSURE", () => {
  const { eng } = makeEngine();
  assert.deepEqual(kinds(eng.onFrame(note(null, 0.5), [], 0)), []);
  assert.deepEqual(kinds(eng.onFrame(note(null, 0.5), [], 500)), ["NOTE_UNSURE"]);
});

test("unclear note that becomes clear fires NOTE_SEEN", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(500, 0.5), [], 0);
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.9), [], 500)), ["NOTE_SEEN"]);
});

test("known person fires on 2-of-3 frames, silent 10 min per person", () => {
  const { eng } = makeEngine();
  assert.deepEqual(kinds(eng.onFrame(EMPTY, [], 0)), []);
  assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 500)), []);
  const fired = eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 1000);
  assert.deepEqual(kinds(fired), ["KNOWN_ARRIVED"]);
  assert.equal((fired[0] as { name: string }).name, "Ravi");
  // Still present: no refire within 10 min.
  for (const t of [1500, 2000, 300000]) {
    assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), t)), [], `t=${t}`);
  }
  // After 10 min, presence fires again.
  assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 601001)), ["KNOWN_ARRIVED"]);
});

test("known person 2-of-3 tolerates one miss in the middle", () => {
  const { eng } = makeEngine();
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 0);
  eng.onFrame(EMPTY, [], 500);
  assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 1000)), ["KNOWN_ARRIVED"]);
});

test("different enrolled people fire independently", () => {
  const { eng } = makeEngine();
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 0);
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 500);
  eng.onFrame(EMPTY, hits("p2", "Simran", 0.9), 1000);
  assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p2", "Simran", 0.9), 1500)), ["KNOWN_ARRIVED"]);
});

test("below-threshold face scores never fire", () => {
  const { eng } = makeEngine();
  for (const t of [0, 500, 1000, 1500]) {
    assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.5), t)), [], `t=${t}`);
  }
});

test("person count up for 2 frames fires PERSON_ARRIVED, then silent 2 min", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  assert.deepEqual(kinds(eng.onFrame(people(1), [], 500)), []);
  const fired = eng.onFrame(people(1), [], 1000);
  assert.deepEqual(kinds(fired), ["PERSON_ARRIVED"]);
  assert.equal((fired[0] as { count: number }).count, 1);
  // Leaves and comes back within 2 min: suppressed.
  eng.onFrame(people(0), [], 1500);
  eng.onFrame(people(1), [], 2000);
  assert.deepEqual(kinds(eng.onFrame(people(1), [], 2500)), []);
  // After 2 min a new arrival fires again.
  eng.onFrame(people(0), [], 121000);
  eng.onFrame(people(1), [], 121500);
  assert.deepEqual(kinds(eng.onFrame(people(1), [], 122000)), ["PERSON_ARRIVED"]);
});

test("person count that drops before 2 frames does not fire", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  assert.deepEqual(kinds(eng.onFrame(people(0), [], 1000)), []);
});

test("known arrival suppresses the unknown-person event on the same frames", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), hits("p1", "Ravi", 0.9), 500);
  // Frame 3: count stays up (PERSON would fire) but KNOWN fires instead.
  assert.deepEqual(kinds(eng.onFrame(people(1), hits("p1", "Ravi", 0.9), 1000)), ["KNOWN_ARRIVED"]);
});

test("P3 is dropped when a P1 is pending", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  eng.onFrame(people(1), [], 1000); // PERSON_ARRIVED queued, not drained
  eng.onFrame(note(500, 0.9), [], 1500); // NOTE_SEEN queued
  const speaks = eng.takeSpeak(1500);
  assert.deepEqual(
    speaks.map((s) => s.priority),
    ["P1"]
  );
  assert.equal(speaks[0].event.kind, "NOTE_SEEN");
});

test("P3 queue holds max 1: a newer arrival replaces the older", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  eng.onFrame(people(1), [], 1000); // first PERSON_ARRIVED queued
  // 3 min later the count rises again: second PERSON_ARRIVED replaces the first.
  eng.onFrame(people(0), [], 181000);
  eng.onFrame(people(2), [], 181500);
  eng.onFrame(people(2), [], 182000);
  const speaks = eng.takeSpeak(182000);
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0].event.kind, "PERSON_ARRIVED");
  assert.equal((speaks[0].event as { count: number }).count, 2);
});

test("stale P2 (>5s) is dropped, fresh P2 speaks behind P1", () => {
  const aged = makeEngine();
  aged.eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 0);
  aged.eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 500); // KNOWN queued at t=500
  assert.deepEqual(aged.eng.takeSpeak(5600), []); // 5.1s old: dropped

  const { eng } = makeEngine();
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 0);
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 500); // KNOWN queued
  eng.onFrame(note(100, 0.9), [], 1000); // NOTE queued
  const speaks = eng.takeSpeak(1000);
  assert.deepEqual(
    speaks.map((s) => s.priority),
    ["P1", "P2"]
  );
});

test("stale P3 (>3s) is dropped", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  eng.onFrame(people(1), [], 1000); // PERSON queued at t=1000
  assert.deepEqual(eng.takeSpeak(4100), []); // 3.1s old: dropped
});

test("mute suppresses people events; cash and commands still speak", () => {
  const { eng } = makeEngine();
  eng.setMuted(true);
  assert.equal(eng.isMuted(), true);
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  assert.deepEqual(kinds(eng.onFrame(people(1), [], 1000)), []);
  eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 1500);
  assert.deepEqual(kinds(eng.onFrame(EMPTY, hits("p1", "Ravi", 0.9), 2000)), []);
  assert.deepEqual(kinds(eng.onFrame(note(500, 0.9), [], 2500)), ["NOTE_SEEN"]);
  eng.answer("two packets", "en", 2600);
  const speaks = eng.takeSpeak(2600);
  assert.deepEqual(
    speaks.map((s) => s.event.kind),
    ["NOTE_SEEN", "COMMAND_ANSWER"]
  );
  eng.setMuted(false);
  eng.onFrame(people(0), [], 3000);
  eng.onFrame(people(1), [], 3500);
  assert.deepEqual(kinds(eng.onFrame(people(1), [], 4000)), ["PERSON_ARRIVED"]);
});

test("muting clears pending P2/P3; cancel() does the same", () => {
  const { eng } = makeEngine();
  eng.onFrame(people(0), [], 0);
  eng.onFrame(people(1), [], 500);
  eng.onFrame(people(1), [], 1000); // P3 queued
  eng.setMuted(true);
  assert.deepEqual(eng.takeSpeak(1000), []);
  eng.setMuted(false);

  const second = makeEngine();
  second.eng.onFrame(people(0), [], 0);
  second.eng.onFrame(people(1), [], 500);
  second.eng.onFrame(people(1), [], 1000); // P3 queued
  second.eng.cancel();
  assert.deepEqual(second.eng.takeSpeak(1000), []);
});

test("command answer speaks as P1 behind cash already queued", () => {
  const { eng } = makeEngine();
  eng.onFrame(note(500, 0.9), [], 0);
  eng.answer("sau da note", "pa", 100);
  const speaks = eng.takeSpeak(100);
  assert.deepEqual(
    speaks.map((s) => [s.event.kind, s.priority]),
    [
      ["NOTE_SEEN", "P1"],
      ["COMMAND_ANSWER", "P1"],
    ]
  );
  assert.equal(speaks[1].text, "sau da note");
  assert.equal(speaks[1].lang, "pa");
});

test("scene summary speaks as P2, scene update as P3", () => {
  const { eng } = makeEngine();
  eng.announceScene({ kind: "SCENE_SUMMARY", items: [] }, 0);
  eng.announceScene({ kind: "SCENE_UPDATE", items: [] }, 0);
  const speaks = eng.takeSpeak(0);
  assert.deepEqual(
    speaks.map((s) => [s.event.kind, s.priority]),
    [
      ["SCENE_SUMMARY", "P2"],
      ["SCENE_UPDATE", "P3"],
    ]
  );
});

test("scene update yields to P1 and drops when stale", () => {
  const { eng } = makeEngine();
  eng.announceScene({ kind: "SCENE_UPDATE", items: [] }, 0);
  eng.answer("jawab", "pa", 0);
  const speaks = eng.takeSpeak(0);
  assert.deepEqual(
    speaks.map((s) => s.event.kind),
    ["COMMAND_ANSWER"]
  );
  const stale = makeEngine();
  stale.eng.announceScene({ kind: "SCENE_UPDATE", items: [] }, 0);
  assert.deepEqual(stale.eng.takeSpeak(3100), []);
  const staleSummary = makeEngine();
  staleSummary.eng.announceScene({ kind: "SCENE_SUMMARY", items: [] }, 0);
  assert.deepEqual(staleSummary.eng.takeSpeak(5100), []);
});

test("muted engine drops scene announcements; cancel clears them", () => {
  const { eng } = makeEngine();
  eng.setMuted(true);
  eng.announceScene({ kind: "SCENE_SUMMARY", items: [] }, 0);
  eng.announceScene({ kind: "SCENE_UPDATE", items: [] }, 0);
  assert.deepEqual(eng.takeSpeak(0), []);
  const second = makeEngine();
  second.eng.announceScene({ kind: "SCENE_SUMMARY", items: [] }, 0);
  second.eng.cancel();
  assert.deepEqual(second.eng.takeSpeak(0), []);
});
