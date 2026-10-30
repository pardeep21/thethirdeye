// Eval notes tests: usage + cost are recorded even when triage throws
// (failed parses still consumed tokens), and debug labels pass through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { NamedTriage } from "@thethirdeye/server/adapters";
import type { TriageResult } from "@thethirdeye/server/protocol";
import { debugLabelFor, parseExpected, runNotes } from "./notes.js";

function stubTriage(opts: {
  name?: string;
  failWith?: string;
  result?: TriageResult;
  usage?: { promptTokens: number; completionTokens: number };
  seenLabels?: string[];
}): NamedTriage {
  return {
    name: opts.name ?? "openai-compat:muse-spark-1.3",
    getLastUsage: () => opts.usage,
    triage: async (_img: Buffer, debugLabel?: string) => {
      if (debugLabel && opts.seenLabels) opts.seenLabels.push(debugLabel);
      if (opts.failWith) throw new Error(opts.failWith);
      return opts.result ?? { notes: [], people: [] };
    },
  };
}

async function withJpeg(name: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "thethirdeye-eval-"));
  try {
    const file = join(dir, name);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888888" } })
      .jpeg()
      .toFile(file);
    await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("failed triage still records usage and cost (no $0 lie)", async () => {
  await withJpeg("500_1.jpg", async (file) => {
    const results = await runNotes(
      [file],
      [512],
      "meta",
      stubTriage({
        failWith: "triage output is not JSON",
        usage: { promptTokens: 1000, completionTokens: 50 },
      })
    );
    assert.equal(results.length, 1);
    assert.match(results[0].error ?? "", /not JSON/);
    assert.deepEqual(results[0].usage, { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 });
    // 1000 * 1.25 + 50 * 4.25 per 1M.
    assert.equal(results[0].costUsd, (1000 * 1.25 + 50 * 4.25) / 1e6);
  });
});

test("contributor model uses contributor rates", async () => {
  await withJpeg("500_1.jpg", async (file) => {
    const results = await runNotes(
      [file],
      [512],
      "meta",
      stubTriage({
        name: "openai-compat:muse-spark-1.3-contributor",
        result: { notes: [{ denomination: 500, confidence: 0.9 }], people: [] },
        usage: { promptTokens: 1000, completionTokens: 50 },
      })
    );
    assert.equal(results[0].costUsd, (1000 * 0.1 + 50 * 0.2) / 1e6);
    assert.equal(results[0].predicted, 500);
  });
});

test("debug label is <file>_<size> and reaches triage", async () => {
  assert.equal(debugLabelFor("500_new_front_03.jpg", 512), "500_new_front_03_512");
  assert.equal(parseExpected("500_03.jpg"), 500);
  const seenLabels: string[] = [];
  await withJpeg("500_1.jpg", async (file) => {
    await runNotes([file], [512], "mock", stubTriage({ seenLabels }));
  });
  assert.deepEqual(seenLabels, ["500_1_512"]);
});
