// Narration engine tests: summary selection, novelty windows, rate
// limits, stability and paging, all with explicit timestamps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SceneNarrator } from "./narration.js";
import type { ScenePhraseItem } from "./decision.js";
import type { SceneObject, SceneTriage, TriagePerson } from "./protocol.js";

function obj(
  label: string,
  x: number,
  salience: 1 | 2 | 3 = 2,
  distance: "near" | "mid" | "far" = "mid"
): SceneObject {
  return { label, x, y: 0.5, distance, salience };
}

function person(x?: number, overrides: Partial<TriagePerson> = {}): TriagePerson {
  return { position: "centre", distance: "near", ...overrides, ...(x === undefined ? {} : { x, y: 0.4 }) };
}

function scene(objects: SceneObject[] = [], people: TriagePerson[] = []): SceneTriage {
  return { notes: [], people, objects };
}

function itemsOf(n: SceneNarrator, s: SceneTriage, hfov: number, t: number): ScenePhraseItem[] {
  const evs = n.onScene(s, hfov, t);
  assert.equal(evs.length, 1);
  return evs[0]?.items ?? [];
}

test("inactive narrator stays silent and reports no scene", () => {
  const n = new SceneNarrator();
  assert.equal(n.isActive(), false);
  assert.equal(n.hasScene(), false);
  assert.deepEqual(n.onScene(scene([obj("kursi", 0.5)]), 100, 0), []);
  assert.equal(n.hasScene(), false);
  assert.deepEqual(n.requestMore(0), []);
});

test("activation summary picks the top 3 by salience, then nearness", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const s = scene(
    [
      obj("wall", 0.1, 1, "near"), // clutter: never a candidate
      obj("kursi", 0.5, 2, "far"),
      obj("darwaza", 0.8, 3, "mid"),
      obj("phone", 0.5, 3, "near"),
    ],
    [person(0.2, { gender: "man" })]
  );
  const evs = n.onScene(s, 100, 0);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "SCENE_SUMMARY");
  // People count as salience 3; ties keep people-first, model order.
  assert.deepEqual(evs[0]?.items, [
    { kind: "person", gender: "man", clock: 11 },
    { kind: "object", label: "phone", clock: 12 },
    { kind: "object", label: "darwaza", clock: 1 },
  ]);
});

test("empty or clutter-only scene summarises with no items", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  assert.deepEqual(itemsOf(n, scene(), 100, 0), []);
  const clutter = new SceneNarrator();
  clutter.setActive(true);
  assert.deepEqual(itemsOf(clutter, scene([obj("wall", 0.5, 1), obj("ceiling", 0.3, 1)]), 100, 0), []);
});

test("identical frames after the summary stay silent", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const s = scene([obj("kursi", 0.5), obj("thaila", 0.7, 3)]);
  assert.equal(n.onScene(s, 100, 0)[0]?.kind, "SCENE_SUMMARY");
  for (const t of [2000, 4000, 6000, 10000, 30000]) {
    assert.deepEqual(n.onScene(s, 100, t), [], `t=${t}`);
  }
});

test("new salient items need 2 consecutive frames, then speak once", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const base = [obj("kursi", 0.5)];
  assert.equal(n.onScene(scene(base), 100, 0)[0]?.kind, "SCENE_SUMMARY");
  const withPhone = [...base, obj("phone", 0.6, 3)];
  assert.deepEqual(n.onScene(scene(withPhone), 100, 2000), []); // first sighting
  const evs = n.onScene(scene(withPhone), 100, 4000);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "SCENE_UPDATE");
  assert.deepEqual(evs[0]?.items, [{ kind: "object", label: "phone", clock: 12 }]);
  assert.deepEqual(n.onScene(scene(withPhone), 100, 6000), []); // mentioned now
});

test("updates wait 8 s after the previous update", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const kursi = obj("kursi", 0.5);
  n.onScene(scene([kursi]), 100, 0);
  const phone = obj("phone", 0.6, 3);
  n.onScene(scene([kursi, phone]), 100, 1000);
  assert.equal(n.onScene(scene([kursi, phone]), 100, 2000)[0]?.kind, "SCENE_UPDATE");
  const thaila = obj("thaila", 0.7, 3);
  n.onScene(scene([kursi, phone, thaila]), 100, 3000);
  assert.deepEqual(n.onScene(scene([kursi, phone, thaila]), 100, 4000), []); // stable but rate-limited
  const late = n.onScene(scene([kursi, phone, thaila]), 100, 10000);
  assert.equal(late[0]?.kind, "SCENE_UPDATE");
  assert.deepEqual(late[0]?.items, [{ kind: "object", label: "thaila", clock: 1 }]);
});

