// Silence audit (R1, fixed): every user turn ends with a `speak`
// message, or at least an `ack` earcon for the intentional no-speech
// intents (mute / unmute / cancel). See SILENCE_AUDIT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./index.js";
import { MockAgentBrain } from "./adapters/agent.js";
import type { AgentBrain, AgentInput, AgentOutput, MockAgentScript } from "./adapters/agent.js";
import { MockObjectFinder } from "./adapters/mocks.js";
import type { NamedTriage, ObjectFinder, VisionAnswer } from "./adapters/index.js";
import { PeopleStore } from "./faces/store.js";
import type { FaceEmbedder } from "./faces/embed.js";

async function startTestServer(
  embedder?: FaceEmbedder,
  agent?: AgentBrain,
  triage?: NamedTriage,
  finder?: ObjectFinder,
  answer?: VisionAnswer
): Promise<{
  port: number;
  done: () => Promise<void>;
}> {
  process.env.PROVIDER = "mock";
  // Stub faces for determinism: a running sidecar must not change test behaviour.
  process.env.FACES = "stub";
  // Turn logging writes files: disabled in tests.
  process.env.TURN_LOG_DIR ??= "";
  const store = new PeopleStore(":memory:");
  const server = await startServer(0, { store, embedder, agent, triage, finder, answer });
  return {
    port: server.port,
    done: async () => {
      await server.close();
      store.close();
    },
  };
}

/**
 * Collect parsed messages until pred matches one, or the timeout hits.
 * Uses one persistent listener: messages that arrive in the same TCP
 * chunk are emitted synchronously, so a one-shot listener per message
 * would drop all but the first.
 */
async function collectUntil(
  ws: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  timeoutMs: number
): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = [];
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(timer);
      ws.off("message", onMsg);
      resolve(got);
    }
    function onMsg(data: unknown): void {
      const m = JSON.parse(String(data)) as Record<string, unknown>;
      got.push(m);
      if (pred(m)) done();
    }
    ws.on("message", onMsg);
  });
}

/** Collect every message that arrives within timeoutMs. */
async function collectFor(ws: WebSocket, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
  return collectUntil(ws, () => false, timeoutMs);
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

function sendFrame(ws: WebSocket, extra: Record<string, unknown> = {}): void {
  ws.send(
    JSON.stringify({
      type: "frame",
      jpegBase64: Buffer.from("fake-jpeg").toString("base64"),
      width: 4,
      height: 4,
      ts: Date.now(),
      ...extra,
    })
  );
}

function sendAudio(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "audio",
      audioBase64: Buffer.from("fake-m4a").toString("base64"),
      encoding: "m4a",
      sampleRate: 44100,
      ts: Date.now(),
    })
  );
}

function sendUtterance(ws: WebSocket, text: string): void {
  ws.send(JSON.stringify({ type: "utterance", text, lang: "pa-IN", ts: Date.now() }));
}

function sendMode(ws: WebSocket, lookAround: boolean): void {
  ws.send(JSON.stringify({ type: "mode", lookAround }));
}

const testDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class SlowAgent extends MockAgentBrain {
  constructor(
    private readonly delayMs: number,
    script?: MockAgentScript
  ) {
    super(script);
  }
  override async respond(input: AgentInput): Promise<AgentOutput> {
    await testDelay(this.delayMs);
    return super.respond(input);
  }
}

class SlowAnswer implements VisionAnswer {
  constructor(private readonly delayMs: number) {}
  async describe(): Promise<string> {
    await testDelay(this.delayMs);
    return "late description";
  }
  async read(): Promise<string> {
    await testDelay(this.delayMs);
    return "late label text here";
  }
}

class ThrowingAnswer implements VisionAnswer {
  async describe(): Promise<string> {
    throw new Error("spark exploded");
  }
  async read(): Promise<string> {
    throw new Error("spark exploded");
  }
}

/** Drive one agent turn with no capture reply; resolve when the turn ends. */
async function runSilentAgentTurn(
  ws: WebSocket,
  text: string
): Promise<Array<Record<string, unknown>>> {
  sendUtterance(ws, text);
  return collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
}

function assertSpeaks(got: Array<Record<string, unknown>>): void {
  assert.ok(
    got.some((m) => m.type === "speak"),
    `expected at least one speak, got: ${JSON.stringify(got)}`
  );
}

function assertAck(got: Array<Record<string, unknown>>): void {
  assert.ok(
    got.some((m) => m.type === "earcon" && m.name === "ack"),
    `expected an ack earcon, got: ${JSON.stringify(got)}`
  );
}

