// TurnLogger tests: record shape + privacy (never image/audio bytes),
// spoken join + latency, immediate vs pending writes, flush paths,
// duplicate/unknown receipts, and the disabled (empty dir) mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLogger, turnLogDirFromEnv } from "./turnLog.js";

function makeLogger(dir?: string, now?: number): { logger: TurnLogger; clock: { t: number } } {
  const clock = { t: now ?? 1_700_000_000_000 };
  const logger = new TurnLogger({ dir: dir ?? mkdtempSync(join(tmpdir(), "turns-")), clock: () => clock.t });
  return { logger, clock };
}

function linesOf(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  return readFileSync(join(dir, files[0]!), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("a full turn writes one line with every field, joined to its spoken receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger, clock } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "utterance", intent: "describe", owner: "c1" });
    logger.setCapture("t1", "ok");
    logger.recordAttempt("t1", { provider: "mock", stage: "agent", ms: 12, outcome: "ok" });
    logger.setText("t1", "Saamne kursi hai");
    clock.t += 1500;
    const rec = logger.finish("t1", { rescued: false, rescueReason: "silent" });
    assert.ok(rec);
    assert.equal(rec.text, "Saamne kursi hai");
    assert.equal(rec.durationMs, 1500);
    // Speaking turns wait for the phone receipt: nothing written yet.
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), []);

    const res = logger.onSpoken({ type: "spoken", turnId: "t1", startedAt: clock.t - 1400, endedAt: clock.t - 200, outcome: "done" });
    assert.equal(res.status, "attached");
    assert.equal(res.latencyMs, 100);

    const lines = linesOf(dir);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      turnId: "t1",
      kind: "utterance",
      intent: "describe",
      startedAt: 1_700_000_000_000,
      durationMs: 1500,
      capture: "ok",
      attempts: [{ provider: "mock", stage: "agent", ms: 12, outcome: "ok" }],
      text: "Saamne kursi hai",
      rescued: false,
      rescueReason: "silent",
      superseded: false,
      spoken: { outcome: "done", startedAt: 1_700_000_000_100, endedAt: 1_700_000_001_300, latencyMs: 100 },
    });
  } finally {
    logger.close();
  }
});

test("turn lines never carry image bytes or audio", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "command", intent: "describe" });
    logger.setCapture("t1", "ok");
    logger.setText("t1", "Mock counter: two packets");
    const rec = logger.finish("t1", { rescued: false });
    assert.ok(rec);
    logger.flushAll();
    const raw = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!), "utf8");
    for (const banned of ["jpeg", "base64", "audio", "embedding", "image"]) {
      assert.ok(!raw.toLowerCase().includes(banned), `turn line must not mention ${banned}: ${raw}`);
    }
  } finally {
    logger.close();
  }
});

test("silent turns write immediately; flushAll writes pending turns with spoken=null", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "utterance", intent: "mute" });
    logger.finish("t1", { rescued: false });
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, 1);

    logger.begin("t2", { kind: "proactive", intent: "cash" });
    logger.setText("t2", "note");
    logger.finish("t2", { rescued: false });
    logger.flushAll();
    const lines = linesOf(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!["spoken"], null);
    assert.equal(lines[1]!["spoken"], null);
    assert.equal(lines[1]!["text"], "note");
  } finally {
    logger.close();
  }
});

test("discarded silent proactive turns are never logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger } = makeLogger(dir);
  try {
    logger.begin("p1", { kind: "proactive" });
    logger.recordAttempt("p1", { provider: "mock", stage: "triage", ms: 5, outcome: "ok" });
    logger.discard("p1");
    logger.flushAll();
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), []);
    assert.equal(logger.finish("p1", { rescued: false }), null);
  } finally {
    logger.close();
  }
});

test("duplicate receipts are ignored, unknown receipts report unknown", () => {
  const { logger } = makeLogger(mkdtempSync(join(tmpdir(), "turns-")));
  try {
    logger.begin("t1", { kind: "utterance" });
    logger.setText("t1", "hi");
    logger.finish("t1", { rescued: false });
    assert.equal(logger.onSpoken({ type: "spoken", turnId: "t1", startedAt: 1, endedAt: 2, outcome: "done" }).status, "attached");
    assert.equal(logger.onSpoken({ type: "spoken", turnId: "t1", startedAt: 1, endedAt: 2, outcome: "done" }).status, "duplicate");
    assert.equal(logger.onSpoken({ type: "spoken", turnId: "nope", startedAt: 1, endedAt: 2, outcome: "watchdog" }).status, "unknown");
  } finally {
    logger.close();
  }
});

