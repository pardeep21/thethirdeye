// FallbackChain tests (R4): scripted fake providers, real timers, no network.
// Primary ok skips the backup; timeouts, 5xx/429 and bad JSON fail over
// inside the total budget; double failures throw (TurnGuard rescues the
// turn); mock never chains; late primary answers are discarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SceneTriage, TriageResult } from "../protocol.js";
import { emptyScene } from "../session.js";
import { TurnGuard } from "../turnGuard.js";
import { DecisionEngine } from "../decision.js";
import { UtteranceStats } from "../stats.js";
import { ModelTimeoutError } from "../timeouts.js";
import type { AgentBrain, AgentInput, AgentOutput } from "./agent.js";
import { MockAgentBrain } from "./agent.js";
import type { LocatedObject, NamedTriage, ObjectFinder, VisionAnswer } from "./index.js";
import { MockObjectFinder, MockVisionAnswer, MockVisionTriage } from "./mocks.js";
import { createAdapters } from "./factory.js";
import {
  agentFallbackFromEnv,
  FallbackAgentBrain,
  FallbackAnswer,
  FallbackFinder,
  FallbackTriage,
  isRetryableError,
  triageFallbackFromEnv,
  type AttemptOutcome,
} from "./fallback.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function baseInput(): AgentInput {
  return { history: [], utterance: "ki hai saamne", scene: emptyScene(), lang: "pa", script: "gurmukhi" };
}

const PRIMARY_SAY = "primary answer";
const BACKUP_SAY = "backup answer";

interface AgentStep {
  delayMs?: number;
  output?: AgentOutput;
  error?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

class FakeAgentBrain implements AgentBrain {
  calls = 0;
  private usage?: { promptTokens: number; completionTokens: number };

  constructor(private readonly steps: AgentStep[] = []) {}

  async respond(_input: AgentInput): Promise<AgentOutput> {
    const step = this.steps[Math.min(this.calls++, Math.max(0, this.steps.length - 1))] ?? {};
    if (step.delayMs) await delay(step.delayMs);
    if (step.error) throw step.error;
    if (step.usage) this.usage = step.usage;
    return structuredClone(step.output ?? { say: PRIMARY_SAY, positions: [], actions: [] });
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.usage;
  }

  getLastCostUsd(): null {
    return null;
  }
}

interface TriageStep {
  delayMs?: number;
  result?: TriageResult;
  scene?: SceneTriage;
  error?: unknown;
}

class FakeTriage implements NamedTriage {
  readonly name: string;
  calls = 0;
  sceneCalls = 0;

  constructor(
    private readonly steps: TriageStep[] = [],
    name = "fake-triage"
  ) {
    this.name = name;
  }

  private next(): TriageStep {
    return this.steps[0] ?? {};
  }

  async triage(_img: Buffer): Promise<TriageResult> {
    const step = this.steps[Math.min(this.calls++, Math.max(0, this.steps.length - 1))] ?? this.next();
    if (step.delayMs) await delay(step.delayMs);
    if (step.error) throw step.error;
    return structuredClone(step.result ?? { notes: [], people: [] });
  }

  async triageScene(_img: Buffer): Promise<SceneTriage> {
    const step = this.steps[Math.min(this.sceneCalls++, Math.max(0, this.steps.length - 1))] ?? this.next();
    if (step.delayMs) await delay(step.delayMs);
    if (step.error) throw step.error;
    return structuredClone(step.scene ?? { notes: [], people: [], objects: [] });
  }

