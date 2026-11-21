// Liveness monitor tests: off while the camera should not run, stalled
// after 4 s of gate silence (or a camera error), speak-once transitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_STALL_MS, cameraLiveness, livenessTransition } from "./cameraLiveness.ts";

test("stall window is 4 s", () => {
  assert.equal(CAMERA_STALL_MS, 4000);
});

test("off while the camera should not run, whatever the frames say", () => {
  assert.equal(
    cameraLiveness({ shouldRun: false, lastFrameAt: 1000, activeSinceMs: null, nowMs: 2000 }),
    "off"
  );
  assert.equal(
    cameraLiveness({
      shouldRun: false,
      lastFrameAt: 1000,
      activeSinceMs: null,
      nowMs: 2000,
      cameraError: true,
    }),
    "off"
  );
});

test("ok while frames flow, stalled after 4 s of silence", () => {
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: 1000, activeSinceMs: 1000, nowMs: 4999 }),
    "ok"
  );
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: 1000, activeSinceMs: 1000, nowMs: 5000 }),
    "stalled"
  );
});

test("a just-started camera gets the full stall window", () => {
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: null, activeSinceMs: 1000, nowMs: 4999 }),
    "ok"
  );
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: null, activeSinceMs: 1000, nowMs: 5000 }),
    "stalled"
  );
  // No baseline at all (first tick): assume ok, never instant-stall.
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: null, activeSinceMs: null, nowMs: 1000 }),
    "ok"
  );
});

test("camera error reads stalled even with a fresh frame", () => {
  assert.equal(
    cameraLiveness({
      shouldRun: true,
      lastFrameAt: 1999,
      activeSinceMs: 1000,
      nowMs: 2000,
      cameraError: true,
    }),
    "stalled"
  );
});

test("stall window is configurable", () => {
  assert.equal(
    cameraLiveness({ shouldRun: true, lastFrameAt: 1000, activeSinceMs: 1000, nowMs: 2000, stallMs: 5000 }),
    "ok"
  );
});

test("leaving ok speaks off once and uplinks the state", () => {
  assert.deepEqual(livenessTransition("ok", "stalled"), { speak: "off", sendState: true });
  assert.deepEqual(livenessTransition("ok", "off"), { speak: "off", sendState: true });
});

test("returning to ok speaks back once and uplinks the state", () => {
  assert.deepEqual(livenessTransition("stalled", "ok"), { speak: "back", sendState: true });
  assert.deepEqual(livenessTransition("off", "ok"), { speak: "back", sendState: true });
});

test("moves between down states uplink silently, steady states stay quiet", () => {
  assert.deepEqual(livenessTransition("stalled", "off"), { speak: null, sendState: true });
  assert.deepEqual(livenessTransition("off", "stalled"), { speak: null, sendState: true });
  assert.deepEqual(livenessTransition("ok", "ok"), { speak: null, sendState: false });
  assert.deepEqual(livenessTransition("stalled", "stalled"), { speak: null, sendState: false });
  assert.deepEqual(livenessTransition("off", "off"), { speak: null, sendState: false });
});
