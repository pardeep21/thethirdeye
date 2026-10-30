// Adapter tests. Nothing here touches the network: mocks return fixed data,
// the triage parser runs on strings, and the factory is checked by selection
// (constructing the OpenAI client makes no calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFromEnv } from "./index.js";
import { MockVisionTriage } from "./mocks.js";
import { createAdapters } from "./factory.js";
import { TRIAGE_SYSTEM_PROMPT, parseTriageResult } from "./openaiCompat.js";

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
