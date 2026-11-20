// TurnGuard unit tests: spoken turns stay quiet, silent turns rescue once,
// thrown errors still rescue via finally, superseded (barged-in) turns stay silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnGuard } from "./turnGuard.js";

test("spoken turn: no fallback", () => {
  const logs: string[] = [];
  const g = new TurnGuard({ clock: () => 0, log: (m) => logs.push(m) });
  let spoke = 0;
  g.begin("t1");
  g.markSpoken("t1");
  assert.equal(g.finish("t1", "silent", () => spoke++), false);
  assert.equal(spoke, 0);
  assert.equal(g.rescuedCount, 0);
  assert.deepEqual(logs, []);
});

test("silent turn: fallback once", () => {
  const logs: string[] = [];
  const g = new TurnGuard({ clock: () => 0, log: (m) => logs.push(m) });
  let spoke = 0;
  g.begin("t1");
  assert.equal(g.finish("t1", "empty-say", () => spoke++), true);
  assert.equal(spoke, 1);
  assert.equal(g.rescuedCount, 1);
  assert.deepEqual(logs, ["silent_turn_rescued reason=empty-say"]);
  // Double finish is a no-op: fallback once.
  assert.equal(g.finish("t1", "empty-say", () => spoke++), false);
  assert.equal(spoke, 1);
  assert.equal(g.rescuedCount, 1);
});

test("thrown error: fallback once via finally", () => {
  const logs: string[] = [];
  const g = new TurnGuard({ clock: () => 0, log: (m) => logs.push(m) });
  let spoke = 0;
  g.begin("t1");
  try {
    try {
      throw new Error("spark exploded");
    } finally {
      g.finish("t1", "error", () => spoke++);
    }
  } catch {
    // Caller swallows after the rescue; the fallback already ran.
  }
  assert.equal(spoke, 1);
  assert.equal(g.rescuedCount, 1);
  assert.deepEqual(logs, ["silent_turn_rescued reason=error"]);
});

test("superseded turn: no fallback", () => {
  const logs: string[] = [];
  const g = new TurnGuard({ clock: () => 0, log: (m) => logs.push(m) });
  let spokeA = 0;
  let spokeB = 0;
  g.begin("A");
  g.begin("B"); // barge-in: A is superseded
  assert.ok(g.isSuperseded("A"));
  assert.ok(!g.isSuperseded("B"));
  assert.equal(g.finish("A", "silent", () => spokeA++), false);
  assert.equal(spokeA, 0);
  assert.equal(g.rescuedCount, 0);
  // The winning turn still rescues when silent.
  assert.equal(g.finish("B", "silent", () => spokeB++), true);
  assert.equal(spokeB, 1);
  assert.equal(g.rescuedCount, 1);
  assert.deepEqual(logs, ["silent_turn_rescued reason=silent"]);
});
