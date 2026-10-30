// Provider factory: PROVIDER=mock|meta|openrouter|openai|local.
// Only mock works without keys; the rest build the OpenAI-compatible client
// from env. Finder/STT/faces stay mock until their real adapters land
// (M4 SAM/STT wiring, M5 faces).
import type {
  AdapterSet,
  ProviderName,
} from "./index.js";
import { providerFromEnv } from "./index.js";

export { providerFromEnv };
export type * from "./index.js";
import {
  MockObjectFinder,
  MockSpeechToText,
  MockVisionAnswer,
  MockVisionTriage,
} from "./mocks.js";
import { createFaceMatcher } from "../faces/index.js";
import { PeopleStore } from "../faces/store.js";
import { OpenAICompatAnswer, OpenAICompatTriage } from "./openaiCompat.js";

function needEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for this provider`);
  return v;
}

export interface AdapterDeps {
  store?: PeopleStore;
}

export function createAdapters(
  provider: ProviderName = providerFromEnv(),
  deps?: AdapterDeps
): AdapterSet {
  // Faces are always store-backed (even for mock) so enrollment works in
  // every mode; without an explicit store the data is memory-only.
  const faces = createFaceMatcher(deps?.store ?? new PeopleStore(":memory:"));
  const mocks = {
    finder: new MockObjectFinder(),
    stt: new MockSpeechToText(),
    faces,
  };
  switch (provider) {
    case "mock":
      return { triage: new MockVisionTriage(), answer: new MockVisionAnswer(), ...mocks };
    case "meta":
      return {
        triage: new OpenAICompatTriage({
          baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
          model: process.env.META_MODEL ?? "muse-spark-1.3",
          apiKey: needEnv("META_API_KEY"),
        }),
        answer: new OpenAICompatAnswer({
          baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
          model: process.env.META_MODEL ?? "muse-spark-1.3",
          apiKey: needEnv("META_API_KEY"),
        }),
        ...mocks,
      };
    case "openrouter":
      return {
        triage: new OpenAICompatTriage({
          baseURL: "https://openrouter.ai/api/v1",
          model: process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3",
          apiKey: needEnv("OPENROUTER_API_KEY"),
        }),
        answer: new OpenAICompatAnswer({
          baseURL: "https://openrouter.ai/api/v1",
          model: process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3",
          apiKey: needEnv("OPENROUTER_API_KEY"),
        }),
        ...mocks,
      };
    case "openai":
    case "local": {
      const baseURL =
        process.env.OPENAI_BASE_URL ?? (provider === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
      const model = process.env.OPENAI_MODEL ?? (provider === "local" ? "muse-glimmer" : "gpt-4o-mini");
      const apiKey = process.env.OPENAI_API_KEY ?? (provider === "local" ? "ollama" : needEnv("OPENAI_API_KEY"));
      return {
        triage: new OpenAICompatTriage({ baseURL, model, apiKey }),
        answer: new OpenAICompatAnswer({ baseURL, model, apiKey }),
        ...mocks,
      };
    }
  }
}
