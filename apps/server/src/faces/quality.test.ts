// Enrollment face policy tests: exactly one clear frontal face per photo.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedFace } from "./embed.js";
import { checkEnrollFace } from "./quality.js";

function face(overrides: Partial<DetectedFace["quality"]> = {}): DetectedFace {
  return {
    box: [10, 10, 120, 120],
    boxNorm: [0.1, 0.1, 0.5, 0.5],
    score: 0.98,
    quality: { blur: 200, yawDeg: 0, sizePx: 120, ...overrides },
    embedding: [0.1, 0.2],
  };
}

test("one clear frontal face passes", () => {
  const out = checkEnrollFace([face()], 1);
  assert.ok("face" in out);
});

test("missing yaw never blocks (detector without landmarks)", () => {
  const out = checkEnrollFace([face({ yawDeg: null })], 2);
  assert.ok("face" in out);
});

test("zero or many faces are rejected with the photo number", () => {
  assert.deepEqual(checkEnrollFace([], 1), { error: "no face found in photo 1; please retake it" });
  assert.deepEqual(checkEnrollFace([face(), face()], 3), {
    error: "more than one face in photo 3; one person at a time, please",
  });
});

test("small, blurry or turned faces are rejected", () => {
  assert.deepEqual(checkEnrollFace([face({ sizePx: 50 })], 2), {
    error: "face in photo 2 is too small; hold the camera closer",
  });
  assert.deepEqual(checkEnrollFace([face({ blur: 40 })], 2), {
    error: "photo 2 is blurry; please retake it",
  });
  assert.deepEqual(checkEnrollFace([face({ yawDeg: 45 })], 2), {
    error: "face in photo 2 is turned away; look at the camera",
  });
  assert.deepEqual(checkEnrollFace([face({ yawDeg: -45 })], 2), {
    error: "face in photo 2 is turned away; look at the camera",
  });
});
