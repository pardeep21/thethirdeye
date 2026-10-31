// Eval report tests: per-denomination accuracy + unsure rate, latency
// percentiles, and the machine-readable results JSON shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkdown,
  buildResultsJson,
  percentile,
  resultsJsonName,
  summarizeNotes,
} from "./report.js";
import type { NoteCall } from "./types.js";

function note(over: Partial<NoteCall> & { expected: number | null; predicted: number | null }): NoteCall {
  return {
    test: "notes",
    file: "500_1.jpg",
    model: "mock",
    imageSize: "512px",
    latencyMs: 100,
    attempts: 1,
    actualDims: "512x512",
    confidence: 0.9,
    noteVisible: true,
    raw: "",
    ...over,
  };
}

const MIXED: NoteCall[] = [
  note({ expected: 500, predicted: 500, latencyMs: 100 }), // correct
  note({ expected: 500, predicted: 100, latencyMs: 200 }), // wrong value
  note({ expected: 500, predicted: null, confidence: 0.2, noteVisible: false, latencyMs: 300 }), // unsure
  note({ expected: 100, predicted: 100, latencyMs: 400 }), // correct
  note({ expected: 500, predicted: 500, latencyMs: 500, error: "boom" }), // error: excluded
  note({ expected: null, predicted: 500 }), // unscored filename: excluded
];

test("summarizeNotes scores per denomination with unsure rate", () => {
  const s = summarizeNotes(MIXED);
  const d500 = s.perDenomination.find((d) => d.denomination === 500);
  assert.deepEqual(d500, {
    denomination: 500,
    n: 3,
    correct: 1,
    accuracy: 1 / 3,
    unsure: 1,
    unsureRate: 1 / 3,
  });
  const d100 = s.perDenomination.find((d) => d.denomination === 100);
  assert.equal(d100?.n, 1);
  assert.equal(d100?.correct, 1);
  assert.equal(d100?.unsure, 0);
  const d10 = s.perDenomination.find((d) => d.denomination === 10);
  assert.deepEqual(d10, { denomination: 10, n: 0, correct: 0, accuracy: null, unsure: 0, unsureRate: null });
  assert.deepEqual(s.overall, {
    n: 4,
    correct: 2,
    accuracy: 0.5,
    unsure: 1,
    unsureRate: 0.25,
  });
});

test("summarizeNotes latency uses scored calls only", () => {
  const s = summarizeNotes(MIXED);
  // Scored latencies: 100, 200, 300, 400 (error/unscored excluded).
  assert.deepEqual(s.latencyMs, { n: 4, p50: 200, p95: 400 });
  assert.deepEqual(summarizeNotes([]).latencyMs, { n: 0, p50: null, p95: null });
});

test("percentile handles empty and single values", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([10, 20, 30], 50), 20);
});

test("resultsJsonName is filesystem-safe", () => {
  const name = resultsJsonName(new Date("2026-10-31T04:12:33.123Z"));
  assert.equal(name, "2026-10-31T04-12-33-123Z.json");
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
});

test("buildResultsJson carries summary, latency and calls", () => {
  const doc = JSON.parse(
    buildResultsJson({
      runInfo: ["Notes triage: `mock` (provider mock)"],
      sizes: [512],
      notes: MIXED,
      scenes: [],
      audios: [],
      startedAt: new Date("2026-10-31T04:12:33.123Z"),
      provider: "mock",
    })
  );
  assert.equal(doc.provider, "mock");
  assert.equal(doc.generatedAt, "2026-10-31T04:12:33.123Z");
  assert.equal(doc.notesSummary.overall.n, 4);
  assert.equal(doc.notesSummary.overall.unsure, 1);
  assert.equal(doc.calls.notes.length, 6);
  assert.ok(Array.isArray(doc.latencyByGroup));
  assert.ok(typeof doc.spendUsd.total === "number");
});

test("markdown accuracy table has an Unsure column", () => {
  const md = buildMarkdown({
    runInfo: [],
    sizes: [512],
    notes: MIXED,
    scenes: [],
    audios: [],
    startedAt: new Date("2026-10-31T04:12:33.123Z"),
  });
  assert.match(md, /\| Denomination \| Size \| n \| Correct \| Accuracy \| Unsure \|/);
});
