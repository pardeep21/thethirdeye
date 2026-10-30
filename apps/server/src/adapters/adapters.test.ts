// Adapter tests. Nothing here touches the network: mocks return fixed data,
// the triage parser runs on strings, and the factory is checked by selection
// (constructing the OpenAI client makes no calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { providerFromEnv } from "./index.js";
import { MockVisionTriage } from "./mocks.js";
import { createAdapters, metaReasoningEffortFromEnv } from "./factory.js";
import {
  OpenAICompatTriage,
  TRIAGE_SYSTEM_PROMPT,
  parseTriageResult,
  sanitizeLabel,
  triageMaxTokensFromEnv,
  type DebugFile,
} from "./openaiCompat.js";

test("mock triage cycles its script and clones results", async () => {
  const mock = new MockVisionTriage([
    { notes: [{ denomination: 100, confidence: 0.8 }], people: [] },
    { notes: [], people: [] },
  ]);
  assert.equal(mock.name, "mock");
  assert.equal(mock.getLastUsage(), undefined);
  const first = await mock.triage(Buffer.alloc(0));
  assert.equal(first.notes[0]?.denomination, 100);
  first.notes[0]!.denomination = 10; // must not leak into later calls
  assert.equal((await mock.triage(Buffer.alloc(0))).notes.length, 0);
  assert.equal((await mock.triage(Buffer.alloc(0))).notes[0]?.denomination, 100);
});

test("triage prompt forces the TriageResult JSON shape", () => {
  assert.match(TRIAGE_SYSTEM_PROMPT, /return ONLY a JSON object/);
  for (const d of ["10", "20", "50", "100", "200", "500"]) {
    assert.ok(TRIAGE_SYSTEM_PROMPT.includes(d), `prompt mentions ${d}`);
  }
  for (const key of ['"notes"', '"people"', '"denomination"', '"confidence"', '"position"', '"distance"']) {
    assert.ok(TRIAGE_SYSTEM_PROMPT.includes(key), `prompt mentions ${key}`);
  }
  assert.match(TRIAGE_SYSTEM_PROMPT, /never name anyone/i);
});

test("triage parser accepts a full valid answer", () => {
  const r = parseTriageResult(
    '{"notes":[{"denomination":500,"confidence":0.9}],"people":[{"position":"left","distance":"near","gender":"man","age_range":"30s","action":"handing a note"}]}'
  );
  assert.equal(r.notes[0]?.denomination, 500);
  assert.equal(r.notes[0]?.confidence, 0.9);
  assert.equal(r.people[0]?.position, "left");
  assert.equal(r.people[0]?.gender, "man");
});

test("triage parser is lenient on empties, strict on shapes", () => {
  assert.deepEqual(parseTriageResult("{}"), { notes: [], people: [] });
  assert.deepEqual(parseTriageResult('prefix {"notes":[],"people":[]} suffix'), { notes: [], people: [] });
  const clamped = parseTriageResult('{"notes":[{"denomination":null,"confidence":2}],"people":[]}');
  assert.equal(clamped.notes[0]?.confidence, 1);
  assert.throws(() => parseTriageResult("no json here"), /not JSON/);
  assert.throws(() => parseTriageResult('{"notes":[{"denomination":5,"confidence":0.5}],"people":[]}'), /denomination/);
  assert.throws(() => parseTriageResult('{"notes":[{"denomination":10}],"people":[]}'), /confidence/);
  assert.throws(() => parseTriageResult('{"notes":[],"people":[{"position":"middle","distance":"near"}]}'), /position/);
  assert.throws(() => parseTriageResult('{"notes":[],"people":[{"position":"left","distance":"close"}]}'), /distance/);
  assert.throws(() => parseTriageResult('{"notes":{},"people":[]}'), /must be an array/);
});

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

test("provider selection defaults to mock and rejects unknown names", () => {
  withEnv({ PROVIDER: undefined }, () => assert.equal(providerFromEnv(), "mock"));
  withEnv({ PROVIDER: "META" }, () => assert.equal(providerFromEnv(), "meta"));
  withEnv({ PROVIDER: "nope" }, () => assert.throws(() => providerFromEnv(), /unknown/));
});

