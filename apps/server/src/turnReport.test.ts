// turn-report.mjs tests: run the standalone script on a fixture file and
// check the printed report (counts, rates, slowest turns, flagged turns).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "turn-report.mjs");

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-"));
  const path = join(dir, "turns-2026-11-21.jsonl");
  const lines = [
    {
      turnId: "t1",
      kind: "utterance",
      intent: "describe",
      startedAt: 1000,
      durationMs: 2000,
      capture: "ok",
      attempts: [{ provider: "mock", stage: "agent", ms: 50, outcome: "ok" }],
      text: "Saamne kursi hai",
      rescued: false,
      rescueReason: "silent",
      superseded: false,
      spoken: { outcome: "done", startedAt: 1900, endedAt: 2500, latencyMs: 900 },
    },
    {
      turnId: "t2",
      kind: "utterance",
      intent: "describe",
      startedAt: 5000,
      durationMs: 3000,
      capture: "failed",
      attempts: [],
      text: "pakka nahi, dobara bolo",
      rescued: true,
      rescueReason: "error",
      superseded: false,
      spoken: null,
    },
    {
      turnId: "t3",
      kind: "proactive",
      intent: "cash",
      startedAt: 9000,
      durationMs: 500,
      capture: null,
      attempts: [{ provider: "mock", stage: "triage", ms: 30, outcome: "ok" }],
      text: "note",
      rescued: false,
      rescueReason: "silent",
      superseded: false,
      spoken: { outcome: "watchdog", startedAt: 13200, endedAt: 15000, latencyMs: 4200 },
    },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  return path;
}

test("turn-report prints counts, rates, slowest turns and flagged turns", async () => {
  const { code, out } = await run([fixture()]);
  assert.equal(code, 0);
  assert.match(out, /turns: 3 \(utterance 2, proactive 1\)/);
  assert.match(out, /rescued: 1/);
  assert.match(out, /capture: ok 1, failed 1  fail rate 50\.0%/);
  assert.match(out, /model: 2 attempts, 0 timeouts/);
  assert.match(out, /fallback turns 0\/2/);
  assert.match(out, /tts: 2 receipts \(done 1, watchdog 1\)  no-report 1/);
  assert.match(out, /p50 900ms p95 4200ms/);
  assert.match(out, /slowest 10 turns/);
  // Slowest first: t3 (4200 tts) > t2 (3000 dur) > t1 (900 tts).
  const slowSection = out.slice(out.indexOf("slowest 10 turns"));
  const at = (id: string): number => slowSection.indexOf(`${id} `);
  assert.ok(at("t3") !== -1 && at("t3") < at("t2") && at("t2") < at("t1"), `bad slowest order:\n${out}`);
  assert.match(out, /t2 utterance\/describe \[rescued:error, capture:failed, no-spoken-report\]/);
  assert.match(out, /t3 proactive\/cash \[tts:watchdog\]/);
});

test("turn-report on an empty file reports no turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "report-"));
  const path = join(dir, "turns-2026-11-21.jsonl");
  writeFileSync(path, "\n", "utf8");
  const { code, out } = await run([path]);
  assert.equal(code, 0);
  assert.match(out, /no turns recorded/);
});

test("turn-report on a missing file exits nonzero with a message", async () => {
  const { code, err } = await run([join(tmpdir(), "does-not-exist.jsonl")]);
  assert.equal(code, 2);
  assert.match(err, /cannot read/);
});
