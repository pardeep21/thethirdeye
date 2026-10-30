#!/usr/bin/env node
// thethirdeye-spike: benchmark vision + transcription for a blind shopkeeper's
// assistant. The notes test runs any server VisionTriage provider over
// data/notes/<label>_*.jpg; scenes/audio still use the direct Meta client.
//
// Usage:
//   thethirdeye-spike [notes|scenes|audio|all] [--provider mock] [--data ./data]
//                  [--out ./results.md] [--sizes 512,1024] [--limit N]

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { providerFromEnv, type ProviderName } from "@thethirdeye/server/adapters";
import { getConfig, loadDotEnv } from "./client.js";
import { runNotes } from "./notes.js";
import { runScenes } from "./scenes.js";
import { runAudio } from "./audio.js";
import { buildMarkdown, writeResultsMd } from "./report.js";
import type { TestName } from "./types.js";

const PROVIDERS: ProviderName[] = ["mock", "meta", "openrouter", "openai", "local"];

interface Args {
  test: TestName | "all";
  provider: ProviderName;
  data: string;
  out: string;
  sizes: number[];
  limit: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    test: "all",
    provider: providerFromEnv(),
    data: "./data",
    out: "./results.md",
    sizes: [512, 1024],
    limit: 0,
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--data") args.data = argv[++i] ?? args.data;
    else if (a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--provider") {
      const v = (argv[++i] ?? "").toLowerCase();
      if (!PROVIDERS.includes(v as ProviderName)) {
        throw new Error(`Unknown provider: ${v} (expected ${PROVIDERS.join("|")})`);
      }
      args.provider = v as ProviderName;
    } else if (a === "--sizes") {
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
    "thethirdeye-spike - benchmark for a blind shopkeeper's assistant",
    "",
    "Usage: thethirdeye-spike [notes|scenes|audio|all] [options]",
    "",
    "Options:",
    "  --provider NAME  notes triage provider: mock|meta|openrouter|openai|local",
    "                   (default: PROVIDER env, else mock)",
    "  --data DIR       input root (default ./data; expects notes/, scenes/, audio/)",
    "  --out FILE       report path (default ./results.md)",
    "  --sizes LIST     notes resize sizes, longest side px (default 512,1024)",
    "  --limit N        max files per test, 0 = all (default 0; use for cheap smoke runs)",
    "  --help           this text",
    "",
    "Notes labels: leading digits of data/notes/<label>_*.jpg (10_1.jpg, 500_new_front_03.jpg).",
    "Keys per provider: META_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY (see ../server/.env.example).",
    "Scenes/audio still use the direct Meta client (META_API_KEY required).",
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
  loadDotEnv(process.cwd());
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const startedAt = new Date();
  console.log(`thethirdeye-spike: notes provider=${args.provider}`);

  const data = resolve(args.data);
  const want = (t: TestName) => args.test === "all" || args.test === t;
  const applyLimit = (files: string[]) => (args.limit > 0 ? files.slice(0, args.limit) : files);

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
        `(needs notes/<label>_*.jpg, scenes/*, audio/*).`
    );
  }

  // The direct Meta client (scenes/audio) needs a key; provider notes do not.
  const ctx =
    sceneFiles.length > 0 || audioFiles.length > 0 ? getConfig(args.limit) : undefined;

  // Sequential on purpose: one call at a time, in file order.
  const notes = noteFiles.length ? await runNotes(noteFiles, args.sizes, args.provider) : [];
  const scenes = sceneFiles.length > 0 && ctx ? await runScenes(ctx, sceneFiles) : [];
  const audios = audioFiles.length > 0 && ctx ? await runAudio(ctx, audioFiles) : [];

  const runInfo = [
    `Notes triage: \`${notes[0]?.model ?? "not run"}\` (provider ${args.provider})`,
    ctx
      ? `Direct Meta client: vision \`${ctx.visionModel}\`, asr \`${ctx.asrModel}\` via \`${ctx.baseUrl}\``
      : "Direct Meta client: not used (no scenes/audio files)",
  ];
  const markdown = buildMarkdown({ runInfo, sizes: args.sizes, notes, scenes, audios, startedAt });
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
