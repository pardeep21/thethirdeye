// Test 1 — notes: run a server VisionTriage provider over
// data/notes/<label>_*.jpg and score against the label's leading digits
// (supports 10_1.jpg and 500_new_front_03.jpg). Sequential, one size at a time.
// Every OpenAI-compat call logs raw request/response to debug/<file>_<size>.json.

import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters, type NamedTriage, type ProviderName } from "@thethirdeye/server/adapters";
import { estimateVisionCost } from "./client.js";
import type { NoteCall, TokenUsage } from "./types.js";

export const DENOMINATIONS = [10, 20, 50, 100, 200, 500];

/** Raw-call debug dir: EVAL_DEBUG_DIR or apps/eval/debug/. */
export function debugDirFromEnv(): string {
  if (process.env.EVAL_DEBUG_DIR) return process.env.EVAL_DEBUG_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "debug");
}

export function parseExpected(filename: string): number | null {
  const m = basename(filename).match(/^(\d+)/);
  if (!m) return null;
  const v = Number(m[1]);
  return DENOMINATIONS.includes(v) ? v : null;
}

export function debugLabelFor(filename: string, size: number): string {
  return `${basename(filename, extname(filename))}_${size}`;
}

async function loadSharp(): Promise<typeof import("sharp")> {
  try {
    return (await import("sharp")).default;
  } catch {
    throw new Error(
      "The notes test needs the 'sharp' package for resizing. Run: npm install"
    );
  }
}

function usageAndCost(
  triage: NamedTriage,
  provider: ProviderName
): { usage: TokenUsage | undefined; costUsd: number | undefined } {
  const last = triage.getLastUsage();
  const usage = last
    ? {
        promptTokens: last.promptTokens,
        completionTokens: last.completionTokens,
        totalTokens: last.promptTokens + last.completionTokens,
      }
    : undefined;
  // Meta rates are the only ones we know; other providers report latency/accuracy only.
  const costUsd = provider === "meta" ? estimateVisionCost(triage.name, usage) : undefined;
  return { usage, costUsd };
}

export async function runNotes(
  files: string[],
  sizes: number[],
  provider: ProviderName,
  triageOverride?: NamedTriage
): Promise<NoteCall[]> {
  const { triage } = triageOverride ? { triage: triageOverride } : createAdapters(provider, { debugDir: debugDirFromEnv() });
  const sharp = await loadSharp();
  const results: NoteCall[] = [];
  for (const size of sizes) {
    for (const file of files) {
      const name = basename(file);
      const expected = parseExpected(name);
      const label = `${name} @ ${size}px`;
      console.log(`[notes] ${label} (expected ${expected ?? "?"}) ...`);
      try {
        const { data, info } = await sharp(readFileSync(file))
          .rotate() // honor EXIF orientation from phone photos
          .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer({ resolveWithObject: true });
        const start = Date.now();
        let result;
        try {
          result = await triage.triage(data, debugLabelFor(name, size));
        } catch (err) {
          // Failed calls still consumed tokens: record usage + cost, not $0.
          const message = err instanceof Error ? err.message : String(err);
          const latencyMs = Date.now() - start;
          const { usage, costUsd } = usageAndCost(triage, provider);
          console.log(`  -> ERROR: ${message} (${latencyMs}ms)`);
          results.push({
            test: "notes",
            file: name,
            model: triage.name,
            imageSize: `${size}px`,
            latencyMs,
            attempts: 1,
            usage,
            costUsd,
            actualDims: `${info.width}x${info.height}`,
            expected,
            predicted: null,
            confidence: null,
            noteVisible: null,
            raw: "",
            error: message,
          });
          continue;
        }
        const latencyMs = Date.now() - start;
        const top = result.notes[0];
        const predicted = top?.denomination ?? null;
        const confidence = top?.confidence ?? null;
        const ok = expected !== null && predicted !== null && predicted === expected;
        console.log(
          `  -> predicted ${predicted ?? "null"} (conf ${confidence ?? "?"}) ${ok ? "OK" : "WRONG"} ${latencyMs}ms`
        );
        const { usage, costUsd } = usageAndCost(triage, provider);
        results.push({
          test: "notes",
          file: name,
          model: triage.name,
          imageSize: `${size}px`,
          latencyMs,
          attempts: 1,
          usage,
          costUsd,
          actualDims: `${info.width}x${info.height}`,
          expected,
          predicted,
          confidence,
          noteVisible: predicted !== null,
          raw: JSON.stringify(result).slice(0, 500),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  -> ERROR: ${message}`);
        results.push({
          test: "notes",
          file: name,
          model: triage.name,
          imageSize: `${size}px`,
          latencyMs: 0,
          attempts: 1,
          actualDims: "n/a",
          expected,
          predicted: null,
          confidence: null,
          noteVisible: null,
          raw: "",
          error: message,
        });
      }
    }
  }
  return results;
}