test("early receipts (before finish) attach at finish time", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger, clock } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "utterance" });
    logger.setText("t1", "hi");
    const early = logger.onSpoken({ type: "spoken", turnId: "t1", startedAt: clock.t + 50, endedAt: clock.t + 60, outcome: "done" });
    assert.equal(early.status, "early");
    const rec = logger.finish("t1", { rescued: false });
    assert.ok(rec?.spoken);
    assert.equal(rec.spoken.latencyMs, 50);
    assert.equal(linesOf(dir).length, 1);
  } finally {
    logger.close();
  }
});

test("flushOwner writes one connection's pending turns only", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "utterance", owner: "c1" });
    logger.setText("t1", "one");
    logger.finish("t1", { rescued: false });
    logger.begin("t2", { kind: "utterance", owner: "c2" });
    logger.setText("t2", "two");
    logger.finish("t2", { rescued: false });
    logger.flushOwner("c1");
    let lines = linesOf(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!["turnId"], "t1");
    logger.flushAll();
    lines = linesOf(dir);
    assert.equal(lines.length, 2);
  } finally {
    logger.close();
  }
});

test("attemptCount tracks per-stage attempts for the outer-call skip logic", () => {
  const { logger } = makeLogger(mkdtempSync(join(tmpdir(), "turns-")));
  try {
    logger.begin("t1", { kind: "utterance" });
    assert.equal(logger.attemptCount("t1", "agent"), 0);
    logger.recordAttempt("t1", { provider: "a", stage: "agent", ms: 1, outcome: "timeout" });
    logger.recordAttempt("t1", { provider: "b", stage: "agent", ms: 2, outcome: "ok" });
    logger.recordAttempt("t1", { provider: "a", stage: "find", ms: 3, outcome: "ok" });
    assert.equal(logger.attemptCount("t1", "agent"), 2);
    assert.equal(logger.attemptCount("t1", "find"), 1);
    assert.equal(logger.attemptCount("t1", "triage"), 0);
    assert.equal(logger.attemptCount("unknown", "agent"), 0);
  } finally {
    logger.close();
  }
});

test("empty dir disables file logging but tracking still works", () => {
  const logger = new TurnLogger({ dir: "" });
  try {
    assert.equal(logger.enabled, false);
    logger.begin("t1", { kind: "utterance" });
    logger.setText("t1", "hi");
    const rec = logger.finish("t1", { rescued: true, rescueReason: "silent" });
    assert.ok(rec);
    assert.equal(rec.rescued, true);
    const res = logger.onSpoken({ type: "spoken", turnId: "t1", startedAt: 1, endedAt: 2, outcome: "done" });
    assert.equal(res.status, "attached");
  } finally {
    logger.close();
  }
});

test("turnLogDirFromEnv defaults to logs, empty disables", () => {
  const saved = process.env.TURN_LOG_DIR;
  try {
    delete process.env.TURN_LOG_DIR;
    assert.equal(turnLogDirFromEnv(), "logs");
    process.env.TURN_LOG_DIR = "";
    assert.equal(turnLogDirFromEnv(), "");
    process.env.TURN_LOG_DIR = "/tmp/x";
    assert.equal(turnLogDirFromEnv(), "/tmp/x");
  } finally {
    if (saved === undefined) delete process.env.TURN_LOG_DIR;
    else process.env.TURN_LOG_DIR = saved;
  }
});

test("writes survive the log dir being removed mid-run", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const { logger } = makeLogger(dir);
  try {
    logger.begin("t1", { kind: "utterance" });
    logger.finish("t1", { rescued: false });
    assert.equal(linesOf(dir).length, 1);
    rmSync(dir, { recursive: true, force: true });
    logger.begin("t2", { kind: "utterance" });
    logger.finish("t2", { rescued: false });
    const lines = linesOf(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!["turnId"], "t2");
  } finally {
    logger.close();
  }
});

test("file name carries the UTC day of the turn start", () => {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  // 2026-11-21T10:00:00Z.
  const { logger } = makeLogger(dir, Date.parse("2026-11-21T10:00:00Z"));
  try {
    logger.begin("t1", { kind: "utterance" });
    logger.finish("t1", { rescued: false });
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".jsonl")),
      ["turns-2026-11-21.jsonl"]
    );
  } finally {
    logger.close();
  }
});
