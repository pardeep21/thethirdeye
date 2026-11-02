// Timeout guard tests: the race, env parsing, late-settlement discard.
// Real timers with tiny budgets: timeouts are inherently time-based.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentTimeoutFromEnv,
  findTimeoutFromEnv,
  triageTimeoutFromEnv,
  withTimeout,
  ModelTimeoutError,
} from "./timeouts.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("withTimeout passes fast values through", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, "agent"), "ok");
});

test("withTimeout rejects slow calls with the stage", async () => {
  const slow = delay(300).then(() => "late");
  const err = await withTimeout(slow, 20, "triage").then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(err instanceof ModelTimeoutError);
  assert.equal(err.stage, "triage");
  assert.equal(err.timeoutMs, 20);
  assert.match(err.message, /stage=triage/);
  await slow;
});

test("withTimeout propagates fast rejections unchanged", async () => {
  const boom = new Error("boom");
  const err = await withTimeout(Promise.reject(boom), 1000, "find").then(
    () => null,
    (e: unknown) => e
  );
  assert.equal(err, boom);
});

test("a late rejection after timeout never surfaces", async () => {
  // If withTimeout leaked the loser, node would crash on unhandled
  // rejection; reaching the end of this test is the assertion.
  const late = delay(30).then(() => {
    throw new Error("slow failure");
  });
  const err = await withTimeout(late, 5, "scene").then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(err instanceof ModelTimeoutError);
  await delay(80);
});

test("timeout env parsing: defaults, overrides, invalid", () => {
  for (const k of ["TRIAGE_TIMEOUT_MS", "AGENT_TIMEOUT_MS", "FIND_TIMEOUT_MS"]) delete process.env[k];
  assert.equal(triageTimeoutFromEnv(), 5000);
  assert.equal(agentTimeoutFromEnv(), 7000);
  assert.equal(findTimeoutFromEnv(), 7000);
  process.env.TRIAGE_TIMEOUT_MS = "100";
  process.env.AGENT_TIMEOUT_MS = "200";
  process.env.FIND_TIMEOUT_MS = "300";
  try {
    assert.equal(triageTimeoutFromEnv(), 100);
    assert.equal(agentTimeoutFromEnv(), 200);
    assert.equal(findTimeoutFromEnv(), 300);
    process.env.TRIAGE_TIMEOUT_MS = "nope";
    assert.throws(() => triageTimeoutFromEnv(), /must be a non-negative integer/);
    process.env.AGENT_TIMEOUT_MS = "-5";
    assert.throws(() => agentTimeoutFromEnv(), /must be a non-negative integer/);
  } finally {
    for (const k of ["TRIAGE_TIMEOUT_MS", "AGENT_TIMEOUT_MS", "FIND_TIMEOUT_MS"]) delete process.env[k];
  }
});
