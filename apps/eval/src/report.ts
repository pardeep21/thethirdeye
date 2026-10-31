// results.md generation: accuracy per denomination, confusion list,
// p50/p95 latency per test and image size, transcripts, total spend.
// Also builds the machine-readable results/<timestamp>.json report.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatUsd } from "./client.js";
import { DENOMINATIONS } from "./notes.js";
import type { AudioCall, CallRecord, NoteCall, SceneCall } from "./types.js";

/** Nearest-rank percentile; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function fmtMs(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v)}ms`;
}

function fmtPct(ok: number, n: number): string {
  return n ? `${((100 * ok) / n).toFixed(1)}%` : "n/a";
}

export interface LatencyGroup {
  test: string;
  imageSize: string;
  n: number;
  ok: number;
  p50: number | null;
  p95: number | null;
}

/** Successful-call latency per (test, image size) group. */
export function latencyGroups(all: CallRecord[]): LatencyGroup[] {
  const groups = new Map<string, CallRecord[]>();
  for (const c of all) {
    const key = `${c.test}\u0000${c.imageSize}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  return [...groups].map(([key, calls]) => {
    const ok = calls.filter((c) => !c.error).map((c) => c.latencyMs);
    const [test, imageSize] = key.split("\u0000");
    return { test, imageSize, n: calls.length, ok: ok.length, p50: percentile(ok, 50), p95: percentile(ok, 95) };
  });
}

function latencyTable(title: string, all: CallRecord[]): string {
  const lines = [`### ${title}`, "", "| Test | Image size | n (ok/total) | p50 | p95 |", "|---|---|---|---|---|"];
  for (const g of latencyGroups(all)) {
    lines.push(`| ${g.test} | ${g.imageSize} | ${g.ok}/${g.n} | ${fmtMs(g.p50)} | ${fmtMs(g.p95)} |`);
  }
  return lines.join("\n");
}

export interface DenomSummary {
  denomination: number;
  n: number;
  correct: number;
  accuracy: number | null;
  /** Predicted null (model said unsure) among scored calls. */
  unsure: number;
  unsureRate: number | null;
}

export interface NotesSummary {
  perDenomination: DenomSummary[];
  overall: { n: number; correct: number; accuracy: number | null; unsure: number; unsureRate: number | null };
  /** Successful-call latency over all scored notes calls. */
  latencyMs: { n: number; p50: number | null; p95: number | null };
}

function rate(ok: number, n: number): number | null {
  return n ? ok / n : null;
}

/** Accuracy + unsure rate per denomination and overall, across sizes. Errors and unscored files excluded. */
export function summarizeNotes(notes: NoteCall[]): NotesSummary {
  const scored = notes.filter((c) => !c.error && c.expected !== null);
  const perDenomination = DENOMINATIONS.map((d) => {
    const group = scored.filter((c) => c.expected === d);
    const correct = group.filter((c) => c.predicted === c.expected).length;
    const unsure = group.filter((c) => c.predicted === null).length;
    return {
      denomination: d,
      n: group.length,
      correct,
      accuracy: rate(correct, group.length),
      unsure,
      unsureRate: rate(unsure, group.length),
    };
  });
  const correct = scored.filter((c) => c.predicted === c.expected).length;
  const unsure = scored.filter((c) => c.predicted === null).length;
  const lat = scored.map((c) => c.latencyMs);
  return {
    perDenomination,
    overall: {
      n: scored.length,
      correct,
      accuracy: rate(correct, scored.length),
      unsure,
      unsureRate: rate(unsure, scored.length),
    },
    latencyMs: { n: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95) },
  };
}

export interface ReportInput {
  runInfo: string[];
  sizes: number[];
  notes: NoteCall[];
  scenes: SceneCall[];
  audios: AudioCall[];
  startedAt: Date;
}

