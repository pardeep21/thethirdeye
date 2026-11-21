#!/usr/bin/env node
// R7 field report: reads a turns-*.jsonl file (see src/turnLog.ts) and
// prints counts, rates, the slowest 10 turns, and every rescued/failed
// turn with its reason. Run on the VPS after a field session, e.g.
//   node scripts/turn-report.mjs logs/turns-2026-11-21.jsonl
// With no argument, reports the newest logs/turns-*.jsonl in the cwd.
// Standalone: needs only node, no build, no dependencies.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function pct(n, d) {
  if (d === 0) return "n/a";
  return `${((100 * n) / d).toFixed(1)}%`;
}

function trunc(s, n) {
  if (s === null || s === undefined) return "-";
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function newestTurnsFile(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort();
  return join(dir, files[files.length - 1]);
}

function loadTurns(path) {
  const raw = readFileSync(path, "utf8");
  const turns = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      turns.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { turns, bad };
}

function slowness(t) {
  return t.spoken?.latencyMs ?? t.durationMs ?? 0;
}

function failReasons(t) {
  const reasons = [];
  if (t.rescued) reasons.push(`rescued:${t.rescueReason ?? "silent"}`);
  if (t.capture === "failed" || t.capture === "stale_fallback") reasons.push(`capture:${t.capture}`);
  const timeouts = (t.attempts ?? []).filter((a) => a.outcome === "timeout").length;
  if (timeouts > 0) reasons.push(`timeout x${timeouts}`);
  const errors = (t.attempts ?? []).filter((a) => a.outcome === "error").length;
  if (errors > 0) reasons.push(`error x${errors}`);
  if (t.spoken && (t.spoken.outcome === "watchdog" || t.spoken.outcome === "error")) {
    reasons.push(`tts:${t.spoken.outcome}`);
  }
  if (t.text !== null && t.text !== undefined && !t.spoken) reasons.push("no-spoken-report");
  return reasons;
}

function report(path, turns, bad) {
  const out = [];
  out.push(`turns file: ${path} (${turns.length} turns${bad ? `, ${bad} bad lines skipped` : ""})`);
  if (turns.length === 0) {
    out.push("no turns recorded");
    return out.join("\n");
  }
  const byKind = {};
  for (const t of turns) byKind[t.kind ?? "?"] = (byKind[t.kind ?? "?"] ?? 0) + 1;
  out.push(
    `turns: ${turns.length} (${Object.entries(byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")})`
  );

  const rescued = turns.filter((t) => t.rescued);
  const superseded = turns.filter((t) => t.superseded).length;
  out.push(`rescued: ${rescued.length}  superseded(barge-in): ${superseded}`);

  const captureKnown = turns.filter((t) => t.capture && t.capture !== "camera_off");
  const captureFailed = captureKnown.filter((t) => t.capture === "failed" || t.capture === "stale_fallback");
  const captureOutcomes = {};
  for (const t of turns) {
    if (t.capture) captureOutcomes[t.capture] = (captureOutcomes[t.capture] ?? 0) + 1;
  }
  out.push(
    `capture: ${Object.entries(captureOutcomes)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none recorded"}  fail rate ${pct(captureFailed.length, captureKnown.length)}`
  );

  const attempts = turns.flatMap((t) => t.attempts ?? []);
  const timeouts = attempts.filter((a) => a.outcome === "timeout");
  const byStage = {};
  for (const a of attempts) {
    const cell = (byStage[a.stage] ??= { total: 0, timeouts: 0 });
    cell.total++;
    if (a.outcome === "timeout") cell.timeouts++;
  }
  const stageRates = Object.entries(byStage)
    .map(([s, c]) => `${s} ${c.timeouts}/${c.total}`)
    .join(", ");
  const attempted = turns.filter((t) => (t.attempts ?? []).length > 0);
  const fallbacked = attempted.filter((t) => {
    const per = {};
    for (const a of t.attempts) per[a.stage] = (per[a.stage] ?? 0) + 1;
    return Object.values(per).some((n) => n > 1);
  });
  out.push(
    `model: ${attempts.length} attempts, ${timeouts.length} timeouts` +
      (stageRates ? ` (${stageRates})` : "") +
      `  fallback turns ${fallbacked.length}/${attempted.length} (${pct(fallbacked.length, attempted.length)})`
  );

  const spoken = turns.filter((t) => t.spoken);
  const outcomes = {};
  for (const t of spoken) outcomes[t.spoken.outcome] = (outcomes[t.spoken.outcome] ?? 0) + 1;
  const lat = spoken.map((t) => t.spoken.latencyMs).sort((a, b) => a - b);
  const noReport = turns.filter((t) => t.text !== null && t.text !== undefined && !t.spoken).length;
  out.push(
    `tts: ${spoken.length} receipts` +
      (Object.keys(outcomes).length
        ? ` (${Object.entries(outcomes)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")})`
        : "") +
      `  no-report ${noReport}` +
      (lat.length ? `  turn-start->tts-start p50 ${percentile(lat, 50)}ms p95 ${percentile(lat, 95)}ms` : "")
  );

  const slow = [...turns].sort((a, b) => slowness(b) - slowness(a)).slice(0, 10);
  out.push("slowest 10 turns (turn-start -> TTS start, else turn duration):");
  for (const t of slow) {
    const ms = slowness(t);
    const via = t.spoken ? "tts" : "dur";
    out.push(`  ${ms}ms[${via}] ${t.turnId} ${t.kind}/${t.intent} "${trunc(t.text, 60)}"`);
  }

  out.push("rescued/failed turns:");
  let flagged = 0;
  for (const t of turns) {
    const reasons = failReasons(t);
    if (reasons.length === 0) continue;
    flagged++;
    out.push(`  ${t.turnId} ${t.kind}/${t.intent} [${reasons.join(", ")}] "${trunc(t.text, 60)}"`);
  }
  if (flagged === 0) out.push("  none");
  return out.join("\n");
}

function main() {
  let path = process.argv[2];
  if (!path) {
    const found = newestTurnsFile("logs");
    if (!found) {
      console.error("usage: node scripts/turn-report.mjs <turns-YYYY-MM-DD.jsonl> (no logs/turns-*.jsonl found)");
      process.exit(2);
    }
    path = found;
  }
  let loaded;
  try {
    loaded = loadTurns(path);
  } catch (err) {
    console.error(`cannot read ${path}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  console.log(report(path, loaded.turns, loaded.bad));
}

main();
