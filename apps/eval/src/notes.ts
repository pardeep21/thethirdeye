// Test 1 — notes: identify Indian rupee denominations from images.
// Each image is sent once per requested size (longest side, downscale only)
// with a strict JSON-only prompt; the answer is compared to the filename.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chatCompletions, estimateVisionCost } from "./client.js";
import type { NoteCall, RunContext } from "./types.js";

export const DENOMINATIONS = [10, 20, 50, 100, 200, 500];

const NOTES_PROMPT = [
  "You are identifying an Indian rupee banknote in this photo.",
  'Return ONLY a JSON object, no other text: {"denomination": <10, 20, 50, 100, 200 or 500, or null if no note is visible>, "confidence": <0 to 1>, "note_visible": <true or false>}.',
  'If no note is visible, return exactly {"denomination": null, "confidence": 0, "note_visible": false}.',
].join(" ");

/** Filenames look like <value>_<n>.jpg; anything else yields null (reported, not scored). */
export function parseExpected(filename: string): number | null {
  const m = basename(filename).match(/^(\d+)_/);
  if (!m) return null;
  const v = Number(m[1]);
  return DENOMINATIONS.includes(v) ? v : null;
}

export function parseNoteJson(text: string): {
  denomination: number | null;
  confidence: number | null;
  noteVisible: boolean | null;
} {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        obj = null;
      }
    }
  }
  if (!obj) return { denomination: null, confidence: null, noteVisible: null };
  const d = obj.denomination;
  const denomination =
    typeof d === "number" && DENOMINATIONS.includes(d) ? d : null;
  const c = obj.confidence;
  const confidence = typeof c === "number" && c >= 0 && c <= 1 ? c : null;
  const nv = obj.note_visible;
  return { denomination, confidence, noteVisible: typeof nv === "boolean" ? nv : null };
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
  ctx: RunContext,
  files: string[],
  sizes: number[]
): Promise<NoteCall[]> {
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
        const dataUrl = `data:image/jpeg;base64,${data.toString("base64")}`;
        const { text, usage, latencyMs, attempts } = await chatCompletions(
          ctx,
          NOTES_PROMPT,
          dataUrl,
          { maxTokens: 150, jsonMode: true, label }
        );
        const { denomination, confidence, noteVisible } = parseNoteJson(text);
        const ok =
          expected !== null &&
          denomination !== null &&
          denomination === expected;
        console.log(
          `  -> predicted ${denomination ?? "null"} (conf ${confidence ?? "?"}, visible ${noteVisible ?? "?"}) ${ok ? "OK" : "WRONG"} ${latencyMs}ms`
        );
        results.push({
          test: "notes",
          file: name,
          model: ctx.visionModel,
          imageSize: `${size}px`,
          latencyMs,
          attempts,
          usage,
          costUsd: estimateVisionCost(ctx.visionModel, usage),
          actualDims: `${info.width}x${info.height}`,
          expected,
          predicted: denomination,
          confidence,
          noteVisible,
          raw: text.slice(0, 500),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  -> ERROR: ${message}`);
        results.push({
          test: "notes",
          file: name,
          model: ctx.visionModel,
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