  getLastUsage(): undefined {
    return undefined;
  }
}

class FakeAnswer implements VisionAnswer {
  calls = 0;
  constructor(private readonly steps: Array<{ error?: unknown; text?: string }> = []) {}
  private next(): { error?: unknown; text?: string } {
    return this.steps[Math.min(this.calls++, Math.max(0, this.steps.length - 1))] ?? {};
  }
  async describe(_img: Buffer, _q: string): Promise<string> {
    const s = this.next();
    if (s.error) throw s.error;
    return s.text ?? "primary describe";
  }
  async read(_img: Buffer): Promise<string> {
    const s = this.next();
    if (s.error) throw s.error;
    return s.text ?? "primary read";
  }
}

class FakeFinder implements ObjectFinder {
  calls = 0;
  constructor(private readonly steps: Array<{ error?: unknown; loc?: LocatedObject | null }> = []) {}
  private next(): { error?: unknown; loc?: LocatedObject | null } {
    return this.steps[Math.min(this.calls++, Math.max(0, this.steps.length - 1))] ?? {};
  }
  async find(_img: Buffer, _noun: string): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
    const s = this.next();
    if (s.error) throw s.error;
    return s.loc ? [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] : [];
  }
  async locate(_img: Buffer, _noun: string): Promise<LocatedObject | null> {
    const s = this.next();
    if (s.error) throw s.error;
    return s.loc ?? null;
  }
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test("primary ok -> backup never called", async () => {
  const primary = new FakeAgentBrain([{ output: { say: PRIMARY_SAY, positions: [], actions: [] } }]);
  const backup = new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]);
  const logs: string[] = [];
  const records: Array<[string, AttemptOutcome]> = [];
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: primary },
      { provider: "backup-p", impl: backup },
    ],
    { primaryMs: 100, totalMs: 300, log: (m) => logs.push(m), record: (p, o) => records.push([p, o]) }
  );
  const out = await chain.respond(baseInput());
  assert.equal(out.say, PRIMARY_SAY);
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 0);
  assert.deepEqual(logs, [`model_attempt provider=primary-p stage=agent ok ms=${logs[0]?.match(/ms=(\d+)/)?.[1]}`]);
  assert.match(logs[0] ?? "", /^model_attempt provider=primary-p stage=agent ok ms=\d+$/);
  assert.deepEqual(records, [["primary-p", "ok"]]);
});

test("primary timeout -> backup answers within total budget", async () => {
  const primary = new FakeAgentBrain([
    { delayMs: 500, output: { say: PRIMARY_SAY, positions: [], actions: [] } },
  ]);
  const backup = new FakeAgentBrain([
    { delayMs: 10, output: { say: BACKUP_SAY, positions: [], actions: [] } },
  ]);
  const logs: string[] = [];
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: primary },
      { provider: "backup-p", impl: backup },
    ],
    { primaryMs: 20, totalMs: 300, log: (m) => logs.push(m) }
  );
  const start = Date.now();
  const out = await chain.respond(baseInput());
  const elapsed = Date.now() - start;
  assert.equal(out.say, BACKUP_SAY);
  assert.ok(elapsed < 300, `elapsed ${elapsed}ms exceeds the total budget`);
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 1);
  assert.equal(logs.length, 2);
  assert.match(logs[0] ?? "", /^model_attempt provider=primary-p stage=agent timeout ms=\d+$/);
  assert.match(logs[1] ?? "", /^model_attempt provider=backup-p stage=agent ok ms=\d+$/);
  await delay(550); // let the primary's late answer settle into the void
});

test("primary bad JSON, network error, 429 and 5xx all fall back", async () => {
  const failures: Array<[string, unknown]> = [
    ["bad json", new Error("agent output is not JSON")],
    ["network", new TypeError("fetch failed")],
    ["429", httpError(429, "429 rate limited")],
    ["500", httpError(500, "500 internal error")],
    ["503", httpError(503, "503 unavailable")],
  ];
  assert.ok(isRetryableError(new ModelTimeoutError("agent", 10)));
  for (const [label, error] of failures) {
    const primary = new FakeAgentBrain([{ error }]);
    const backup = new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]);
    const chain = new FallbackAgentBrain(
      [
        { provider: "primary-p", impl: primary },
        { provider: "backup-p", impl: backup },
      ],
      { primaryMs: 100, totalMs: 300, log: () => {} }
    );
    const out = await chain.respond(baseInput());
    assert.equal(out.say, BACKUP_SAY, label);
    assert.equal(backup.calls, 1, label);
    assert.ok(isRetryableError(error), label);
  }
});