test("factory builds mock set without keys, real sets need keys", () => {
  withEnv({ PROVIDER: "mock" }, () => {
    const a = createAdapters();
    assert.equal(a.triage.name, "mock");
  });
  withEnv({ PROVIDER: "meta", META_API_KEY: undefined }, () => {
    assert.throws(() => createAdapters(), /META_API_KEY/);
  });
  withEnv({ PROVIDER: "meta", META_API_KEY: "fake" }, () => {
    const a = createAdapters();
    assert.equal(a.triage.name, "openai-compat:muse-spark-1.3");
  });
  withEnv({ PROVIDER: "openrouter", OPENROUTER_API_KEY: undefined }, () => {
    assert.throws(() => createAdapters(), /OPENROUTER_API_KEY/);
  });
  withEnv({ PROVIDER: "local" }, () => {
    const a = createAdapters(); // ollama default, no key needed
    assert.equal(a.triage.name, "openai-compat:muse-glimmer");
  });
});

test("triage parser strips fences and prose, takes the first object", () => {
  const inner = '{"notes":[{"denomination":50,"confidence":0.7}],"people":[]}';
  assert.equal(parseTriageResult("```json\n" + inner + "\n```").notes[0]?.denomination, 50);
  assert.equal(parseTriageResult("```\n" + inner + "\n```").notes[0]?.denomination, 50);
  assert.equal(parseTriageResult("Sure, here it is: " + inner + " hope that helps").notes[0]?.denomination, 50);
  assert.equal(
    parseTriageResult(inner + ' {"notes":[{"denomination":10,"confidence":0.1}],"people":[]}').notes[0]?.denomination,
    50
  );
  // Braces inside strings must not confuse the scan.
  const tricky = '{"notes":[],"people":[{"position":"left","distance":"near","action":"holds {change}"}]}';
  assert.equal(parseTriageResult("prefix " + tricky + " suffix").people[0]?.action, "holds {change}");
  // Still fails, but only after extraction + validation both fail.
  assert.throws(() => parseTriageResult("```json\nnot json\n```"), /not JSON/);
  assert.throws(
    () => parseTriageResult('```json\n{"notes":[{"denomination":5,"confidence":0.5}],"people":[]}\n```'),
    /denomination/
  );
});

test("triage max tokens default to 400 and TRIAGE_MAX_TOKENS overrides", () => {
  withEnv({ TRIAGE_MAX_TOKENS: undefined }, () => assert.equal(triageMaxTokensFromEnv(), 400));
  withEnv({ TRIAGE_MAX_TOKENS: "123" }, () => assert.equal(triageMaxTokensFromEnv(), 123));
  withEnv({ TRIAGE_MAX_TOKENS: "nope" }, () => assert.throws(() => triageMaxTokensFromEnv(), /positive integer/));
});

test("meta reasoning effort defaults to minimal, off omits it", () => {
  withEnv({ META_REASONING_EFFORT: undefined }, () => assert.equal(metaReasoningEffortFromEnv(), "minimal"));
  withEnv({ META_REASONING_EFFORT: "low" }, () => assert.equal(metaReasoningEffortFromEnv(), "low"));
  withEnv({ META_REASONING_EFFORT: "off" }, () => assert.equal(metaReasoningEffortFromEnv(), undefined));
  withEnv({ PROVIDER: "meta", META_API_KEY: "fake" }, () => {
    const t = createAdapters().triage as OpenAICompatTriage;
    assert.equal(t.reasoningEffort, "minimal");
    assert.equal(t.maxTokens, 400);
  });
});

interface StubCompletion {
  content: string | null;
  finishReason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: Record<string, number>;
  };
}

function stubClient(script: Array<{ error?: string } & Partial<StubCompletion>>): {
  client: OpenAI;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const step = script[Math.min(i++, script.length - 1)];
          if (step.error) throw new Error(step.error);
          return {
            choices: [
              {
                message: { content: step.content ?? null },
                finish_reason: step.finishReason ?? "stop",
              },
            ],
            usage: step.usage,
          };
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, calls };
}

