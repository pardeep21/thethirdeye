// results.md generation: accuracy per denomination, confusion list,
// p50/p95 latency per test and image size, transcripts, total spend.

import { writeFileSync } from "node:fs";
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

function latencyTable(title: string, groups: Map<string, CallRecord[]>): string {
  const lines = [`### ${title}`, "", "| Test | Image size | n (ok/total) | p50 | p95 |", "|---|---|---|---|---|"];
  for (const [key, calls] of groups) {
    const ok = calls.filter((c) => !c.error).map((c) => c.latencyMs);
    const [test, size] = key.split("\u0000");
    lines.push(
      `| ${test} | ${size} | ${ok.length}/${calls.length} | ${fmtMs(percentile(ok, 50))} | ${fmtMs(percentile(ok, 95))} |`
    );
  }
  return lines.join("\n");
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
    out.push("| Denomination | Size | n | Correct | Accuracy |");
    out.push("|---|---|---|---|---|");
    const scored = notes.filter((c) => !c.error && c.expected !== null);
    const sizeTotals = new Map<string, { n: number; ok: number }>();
    for (const d of DENOMINATIONS) {
      for (const size of sizes.map(String).map((s) => `${s}px`)) {
        const group = scored.filter((c) => c.expected === d && c.imageSize === size);
        const ok = group.filter((c) => c.predicted === c.expected).length;
        const acc = sizeTotals.get(size) ?? { n: 0, ok: 0 };
        acc.n += group.length;
        acc.ok += ok;
        sizeTotals.set(size, acc);
        out.push(
          `| ${d} | ${size} | ${group.length} | ${ok} | ${group.length ? `${((100 * ok) / group.length).toFixed(1)}%` : "n/a"} |`
        );
      }
    }
    for (const [size, t] of sizeTotals) {
      out.push(
        `| **overall** | **${size}** | **${t.n}** | **${t.ok}** | **${t.n ? `${((100 * t.ok) / t.n).toFixed(1)}%` : "n/a"}** |`
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
    const groups = new Map<string, CallRecord[]>();
    for (const c of all) {
      const key = `${c.test}\u0000${c.imageSize}`;
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }
    out.push(latencyTable("All groups", groups), "");
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
