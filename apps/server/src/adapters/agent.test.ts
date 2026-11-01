// Agent brain tests. Nothing here touches the network: the mock is
// scripted, the system prompt is asserted as text, and the OpenAI-compat
// brain runs against an injected fake client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import sharp from "sharp";
import { buildAgentSystemPrompt, buildSceneBlock, AGENT_PROMPT_VERSION } from "../prompts/agent.js";
import { emptyScene, type SceneState } from "../session.js";
import {
  agentCostUsd,
  agentDebugDirFromEnv,
  agentImagePxFromEnv,
  agentMaxTokensFromEnv,
  agentModelFromEnv,
  agentReasoningEffortFromEnv,
  agentToolModeFromEnv,
  DEFAULT_MOCK_AGENT_OUTPUT,
  MockAgentBrain,
  OpenAICompatAgentBrain,
  parseAgentOutput,
  type AgentInput,
  type AgentOutput,
} from "./agent.js";

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

function baseInput(over: Partial<AgentInput> = {}): AgentInput {
  return {
    history: [],
    utterance: "ki hai saamne",
    scene: emptyScene(),
    lang: "pa",
    script: "gurmukhi",
    ...over,
  };
}

test("mock brain cycles its script and clones outputs", async () => {
  const out: AgentOutput = { say: "hi {pos:0}", positions: [{ x: 0.1, y: 0.2 }], actions: [] };
  const mock = new MockAgentBrain([out]);
  const first = await mock.respond(baseInput());
  assert.equal(first.say, "hi {pos:0}");
  first.say = "mutated";
  first.positions[0]!.x = 0.9;
  const second = await mock.respond(baseInput());
  assert.equal(second.say, "hi {pos:0}");
  assert.equal(second.positions[0]?.x, 0.1);
  assert.equal(mock.inputs.length, 2);
  assert.equal(mock.inputs[0]?.utterance, "ki hai saamne");
  assert.equal(mock.getLastUsage(), undefined);
  assert.equal(mock.getLastCostUsd(), null);
});

test("mock brain throws scripted errors and has a position-bearing default", async () => {
  const mock = new MockAgentBrain([new Error("boom")]);
  await assert.rejects(() => mock.respond(baseInput()), /boom/);
  assert.match(DEFAULT_MOCK_AGENT_OUTPUT.say ?? "", /\{pos:0\}/);
  assert.equal(DEFAULT_MOCK_AGENT_OUTPUT.positions.length, 1);
});

test("parseAgentOutput accepts a full valid answer", () => {
  const out = parseAgentOutput(
    '{"say": "Kainchi {pos:0}", "positions": [{"x": 0.8, "y": 0.6, "distance": "near"}], "actions": [{"tool": "look_around", "on": true}]}'
  );
  assert.equal(out.say, "Kainchi {pos:0}");
  assert.deepEqual(out.positions, [{ x: 0.8, y: 0.6, distance: "near" }]);
  assert.deepEqual(out.actions, [{ tool: "look_around", on: true }]);
});

test("parseAgentOutput is lenient on missing keys, clamps coordinates", () => {
  assert.deepEqual(parseAgentOutput("{}"), { say: null, positions: [], actions: [] });
  assert.deepEqual(parseAgentOutput('```json\n{"say": null}\n```'), { say: null, positions: [], actions: [] });
  const clamped = parseAgentOutput('{"say": "x", "positions": [{"x": 2, "y": -1}]}');
  assert.deepEqual(clamped.positions, [{ x: 1, y: 0 }]);
});

test("parseAgentOutput validates every action tool", () => {
  const out = parseAgentOutput(
    '{"say": null, "actions": [{"tool": "remember_person", "ref": "P2", "name": "Pardeep"}, {"tool": "confirm_consent", "name": "Pardeep", "granted": true}, {"tool": "forget_person", "name": "Pardeep"}, {"tool": "mute", "on": false}, {"tool": "cash_check"}, {"tool": "find", "noun": "Kainchi"}]}'
  );
  assert.equal(out.actions.length, 6);
  assert.deepEqual(out.actions[0], { tool: "remember_person", ref: "P2", name: "Pardeep" });
  const nullRef = parseAgentOutput('{"actions": [{"tool": "remember_person", "ref": null, "name": "X"}]}');
  assert.deepEqual(nullRef.actions[0], { tool: "remember_person", ref: null, name: "X" });
});

test("parseAgentOutput rejects malformed answers", () => {
  assert.throws(() => parseAgentOutput("no json here"), /agent output is not JSON/);
  assert.throws(() => parseAgentOutput('{"say": 5}'), /agent\.say/);
  assert.throws(() => parseAgentOutput('{"positions": {}}'), /agent\.positions must be an array/);
  assert.throws(() => parseAgentOutput('{"positions": [{"x": "left", "y": 0}]}'), /positions\[0\]\.x/);
  assert.throws(() => parseAgentOutput('{"positions": [{"x": 0, "y": 0, "distance": "close"}]}'), /distance/);
  assert.throws(() => parseAgentOutput('{"actions": {}}'), /agent\.actions must be an array/);
  assert.throws(() => parseAgentOutput('{"actions": [{"tool": "dance"}]}'), /tool is unknown/);
  assert.throws(() => parseAgentOutput('{"actions": [{"tool": "mute"}]}'), /\.on must be a boolean/);
  assert.throws(() => parseAgentOutput('{"actions": [{"tool": "find", "noun": "  "}]}'), /\.noun/);
  assert.throws(() => parseAgentOutput('{"actions": [{"tool": "remember_person", "name": "X"}]}'), /\.ref/);
});

