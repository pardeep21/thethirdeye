// Chaos provider tests. No network, no real latency: fault rates are set
// per test and latency is disabled (or capped at a few ms) so the suite
// stays fast while proving each fault shape and seeded determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentInput } from "./agent.js";
import { MockAgentBrain } from "./agent.js";
import { MockObjectFinder, MockVisionAnswer, MockVisionTriage } from "./mocks.js";
import { createAdapters } from "./factory.js";
import { isMockMember } from "./fallback.js";
import {
  ChaosAgentBrain,
  ChaosAnswer,
  ChaosFinder,
  ChaosTriage,
  chaosConfigFromEnv,
  makeChaosRng,
  wrapAdaptersWithChaos,
  type ChaosConfig,
} from "./chaos.js";
import { emptyScene } from "../session.js";

const CLEAN: ChaosConfig = {
  seed: 1,
  latencyP: 0,
  latencyMaxMs: 0,
  errorP: 0,
  invalidP: 0,
  nullSayP: 0,
  emptyP: 0,
};

function withFaults(partial: Partial<ChaosConfig>): ChaosConfig {
  return { ...CLEAN, ...partial };
}

function agentInput(): AgentInput {
  return { history: [], utterance: "ki hai saamne", scene: emptyScene(), lang: "pa", script: "latin" };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("chaos config defaults and env overrides", () => {
  withEnv(
    {
      CHAOS_SEED: undefined,
      CHAOS_LATENCY_P: undefined,
      CHAOS_LATENCY_MAX_MS: undefined,
      CHAOS_ERROR_P: undefined,
      CHAOS_INVALID_P: undefined,
      CHAOS_NULL_SAY_P: undefined,
      CHAOS_EMPTY_P: undefined,
    },
    () => {
      const cfg = chaosConfigFromEnv();
      assert.equal(cfg.latencyP, 0.25);
      assert.equal(cfg.latencyMaxMs, 8000);
      assert.equal(cfg.errorP, 0.08);
      assert.equal(cfg.invalidP, 0.08);
      assert.equal(cfg.nullSayP, 0.05);
      assert.equal(cfg.emptyP, 0.05);
    }
  );
  withEnv(
    {
      CHAOS_SEED: "42",
      CHAOS_LATENCY_P: "0.5",
      CHAOS_LATENCY_MAX_MS: "100",
      CHAOS_ERROR_P: "0.1",
      CHAOS_INVALID_P: "0.2",
      CHAOS_NULL_SAY_P: "0.3",
      CHAOS_EMPTY_P: "0.4",
    },
    () => {
      assert.deepEqual(chaosConfigFromEnv(), {
        seed: 42,
        latencyP: 0.5,
        latencyMaxMs: 100,
        errorP: 0.1,
        invalidP: 0.2,
        nullSayP: 0.3,
        emptyP: 0.4,
      });
    }
  );
});

test("chaos config rejects out-of-range values", () => {
  withEnv({ CHAOS_ERROR_P: "2" }, () => assert.throws(() => chaosConfigFromEnv(), /CHAOS_ERROR_P/));
  withEnv({ CHAOS_INVALID_P: "-0.1" }, () => assert.throws(() => chaosConfigFromEnv(), /CHAOS_INVALID_P/));
  withEnv({ CHAOS_LATENCY_P: "nope" }, () => assert.throws(() => chaosConfigFromEnv(), /CHAOS_LATENCY_P/));
  withEnv({ CHAOS_LATENCY_MAX_MS: "-1" }, () =>
    assert.throws(() => chaosConfigFromEnv(), /CHAOS_LATENCY_MAX_MS/)
  );
  withEnv({ CHAOS_SEED: "xyz" }, () => assert.throws(() => chaosConfigFromEnv(), /CHAOS_SEED/));
});

test("chaos rng replays per seed+stream", () => {
  const a = makeChaosRng(7, "agent");
  const b = makeChaosRng(7, "agent");
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
  const other = makeChaosRng(7, "triage");
  assert.notDeepEqual(
    Array.from({ length: 10 }, () => other()),
    seqA
  );
});

test("chaos agent with zero rates delegates to the inner brain", async () => {
  const inner = new MockAgentBrain([{ say: "hello", positions: [], actions: [] }]);
  const chaos = new ChaosAgentBrain(inner, CLEAN);
  const out = await chaos.respond(agentInput());
  assert.equal(out.say, "hello");
  assert.equal(inner.inputs.length, 1);
});

test("chaos agent error rate throws a network-style error", async () => {
  const chaos = new ChaosAgentBrain(new MockAgentBrain(), withFaults({ errorP: 1 }));
  await assert.rejects(() => chaos.respond(agentInput()), /network error/);
});

test("chaos agent invalid rate throws a malformed-JSON error", async () => {
  const chaos = new ChaosAgentBrain(new MockAgentBrain(), withFaults({ invalidP: 1 }));
  await assert.rejects(() => chaos.respond(agentInput()), /not JSON/);
});

test("chaos agent null-say returns the action-only shape", async () => {
  const chaos = new ChaosAgentBrain(new MockAgentBrain(), withFaults({ nullSayP: 1 }));
  const out = await chaos.respond(agentInput());
  assert.deepEqual(out, { say: null, positions: [], actions: [] });
});

test("chaos agent empty rate returns an empty say", async () => {
  const chaos = new ChaosAgentBrain(new MockAgentBrain(), withFaults({ emptyP: 1 }));
  const out = await chaos.respond(agentInput());
  assert.deepEqual(out, { say: "", positions: [], actions: [] });
});

test("chaos agent latency keeps the call working", async () => {
  const chaos = new ChaosAgentBrain(
    new MockAgentBrain([{ say: "slow hello", positions: [], actions: [] }]),
    withFaults({ latencyP: 1, latencyMaxMs: 20 })
  );
  const out = await chaos.respond(agentInput());
  assert.equal(out.say, "slow hello");
});

async function classify(agent: ChaosAgentBrain): Promise<string> {
  try {
    const out = await agent.respond(agentInput());
    if (out.say === null) return "null";
    if (out.say === "") return "empty";
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

test("chaos agent replays the same fault sequence for one seed", async () => {
  const cfg = withFaults({ seed: 1234, errorP: 0.2, invalidP: 0.2, nullSayP: 0.2, emptyP: 0.2 });
  const a = new ChaosAgentBrain(new MockAgentBrain(), cfg);
  const b = new ChaosAgentBrain(new MockAgentBrain(), cfg);
  const seqA: string[] = [];
  const seqB: string[] = [];
  for (let i = 0; i < 25; i++) {
    seqA.push(await classify(a));
    seqB.push(await classify(b));
  }
  assert.deepEqual(seqA, seqB);
  // Mixed rates must actually fault: not every call is clean.
  assert.ok(seqA.some((s) => s !== "ok"), "seeded faults should fire");
});

test("chaos triage delegates clean and faults on demand", async () => {
  const inner = new MockVisionTriage([{ notes: [{ denomination: 100, confidence: 0.8 }], people: [] }]);
  const clean = new ChaosTriage(inner, CLEAN);
  assert.equal(clean.name, "chaos:mock");
  const r = await clean.triage(Buffer.alloc(0));
  assert.equal(r.notes[0]?.denomination, 100);

  const err = new ChaosTriage(new MockVisionTriage(), withFaults({ errorP: 1 }));
  await assert.rejects(() => err.triage(Buffer.alloc(0)), /network error/);
  await assert.rejects(() => err.triageScene(Buffer.alloc(0)), /network error/);

  const bad = new ChaosTriage(new MockVisionTriage(), withFaults({ invalidP: 1 }));
  await assert.rejects(() => bad.triage(Buffer.alloc(0)), /not JSON/);
  await assert.rejects(() => bad.triageScene(Buffer.alloc(0)), /not JSON/);
});

test("chaos answer returns empty text or throws on demand", async () => {
  const empty = new ChaosAnswer(new MockVisionAnswer(), withFaults({ emptyP: 1 }));
  assert.equal(await empty.describe(Buffer.alloc(0), "q"), "");
  assert.equal(await empty.read(Buffer.alloc(0)), "");
  const err = new ChaosAnswer(new MockVisionAnswer(), withFaults({ errorP: 1 }));
  await assert.rejects(() => err.describe(Buffer.alloc(0), "q"), /network error/);
  await assert.rejects(() => err.read(Buffer.alloc(0)), /network error/);
});

test("chaos finder throws on demand and delegates clean", async () => {
  const err = new ChaosFinder(new MockObjectFinder(), withFaults({ errorP: 1 }));
  await assert.rejects(() => err.locate(Buffer.alloc(0), "Kainchi"), /network error/);
  await assert.rejects(() => err.find(Buffer.alloc(0), "Kainchi"), /network error/);
  const clean = new ChaosFinder(new MockObjectFinder(), CLEAN);
  assert.equal(await clean.locate(Buffer.alloc(0), "Kainchi"), null);
  assert.equal((await clean.find(Buffer.alloc(0), "Kainchi")).length, 1);
});

test("wrapAdaptersWithChaos keeps stt/faces and wraps the models", () => {
  withEnv({ PROVIDER: "mock" }, () => {
    const set = createAdapters();
    const wrapped = wrapAdaptersWithChaos(set, CLEAN);
    assert.equal(wrapped.stt, set.stt);
    assert.equal(wrapped.faces, set.faces);
    assert.ok(wrapped.triage instanceof ChaosTriage);
    assert.ok(wrapped.answer instanceof ChaosAnswer);
    assert.ok(wrapped.finder instanceof ChaosFinder);
    assert.ok(wrapped.agent instanceof ChaosAgentBrain);
  });
});

test("factory builds the chaos provider without keys", async () => {
  withEnv(
    {
      PROVIDER: "chaos",
      CHAOS_SEED: "9",
      CHAOS_LATENCY_P: "0",
      CHAOS_ERROR_P: "0",
      CHAOS_INVALID_P: "0",
      CHAOS_NULL_SAY_P: "0",
      CHAOS_EMPTY_P: "0",
    },
    () => {
      const set = createAdapters();
      assert.equal(set.triage.name, "chaos:mock");
    }
  );
  // Respond outside withEnv via explicit zero-fault wrap (same wiring).
  withEnv({ PROVIDER: "mock" }, () => {
    const set = wrapAdaptersWithChaos(createAdapters(), CLEAN);
    assert.ok(set.triage.name.startsWith("chaos:"));
  });
});

test("chaos provider cannot chain a fallback (like mock)", () => {
  withEnv(
    { PROVIDER: "chaos", AGENT_FALLBACK_PROVIDER: "openai", AGENT_FALLBACK_API_KEY: "x" },
    () => assert.throws(() => createAdapters(), /cannot chain the chaos provider/)
  );
  withEnv(
    { PROVIDER: "chaos", TRIAGE_FALLBACK_PROVIDER: "openai", TRIAGE_FALLBACK_API_KEY: "x" },
    () => assert.throws(() => createAdapters(), /cannot chain the chaos provider/)
  );
});

test("chaos members are never chainable", () => {
  assert.equal(isMockMember("chaos", {}), true);
  assert.equal(isMockMember("other", new ChaosAgentBrain(new MockAgentBrain(), CLEAN)), true);
  assert.equal(isMockMember("other", new ChaosTriage(new MockVisionTriage(), CLEAN)), true);
});