test("items re-mention only after the 60 s window", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const kursi = obj("kursi", 0.5);
  n.onScene(scene([kursi]), 100, 0); // summary mentions kursi
  n.onScene(scene(), 100, 2000); // leaves view
  n.onScene(scene([kursi]), 100, 59000);
  assert.deepEqual(n.onScene(scene([kursi]), 100, 59500), []); // stable but inside the window
  const n2 = new SceneNarrator();
  n2.setActive(true);
  n2.onScene(scene([kursi]), 100, 0);
  n2.onScene(scene(), 100, 2000);
  n2.onScene(scene([kursi]), 100, 61000);
  const evs = n2.onScene(scene([kursi]), 100, 62000);
  assert.equal(evs[0]?.kind, "SCENE_UPDATE");
  assert.deepEqual(evs[0]?.items, [{ kind: "object", label: "kursi", clock: 12 }]);
});

test("the same label at a new clock counts as new", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  n.onScene(scene([obj("kursi", 0.5)]), 100, 0); // kursi@12 mentioned
  n.onScene(scene([obj("Kursi", 0.9)]), 100, 2000); // same label, moved right (case differs too)
  const evs = n.onScene(scene([obj("Kursi", 0.9)]), 100, 4000);
  assert.equal(evs[0]?.kind, "SCENE_UPDATE");
  assert.deepEqual(evs[0]?.items, [{ kind: "object", label: "Kursi", clock: 1 }]);
});

test("salience-1 clutter never updates", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  n.onScene(scene([obj("kursi", 0.5)]), 100, 0);
  const wall = obj("wall", 0.5, 1);
  n.onScene(scene([obj("kursi", 0.5), wall]), 100, 2000);
  assert.deepEqual(n.onScene(scene([obj("kursi", 0.5), wall]), 100, 12000), []);
});

test("new people never duplicate into scene updates", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  n.onScene(scene([obj("kursi", 0.5)]), 100, 0);
  const arrived = scene([obj("kursi", 0.5)], [person(0.7, { gender: "woman" })]);
  n.onScene(arrived, 100, 2000);
  assert.deepEqual(n.onScene(arrived, 100, 12000), []); // the engine's person path owns this
});

test("updates carry at most 2 items, top by salience then nearness", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  n.onScene(scene(), 100, 0); // empty summary
  const crowded = scene([obj("kursi", 0.5, 2, "far"), obj("phone", 0.5, 3, "near"), obj("thaila", 0.5, 3, "mid")]);
  n.onScene(crowded, 100, 2000);
  const evs = n.onScene(crowded, 100, 4000);
  assert.equal(evs[0]?.kind, "SCENE_UPDATE");
  assert.deepEqual(evs[0]?.items, [
    { kind: "object", label: "phone", clock: 12 },
    { kind: "object", label: "thaila", clock: 12 },
  ]);
});

test("requestMore pages unmentioned items in threes", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const s = scene([
    obj("darwaza", 0.8, 3, "mid"),
    obj("phone", 0.5, 3, "near"),
    obj("kursi", 0.5, 2, "far"),
    obj("thaila", 0.6, 2, "near"),
    obj("switch", 0.4, 2, "mid"),
  ]);
  n.onScene(s, 100, 0); // summary takes phone, darwaza, thaila (sal 3,3 then near-rank)
  const page1 = n.requestMore(1000);
  assert.deepEqual(page1, [
    { kind: "object", label: "switch", clock: 12 },
    { kind: "object", label: "kursi", clock: 12 },
  ]);
  assert.deepEqual(n.requestMore(2000), []); // everything mentioned now
});

test("switching off clears state; re-activation re-summarises", () => {
  const n = new SceneNarrator();
  n.setActive(true);
  const s = scene([obj("kursi", 0.5)]);
  assert.equal(n.onScene(s, 100, 0)[0]?.kind, "SCENE_SUMMARY");
  assert.equal(n.hasScene(), true);
  n.setActive(false);
  assert.equal(n.isActive(), false);
  assert.equal(n.hasScene(), false);
  assert.deepEqual(n.onScene(s, 100, 2000), []);
  n.setActive(true);
  assert.equal(n.onScene(s, 100, 4000)[0]?.kind, "SCENE_SUMMARY");
});