test("agent env config: defaults and validation", () => {
  withEnv(
    {
      AGENT_MODEL: undefined,
      AGENT_MAX_TOKENS: undefined,
      AGENT_IMAGE_PX: undefined,
      AGENT_TOOL_MODE: undefined,
      AGENT_REASONING_EFFORT: undefined,
    },
    () => {
      assert.equal(agentModelFromEnv(), "muse-spark-1.3");
      assert.equal(agentMaxTokensFromEnv(), 600);
      assert.equal(agentImagePxFromEnv(), 640);
      assert.equal(agentToolModeFromEnv(), "json");
      assert.equal(agentReasoningEffortFromEnv(), "minimal");
    }
  );
  withEnv({ AGENT_MODEL: "x", AGENT_MAX_TOKENS: "100", AGENT_IMAGE_PX: "512" }, () => {
    assert.equal(agentModelFromEnv(), "x");
    assert.equal(agentMaxTokensFromEnv(), 100);
    assert.equal(agentImagePxFromEnv(), 512);
  });
  withEnv({ AGENT_MAX_TOKENS: "0" }, () => {
    assert.throws(() => agentMaxTokensFromEnv(), /positive integer/);
  });
  withEnv({ AGENT_IMAGE_PX: "big" }, () => {
    assert.throws(() => agentImagePxFromEnv(), /positive integer/);
  });
  withEnv({ AGENT_TOOL_MODE: "carrier-pigeon" }, () => {
    assert.throws(() => agentToolModeFromEnv(), /AGENT_TOOL_MODE/);
  });
  withEnv({ AGENT_REASONING_EFFORT: "off" }, () => {
    assert.equal(agentReasoningEffortFromEnv(), undefined);
  });
  withEnv({ AGENT_DEBUG_DIR: "" }, () => {
    assert.equal(agentDebugDirFromEnv(), undefined);
  });
});

test("native tool mode refuses to construct (probe has not passed)", () => {
  assert.throws(
    () =>
      new OpenAICompatAgentBrain({ baseURL: "http://x", model: "m", apiKey: "k", toolMode: "native" }),
    /probe/
  );
});

test("agent cost table prices Spark, null otherwise", () => {
  assert.equal(agentCostUsd("muse-spark-1.3", { promptTokens: 1000, completionTokens: 1000 }), 0.0055);
  assert.equal(agentCostUsd("muse-spark-1.3", undefined), null);
  assert.equal(agentCostUsd("unknown-model", { promptTokens: 1, completionTokens: 1 }), null);
});

test("system prompt carries the rules, schema and few-shots", () => {
  assert.equal(AGENT_PROMPT_VERSION, 2);
  const prompt = buildAgentSystemPrompt({ lang: "pa", script: "gurmukhi" });
  assert.match(prompt, /blind shopkeeper/);
  assert.match(prompt, /15 words/);
  assert.match(prompt, /Never say "I can see"/);
  assert.match(prompt, /cash_check/);
  assert.match(prompt, /Never identify people except/);
  assert.match(prompt, /Never claim.*real or fake/);
  assert.match(prompt, /\{pos:0\}/);
  assert.match(prompt, /Never write clock words/);
  assert.match(prompt, /pakka nahi/);
  assert.match(prompt, /Gurmukhi/);
  assert.match(prompt, /ki haal hai/);
  assert.match(prompt, /remember_person/);
  assert.match(buildAgentSystemPrompt({ lang: "en", script: "latin" }), /Latin\/Roman/);
  assert.match(buildAgentSystemPrompt({ lang: "hi", script: "devanagari" }), /Devanagari/);
});

test("scene block renders people, notes and look-around state", () => {
  const scene: SceneState = {
    people: [
      { ref: "P1", clock: 10, distance: "near", desc: "man around 30s" },
      { ref: "P2", clock: 2, distance: "far", desc: "woman", knownName: "Ravi" },
    ],
    recentNotes: ["500 (conf 0.9)"],
    lookAround: true,
    objects: [{ label: "kursi", clock: 12, distance: "mid" }],
  };
  const block = buildSceneBlock(scene);
  assert.match(block, /look-around: on/);
  assert.match(block, /P1: man around 30s at 10 o'clock, near/);
  assert.match(block, /P2: woman at 2 o'clock, far \(known: Ravi\)/);
  assert.match(block, /Recent notes: 500 \(conf 0\.9\)/);
  assert.match(block, /Objects in view: kursi at 12 o'clock, mid/);
  assert.match(buildSceneBlock(emptyScene()), /People in view: none/);
  assert.match(buildSceneBlock(emptyScene()), /Objects in view: none/);
});

interface FakeClient {
  seen: Array<Record<string, unknown>>;
  client: OpenAI;
}

function fakeClient(handler: (params: Record<string, unknown>) => unknown): FakeClient {
  const seen: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          return handler(params);
        },
      },
    },
  } as unknown as OpenAI;
  return { seen, client };
}

