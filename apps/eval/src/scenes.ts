// Test 2 — scenes: short shop-counter descriptions focused on people.
// Sent at original size; never identifies anyone by name.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { chatCompletions, estimateVisionCost } from "./client.js";
import type { RunContext, SceneCall } from "./types.js";

const SCENES_PROMPT = [
  "Describe this shop photo in under 12 words.",
  "Focus on people: how many, rough position (left/center/right, near/far),",
  "approximate age/gender, and what they are doing.",
  "Never identify anyone by name.",
  "Reply with only the description, nothing else.",
].join(" ");

function mimeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

async function dimsOf(buf: Buffer): Promise<string> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    return meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown";
  } catch {
    return "unknown";
  }
}

export async function runScenes(
  ctx: RunContext,
  files: string[]
): Promise<SceneCall[]> {
  const results: SceneCall[] = [];
  for (const file of files) {
    const name = basename(file);
    console.log(`[scenes] ${name} ...`);
    try {
      const buf = readFileSync(file);
      const dims = await dimsOf(buf);
      const dataUrl = `data:${mimeFor(name)};base64,${buf.toString("base64")}`;
      const { text, usage, latencyMs, attempts } = await chatCompletions(
        ctx,
        SCENES_PROMPT,
        dataUrl,
        { maxTokens: 80, jsonMode: false, label: name }
      );
      const description = text.trim();
      const words = description ? description.split(/\s+/).length : 0;
      console.log(`  -> "${description}" (${dims}, ${words} words, ${latencyMs}ms)`);
      results.push({
        test: "scenes",
        file: name,
        model: ctx.visionModel,
        imageSize: `original (${dims})`,
        latencyMs,
        attempts,
        usage,
        costUsd: estimateVisionCost(ctx.visionModel, usage),
        description,
        words,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  -> ERROR: ${message}`);
      results.push({
        test: "scenes",
        file: name,
        model: ctx.visionModel,
        imageSize: "original",
        latencyMs: 0,
        attempts: 1,
        description: "",
        words: 0,
        error: message,
      });
    }
  }
  return results;
}
