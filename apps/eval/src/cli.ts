#!/usr/bin/env node
// eyesmart-spike CLI: benchmark Meta Model API vision + transcription for a
// blind shopkeeper's assistant. Sequential calls, retry on 429, results.md out.
//
// Usage:
//   eyesmart-spike [notes|scenes|audio|all] [--data ./data] [--out ./results.md]
//                  [--sizes 512,1024] [--limit N]
// Data layout: <data>/notes/<value>_<n>.jpg, <data>/scenes/*, <data>/audio/*

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, loadDotEnv } from "./client.js";
import { runNotes } from "./notes.js";
import { runScenes } from "./scenes.js";
import { runAudio } from "./audio.js";
import { buildMarkdown, writeResultsMd } from "./report.js";
import type { TestName } from "./types.js";

interface Args {
  test: TestName | "all";
  data: string;
  out: string;
  sizes: number[];
  limit: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { test: "all", data: "./data", out: "./results.md", sizes: [512, 1024], limit: 0, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--data") args.data = argv[++i] ?? args.data;
    else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--sizes") {
      const v = argv[++i] ?? "";
      const sizes = v.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (sizes.length) args.sizes = sizes;
    } else if (a === "--limit") args.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`Expected one test name, got: ${rest.join(" ")}`);
  if (rest.length === 1) {
    const t = rest[0].toLowerCase();
    if (t !== "notes" && t !== "scenes" && t !== "audio" && t !== "all") {
      throw new Error(`Unknown test: ${rest[0]} (expected notes|scenes|audio|all)`);
    }
    args.test = t;
  }
  return args;
}

function usage(): string {
  return [
    "eyesmart-spike - Meta Model API benchmark for a blind shopkeeper's assistant",
    "",
    "Usage: eyesmart-spike [notes|scenes|audio|all] [options]",
    "",
    "Options:",
    "  --data DIR     input root (default ./data; expects notes/, scenes/, audio/)",
    "  --out FILE     report path (default ./results.md)",
    "  --sizes LIST   notes resize sizes, longest side px (default 512,1024)",
    "  --limit N      max files per test, 0 = all (default 0; use for cheap smoke runs)",
    "  --help         this text",
    "",
    "Env (.env or environment): META_API_KEY (required), MODEL_API_KEY (fallback),",
    "META_BASE_URL, META_VISION_MODEL, META_ASR_MODEL.",
  ].join("\n");
}

function listFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) {
    console.log(`(skip) missing folder: ${dir}`);
    return [];
  }
  return readdirSync(dir)
    .filter((f) => exts.includes(f.toLowerCase().slice(f.lastIndexOf("."))))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  loadDotEnv(process.cwd());
  const ctx = getConfig(args.limit);
  const startedAt = new Date();
  console.log(`eyesmart-spike: vision=${ctx.visionModel} asr=${ctx.asrModel} base=${ctx.baseUrl}`);

  const data = resolve(args.data);
  const want = (t: TestName) => args.test === "all" || args.test === t;
  const applyLimit = (files: string[]) => (ctx.limit > 0 ? files.slice(0, ctx.limit) : files);

  const noteFiles = want("notes")
    ? applyLimit(listFiles(join(data, "notes"), [".jpg", ".jpeg", ".png", ".webp"]))
    : [];
  const sceneFiles = want("scenes")
    ? applyLimit(listFiles(join(data, "scenes"), [".jpg", ".jpeg", ".png", ".webp"]))
    : [];
  const audioFiles = want("audio")
    ? applyLimit(listFiles(join(data, "audio"), [".wav", ".mp3", ".m4a", ".ogg", ".flac"]))
    : [];

  if (!noteFiles.length && !sceneFiles.length && !audioFiles.length) {
    throw new Error(
      `No input files for test "${args.test}" under ${data}/ ` +
        `(needs notes/<value>_<n>.jpg, scenes/*, audio/*).`
    );
  }

  // Sequential on purpose: one call at a time, in file order.
  const notes = noteFiles.length ? await runNotes(ctx, noteFiles, args.sizes) : [];
  const scenes = sceneFiles.length ? await runScenes(ctx, sceneFiles) : [];
  const audios = audioFiles.length ? await runAudio(ctx, audioFiles) : [];

  const markdown = buildMarkdown({ ctx, sizes: args.sizes, notes, scenes, audios, startedAt });
  const outPath = resolve(args.out);
  writeResultsMd(outPath, markdown);

  const scored = notes.filter((c) => !c.error && c.expected !== null);
  const correct = scored.filter((c) => c.predicted === c.expected).length;
  const spend = [...notes, ...scenes, ...audios].reduce((s, c) => s + (c.costUsd ?? 0), 0);
  console.log(`\nDone: notes ${correct}/${scored.length} correct, report -> ${outPath}`);
  console.log(`Estimated spend: $${spend.toFixed(spend >= 1 ? 4 : 6)}`);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
