// Model adapter layer (MVP.md section 2). Every model sits behind one of
// these interfaces; providers are selected by PROVIDER env (mock-first).
import type { Box, FaceHit, SceneTriage, TriageResult } from "../protocol.js";
import type { AgentBrain } from "./agent.js";

export interface VisionTriage {
  triage(img: Buffer): Promise<TriageResult>;
  /** Look-around call: cash + people with coordinates + scene objects. */
  triageScene(img: Buffer, debugLabel?: string): Promise<SceneTriage>;
} // F1 + F2

export interface VisionAnswer {
  describe(img: Buffer, q: string): Promise<string>; // F3
  read(img: Buffer): Promise<string>;
}

export interface ObjectFinder {
  find(img: Buffer, noun: string): Promise<Box[]>;
} // F3 find

export interface SpeechToText {
  transcribe(audio: Buffer): Promise<string>;
}

export interface FaceMatcher {
  match(img: Buffer): Promise<FaceHit[]>;
} // local

/** VisionTriage plus a display name and last-call usage for eval reports. */
export interface NamedTriage extends VisionTriage {
  readonly name: string;
  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined;
  triage(img: Buffer, debugLabel?: string): Promise<TriageResult>;
}

export interface AdapterSet {
  triage: NamedTriage;
  answer: VisionAnswer;
  finder: ObjectFinder;
  stt: SpeechToText;
  faces: FaceMatcher;
  agent: AgentBrain;
}

export type ProviderName = "mock" | "meta" | "openrouter" | "openai" | "local";

export function providerFromEnv(): ProviderName {
  const raw = (process.env.PROVIDER ?? "mock").toLowerCase();
  if (raw === "mock" || raw === "meta" || raw === "openrouter" || raw === "openai" || raw === "local") {
    return raw;
  }
  throw new Error(`PROVIDER=${raw} unknown (expected mock|meta|openrouter|openai|local)`);
}
