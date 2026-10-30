// Test 1 — notes: run a server VisionTriage provider over
// data/notes/<label>_*.jpg and score against the label's leading digits
// (supports 10_1.jpg and 500_new_front_03.jpg). Sequential, one size at a time.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createAdapters, type ProviderName } from "@eyesmart/server/adapters";
import { estimateVisionCost } from "./client.js";
import type { NoteCall } from "./types.js";

export const DENOMINATIONS = [10, 20, 50, 100, 200, 500];

export function parseExpected(filename: string): number | null {
  const m = basename(filename).match(/^(\d+)/);
  if (!m) return null;
  const v = Number(m[1]);
  return DENOMINATIONS.includes(v) ? v : null;
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

export async function runNotes(
  files: string[],
  sizes: number[],
  provider: ProviderName
): Promise<NoteCall[]> {
  const { triage } = createAdapters(provider);
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
        const result = await triage.triage(data);
        const latencyMs = Date.now() - start;
        const top = result.notes[0];
        const predicted = top?.denomination ?? null;
        const confidence = top?.confidence ?? null;
        const ok = expected !== null && predicted !== null && predicted === expected;
        console.log(
          `  -> predicted ${predicted ?? "null"} (conf ${confidence ?? "?"}) ${ok ? "OK" : "WRONG"} ${latencyMs}ms`
        );
        const last = triage.getLastUsage();
        const usage = last
          ? {
              promptTokens: last.promptTokens,
              completionTokens: last.completionTokens,
              totalTokens: last.promptTokens + last.completionTokens,
            }
          : undefined;
        results.push({
          test: "notes",
          file: name,
          model: triage.name,
          imageSize: `${size}px`,
          latencyMs,
          attempts: 1,
          usage,
          // Meta rates are the only ones we know; other providers report latency/accuracy only.
          costUsd: provider === "meta" ? estimateVisionCost(triage.name, usage) : undefined,
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
