// FaceTracker tests: IoU/embedding association, TTL privacy deletion,
// best-sample ranking, diversity selection. Fixed vectors, fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FaceTracker,
  TRACK_SAMPLES_MAX,
  TRACK_TTL_MS,
  boxIoU,
  sampleScore,
  selectDiverseSamples,
  type TrackedFace,
} from "./tracker.js";
import type { DetectedFace, FaceQuality } from "./embed.js";

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

function seen(face: DetectedFace, hit: TrackedFace["hit"] = null): TrackedFace {
  return { face, hit };
}

test("boxIoU measures overlap on normalised boxes", () => {
  assert.equal(boxIoU([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(boxIoU([0, 0, 0.1, 0.1], [0.9, 0.9, 0.1, 0.1]), 0);
  const iou = boxIoU([0.4, 0.4, 0.2, 0.2], [0.42, 0.42, 0.2, 0.2]);
  assert.ok(iou > 0.3 && iou < 1, `iou=${iou}`);
});

test("sampleScore rewards big, sharp, frontal faces", () => {
  assert.equal(sampleScore(quality()), 100);
  assert.equal(sampleScore(quality({ sizePx: 50 })), 50);
  assert.equal(sampleScore(quality({ blur: 50 })), 50);
  assert.equal(sampleScore(quality({ yawDeg: null })), 100);
  assert.ok(Math.abs(sampleScore(quality({ yawDeg: 60 })) - 50) < 1e-9);
});

test("nearby boxes keep their ref, far faces spawn new refs", () => {
  const t = new FaceTracker();
  const first = t.update([seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]))], 100, 0);
  assert.deepEqual(first.map((x) => x.ref), ["P1"]);
  const moved = t.update([seen(det([0.42, 0.42, 0.2, 0.2], [1, 0]))], 100, 500);
  assert.deepEqual(moved.map((x) => x.ref), ["P1"]);
  assert.equal(moved[0]?.clock, 12);
  const two = t.update(
    [seen(det([0.42, 0.42, 0.2, 0.2], [1, 0])), seen(det([0.0, 0.0, 0.1, 0.1], [0, 1]))],
    100,
    1000
  );
  assert.deepEqual(two.map((x) => x.ref), ["P1", "P2"]);
});

test("a jumped box re-associates by embedding", () => {
  const t = new FaceTracker();
  t.update([seen(det([0.1, 0.1, 0.1, 0.1], [1, 0]))], 100, 0);
  const jumped = t.update([seen(det([0.8, 0.8, 0.1, 0.1], [1, 0]))], 100, 500);
  assert.deepEqual(jumped.map((x) => x.ref), ["P1"]);
  assert.equal(jumped[0]?.clock, 1);
});

test("refs never repeat within a session, even after TTL death", () => {
  const t = new FaceTracker();
  t.update([seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]))], 100, 0);
  assert.equal(t.update([], 100, TRACK_TTL_MS).length, 1); // alive at exactly TTL
  assert.equal(t.update([], 100, TRACK_TTL_MS + 1).length, 0); // embeddings gone after
  const reborn = t.update([seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]))], 100, TRACK_TTL_MS + 2);
  assert.deepEqual(reborn.map((x) => x.ref), ["P2"]);
  assert.equal(reborn[0]?.samples.length, 1); // nothing carried over
});

test("tracks keep the best 8 samples, best first", () => {
  const t = new FaceTracker();
  for (let i = 0; i < 10; i++) {
    t.update([seen(det([0.4, 0.4, 0.2, 0.2], [1, 0], quality({ sizePx: 40 + i * 10 })))], 100, i * 500);
  }
  const track = t.getTrack("P1");
  assert.equal(track?.samples.length, TRACK_SAMPLES_MAX);
  assert.equal(track?.samples[0]?.quality.sizePx, 130);
  assert.equal(track?.samples[7]?.quality.sizePx, 60);
});

test("hits stick known names to tracks; markKnown sets them directly", () => {
  const t = new FaceTracker();
  t.update(
    [seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]), { personId: "7", name: "Ravi", score: 0.6 })],
    100,
    0
  );
  assert.equal(t.getTrack("P1")?.knownName, "Ravi");
  assert.equal(t.getTrack("P1")?.knownPersonId, "7");
  // A later unmatched frame keeps the sticky name but reports no match.
  const quiet = t.update([seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]))], 100, 500);
  assert.equal(quiet[0]?.knownName, "Ravi");
  t.markKnown("P1", "9", "Simran");
  assert.equal(t.getTrack("P1")?.knownName, "Simran");
  t.markKnown("P99", "9", "Nobody"); // unknown ref: no crash
});

test("visibleTracks reports only tracks matched in the latest update", () => {
  const t = new FaceTracker();
  t.update(
    [seen(det([0.4, 0.4, 0.2, 0.2], [1, 0])), seen(det([0.0, 0.0, 0.1, 0.1], [0, 1]))],
    100,
    0
  );
  assert.deepEqual(t.visibleTracks().map((x) => x.ref), ["P1", "P2"]);
  t.update([seen(det([0.42, 0.42, 0.2, 0.2], [1, 0]))], 100, 500);
  assert.deepEqual(t.visibleTracks().map((x) => x.ref), ["P1"]);
  assert.equal(t.liveTracks().length, 2);
});

test("forgetPerson clears identity but keeps the live track", () => {
  const t = new FaceTracker();
  t.update(
    [seen(det([0.4, 0.4, 0.2, 0.2], [1, 0]), { personId: "7", name: "Ravi", score: 0.6 })],
    100,
    0
  );
  t.forgetPerson("7");
  assert.equal(t.getTrack("P1")?.knownName, undefined);
  assert.equal(t.getTrack("P1")?.knownPersonId, undefined);
  assert.equal(t.liveTracks().length, 1); // the face is still there, generic
  t.forgetPerson("nobody"); // unknown id: no crash
});

test("selectDiverseSamples seeds best, then maximises spread", () => {
  const mk = (embedding: number[], sizePx: number) => ({
    embedding,
    quality: quality({ sizePx }),
    score: 0.9,
    ts: 0,
  });
  const samples = [mk([1, 0], 100), mk([0.99, 0.14], 90), mk([0, 1], 80)];
  const picked = selectDiverseSamples(samples, 2);
  assert.deepEqual(picked.map((s) => s.embedding), [
    [1, 0],
    [0, 1],
  ]);
  assert.equal(selectDiverseSamples(samples, 5).length, 3);
  assert.deepEqual(selectDiverseSamples([], 3), []);
});