export function buildMarkdown(input: ReportInput): string {
  const { runInfo, sizes, notes, scenes, audios, startedAt } = input;
  const all: CallRecord[] = [...notes, ...scenes, ...audios];
  const okCalls = all.filter((c) => !c.error);
  const totalCost = all.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const visionCost = [...notes, ...scenes].reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const audioCost = audios.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const tokens = okCalls.reduce((s, c) => s + (c.usage?.totalTokens ?? 0), 0);

  const out: string[] = [];
  out.push("# thethirdeye-spike results", "");
  out.push(`Run at (UTC): ${startedAt.toISOString()}`);
  for (const line of runInfo) out.push(line);
  out.push(`Notes sizes: ${sizes.map((s) => `${s}px longest side`).join(", ")} (downscale only; actual dims per call)`);
  out.push("");

  out.push("## Total spend (estimated)", "");
  out.push(`**${formatUsd(totalCost)}** across ${all.length} calls (${okCalls.length} ok, ${all.length - okCalls.length} failed).`);
  out.push(`- Vision: ${formatUsd(visionCost)} over ${notes.length + scenes.length} calls, ${tokens} tokens total (where usage was returned).`);
  out.push(`- Audio: ${formatUsd(audioCost)} over ${audios.length} clips.`);
  out.push("");
  out.push("Costs are estimates from public Meta Model API pricing, not billed amounts:");
  out.push("muse-spark standard $1.25/1M input, $4.25/1M output, $0.15/1M cached input;");
  out.push("muse-voice-transcribe-1.0 $0.18/hour of audio. Pricing checked 2026-10-29;");
  out.push("see https://dev.meta.ai/products/meta-model-api and https://dev.meta.ai/docs/overview.");
  out.push("");

  // Accuracy per denomination (per size).
  out.push("## Notes accuracy per denomination", "");
  if (!notes.length) {
    out.push("(notes test not run)", "");
  } else {
    out.push("| Denomination | Size | n | Correct | Accuracy | Unsure |");
    out.push("|---|---|---|---|---|---|");
    const scored = notes.filter((c) => !c.error && c.expected !== null);
    const sizeTotals = new Map<string, { n: number; ok: number; unsure: number }>();
    for (const d of DENOMINATIONS) {
      for (const size of sizes.map(String).map((s) => `${s}px`)) {
        const group = scored.filter((c) => c.expected === d && c.imageSize === size);
        const ok = group.filter((c) => c.predicted === c.expected).length;
        const unsure = group.filter((c) => c.predicted === null).length;
        const acc = sizeTotals.get(size) ?? { n: 0, ok: 0, unsure: 0 };
        acc.n += group.length;
        acc.ok += ok;
        acc.unsure += unsure;
        sizeTotals.set(size, acc);
        out.push(
          `| ${d} | ${size} | ${group.length} | ${ok} | ${fmtPct(ok, group.length)} | ${unsure} (${fmtPct(unsure, group.length)}) |`
        );
      }
    }
    for (const [size, t] of sizeTotals) {
      out.push(
        `| **overall** | **${size}** | **${t.n}** | **${t.ok}** | **${fmtPct(t.ok, t.n)}** | **${t.unsure} (${fmtPct(t.unsure, t.n)})** |`
      );
    }
    out.push("");
    const unscored = notes.filter((c) => c.expected === null);
    if (unscored.length) {
      out.push(
        `Note: ${unscored.length} call(s) had filenames outside \`<value>_<n>.jpg\` and were not scored: ` +
          unscored.map((c) => `${c.file} @ ${c.imageSize} (predicted ${c.predicted ?? "null"})`).join("; ")
      );
      out.push("");
    }
  }

  // Confusion list.
  out.push("## Confusion list (wrong notes answers)", "");
  const wrong = notes.filter(
    (c) => !c.error && c.expected !== null && c.predicted !== c.expected
  );
  if (!notes.length) out.push("(notes test not run)", "");
  else if (!wrong.length) out.push("None - every scored answer was correct.", "");
  else {
    for (const c of wrong) {
      out.push(
        `- \`${c.file}\` @ ${c.imageSize} (${c.actualDims}): expected **${c.expected}**, got **${c.predicted ?? "null"}** ` +
          `(confidence ${c.confidence ?? "?"}, note_visible ${c.noteVisible ?? "?"}, ${c.latencyMs}ms)`
      );
    }
    out.push("");
  }

  // Latency.
  out.push("## Latency p50/p95 per test and image size", "");
  out.push("_Successful calls only; end-to-end HTTP round-trip per call, sequential, retries excluded from the timed span._", "");
  if (!all.length) {
    out.push("(no calls)", "");
  } else {
    out.push(latencyTable("All groups", all), "");
  }

  // Scenes.
  out.push("## Scene descriptions", "");
  if (!scenes.length) {
    out.push("(scenes test not run)", "");
  } else {
    for (const c of scenes) {
      if (c.error) {
        out.push(`- \`${c.file}\`: ERROR: ${c.error}`);
      } else {
        const flag = c.words > 12 ? " (OVER 12 WORDS)" : "";
        out.push(
          `- \`${c.file}\`: "${c.description}" — ${c.words} words${flag}, ${c.imageSize}, ${c.latencyMs}ms, ${formatUsd(c.costUsd)}`
        );
      }
    }
    out.push("");
  }

  // Transcripts.
  out.push("## Transcripts", "");
  if (!audios.length) {
    out.push("(audio test not run)", "");
  } else {
    for (const c of audios) {
      out.push(`### \`${c.file}\``);
      if (c.error) {
        out.push("", `ERROR: ${c.error}`, "");
      } else {
        out.push(
          "",
          c.transcript || "(empty transcript)",
          "",
          `_Duration ${c.durationSec !== undefined ? `${c.durationSec.toFixed(1)}s` : "unknown"}, ` +
            `latency ${c.latencyMs}ms, cost ${formatUsd(c.costUsd)}_`,
          ""
        );
      }
    }
  }

  // Errors.
  const failed = all.filter((c) => c.error);
  if (failed.length) {
    out.push("## Errors", "");
    for (const c of failed) {
      out.push(`- \`${c.file}\` [${c.test} @ ${c.imageSize}]: ${c.error}`);
    }
    out.push("");
  }

  return out.join("\n");
}

export function writeResultsMd(path: string, markdown: string): void {
  writeFileSync(path, markdown, "utf8");
}

/** Machine-readable twin of the markdown report. */
export function buildResultsJson(input: ReportInput & { provider: string }): string {
  const { runInfo, sizes, notes, scenes, audios, startedAt, provider } = input;
  const all: CallRecord[] = [...notes, ...scenes, ...audios];
  const doc = {
    generatedAt: startedAt.toISOString(),
    provider,
    sizes,
    runInfo,
    notesSummary: summarizeNotes(notes),
    latencyByGroup: latencyGroups(all),
    spendUsd: {
      total: all.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      vision: [...notes, ...scenes].reduce((s, c) => s + (c.costUsd ?? 0), 0),
      audio: audios.reduce((s, c) => s + (c.costUsd ?? 0), 0),
    },
    calls: { notes, scenes, audios },
  };
  return JSON.stringify(doc, null, 2);
}

/** Windows-safe results filename: 2026-10-31T04-12-33-123Z.json (no colons). */
export function resultsJsonName(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

export function writeResultsJson(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, "utf8");
}
