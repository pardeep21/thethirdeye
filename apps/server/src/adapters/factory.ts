// Provider factory: PROVIDER=mock|meta|openrouter|openai|local.
// Only mock works without keys; the rest build the OpenAI-compatible client
// from env. STT stays mock until its real adapter lands; the finder is
// Spark-backed for real providers (07) and scriptable-mock for mock.
import type {
  AdapterSet,
  NamedTriage,
  ObjectFinder,
  ProviderName,
} from "./index.js";
import { providerFromEnv } from "./index.js";
import {
  findMaxTokensFromEnv,
  sceneMaxTokensFromEnv,
  triageMaxTokensFromEnv,
} from "./openaiCompat.js";

export { providerFromEnv };
export type * from "./index.js";
import {
  MockObjectFinder,
  MockSpeechToText,
  MockVisionAnswer,
  MockVisionTriage,
} from "./mocks.js";
import { chaosConfigFromEnv, wrapAdaptersWithChaos } from "./chaos.js";
import { createFaceMatcher } from "../faces/index.js";
import type { FaceEmbedder } from "../faces/embed.js";
import type { AgentBrain, AgentToolMode } from "./agent.js";
import type { AttemptDetails, AttemptOutcome } from "./fallback.js";
import {
  agentFallbackFromEnv,
  FallbackAgentBrain,
  FallbackTriage,
  triageFallbackFromEnv,
} from "./fallback.js";
import {
  agentPrimaryTimeoutFromEnv,
  agentTimeoutFromEnv,
  triagePrimaryTimeoutFromEnv,
  triageTimeoutFromEnv,
} from "../timeouts.js";
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
import { OpenAICompatAnswer, OpenAICompatFinder, OpenAICompatTriage } from "./openaiCompat.js";

function needEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for this provider`);
  return v;
}

export interface AdapterDeps {
  store?: PeopleStore;
  /** Face embedder for recognition (default: the fail-closed stub). */
  embedder?: FaceEmbedder;
  /** When set, OpenAI-compat triage writes raw request/response logs here. */
  debugDir?: string;
  /** Stats sink for fallback-chain attempts (R4 model_attempt outcomes). */
  onModelAttempt?: (provider: string, outcome: AttemptOutcome, details: AttemptDetails) => void;
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

function agentCommonOpts(deps?: AdapterDeps): {
  maxTokens: number;
  reasoningEffort: string | undefined;
  imagePx: number;
  toolMode: AgentToolMode;
  debugDir: string | undefined;
} {
  return {
    maxTokens: agentMaxTokensFromEnv(),
    reasoningEffort: agentReasoningEffortFromEnv(),
    imagePx: agentImagePxFromEnv(),
    toolMode: agentToolModeFromEnv(),
    debugDir: deps?.debugDir ?? agentDebugDirFromEnv(),
  };
}

function createAgentBrain(provider: ProviderName, deps?: AdapterDeps): AgentBrain {
  if (provider === "mock" || provider === "chaos") return new MockAgentBrain();
  const common = agentCommonOpts(deps);
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

/** Endpoint + model + key for the Spark-backed finder (mirrors triage). */
function finderOpts(
  provider: ProviderName,
  deps?: AdapterDeps
): { baseURL: string; model: string; apiKey: string; reasoningEffort?: string; debugDir?: string } {
  const common = { maxTokens: findMaxTokensFromEnv(), debugDir: deps?.debugDir };
  switch (provider) {
    case "meta":
      return {
        baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
        model: process.env.META_MODEL ?? "muse-spark-1.3",
        apiKey: needEnv("META_API_KEY"),
        reasoningEffort: metaReasoningEffortFromEnv(),
        ...common,
      };
    case "openrouter":
      return {
        baseURL: "https://openrouter.ai/api/v1",
        model: process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3",
        apiKey: needEnv("OPENROUTER_API_KEY"),
        ...common,
      };
    case "openai":
    case "local": {
      const baseURL =
        process.env.OPENAI_BASE_URL ?? (provider === "local" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
      const model = process.env.OPENAI_MODEL ?? (provider === "local" ? "muse-glimmer" : "gpt-4o-mini");
      const apiKey = process.env.OPENAI_API_KEY ?? (provider === "local" ? "ollama" : needEnv("OPENAI_API_KEY"));
      return { baseURL, model, apiKey, ...common };
    }
    case "mock":
    case "chaos":
      throw new Error("mock and chaos use MockObjectFinder, never finderOpts");
  }
}

function createFinder(provider: ProviderName, deps?: AdapterDeps): ObjectFinder {
  if (provider === "mock" || provider === "chaos") return new MockObjectFinder();
  return new OpenAICompatFinder(finderOpts(provider, deps));
}

/**
 * Wrap the primary agent brain in a primary+backup chain when
 * AGENT_FALLBACK_PROVIDER is set. Mock can never chain (startup error).
 */
function withAgentFallback(
  primary: AgentBrain,
  provider: ProviderName,
  deps?: AdapterDeps
): AgentBrain {
  const fb = agentFallbackFromEnv();
  if (!fb) return primary;
  if (provider === "mock" || provider === "chaos") {
    throw new Error(`AGENT_FALLBACK_* cannot chain the ${provider} provider`);
  }
  const backup = new OpenAICompatAgentBrain({
    baseURL: fb.baseURL,
    model: fb.model,
    apiKey: fb.apiKey,
    ...agentCommonOpts(deps),
  });
  return new FallbackAgentBrain(
    [
      { provider, impl: primary },
      { provider: fb.provider, impl: backup },
    ],
    {
      primaryMs: agentPrimaryTimeoutFromEnv(),
      totalMs: agentTimeoutFromEnv(),
      record: deps?.onModelAttempt,
    }
  );
}

/**
 * Wrap the primary triage in a primary+backup chain when
 * TRIAGE_FALLBACK_PROVIDER is set. Mock can never chain (startup error).
 */
function withTriageFallback(
  primary: NamedTriage,
  provider: ProviderName,
  deps?: AdapterDeps
): NamedTriage {
  const fb = triageFallbackFromEnv();
  if (!fb) return primary;
  if (provider === "mock" || provider === "chaos") {
    throw new Error(`TRIAGE_FALLBACK_* cannot chain the ${provider} provider`);
  }
  const backup = new OpenAICompatTriage({
    baseURL: fb.baseURL,
    model: fb.model,
    apiKey: fb.apiKey,
    maxTokens: triageMaxTokensFromEnv(),
    sceneMaxTokens: sceneMaxTokensFromEnv(),
    reasoningEffort: fb.provider === "meta" ? metaReasoningEffortFromEnv() : undefined,
    debugDir: deps?.debugDir,
  });
  return new FallbackTriage(
    [
      { provider, impl: primary },
      { provider: fb.provider, impl: backup },
    ],
    {
      primaryMs: triagePrimaryTimeoutFromEnv(),
      totalMs: triageTimeoutFromEnv(),
      record: deps?.onModelAttempt,
    }
  );
}

export function createAdapters(
  provider: ProviderName = providerFromEnv(),
  deps?: AdapterDeps
): AdapterSet {
  // Faces are always store-backed (even for mock) so enrollment works in
  // every mode; without an explicit store the data is memory-only.
  const faces = createFaceMatcher(deps?.store ?? new PeopleStore(":memory:"), deps?.embedder);
  const agent = withAgentFallback(createAgentBrain(provider, deps), provider, deps);
  const mocks = {
    finder: createFinder(provider, deps),
    stt: new MockSpeechToText(),
    faces,
    agent,
  };
  switch (provider) {
    case "mock":
      return {
        triage: withTriageFallback(new MockVisionTriage(), provider, deps),
        answer: new MockVisionAnswer(),
        ...mocks,
      };
    case "chaos":
      // Mock values under seeded faults (R8 soak). STT and faces stay
      // deterministic; the fallback guards above already reject chaining.
      return wrapAdaptersWithChaos(
        {
          triage: withTriageFallback(new MockVisionTriage(), provider, deps),
          answer: new MockVisionAnswer(),
          ...mocks,
        },
        chaosConfigFromEnv()
      );
    case "meta":
      return {
        triage: withTriageFallback(
          new OpenAICompatTriage({
            baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
            model: process.env.META_MODEL ?? "muse-spark-1.3",
            apiKey: needEnv("META_API_KEY"),
            maxTokens: triageMaxTokensFromEnv(),
            sceneMaxTokens: sceneMaxTokensFromEnv(),
            reasoningEffort: metaReasoningEffortFromEnv(),
            debugDir: deps?.debugDir,
          }),
          provider,
          deps
        ),
        answer: new OpenAICompatAnswer({
          baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
          model: process.env.META_MODEL ?? "muse-spark-1.3",
          apiKey: needEnv("META_API_KEY"),
        }),
        ...mocks,
      };
    case "openrouter":
      return {
        triage: withTriageFallback(
          new OpenAICompatTriage({
            baseURL: "https://openrouter.ai/api/v1",
            model: process.env.OPENROUTER_MODEL ?? "meta/muse-spark-1.3",
            apiKey: needEnv("OPENROUTER_API_KEY"),
            maxTokens: triageMaxTokensFromEnv(),
            sceneMaxTokens: sceneMaxTokensFromEnv(),
            debugDir: deps?.debugDir,
          }),
          provider,
          deps
        ),
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
        triage: withTriageFallback(
          new OpenAICompatTriage({
            baseURL,
            model,
            apiKey,
            maxTokens: triageMaxTokensFromEnv(),
            sceneMaxTokens: sceneMaxTokensFromEnv(),
            debugDir: deps?.debugDir,
          }),
          provider,
          deps
        ),
        answer: new OpenAICompatAnswer({ baseURL, model, apiKey }),
        ...mocks,
      };
    }
  }
}
