// Shared record types for the thethirdeye-spike benchmark.

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export type TestName = "notes" | "scenes" | "audio";

export interface CallRecord {
  test: TestName;
  /** Basename of the input file. */
  file: string;
  /** Exact model ID sent to the API. */
  model: string;
  /** Requested image size ("512px", "1024px", "original") or "n/a" for audio. */
  imageSize: string;
  /** End-to-end ms of the successful HTTP round-trip (excludes backoff). */
  latencyMs: number;
  /** HTTP attempts for this call (1 when no 429 retry happened). */
  attempts: number;
  usage?: TokenUsage;
  /** Estimated USD (docs pricing, not billed cost). */
  costUsd?: number;
  /** Set when the call failed; latencyMs is then the last attempt's time. */
  error?: string;
}

export interface NoteCall extends CallRecord {
  test: "notes";
  /** Actual pixel dims after resize, e.g. "512x384". */
  actualDims: string;
  expected: number | null;
  predicted: number | null;
  confidence: number | null;
  noteVisible: boolean | null;
  raw: string;
}

export interface SceneCall extends CallRecord {
  test: "scenes";
  description: string;
  words: number;
}

export interface AudioCall extends CallRecord {
  test: "audio";
  transcript: string;
  durationSec?: number;
}

export interface RunContext {
  apiKey: string;
  baseUrl: string;
  visionModel: string;
  asrModel: string;
  /** Max files per test (0 = no limit). */
  limit: number;
}
