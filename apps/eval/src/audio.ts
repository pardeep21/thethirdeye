// Test 3 — audio: transcribe voice clips with Muse Voice Transcribe.
// Endpoint: POST /v1/asr/transcribe, multipart with a JSON `request` part and
// an `audio` part. The file endpoint requires mono 16-bit WAV (<=10 min,
// <=32 MB); anything else is attempted as-is and the API error is recorded.

import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fetchWithRetry } from "./client.js";
import type { AudioCall, RunContext } from "./types.js";

/** $0.18 per hour of audio (Meta Model API pricing). */
export const ASR_USD_PER_HOUR = 0.18;

/** Duration from a WAV header (byteRate + data chunk size); undefined if unparseable. */
export function parseWavDuration(buf: Buffer): number | undefined {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
    if (buf.toString("ascii", 8, 12) !== "WAVE") return undefined;
    let offset = 12;
    let byteRate: number | undefined;
    let dataSize: number | undefined;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "fmt " && size >= 16) {
        byteRate = buf.readUInt32LE(offset + 16); // fmt data + 8
      } else if (id === "data") {
        dataSize = size;
      }
      offset += 8 + size + (size % 2);
      if (byteRate && dataSize) break;
    }
    if (!byteRate || !dataSize) return undefined;
    return dataSize / byteRate;
  } catch {
    return undefined;
  }
}

/** Best-effort transcript extraction across plausible response shapes. */
export function extractTranscript(json: unknown): string {
  if (typeof json === "string") return json;
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;
  for (const key of ["transcript", "text"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim()) {
      return (obj[key] as string).trim();
    }
  }
  for (const key of ["turns", "segments", "chunks", "results"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      const parts = arr
        .map((t) => {
          if (typeof t === "string") return t;
          if (t && typeof t === "object") {
            const turn = t as Record<string, unknown>;
            for (const k of ["transcript", "text"]) {
              if (typeof turn[k] === "string") return (turn[k] as string).trim();
            }
            if (Array.isArray(turn.words)) {
              return (turn.words as Array<Record<string, unknown>>)
                .map((w) => String(w.word ?? w.text ?? ""))
                .join(" ")
                .trim();
            }
          }
          return "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
  }
  if (Array.isArray(obj.words)) {
    return (obj.words as Array<Record<string, unknown>>)
      .map((w) => String(w.word ?? w.text ?? ""))
      .join(" ")
      .trim();
  }
  return "";
}

export async function runAudio(
  ctx: RunContext,
  files: string[]
): Promise<AudioCall[]> {
  const results: AudioCall[] = [];
  for (const file of files) {
    const name = basename(file);
    const isWav = extname(name).toLowerCase() === ".wav";
    const bytes = statSync(file).size;
    if (bytes > 32 * 1024 * 1024) {
      const error = `file is ${(bytes / 1024 / 1024).toFixed(1)} MB; API limit is 32 MB`;
      console.log(`[audio] ${name} ... skipped: ${error}`);
      results.push({
        test: "audio",
        file: name,
        model: ctx.asrModel,
        imageSize: "n/a",
        latencyMs: 0,
        attempts: 0,
        transcript: "",
        error,
      });
      continue;
    }
    if (!isWav) {
      console.log(
        `[audio] ${name} ... note: not a .wav file; the API file endpoint ` +
          `expects mono 16-bit WAV (convert: ffmpeg -i input -ac 1 -ar 16000 -c:a pcm_s16le out.wav)`
      );
    } else {
      console.log(`[audio] ${name} ...`);
    }
    try {
      const buf = readFileSync(file);
      const durationSec = isWav ? parseWavDuration(buf) : undefined;
      const request = {
        model: ctx.asrModel,
        audioEncoding: "WAV",
        mode: "PUSH_TO_TALK",
      };
      const form = new FormData();
      form.append(
        "request",
        new Blob([JSON.stringify(request)], { type: "application/json" })
      );
      form.append("audio", new Blob([new Uint8Array(buf)]), name);
      const { res, attempts, latencyMs } = await fetchWithRetry(
        `${ctx.baseUrl}/asr/transcribe`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
          body: form,
        },
        name
      );
      const text = await res.text();
      let transcript = "";
      try {
        transcript = extractTranscript(JSON.parse(text));
      } catch {
        transcript = text.trim();
      }
      const costUsd =
        durationSec !== undefined ? (durationSec / 3600) * ASR_USD_PER_HOUR : undefined;
      console.log(`--- transcript: ${name} (${latencyMs}ms) ---`);
      console.log(transcript || "(empty transcript)");
      results.push({
        test: "audio",
        file: name,
        model: ctx.asrModel,
        imageSize: "n/a",
        latencyMs,
        attempts,
        costUsd,
        transcript,
        durationSec,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  -> ERROR: ${message}`);
      results.push({
        test: "audio",
        file: name,
        model: ctx.asrModel,
        imageSize: "n/a",
        latencyMs: 0,
        attempts: 1,
        transcript: "",
        error: message,
      });
    }
  }
  return results;
}