test("4xx other than 429 fails fast without calling backup", async () => {
  for (const status of [400, 401, 403, 404]) {
    const primary = new FakeAgentBrain([{ error: httpError(status, `${status} no retry`) }]);
    const backup = new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]);
    const chain = new FallbackAgentBrain(
      [
        { provider: "primary-p", impl: primary },
        { provider: "backup-p", impl: backup },
      ],
      { primaryMs: 100, totalMs: 300, log: () => {} }
    );
    await assert.rejects(() => chain.respond(baseInput()), new RegExp(`${status} no retry`));
    assert.equal(backup.calls, 0, `status ${status} must not fall back`);
    assert.equal(isRetryableError(httpError(status, "x")), false);
  }
});

test("both fail -> throws; TurnGuard speaks the fallback line once (end-to-end)", async () => {
  const mkChain = (): FallbackAgentBrain =>
    new FallbackAgentBrain(
      [
        { provider: "primary-p", impl: new FakeAgentBrain([{ error: new Error("primary down") }]) },
        { provider: "backup-p", impl: new FakeAgentBrain([{ error: new Error("backup down") }]) },
      ],
      { primaryMs: 50, totalMs: 200, log: () => {} }
    );
  await assert.rejects(() => mkChain().respond(baseInput()), /backup down/);

  // End-to-end once: the turn whose chain threw still ends audible via R1.
  const guard = new TurnGuard({ clock: () => 0, log: () => {} });
  let spoke = 0;
  guard.begin("t1");
  try {
    await mkChain().respond(baseInput());
    assert.fail("chain should have thrown");
  } catch {
    // No model answer and nothing spoken yet.
  } finally {
    guard.finish("t1", "error", () => spoke++);
  }
  assert.equal(spoke, 1);
  assert.equal(guard.rescuedCount, 1);
});

test("mock in chain is a startup error", () => {
  const opts = { primaryMs: 10, totalMs: 20, log: () => {} };
  assert.throws(
    () =>
      new FallbackAgentBrain(
        [
          { provider: "mock", impl: new FakeAgentBrain() },
          { provider: "meta", impl: new FakeAgentBrain() },
        ],
        opts
      ),
    /mock/
  );
  assert.throws(
    () =>
      new FallbackAgentBrain(
        [
          { provider: "meta", impl: new MockAgentBrain() },
          { provider: "openrouter", impl: new FakeAgentBrain() },
        ],
        opts
      ),
    /mock/
  );
  assert.throws(
    () =>
      new FallbackTriage(
        [
          { provider: "meta", impl: new MockVisionTriage() },
          { provider: "openrouter", impl: new FakeTriage() },
        ],
        opts
      ),
    /mock/
  );
  assert.throws(
    () =>
      new FallbackAnswer(
        [
          { provider: "meta", impl: new MockVisionAnswer() },
          { provider: "openrouter", impl: new FakeAnswer() },
        ],
        opts
      ),
    /mock/
  );
  assert.throws(
    () =>
      new FallbackFinder(
        [
          { provider: "meta", impl: new MockObjectFinder() },
          { provider: "openrouter", impl: new FakeFinder() },
        ],
        opts
      ),
    /mock/
  );
  withEnv({ AGENT_FALLBACK_PROVIDER: "mock" }, () => {
    assert.throws(() => agentFallbackFromEnv(), /mock/);
  });
  withEnv({ TRIAGE_FALLBACK_PROVIDER: "MOCK" }, () => {
    assert.throws(() => triageFallbackFromEnv(), /mock/);
  });
});