const OK_JSON = '{"notes":[{"denomination":500,"confidence":0.9}],"people":[]}';

test("json_object rejection falls back to prompt-only JSON, once", async () => {
  const { client, calls } = stubClient([
    { error: "400 Unknown parameter: 'response_format'" },
    { content: OK_JSON, finishReason: "stop" },
  ]);
  const t = new OpenAICompatTriage({ baseURL: "http://x", model: "m", apiKey: "k" }, client);
  const r = await t.triage(Buffer.alloc(0));
  assert.equal(r.notes[0]?.denomination, 500);
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[0].response_format as { type: string }).type, "json_object");
  assert.equal("response_format" in calls[1], false);
});

test("non-format errors are not retried as fallback", async () => {
  const { client, calls } = stubClient([{ error: "401 invalid_api_key" }]);
  const t = new OpenAICompatTriage({ baseURL: "http://x", model: "m", apiKey: "k" }, client);
  await assert.rejects(() => t.triage(Buffer.alloc(0)), /invalid_api_key/);
  assert.equal(calls.length, 1);
});

test("request carries max_tokens and reasoning_effort", async () => {
  const { client, calls } = stubClient([{ content: OK_JSON, finishReason: "stop" }]);
  const t = new OpenAICompatTriage(
    { baseURL: "http://x", model: "muse-spark-1.3", apiKey: "k", maxTokens: 400, reasoningEffort: "minimal" },
    client
  );
  await t.triage(Buffer.alloc(0));
  assert.equal(calls[0].max_tokens, 400);
  assert.equal(calls[0].reasoning_effort, "minimal");
});

test("debug file captures content, finish_reason, usage and params without the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thethirdeye-debug-"));
  try {
    const { client } = stubClient([
      {
        content: OK_JSON,
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
      },
    ]);
    const t = new OpenAICompatTriage(
      { baseURL: "http://x", model: "muse-spark-1.3", apiKey: "sk-SUPERSECRET", maxTokens: 400, reasoningEffort: "minimal", debugDir: dir },
      client
    );
    await t.triage(Buffer.from("fake-image-bytes"), "500_03_512");
    const raw = readFileSync(join(dir, "500_03_512.json"), "utf8");
    assert.ok(!raw.includes("sk-SUPERSECRET"), "debug file must not contain the key");
    const file = JSON.parse(raw) as DebugFile;
    assert.equal(file.label, "500_03_512");
    assert.equal(file.model, "muse-spark-1.3");
    assert.equal(file.parsed, true);
    assert.equal(file.attempts.length, 1);
    assert.equal(file.attempts[0].response?.content, OK_JSON);
    assert.equal(file.attempts[0].response?.finishReason, "stop");
    assert.deepEqual(file.attempts[0].request.reasoning_effort, "minimal");
    assert.deepEqual((file.attempts[0].request.response_format as { type: string }).type, "json_object");
    assert.equal((file.usage as { completion_tokens_details: { reasoning_tokens: number } }).completion_tokens_details.reasoning_tokens, 5);
    assert.equal((file.attempts[0].request.image as { bytes: number }).bytes, 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debug file is written even when parsing fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thethirdeye-debug-"));
  try {
    const { client } = stubClient([{ content: "not json at all", finishReason: "length" }]);
    const t = new OpenAICompatTriage(
      { baseURL: "http://x", model: "m", apiKey: "k", debugDir: dir },
      client
    );
    await assert.rejects(() => t.triage(Buffer.alloc(0), "bad_512"), /not JSON/);
    const file = JSON.parse(readFileSync(join(dir, "bad_512.json"), "utf8")) as DebugFile;
    assert.equal(file.parsed, false);
    assert.match(file.parseError ?? "", /not JSON/);
    assert.equal(file.attempts[0].response?.finishReason, "length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitizeLabel keeps filenames safe", () => {
  assert.equal(sanitizeLabel("500_03_512"), "500_03_512");
  assert.equal(sanitizeLabel("../../etc/x"), ".._.._etc_x");
});