// ---- Open silent paths: agent says nothing (U13/U14/U17) ----

test("agent {say: null, actions: []} must speak", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([{ say: null, positions: [], actions: [] }]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      assertSpeaks(await runSilentAgentTurn(ws, "ki hai saamne"));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test('agent {say: ""} must speak', async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([{ say: "", positions: [], actions: [] }]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      assertSpeaks(await runSilentAgentTurn(ws, "ki hai saamne"));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test('agent {say: "   "} must speak', async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([{ say: "   ", positions: [], actions: [] }]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      assertSpeaks(await runSilentAgentTurn(ws, "ki hai saamne"));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent {say: null} + look_around-only must speak", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    { say: null, positions: [], actions: [{ tool: "look_around", on: true }] },
  ]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      assertSpeaks(await runSilentAgentTurn(ws, "look around on karo"));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent {say: null} + mute-only must speak", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([{ say: null, positions: [], actions: [{ tool: "mute", on: true }] }]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      // Four words: skips the mute fast path (<= 3 words) so the agent runs.
      assertSpeaks(await runSilentAgentTurn(ws, "please mute announcements now"));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

// ---- Open silent paths: audio turns with no reply (C6/C7/C9/C11) ----

test("audio describe with no frame must speak", async () => {
  process.env.MOCK_STT_TEXT = "ki hai saamne";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws); // no frame ever sent
      assertSpeaks(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio read with no frame must speak", async () => {
  process.env.MOCK_STT_TEXT = "eh padh";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws); // no frame ever sent
      assertSpeaks(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio unknown intent must speak", async () => {
  process.env.MOCK_STT_TEXT = "xyzzy blargh flimflam";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws);
      assertSpeaks(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio describe whose model throws must speak", async () => {
  process.env.MOCK_STT_TEXT = "ki hai saamne";
  const t = await startTestServer(undefined, undefined, undefined, undefined, new ThrowingAnswer());
  const origError = console.error;
  console.error = () => {};
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws); // seeds frames.get() so describe reaches the model
      await collectUntil(ws, (m) => m.type === "speak" && m.kind === "cash", 2000);
      sendAudio(ws);
      const got = await collectFor(ws, 400);
      assert.ok(
        got.some((m) => m.type === "speak" && m.kind === "answer"),
        `expected an answer speak, got: ${JSON.stringify(got)}`
      );
    } finally {
      ws.close();
    }
  } finally {
    console.error = origError;
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

// ---- Open silent paths: mute / unmute / cancel need an ack (U1-U4, C1-C4) ----

test("utterance mute must emit ack", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "chup");
      const got = await collectFor(ws, 300);
      assert.ok(
        got.some((m) => m.type === "state" && m.muted === true),
        `mute must still apply, got: ${JSON.stringify(got)}`
      );
      assertAck(got);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance unmute must emit ack", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "bol");
      const got = await collectFor(ws, 300);
      assert.ok(
        got.some((m) => m.type === "state" && m.muted === false),
        `unmute must still apply, got: ${JSON.stringify(got)}`
      );
      assertAck(got);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance cancel (look-around off) must emit ack", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "bas");
      assertAck(await collectFor(ws, 300));
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance cancel (look-around on) must emit ack", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendUtterance(ws, "bas");
      const first = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.equal(first.find((m) => m.type === "speak")?.text, "Theek hai");
      assertAck([...first, ...(await collectFor(ws, 300))]);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("audio mute must emit ack", async () => {
  process.env.MOCK_STT_TEXT = "chup";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws);
      assertAck(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio unmute must emit ack", async () => {
  process.env.MOCK_STT_TEXT = "bol";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws);
      assertAck(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio cancel (look-around off) must emit ack", async () => {
  process.env.MOCK_STT_TEXT = "bas";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws);
      assertAck(await collectFor(ws, 400));
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio cancel (look-around on) must emit ack", async () => {
  process.env.MOCK_STT_TEXT = "bas";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendAudio(ws);
      const first = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(first.find((m) => m.type === "speak")?.text, "Theek hai");
      assertAck([...first, ...(await collectFor(ws, 300))]);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

// ---- Already-speaking paths, pinned green ----

test("agent find miss speaks Nahi labhi", async () => {
  const agent = new MockAgentBrain([
    { say: null, positions: [], actions: [{ tool: "find", noun: "Kainchi" }] },
  ]);
  const t = await startTestServer(undefined, agent, undefined, new MockObjectFinder());
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "kainchi kithe hai");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as { reqId: string } | undefined;
      assert.ok(capture?.reqId, `expected capture_now, got: ${JSON.stringify(early)}`);
      sendFrame(ws, { reqId: capture.reqId, lens: "main", hfovDeg: 100 });
      const late = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(late.find((m) => m.type === "speak" && m.kind === "answer")?.text, "Nahi labhi");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("agent remember_person with no face speaks", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    { say: null, positions: [], actions: [{ tool: "remember_person", ref: null, name: "Ravi" }] },
  ]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "eh Ravi hai, yaad rakh");
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(
        got.find((m) => m.type === "speak" && m.kind === "answer")?.text,
        "Saamne koi chehra nahi"
      );
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent throw speaks the unsure fallback", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([new Error("bad JSON")]);
  const t = await startTestServer(undefined, agent);
  const origError = console.error;
  console.error = () => {};
  try {
    const ws = await openClient(t.port);
    try {
      // Chat so the agent runs and throws (vision without an image
      // answers no-camera before the model is reached).
      sendUtterance(ws, "ki haal hai");
      const got = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.deepEqual(got.find((m) => m.type === "speak"), {
        type: "speak",
        id: "spk-1",
        text: "pakka nahi, dobara bolo",
        lang: "pa",
        priority: "P1",
        kind: "answer",
        turnId: "t1",
      });
      assert.ok(got.some((m) => m.type === "earcon" && m.name === "error"), "error earcon sent");
    } finally {
      ws.close();
    }
  } finally {
    console.error = origError;
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent timeout speaks the timeout line", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  process.env.AGENT_TIMEOUT_MS = "30";
  const agent = new SlowAgent(300);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      const turn = await runSilentAgentTurn(ws, "ki haal hai");
      const answers = turn.filter((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.text, "Pakka nahi, dobara puchho");
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    delete process.env.AGENT_TIMEOUT_MS;
    await t.done();
  }
});

test("capture miss with no lastFrame still speaks", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain();
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      // No frame ever sent: capture_now times out and no lastFrame exists.
      // Chat goes to the agent without an image; vision answers no-camera.
      sendUtterance(ws, "ki haal hai");
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(
        got.find((m) => m.type === "speak" && m.kind === "answer")?.text,
        "Mock saamne: counter te samaan 12 vje"
      );
      assert.equal(agent.inputs.length, 1);
      assert.equal(agent.inputs[0]?.image, undefined);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("audio describe timeout speaks the timeout line", async () => {
  process.env.AGENT_TIMEOUT_MS = "30";
  process.env.MOCK_STT_TEXT = "ki hai saamne";
  const t = await startTestServer(undefined, undefined, undefined, undefined, new SlowAnswer(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws); // seeds frames.get() so describe reaches the model
      await collectUntil(ws, (m) => m.type === "speak" && m.kind === "cash", 2000);
      sendAudio(ws);
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(
        got.find((m) => m.type === "speak" && m.kind === "answer")?.text,
        "Pakka nahi, dobara puchho"
      );
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.AGENT_TIMEOUT_MS;
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

// ---- Barge-in: a superseded turn stays silent ----

/** First model call is slow (utterance A), later calls answer at once. */
class BargeAgent implements AgentBrain {
  readonly inputs: AgentInput[] = [];
  async respond(input: AgentInput): Promise<AgentOutput> {
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      await testDelay(400);
      return { say: "Answer A", positions: [], actions: [] };
    }
    return { say: "Answer B", positions: [], actions: [] };
  }
}

test("barge-in: late A stays silent, only B speaks", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new BargeAgent();
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      // Chat (non-vision) so both turns reach the model without an image.
      sendUtterance(ws, "pehla saval sunao");
      await testDelay(80); // A is in its model call when B arrives
      sendUtterance(ws, "dooja saval sunao");
      const got = await collectFor(ws, 1200);
      const answers = got.filter((m) => m.type === "speak" && m.kind === "answer");
      assert.ok(
        answers.some((m) => m.text === "Answer B"),
        `B must speak, got: ${JSON.stringify(answers)}`
      );
      assert.ok(
        !answers.some((m) => m.text === "Answer A"),
        `late A must stay silent, got: ${JSON.stringify(answers)}`
      );
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("/stats shows silentTurnsRescued", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([{ say: null, positions: [], actions: [] }]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "ki haal hai");
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(got.find((m) => m.type === "speak" && m.kind === "answer")?.text, "pakka nahi, dobara bolo");
      const res = await fetch(`http://127.0.0.1:${t.port}/stats`);
      const stats = (await res.json()) as { silentTurnsRescued: number };
      assert.equal(stats.silentTurnsRescued, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});