test("a late primary answer after fallback started is discarded, never spoken twice", async () => {
  const primary = new FakeAgentBrain([
    { delayMs: 100, output: { say: PRIMARY_SAY, positions: [], actions: [] } },
  ]);
  const backup = new FakeAgentBrain([
    { delayMs: 10, output: { say: BACKUP_SAY, positions: [], actions: [] } },
  ]);
  const logs: string[] = [];
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: primary },
      { provider: "backup-p", impl: backup },
    ],
    { primaryMs: 20, totalMs: 500, log: (m) => logs.push(m) }
  );
  const out = await chain.respond(baseInput());
  assert.equal(out.say, BACKUP_SAY);
  await delay(200); // primary's answer lands here; the chain already settled
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 1);
  assert.equal(logs.length, 2);
  assert.match(logs[0] ?? "", /timeout/);
  assert.match(logs[1] ?? "", / ok /);
});

test("triage, answer and finder chains fail over with their stages", async () => {
  const logs: string[] = [];
  const opts = { primaryMs: 50, totalMs: 200, log: (m: string) => logs.push(m) };

  const triage = new FallbackTriage(
    [
      { provider: "primary-p", impl: new FakeTriage([{ error: new Error("triage output is not JSON") }]) },
      {
        provider: "backup-p",
        impl: new FakeTriage([{ result: { notes: [{ denomination: 100, confidence: 0.9 }], people: [] } }]),
      },
    ],
    opts
  );
  assert.equal(triage.name, "fallback:primary-p+backup-p");
  const r = await triage.triage(Buffer.alloc(0));
  assert.equal(r.notes[0]?.denomination, 100);

  const sceneTriage = new FallbackTriage(
    [
      { provider: "primary-p", impl: new FakeTriage([{ error: httpError(503, "503 down") }]) },
      {
        provider: "backup-p",
        impl: new FakeTriage([
          { scene: { notes: [], people: [], objects: [{ label: "kursi", x: 0.5, y: 0.5, distance: "mid", salience: 2 }] } },
        ]),
      },
    ],
    opts
  );
  const scene = await sceneTriage.triageScene(Buffer.alloc(0));
  assert.equal(scene.objects[0]?.label, "kursi");

  const answer = new FallbackAnswer(
    [
      { provider: "primary-p", impl: new FakeAnswer([{ error: new TypeError("fetch failed") }]) },
      { provider: "backup-p", impl: new FakeAnswer([{ text: "backup describe" }]) },
    ],
    opts
  );
  assert.equal(await answer.describe(Buffer.alloc(0), "ki hai"), "backup describe");

  const finder = new FallbackFinder(
    [
      { provider: "primary-p", impl: new FakeFinder([{ error: httpError(429, "429 slow down") }]) },
      {
        provider: "backup-p",
        impl: new FakeFinder([{ loc: { x: 0.5, y: 0.5, distance: "mid", confidence: 0.8 } }]),
      },
    ],
    opts
  );
  assert.deepEqual(await finder.locate(Buffer.alloc(0), "Kainchi"), {
    x: 0.5,
    y: 0.5,
    distance: "mid",
    confidence: 0.8,
  });

  const stages = logs.map((l) => l.match(/stage=(\w+)/)?.[1]);
  assert.ok(stages.includes("triage"), `expected a triage stage, got ${logs.join(" | ")}`);
  assert.ok(stages.includes("scene"), `expected a scene stage, got ${logs.join(" | ")}`);
  assert.ok(stages.includes("answer"), `expected an answer stage, got ${logs.join(" | ")}`);
  assert.ok(stages.includes("find"), `expected a find stage, got ${logs.join(" | ")}`);
});

test("usage follows the winner on failover", async () => {
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: new FakeAgentBrain([{ error: new Error("boom") }]) },
      {
        provider: "backup-p",
        impl: new FakeAgentBrain([
          {
            output: { say: BACKUP_SAY, positions: [], actions: [] },
            usage: { promptTokens: 11, completionTokens: 22 },
          },
        ]),
      },
    ],
    { primaryMs: 50, totalMs: 200, log: () => {} }
  );
  await chain.respond(baseInput());
  assert.deepEqual(chain.getLastUsage(), { promptTokens: 11, completionTokens: 22 });
});

