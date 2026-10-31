import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PTT_DEBOUNCE_MS,
  createPttState,
  pttTransition,
  type PttState,
} from "./pttMachine.ts";

function step(state: PttState, event: Parameters<typeof pttTransition>[1], now: number) {
  return pttTransition(state, event, now);
}

test("press from idle starts listening", () => {
  const { state, effects } = step(createPttState(), { type: "press" }, 1000);
  assert.equal(state.phase, "listening");
  assert.deepEqual(effects, [{ type: "listeningStarted" }, { type: "startListening" }]);
});

test("happy path: press -> partial -> final -> sent -> idle", () => {
  let s = createPttState();
  let r = step(s, { type: "press" }, 1000);
  s = r.state;
  r = step(s, { type: "partial", text: "ki hai" }, 1500);
  assert.equal(r.state.phase, "listening");
  assert.equal(r.state.partial, "ki hai");
  assert.deepEqual(r.effects, []);
  s = r.state;
  r = step(s, { type: "final", text: "ki hai saamne", confidence: 0.9 }, 2000);
  assert.equal(r.state.phase, "sending");
  assert.deepEqual(r.effects, [
    { type: "sendUtterance", text: "ki hai saamne", confidence: 0.9 },
  ]);
  s = r.state;
  r = step(s, { type: "sent" }, 2100);
  assert.equal(r.state.phase, "idle");
  assert.equal(r.state.partial, "");
  assert.deepEqual(r.effects, [{ type: "thinkingEarcon" }, { type: "listeningStopped" }]);
});

test("second press stops the recognizer but stays listening for the final", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const r = step(s, { type: "press" }, 1000 + PTT_DEBOUNCE_MS + 1);
  assert.equal(r.state.phase, "listening");
  assert.deepEqual(r.effects, [{ type: "stopListening" }]);
});

test("presses within the debounce window are ignored", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const quick = step(s, { type: "press" }, 1000 + PTT_DEBOUNCE_MS - 1);
  assert.equal(quick.state.phase, "listening");
  assert.deepEqual(quick.effects, []);
  // A debounced press must not extend the window: this one lands.
  const late = step(quick.state, { type: "press" }, 1000 + PTT_DEBOUNCE_MS + 1);
  assert.deepEqual(late.effects, [{ type: "stopListening" }]);
});

test("empty final text plays the error earcon and speaks nothing", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const r = step(s, { type: "final", text: "   " }, 2000);
  assert.equal(r.state.phase, "idle");
  assert.deepEqual(r.effects, [{ type: "errorEarcon" }, { type: "listeningStopped" }]);
});

test("recognizer error ends listening with the error earcon", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const r = step(s, { type: "error", code: "no-speech" }, 2000);
  assert.equal(r.state.phase, "idle");
  assert.deepEqual(r.effects, [{ type: "errorEarcon" }, { type: "listeningStopped" }]);
});

test("nomatch ends listening with the error earcon", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const r = step(s, { type: "nomatch" }, 2000);
  assert.equal(r.state.phase, "idle");
  assert.deepEqual(r.effects, [{ type: "errorEarcon" }, { type: "listeningStopped" }]);
});

test("recognizer end-of-speech with partial text sends the partial", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  s = step(s, { type: "partial", text: "eh kinne" }, 1500).state;
  const r = step(s, { type: "end" }, 2000);
  assert.equal(r.state.phase, "sending");
  assert.deepEqual(r.effects, [{ type: "sendUtterance", text: "eh kinne", confidence: undefined }]);
});

test("recognizer end-of-speech with no text plays the error earcon", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  const r = step(s, { type: "end" }, 2000);
  assert.equal(r.state.phase, "idle");
  assert.deepEqual(r.effects, [{ type: "errorEarcon" }, { type: "listeningStopped" }]);
});

test("stale recognizer events in idle are ignored", () => {
  const s = createPttState();
  for (const event of [
    { type: "partial", text: "x" },
    { type: "final", text: "x" },
    { type: "end" },
    { type: "error", code: "network" },
    { type: "nomatch" },
    { type: "sent" },
  ] as const) {
    const r = step(s, event, 1000);
    assert.equal(r.state.phase, "idle");
    assert.deepEqual(r.effects, []);
  }
});

test("presses while sending are ignored", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  s = step(s, { type: "final", text: "hi" }, 2000).state;
  assert.equal(s.phase, "sending");
  const r = step(s, { type: "press" }, 5000);
  assert.equal(r.state.phase, "sending");
  assert.deepEqual(r.effects, []);
});

test("reset returns to idle from any phase", () => {
  let s = step(createPttState(), { type: "press" }, 1000).state;
  s = step(s, { type: "partial", text: "x" }, 1500).state;
  const r = step(s, { type: "reset" }, 1600);
  assert.deepEqual(r.state, { phase: "idle", lastPressAt: null, partial: "" });
  assert.deepEqual(r.effects, []);
});
