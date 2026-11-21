// R7 /stats math on a scripted set of turns: turns, rescues, capture
// failures, per-stage timeout rates, fallback rate, phone watchdog
// fires, and turn-start -> TTS-start latency percentiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UtteranceStats } from "./stats.js";

function scripted(): UtteranceStats {
  const stats = new UtteranceStats();
  // Turn 1: clean utterance, one agent attempt, fast TTS.
  stats.recordAttempt("mock", "ok", "agent");
  stats.recordTurn({
    capture: "ok",
    attempts: [{ stage: "agent", outcome: "ok" }],
    rescued: false,
  });
  stats.recordSpoken(900, "done");
  // Turn 2: failed capture, no model call, rescued silence, no receipt.
  stats.recordTurn({ capture: "failed", attempts: [], rescued: true });
  // Turn 3: fallback chain (primary timeout, backup ok) + TTS watchdog.
  stats.recordAttempt("primary-p", "timeout", "agent");
  stats.recordAttempt("backup-p", "ok", "agent");
  stats.recordTurn({
    capture: "late",
    attempts: [
      { stage: "agent", outcome: "timeout" },
      { stage: "agent", outcome: "ok" },
    ],
    rescued: false,
  });
  stats.recordSpoken(4200, "watchdog");
  // Turn 4: proactive cash (triage attempt only), camera_off excluded
  // from the capture rate; stale command capture fails.
  stats.recordAttempt("mock", "ok", "triage");
  stats.recordTurn({ capture: null, attempts: [{ stage: "triage", outcome: "ok" }], rescued: false });
  stats.recordTurn({ capture: "stale_fallback", attempts: [], rescued: false });
  stats.recordTurn({ capture: "camera_off", attempts: [], rescued: false });
  // Turn 7: orphan watchdog (flushed turn): counts the fire, no latency.
  stats.recordSpoken(null, "watchdog");
  return stats;
}

test("turn counts and rescue counts", () => {
  const snap = scripted().snapshot();
  assert.equal(snap.turns, 6);
  assert.equal(snap.rescuedTurns, 1);
});

test("capture fail rate counts failed+stale over attempted (no camera_off)", () => {
  const snap = scripted().snapshot();
  // Attempted: ok, failed, late, stale_fallback (camera_off + null excluded).
  assert.equal(snap.captureFailRate, 2 / 4);
});

test("per-stage timeout rates come from member attempts", () => {
  const snap = scripted().snapshot();
  assert.deepEqual(snap.timeoutRate, { triage: 0, scene: 0, agent: 1 / 3, answer: 0, find: 0 });
});

test("fallback rate counts turns with a repeated stage", () => {
  const snap = scripted().snapshot();
  // Attempted turns: 1, 3, 4. Only turn 3 repeats a stage.
  assert.equal(snap.fallbackRate, 1 / 3);
});

test("watchdog fires count every report; latency samples matched receipts only", () => {
  const snap = scripted().snapshot();
  assert.equal(snap.ttsWatchdogFires, 2);
  assert.deepEqual(snap.ttsLatencyMs, { p50: 900, p95: 4200 });
});

test("empty stats report zeros, not NaN", () => {
  const snap = new UtteranceStats().snapshot();
  assert.equal(snap.turns, 0);
  assert.equal(snap.rescuedTurns, 0);
  assert.equal(snap.captureFailRate, 0);
  assert.deepEqual(snap.timeoutRate, { triage: 0, scene: 0, agent: 0, answer: 0, find: 0 });
  assert.equal(snap.fallbackRate, 0);
  assert.equal(snap.ttsWatchdogFires, 0);
  assert.deepEqual(snap.ttsLatencyMs, { p50: 0, p95: 0 });
});

test("attempts without a stage feed providers but not timeout rates", () => {
  const stats = new UtteranceStats();
  stats.recordAttempt("primary-p", "timeout");
  const snap = stats.snapshot();
  assert.deepEqual(snap.providers, { "primary-p": { ok: 0, timeout: 1, error: 0 } });
  assert.deepEqual(snap.timeoutRate, { triage: 0, scene: 0, agent: 0, answer: 0, find: 0 });
});

test("latency keeps the last 50 samples", () => {
  const stats = new UtteranceStats();
  for (let i = 1; i <= 60; i++) stats.recordSpoken(i, "done");
  const snap = stats.snapshot();
  // Samples 11..60: p50 = 11 + ceil(0.5*50) - 1 = 35.
  assert.equal(snap.ttsLatencyMs.p50, 35);
  assert.equal(snap.ttsLatencyMs.p95, 58);
});