test("cash stability still applies to whatever the fallback answers", async () => {
  const mkTriage = (): FallbackTriage =>
    new FallbackTriage(
      [
        { provider: "primary-p", impl: new FakeTriage([{ error: new Error("primary down") }]) },
        {
          provider: "backup-p",
          impl: new FakeTriage([{ result: { notes: [{ denomination: 500, confidence: 0.7 }], people: [] } }]),
        },
      ],
      { primaryMs: 50, totalMs: 200, log: () => {} }
    );
  const engine = new DecisionEngine();
  // Below the 0.85 fast path, one frame stays silent even from the backup.
  const first = await mkTriage().triage(Buffer.alloc(0));
  assert.deepEqual(engine.onFrame(first, [], 1000), []);
  // Two agreeing frames speak, exactly like the single-provider path.
  const second = await mkTriage().triage(Buffer.alloc(0));
  const fired = engine.onFrame(second, [], 2000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.kind, "NOTE_SEEN");
});

test("attempts feed per-provider /stats counts", async () => {
  const stats = new UtteranceStats();
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: new FakeAgentBrain([{ error: new Error("boom") }]) },
      { provider: "backup-p", impl: new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]) },
    ],
    {
      primaryMs: 50,
      totalMs: 200,
      log: () => {},
      record: (p, o) => stats.recordAttempt(p, o),
    }
  );
  await chain.respond(baseInput());
  const slow = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: new FakeAgentBrain([{ delayMs: 300, output: { say: "late", positions: [], actions: [] } }]) },
      { provider: "backup-p", impl: new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]) },
    ],
    {
      primaryMs: 20,
      totalMs: 200,
      log: () => {},
      record: (p, o) => stats.recordAttempt(p, o),
    }
  );
  await slow.respond(baseInput());
  assert.deepEqual(stats.snapshot().providers, {
    "primary-p": { ok: 0, timeout: 1, error: 1 },
    "backup-p": { ok: 2, timeout: 0, error: 0 },
  });
  await delay(350); // let the slow primary settle into the void
});

test("R7: chain attempts carry the turnId in logs and record details", async () => {
  const logs: string[] = [];
  const records: Array<[string, AttemptOutcome, { ms: number; stage: string; turnId?: string }]> = [];
  const chain = new FallbackAgentBrain(
    [
      { provider: "primary-p", impl: new FakeAgentBrain([{ error: new Error("boom") }]) },
      { provider: "backup-p", impl: new FakeAgentBrain([{ output: { say: BACKUP_SAY, positions: [], actions: [] } }]) },
    ],
    {
      primaryMs: 50,
      totalMs: 200,
      log: (m) => logs.push(m),
      record: (p, o, d) => records.push([p, o, d]),
    }
  );
  await chain.respond({ ...baseInput(), turnId: "t9" });
  assert.ok(
    logs.every((l) => l.includes("turn=t9")),
    `expected turn=t9 in every attempt line, got: ${logs.join(" | ")}`
  );
  assert.deepEqual(
    records.map(([p, o]) => [p, o]),
    [
      ["primary-p", "error"],
      ["backup-p", "ok"],
    ]
  );
  for (const [, , d] of records) {
    assert.equal(d.turnId, "t9");
    assert.equal(d.stage, "agent");
    assert.ok(d.ms >= 0);
  }
});

const FALLBACK_KEYS = [
  "AGENT_FALLBACK_PROVIDER",
  "AGENT_FALLBACK_MODEL",
  "AGENT_FALLBACK_BASE_URL",
  "AGENT_FALLBACK_API_KEY",
  "TRIAGE_FALLBACK_PROVIDER",
  "TRIAGE_FALLBACK_MODEL",
  "TRIAGE_FALLBACK_BASE_URL",
  "TRIAGE_FALLBACK_API_KEY",
];

function clearFallbackEnv(): Record<string, string | undefined> {
  return Object.fromEntries(FALLBACK_KEYS.map((k) => [k, undefined]));
}

