// Integration: frame in over WS -> mock triage -> speak out;
// audio in -> mock STT -> intent -> answer out; utterance in -> fast path
// or mock agent (capture_now round trip) -> speak out; REST enrollment;
// mode on -> scene summary -> silence -> new-person clock line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./index.js";
import { MockAgentBrain } from "./adapters/agent.js";
import type { AgentBrain } from "./adapters/agent.js";
import { MockVisionTriage } from "./adapters/mocks.js";
import type { NamedTriage } from "./adapters/index.js";
import type { SceneTriage } from "./protocol.js";
import { PeopleStore } from "./faces/store.js";
import type { FaceEmbedder } from "./faces/embed.js";

class FixedEmbedder implements FaceEmbedder {
  constructor(private readonly embedding: number[]) {}
  async embed(_jpeg: Buffer): Promise<Array<{ embedding: number[]; score: number }>> {
    return [{ embedding: [...this.embedding], score: 0.95 }];
  }
}

async function startTestServer(
  embedder?: FaceEmbedder,
  agent?: AgentBrain,
  triage?: NamedTriage
): Promise<{
  port: number;
  done: () => Promise<void>;
}> {
  process.env.PROVIDER = "mock";
  const store = new PeopleStore(":memory:");
  const server = await startServer(0, { store, embedder, agent, triage });
  return {
    port: server.port,
    done: async () => {
      await server.close();
      store.close();
    },
  };
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for speak")), 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
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

function sendSceneFrame(ws: WebSocket): void {
  sendFrame(ws, { lens: "ultrawide", hfovDeg: 100 });
}

test("frame over WS yields a speak message (mock provider)", async () => {
  const t = await startTestServer();
  try {
    const health = await fetch(`http://127.0.0.1:${t.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, provider: "mock" });

    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        id: "spk-1",
        text: "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
        lang: "pa",
        priority: "P1",
        kind: "cash",
      });
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("audio describe command yields the mock answer", async () => {
  process.env.MOCK_STT_TEXT = "ki hai saamne";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      await nextMessage(ws); // proactive note speak first
      sendAudio(ws);
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        id: "spk-2",
        text: "Mock counter: two packets, a phone, one bag left side.",
        lang: "pa",
        priority: "P1",
        kind: "answer",
      });
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio who command with no perception yet says Koi nahi", async () => {
  process.env.MOCK_STT_TEXT = "kaun hai";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendAudio(ws);
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        id: "spk-1",
        text: "Koi nahi",
        lang: "pa",
        priority: "P1",
        kind: "answer",
      });
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("audio how-much command forces a fresh note read", async () => {
  process.env.MOCK_STT_TEXT = "eh kinne da";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      await nextMessage(ws); // proactive note speak first
      sendAudio(ws);
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        id: "spk-2",
        text: "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
        lang: "pa",
        priority: "P1",
        kind: "answer",
      });
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("settings message switches the answer language", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      ws.send(JSON.stringify({ type: "settings", lang: "en" }));
      // Small pause so the settings message is handled before the frame.
      await new Promise((r) => setTimeout(r, 100));
      sendFrame(ws);
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        id: "spk-1",
        text: "500 rupee note",
        lang: "en",
        priority: "P1",
        kind: "cash",
      });
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

async function postPeople(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/people`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

test("enrollment requires consent", async () => {
  const t = await startTestServer(new FixedEmbedder([1, 0]));
  try {
    const photo = Buffer.from("fake-jpeg").toString("base64");
    for (const body of [
      { name: "Ravi", consent: false, photos: [photo] },
      { name: "Ravi", photos: [photo] },
    ]) {
      const res = await postPeople(t.port, body);
      assert.equal(res.status, 400);
      assert.match((res.json as { error: string }).error, /consent is required/);
    }
    const empty = await fetch(`http://127.0.0.1:${t.port}/people`);
    assert.deepEqual(await empty.json(), []);
  } finally {
    await t.done();
  }
});

test("enroll, list and remove a person", async () => {
  const t = await startTestServer(new FixedEmbedder([1, 0]));
  try {
    const photo = Buffer.from("fake-jpeg").toString("base64");
    const created = await postPeople(t.port, { name: "Ravi", consent: true, photos: [photo, photo] });
    assert.equal(created.status, 201);
    assert.equal((created.json as { name: string }).name, "Ravi");
    assert.equal((created.json as { faces: number }).faces, 2);
    const id = (created.json as { id: number }).id;

    const listed = await fetch(`http://127.0.0.1:${t.port}/people`);
    assert.equal(listed.status, 200);
    const people = (await listed.json()) as Array<{ id: number; name: string; faces: number }>;
    assert.equal(people.length, 1);
    assert.equal(people[0].faces, 2);

    const removed = await fetch(`http://127.0.0.1:${t.port}/people/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const gone = await fetch(`http://127.0.0.1:${t.port}/people/${id}`, { method: "DELETE" });
    assert.equal(gone.status, 404);
    const relisted = await fetch(`http://127.0.0.1:${t.port}/people`);
    assert.deepEqual(await relisted.json(), []);
  } finally {
    await t.done();
  }
});

test("enrollment validates name and photos, reports faceless photos", async () => {
  const t = await startTestServer(new FixedEmbedder([1, 0]));
  try {
    const photo = Buffer.from("fake-jpeg").toString("base64");
    const noName = await postPeople(t.port, { name: "  ", consent: true, photos: [photo] });
    assert.equal(noName.status, 400);
    const noPhotos = await postPeople(t.port, { name: "Ravi", consent: true, photos: [] });
    assert.equal(noPhotos.status, 400);
  } finally {
    await t.done();
  }

  const stubbed = await startTestServer(); // stub embedder finds no faces
  try {
    const photo = Buffer.from("fake-jpeg").toString("base64");
    const res = await postPeople(stubbed.port, { name: "Ravi", consent: true, photos: [photo] });
    assert.equal(res.status, 400);
    assert.match((res.json as { error: string }).error, /no face found in photo 1/);
  } finally {
    await stubbed.done();
  }
});

test("v2 hello/listening are accepted and logged", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        ws.send(JSON.stringify({ type: "hello", appVersion: "0.1.0", device: "test" }));
        ws.send(JSON.stringify({ type: "listening", state: "start" }));
        ws.send(JSON.stringify({ type: "listening", state: "stop" }));
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        console.log = origLog;
      }
      assert.ok(
        lines.some((l) => l.includes("listening: start")),
        `expected listening start in logs, got: ${lines.join(" | ")}`
      );
      assert.equal(ws.readyState, WebSocket.OPEN);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance fast path: mute mutes without any capture_now", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "chup");
      const got = await collectFor(ws, 300);
      assert.ok(
        got.some((m) => m.type === "state" && m.muted === true),
        `expected muted state, got: ${JSON.stringify(got)}`
      );
      assert.ok(
        got.every((m) => m.type !== "capture_now"),
        "fast path must not request a frame"
      );
      assert.ok(
        got.every((m) => m.type !== "speak"),
        "mute stays silent"
      );
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance fast path: howmuch reuses the fresh note read", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      await nextMessage(ws); // proactive note speak first
      sendUtterance(ws, "eh kinne da");
      const got = await collectFor(ws, 300);
      const speak = got.find((m) => m.type === "speak");
      assert.deepEqual(speak, {
        type: "speak",
        id: "spk-2",
        text: "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
        lang: "pa",
        priority: "P1",
        kind: "answer",
      });
      assert.ok(got.every((m) => m.type !== "capture_now"), "fast path must not request a frame");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance agent path: capture_now -> frame -> mock agent -> rendered clock speak", async () => {
  const agent = new MockAgentBrain();
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "ki hai saamne");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as { reqId: string } | undefined;
      assert.ok(capture?.reqId, `expected capture_now, got: ${JSON.stringify(early)}`);
      assert.ok(early.some((m) => m.type === "earcon" && m.name === "thinking"), "thinking earcon sent");
      assert.ok(early.some((m) => m.type === "state" && m.agentBusy === true), "busy state pushed");

      // The capture reply also feeds the proactive engine (cash stays first).
      // The idle state is the last message of the agent turn: wait for it so
      // nothing in the same chunk is missed between collections.
      sendFrame(ws, { reqId: capture.reqId, lens: "main", hfovDeg: 100 });
      const late = await collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
      const answer = late.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answer?.text, "Mock saamne: counter te samaan 12 o'clock");
      assert.equal(answer?.priority, "P1");
      assert.equal(agent.inputs.length, 1);
      assert.ok(agent.inputs[0]?.image, "agent saw the fresh frame");

      const statsRes = await fetch(`http://127.0.0.1:${t.port}/stats`);
      assert.equal(statsRes.status, 200);
      const stats = (await statsRes.json()) as { utterances: number };
      assert.equal(stats.utterances, 1);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("capture_now timeout falls back to the last frame, then to no image", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "50";
  const agent = new MockAgentBrain();
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      // No frame yet: the agent goes without an image.
      sendUtterance(ws, "ki hai saamne");
      await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(agent.inputs.length, 1);
      assert.equal(agent.inputs[0]?.image, undefined);

      // Fresh frame (< 5 s): the agent gets it despite the timeout.
      sendFrame(ws);
      await collectUntil(ws, (m) => m.type === "speak" && m.kind === "cash", 2000);
      sendUtterance(ws, "hor ki hai");
      await collectUntil(ws, (m) => m.type === "speak" && m.text === "Mock saamne: counter te samaan 12 o'clock", 2000);
      assert.equal(agent.inputs.length, 2);
      assert.ok(agent.inputs[1]?.image, "agent fell back to the last frame");
      assert.equal(agent.inputs[1]?.image?.hfovDeg, 66);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent failure speaks the unsure fallback plus earcon:error", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([new Error("spark exploded")]);
  const t = await startTestServer(undefined, agent);
  const origError = console.error;
  console.error = () => {};
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "ki hai saamne");
      const got = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.deepEqual(
        got.find((m) => m.type === "speak"),
        { type: "speak", id: "spk-1", text: "pakka nahi, dobara bolo", lang: "pa", priority: "P1", kind: "answer" }
      );
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

test("agent look_around action toggles the session and pushes state", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    { say: "Look around on", positions: [], actions: [{ tool: "look_around", on: true }] },
  ]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "look around on karo");
      const got = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.equal(got.find((m) => m.type === "speak")?.text, "Look around on");
      assert.ok(
        got.some((m) => m.type === "state" && m.lookAround === true),
        `expected look-around state, got: ${JSON.stringify(got)}`
      );
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

test("agent history trims to the last 10 turns", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    { say: "jawab", positions: [], actions: [] },
  ]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      for (let i = 0; i < 7; i++) {
        sendUtterance(ws, `sawal ${i}`);
        await collectUntil(ws, (m) => m.type === "speak", 2000);
      }
      assert.equal(agent.inputs.length, 7);
      assert.equal(agent.inputs[0]?.history.length, 0);
      assert.equal(agent.inputs[1]?.history.length, 2);
      assert.equal(agent.inputs[5]?.history.length, 10);
      assert.equal(agent.inputs[6]?.history.length, 10);
      assert.equal(agent.inputs[6]?.history[0]?.text, "sawal 1");
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});

const LOOK_SCENE: SceneTriage = {
  notes: [{ denomination: 500, confidence: 0.9 }],
  people: [],
  objects: [{ label: "kursi", x: 0.5, y: 0.6, distance: "mid", salience: 2 }],
};

const LOOK_SCENE_WITH_PERSON: SceneTriage = {
  notes: [{ denomination: 500, confidence: 0.9 }],
  people: [{ position: "centre", distance: "near", gender: "man", x: 0.2, y: 0.4 }],
  objects: [{ label: "kursi", x: 0.5, y: 0.6, distance: "mid", salience: 2 }],
};

test("look-around: mode on -> cash + summary -> silence -> one person clock line", async () => {
  const triage = new MockVisionTriage(undefined, [
    LOOK_SCENE,
    LOOK_SCENE,
    LOOK_SCENE,
    LOOK_SCENE_WITH_PERSON,
    LOOK_SCENE_WITH_PERSON,
  ]);
  const t = await startTestServer(undefined, undefined, triage);
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      const mode = await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      assert.ok(mode.length > 0, "server pushes look-around state");

      // First scene frame: cash P1 first, then the summary P2.
      sendSceneFrame(ws);
      const first = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "scene", 2000);
      const cash = first.find((m) => m.kind === "cash");
      assert.equal(cash?.text, "ਪੰਜ ਸੌ ਦਾ ਨੋਟ");
      assert.equal(cash?.priority, "P1");
      const summary = first.find((m) => m.kind === "scene");
      assert.equal(summary?.text, "Saamne: kursi 12 o'clock");
      assert.equal(summary?.priority, "P2");

      // Identical frames: the same note and scene stay silent.
      sendSceneFrame(ws);
      sendSceneFrame(ws);
      const quiet = await collectFor(ws, 400);
      assert.ok(
        quiet.every((m) => m.type !== "speak"),
        `expected silence, got: ${JSON.stringify(quiet)}`
      );

      // A new person: first sighting is silent (stability), the second
      // speaks exactly one person line with a clock, no scene duplicate.
      sendSceneFrame(ws);
      const stabilising = await collectFor(ws, 400);
      assert.ok(
        stabilising.every((m) => m.type !== "speak"),
        `first sighting must stay silent, got: ${JSON.stringify(stabilising)}`
      );
      sendSceneFrame(ws);
      const arrival = await collectUntil(ws, (m) => m.type === "speak", 2000);
      const speaks = arrival.filter((m) => m.type === "speak");
      assert.equal(speaks.length, 1);
      assert.equal(speaks[0]?.kind, "people");
      assert.equal(speaks[0]?.priority, "P3");
      assert.equal(speaks[0]?.text, "Ik banda, 11 o'clock");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("bas with look-around on turns it off with Theek hai", async () => {
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendUtterance(ws, "bas");
      // The speak is the last message of the turn: collect until it so the
      // earlier state in the same chunk is not dropped.
      const got = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.ok(
        got.some((m) => m.type === "state" && m.lookAround === false),
        `expected look-around off state, got: ${JSON.stringify(got)}`
      );
      assert.ok(
        got.some((m) => m.type === "speak" && m.text === "Theek hai" && m.priority === "P1"),
        `expected Theek hai, got: ${JSON.stringify(got)}`
      );
      // Back on the cash path: the next frame speaks cash, never a summary.
      sendFrame(ws);
      const after = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.equal(after.find((m) => m.type === "speak")?.kind, "cash");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("hor ki hai pages the scene as P1, then reports nothing notable", async () => {
  const big: SceneTriage = {
    notes: [],
    people: [],
    objects: [
      { label: "phone", x: 0.5, y: 0.5, distance: "near", salience: 3 },
      { label: "darwaza", x: 0.8, y: 0.5, distance: "mid", salience: 3 },
      { label: "thaila", x: 0.6, y: 0.5, distance: "near", salience: 2 },
      { label: "switch", x: 0.4, y: 0.5, distance: "mid", salience: 2 },
      { label: "kursi", x: 0.5, y: 0.5, distance: "far", salience: 2 },
    ],
  };
  const triage = new MockVisionTriage(undefined, [big]);
  const t = await startTestServer(undefined, undefined, triage);
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendSceneFrame(ws);
      const first = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "scene", 2000);
      assert.equal(
        first.find((m) => m.kind === "scene")?.text,
        "Saamne: phone 12 o'clock, darwaza 1 o'clock, thaila 12 o'clock"
      );

      sendUtterance(ws, "hor ki hai");
      const page = await collectUntil(ws, (m) => m.type === "speak", 2000);
      const paging = page.find((m) => m.type === "speak");
      assert.equal(paging?.priority, "P1");
      assert.equal(paging?.kind, "answer");
      assert.equal(paging?.text, "Hor: switch 12 o'clock, kursi 12 o'clock");
      assert.ok(
        page.every((m) => m.type !== "capture_now"),
        "paging must not request a frame"
      );

      sendUtterance(ws, "hor ki hai");
      const empty = await collectUntil(ws, (m) => m.type === "speak", 2000);
      assert.equal(empty.find((m) => m.type === "speak")?.text, "Kujh khaas nahi");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("mode off clears narration; re-activation re-summarises", async () => {
  const triage = new MockVisionTriage(undefined, [LOOK_SCENE]);
  const t = await startTestServer(undefined, undefined, triage);
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendSceneFrame(ws);
      const first = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "scene", 2000);
      const text = first.find((m) => m.kind === "scene")?.text;
      assert.equal(text, "Saamne: kursi 12 o'clock");

      sendMode(ws, false);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === false, 2000);
      sendMode(ws, true);
      await collectUntil(ws, (m) => m.type === "state" && m.lookAround === true, 2000);
      sendSceneFrame(ws);
      const second = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "scene", 2000);
      assert.equal(second.find((m) => m.kind === "scene")?.text, text);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("agent look_around action starts narration on the next frame", async () => {
  process.env.CAPTURE_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    { say: "Look around on", positions: [], actions: [{ tool: "look_around", on: true }] },
  ]);
  const triage = new MockVisionTriage(undefined, [LOOK_SCENE]);
  const t = await startTestServer(undefined, agent, triage);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "look around on karo");
      const turn = await collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
      assert.ok(
        turn.some((m) => m.type === "state" && m.lookAround === true),
        `expected look-around state, got: ${JSON.stringify(turn)}`
      );
      assert.ok(
        turn.some((m) => m.type === "speak" && m.text === "Look around on"),
        "agent confirmation spoken"
      );
      sendSceneFrame(ws);
      const scene = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "scene", 2000);
      assert.equal(scene.find((m) => m.kind === "scene")?.priority, "P2");
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.CAPTURE_TIMEOUT_MS;
    await t.done();
  }
});