function completion(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    ...extra,
  };
}

async function tinyJpeg(width = 32, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

test("openai-compat brain sends history + downscaled image, parses the answer", async () => {
  const { seen, client } = fakeClient(() => completion('{"say": "Counter te samaan {pos:0}", "positions": [{"x": 0.6, "y": 0.5}]}'));
  const brain = new OpenAICompatAgentBrain(
    { baseURL: "http://test", model: "muse-spark-1.3", apiKey: "k", imagePx: 16 },
    client
  );
  const jpeg = await tinyJpeg();
  const out = await brain.respond(
    baseInput({
      history: [
        { role: "user", text: "ki haal hai" },
        { role: "assistant", text: "Badiya!" },
      ],
      image: { jpeg, hfovDeg: 66 },
    })
  );
  assert.equal(out.say, "Counter te samaan {pos:0}");
  assert.equal(seen.length, 1);
  const params = seen[0]!;
  assert.equal(params.model, "muse-spark-1.3");
  assert.deepEqual(params.response_format, { type: "json_object" });
  assert.equal(params.reasoning_effort, undefined); // unset opts omit the parameter
  const messages = params.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 4); // system + 2 history + user
  assert.equal(messages[0]?.role, "system");
  assert.match(String((messages[0] as { content: string }).content), /blind shopkeeper/);
  assert.match(String((messages[0] as { content: string }).content), /Scene \(may be slightly stale/);
  const userContent = messages[3]?.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(userContent[0]?.type, "text");
  const dataUrl = userContent[1]?.image_url?.url ?? "";
  assert.ok(dataUrl.startsWith("data:image/jpeg;base64,"));
  const meta = await sharp(Buffer.from(dataUrl.split(",")[1] ?? "", "base64")).metadata();
  assert.ok((meta.width ?? 99) <= 16 && (meta.height ?? 99) <= 16);
  assert.deepEqual(brain.getLastUsage(), { promptTokens: 100, completionTokens: 10 });
  assert.equal(typeof brain.getLastCostUsd(), "number");
});

test("openai-compat brain falls back to prompt-only JSON when json mode is rejected", async () => {
  let calls = 0;
  const { seen, client } = fakeClient((params) => {
    calls++;
    if (calls === 1) throw new Error("API does not support response_format json_object");
    assert.equal(params.response_format, undefined);
    return completion('{"say": "ok"}');
  });
  const brain = new OpenAICompatAgentBrain(
    { baseURL: "http://test", model: "m", apiKey: "k", reasoningEffort: "minimal" },
    client
  );
  const out = await brain.respond(baseInput());
  assert.equal(out.say, "ok");
  assert.equal(seen.length, 2);
  assert.equal((seen[0] as Record<string, unknown>).reasoning_effort, "minimal");
});

test("openai-compat brain omits the image block when there is no view", async () => {
  const { seen, client } = fakeClient(() => completion('{"say": "pakka nahi, dobara dikhao"}'));
  const brain = new OpenAICompatAgentBrain({ baseURL: "http://test", model: "m", apiKey: "k" }, client);
  const out = await brain.respond(baseInput());
  assert.equal(out.say, "pakka nahi, dobara dikhao");
  const messages = (seen[0] as { messages: Array<{ content: unknown }> }).messages;
  assert.equal(typeof messages[messages.length - 1]?.content, "string");
});

test("openai-compat brain surfaces malformed model JSON as an error", async () => {
  const { client } = fakeClient(() => completion("definitely not json"));
  const brain = new OpenAICompatAgentBrain({ baseURL: "http://test", model: "m", apiKey: "k" }, client);
  await assert.rejects(() => brain.respond(baseInput()), /agent output is not JSON/);
});

test("openai-compat brain debug log records the call without image bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-debug-"));
  try {
    const { client } = fakeClient(() => completion('{"say": "ok"}'));
    const brain = new OpenAICompatAgentBrain(
      { baseURL: "http://test", model: "m", apiKey: "k", debugDir: dir },
      client
    );
    await brain.respond(baseInput({ image: { jpeg: await tinyJpeg(), hfovDeg: 100 } }));
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const raw = readFileSync(join(dir, files[0]!), "utf8");
    const parsed = JSON.parse(raw) as { utterance: string; parsed: boolean; image: { bytes: number } };
    assert.equal(parsed.utterance, "ki hai saamne");
    assert.equal(parsed.parsed, true);
    assert.ok(parsed.image.bytes > 0);
    assert.ok(!raw.includes("data:image/jpeg"), "no image bytes in the debug log");
    assert.ok(raw.length < 10000, "debug log stays small");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
