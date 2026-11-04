// Clock position tests: x -> hour edges at both lens FOVs, wrap-around,
// distance words, and {pos:N} placeholder rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceWord, renderPositions, toClock } from "./clock.js";

test("toClock edges at main-lens HFOV 66", () => {
  assert.equal(toClock(0, 66), 11);
  assert.equal(toClock(0.5, 66), 12);
  assert.equal(toClock(1, 66), 1);
});

test("toClock edges at ultrawide HFOV 100", () => {
  assert.equal(toClock(0, 100), 10);
  assert.equal(toClock(0.5, 100), 12);
  assert.equal(toClock(1, 100), 2);
});

test("toClock wraps and clamps", () => {
  assert.equal(toClock(0, 180), 9);
  assert.equal(toClock(1, 180), 3);
  assert.equal(toClock(-0.5, 66), toClock(0, 66));
  assert.equal(toClock(1.7, 66), toClock(1, 66));
  for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
    const h = toClock(x, 66);
    assert.ok(h >= 1 && h <= 12, `hour in range for x=${x}`);
  }
});

test("distanceWord in all languages", () => {
  assert.equal(distanceWord("near", "pa"), "kol");
  assert.equal(distanceWord("mid", "pa"), "vich");
  assert.equal(distanceWord("far", "pa"), "door");
  assert.equal(distanceWord("near", "hi"), "paas");
  assert.equal(distanceWord("far", "en"), "far");
  assert.equal(distanceWord("mid", "en"), "in the middle");
});

test("renderPositions replaces placeholders with clock words", () => {
  assert.equal(
    renderPositions("Ik banda {pos:0}", [{ x: 0, y: 0.5 }], 100, "pa"),
    "Ik banda 10 vje"
  );
  assert.equal(
    renderPositions("Kainchi {pos:0}", [{ x: 1, y: 0.9, distance: "near" }], 100, "pa"),
    "Kainchi 2 vje, kol"
  );
  assert.equal(
    renderPositions("{pos:0} and {pos:1}", [{ x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }], 66, "en"),
    "12 o'clock and 11 o'clock"
  );
});

test("renderPositions drops bad indices gracefully", () => {
  assert.equal(renderPositions("Ik banda {pos:3}", [{ x: 0.5, y: 0.5 }], 66, "pa"), "Ik banda");
  assert.equal(renderPositions("Hello {pos:0}", [], 66, "pa"), "Hello");
  assert.equal(renderPositions("no placeholders", [{ x: 0.5, y: 0.5 }], 66, "pa"), "no placeholders");
  assert.equal(renderPositions("{pos:9}", [], 66, "pa"), "");
});