test("fallback env: unset means no chain, set builds a real-provider config", () => {
  withEnv(clearFallbackEnv(), () => {
    assert.equal(agentFallbackFromEnv(), undefined);
    assert.equal(triageFallbackFromEnv(), undefined);
  });
  withEnv(
    { ...clearFallbackEnv(), AGENT_FALLBACK_PROVIDER: "openrouter", AGENT_FALLBACK_API_KEY: "k" },
    () => {
      assert.deepEqual(agentFallbackFromEnv(), {
        provider: "openrouter",
        model: "meta/muse-spark-1.3",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "k",
      });
    }
  );
  withEnv(
    {
      ...clearFallbackEnv(),
      TRIAGE_FALLBACK_PROVIDER: "meta",
      TRIAGE_FALLBACK_MODEL: "custom",
      TRIAGE_FALLBACK_BASE_URL: "https://x/v1",
      TRIAGE_FALLBACK_API_KEY: "k",
    },
    () => {
      assert.deepEqual(triageFallbackFromEnv(), {
        provider: "meta",
        model: "custom",
        baseURL: "https://x/v1",
        apiKey: "k",
      });
    }
  );
  withEnv({ ...clearFallbackEnv(), AGENT_FALLBACK_PROVIDER: "local" }, () => {
    const cfg = agentFallbackFromEnv();
    assert.equal(cfg?.provider, "local");
    assert.equal(cfg?.apiKey, "ollama");
  });
  withEnv({ ...clearFallbackEnv(), AGENT_FALLBACK_PROVIDER: "meta" }, () => {
    assert.throws(() => agentFallbackFromEnv(), /AGENT_FALLBACK_API_KEY is required/);
  });
  withEnv(
    { ...clearFallbackEnv(), AGENT_FALLBACK_PROVIDER: "carrier-pigeon", AGENT_FALLBACK_API_KEY: "k" },
    () => {
      assert.throws(() => agentFallbackFromEnv(), /unknown/);
    }
  );
});

test("factory wires chains only when configured, and never with mock", () => {
  withEnv(
    {
      PROVIDER: "meta",
      META_API_KEY: "fake",
      AGENT_DEBUG_DIR: "",
      ...clearFallbackEnv(),
      AGENT_FALLBACK_PROVIDER: "local",
    },
    () => {
      const a = createAdapters();
      assert.ok(a.agent instanceof FallbackAgentBrain);
      assert.equal(a.triage.name, "openai-compat:muse-spark-1.3");
    }
  );
  withEnv(
    {
      PROVIDER: "meta",
      META_API_KEY: "fake",
      AGENT_DEBUG_DIR: "",
      ...clearFallbackEnv(),
      TRIAGE_FALLBACK_PROVIDER: "local",
    },
    () => {
      const a = createAdapters();
      assert.ok(a.triage instanceof FallbackTriage);
      assert.equal(a.triage.name, "fallback:meta+local");
    }
  );
  withEnv(
    { PROVIDER: "meta", META_API_KEY: "fake", AGENT_DEBUG_DIR: "", ...clearFallbackEnv() },
    () => {
      const a = createAdapters();
      assert.ok(!(a.agent instanceof FallbackAgentBrain));
      assert.ok(!(a.triage instanceof FallbackTriage));
    }
  );
  withEnv(
    { PROVIDER: "mock", AGENT_DEBUG_DIR: "", ...clearFallbackEnv(), AGENT_FALLBACK_PROVIDER: "local" },
    () => {
      assert.throws(() => createAdapters(), /mock/);
    }
  );
  withEnv(
    { PROVIDER: "mock", AGENT_DEBUG_DIR: "", ...clearFallbackEnv(), TRIAGE_FALLBACK_PROVIDER: "local" },
    () => {
      assert.throws(() => createAdapters(), /mock/);
    }
  );
  withEnv(
    {
      PROVIDER: "meta",
      META_API_KEY: "fake",
      AGENT_DEBUG_DIR: "",
      ...clearFallbackEnv(),
      AGENT_FALLBACK_PROVIDER: "mock",
    },
    () => {
      assert.throws(() => createAdapters(), /mock/);
    }
  );
});
