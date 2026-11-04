// Session, scene-state and latency-stats tests: history trimming,
// perception mapping, and p50/p95 over the rolling window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX_TURNS, Session, readChunk, sceneFromPerception } from "./session.js";
import type { SceneTriage } from "./protocol.js";
import { UtteranceStats } from "./stats.js";

test("history keeps the last 4 turns", () => {
  const s = new Session();
  for (let i = 0; i < 10; i++) {
    s.pushTurn({ role: i % 2 === 0 ? "user" : "assistant", text: `t${i}` });
  }
  assert.equal(s.history.length, HISTORY_MAX_TURNS);
  assert.equal(s.history[0]?.text, "t6");
  assert.equal(s.history[3]?.text, "t9");
});

test("session defaults: pa, gurmukhi, idle", () => {
  const s = new Session();
  assert.equal(s.lang, "pa");
  assert.equal(s.script, "gurmukhi");
  assert.equal(s.lookAround, false);
  assert.equal(s.muted, false);
  assert.equal(s.agentBusy, false);
  assert.equal(s.lastFrame, null);
  assert.deepEqual(s.sceneState, { people: [], recentNotes: [], lookAround: false, objects: [] });
});

test("sceneFromPerception maps tracks with Spark attrs and known names", () => {
  const scene = sceneFromPerception(
    {
      notes: [{ denomination: 500, confidence: 0.9 }],
      people: [
        { position: "left", distance: "near", gender: "man", age_range: "30s" },
        { position: "right", distance: "far" },
      ],
    },
    [
      {
        ref: "P1",
        lastBoxNorm: [0.1, 0.2, 0.2, 0.3],
        clock: 10,
        firstSeen: 0,
        lastSeen: 0,
        knownPersonId: "1",
        knownName: "Ravi",
        matchedThisFrame: true,
        samples: [],
      },
      {
        ref: "P2",
        lastBoxNorm: [0.7, 0.2, 0.1, 0.2],
        clock: 2,
        firstSeen: 0,
        lastSeen: 0,
        matchedThisFrame: true,
        samples: [],
      },
    ],
    false,
    100
  );
  assert.equal(scene.people.length, 2);
  assert.deepEqual(scene.people[0], {
    ref: "P1",
    clock: 10,
    distance: "near",
    desc: "man around 30s",
    knownName: "Ravi",
    gender: "man",
  });
  assert.deepEqual(scene.people[1], { ref: "P2", clock: 2, distance: "far", desc: "person" });
  assert.deepEqual(scene.recentNotes, ["500 (conf 0.9)"]);
  assert.equal(scene.lookAround, false);
  assert.deepEqual(scene.objects, []);
});

test("sceneFromPerception falls back to S-refs without tracks", () => {
  const scene = sceneFromPerception(
    {
      notes: [],
      people: [{ position: "left", distance: "near", gender: "man", age_range: "30s" }],
    },
    [],
    false,
    100
  );
  assert.deepEqual(scene.people, [
    { ref: "S1", clock: 10, distance: "near", desc: "man around 30s", gender: "man" },
  ]);
});

test("sceneFromPerception stays silent-safe on empty input", () => {
  const scene = sceneFromPerception({ notes: [], people: [] }, [], true, 100);
  assert.deepEqual(scene, { people: [], recentNotes: [], lookAround: true, objects: [] });
});

test("sceneFromPerception renders clocks from x and carries objects", () => {
  const triage: SceneTriage = {
    notes: [],
    people: [{ position: "centre", distance: "near", gender: "woman", x: 0.8, y: 0.4 }],
    objects: [{ label: "darwaza", x: 0.8, y: 0.5, distance: "mid", salience: 3 }],
  };
  const scene = sceneFromPerception(triage, [], true, 100);
  assert.equal(scene.people[0]?.clock, 1);
  assert.equal(scene.people[0]?.ref, "S1");
  assert.deepEqual(scene.objects, [{ label: "darwaza", clock: 1, distance: "mid" }]);
  assert.equal(scene.lookAround, true);
});

test("readChunk pages a label in 20-word slices", () => {
  const words = Array.from({ length: 45 }, (_, i) => `w${i + 1}`).join(" ");
  const first = readChunk(words, 0);
  assert.equal(first?.chunk.split(" ").length, 20);
  assert.equal(first?.hasMore, true);
  const second = readChunk(words, 1);
  assert.ok(second?.chunk.startsWith("w21"));
  assert.equal(second?.hasMore, true);
  const third = readChunk(words, 2);
  assert.equal(third?.chunk.split(" ").length, 5);
  assert.equal(third?.hasMore, false);
  assert.equal(readChunk(words, 3), null);
  assert.equal(readChunk("  ", 0), null);
});

test("stats snapshot percentiles over samples", () => {
  const st = new UtteranceStats();
  assert.deepEqual(st.snapshot(), {
    utterances: 0,
    frameWaitMs: { p50: 0, p95: 0 },
    modelMs: { p50: 0, p95: 0 },
    totalMs: { p50: 0, p95: 0 },
    timeouts: { triage: 0, scene: 0, agent: 0, answer: 0, find: 0 },
    triageSamples: 0,
    triageMs: { p50: 0, p95: 0 },
  });
  for (let i = 1; i <= 10; i++) {
    st.record({ frameWaitMs: i * 10, modelMs: i * 100, totalMs: i * 1000 });
    st.recordTriage(i * 5);
  }
  const snap = st.snapshot();
  assert.equal(snap.utterances, 10);
  assert.deepEqual(snap.frameWaitMs, { p50: 50, p95: 100 });
  assert.deepEqual(snap.modelMs, { p50: 500, p95: 1000 });
  assert.deepEqual(snap.totalMs, { p50: 5000, p95: 10000 });
  assert.equal(snap.triageSamples, 10);
  assert.deepEqual(snap.triageMs, { p50: 25, p95: 50 });
});

test("stats keep only the last 50 samples", () => {
  const st = new UtteranceStats();
  for (let i = 1; i <= 60; i++) {
    st.record({ frameWaitMs: i, modelMs: i, totalMs: i });
  }
  assert.equal(st.count, 50);
  assert.equal(st.snapshot().totalMs.p50, 35);
});

test("stats count timeouts per stage", () => {
  const st = new UtteranceStats();
  st.recordTimeout("triage");
  st.recordTimeout("triage");
  st.recordTimeout("agent");
  st.recordTimeout("find");
  assert.deepEqual(st.snapshot().timeouts, { triage: 2, scene: 0, agent: 1, answer: 0, find: 1 });
});
