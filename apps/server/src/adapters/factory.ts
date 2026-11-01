// Provider factory: PROVIDER=mock|meta|openrouter|openai|local.
// Only mock works without keys; the rest build the OpenAI-compatible client
// from env. Finder/STT/faces stay mock until their real adapters land
// (M4 SAM/STT wiring, M5 faces).
import type {
  AdapterSet,
  ProviderName,
} from "./index.js";
import { providerFromEnv } from "./index.js";
import { triageMaxTokensFromEnv } from "./openaiCompat.js";

export { providerFromEnv };
export type * from "./index.js";
import {
  MockObjectFinder,
  MockSpeechToText,
  MockVisionAnswer,
  MockVisionTriage,
} from "./mocks.js";
import { createFaceMatcher } from "../faces/index.js";
import type { AgentBrain } from "./agent.js";
import {
  agentDebugDirFromEnv,
  agentImagePxFromEnv,
  agentMaxTokensFromEnv,
  agentModelFromEnv,
  agentReasoningEffortFromEnv,
  agentToolModeFromEnv,
  MockAgentBrain,
  OpenAICompatAgentBrain,
} from "./agent.js";
import { PeopleStore } from "../faces/store.js";
import { OpenAICompatAnswer, OpenAICompatTriage } from "./openaiCompat.js";

function needEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for this provider`);
  return v;
}

export interface AdapterDeps {
  store?: PeopleStore;
  /** When set, OpenAI-compat triage writes raw request/response logs here. */
  debugDir?: string;
}

/**
 * Meta reasoning effort for triage (dev.meta.ai/docs/reasoning): minimal is
 * the lowest level Muse Spark supports ("none" returns HTTP 400).
 * META_REASONING_EFFORT overrides; "off" omits the parameter.
 */
export function metaReasoningEffortFromEnv(): string | undefined {
  const raw = (process.env.META_REASONING_EFFORT ?? "minimal").toLowerCase();
  if (raw === "off" || raw === "unset") return undefined;
  return process.env.META_REASONING_EFFORT ?? "minimal";
}

function createAgentBrain(provider: ProviderName, deps?: AdapterDeps): AgentBrain {
  if (provider === "mock") return new MockAgentBrain();
  const common = {
    maxTokens: agentMaxTokensFromEnv(),
    reasoningEffort: agentReasoningEffortFromEnv(),
    imagePx: agentImagePxFromEnv(),
    toolMode: agentToolModeFromEnv(),
    debugDir: deps?.debugDir ?? agentDebugDirFromEnv(),
  };
  switch (provider) {
    case "meta":
      return new OpenAICompatAgentBrain({
        baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
        model: agentModelFromEnv(process.env.META_MODEL ?? "muse-spark-1.3"),
        apiKey: needEnv("META_API_KEY"),
        ...common,
      });
    case "openrouter":
      return new OpenAICompatAgentBrain({
        baseURL: "https://openrouter.ai/api/v1",
        model: agentModelFromEnv(process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3"),
        apiKey: needEnv("OPENROUTER_API_KEY"),
        ...common,
      });
    case "openai":
    case "local": {
      const baseURL =
        process.env.OPENAI_BASE_URL ?? (provider === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
      const model = agentModelFromEnv(
        process.env.OPENAI_MODEL ?? (provider === "local" ? "muse-glimmer" : "gpt-4o-mini")
      );
      const apiKey = process.env.OPENAI_API_KEY ?? (provider === "local" ? "ollama" : needEnv("OPENAI_API_KEY"));
      return new OpenAICompatAgentBrain({ baseURL, model, apiKey, ...common });
    }
  }
}

export function createAdapters(
  provider: ProviderName = providerFromEnv(),
  deps?: AdapterDeps
): AdapterSet {
  // Faces are always store-backed (even for mock) so enrollment works in
  // every mode; without an explicit store the data is memory-only.
  const faces = createFaceMatcher(deps?.store ?? new PeopleStore(":memory:"));
  const agent = createAgentBrain(provider, deps);
  const mocks = {
    finder: new MockObjectFinder(),
    stt: new MockSpeechToText(),
    faces,
    agent,
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
          maxTokens: triageMaxTokensFromEnv(),
          reasoningEffort: metaReasoningEffortFromEnv(),
          debugDir: deps?.debugDir,
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
          maxTokens: triageMaxTokensFromEnv(),
          debugDir: deps?.debugDir,
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
        triage: new OpenAICompatTriage({ baseURL, model, apiKey, maxTokens: triageMaxTokensFromEnv(), debugDir: deps?.debugDir }),
        answer: new OpenAICompatAnswer({ baseURL, model, apiKey }),
        ...mocks,
      };
    }
  }
}
