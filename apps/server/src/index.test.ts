// Integration: frame in over WS -> mock triage -> speak out;
// audio in -> mock STT -> intent -> answer out; utterance in -> fast path
// or mock agent (capture_now round trip) -> speak out; REST enrollment;
// mode on -> scene summary -> silence -> new-person clock line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import sharp from "sharp";
import { startServer } from "./index.js";
import { MockAgentBrain } from "./adapters/agent.js";
import type { AgentBrain, AgentInput, AgentOutput, MockAgentScript } from "./adapters/agent.js";
import { MockObjectFinder, MockVisionTriage } from "./adapters/mocks.js";
import type { NamedTriage, ObjectFinder, VisionAnswer } from "./adapters/index.js";
import type { Box, SceneTriage, TriageResult } from "./protocol.js";
import { PeopleStore } from "./faces/store.js";
import type { DetectedFace, FaceEmbedder } from "./faces/embed.js";

class FixedEmbedder implements FaceEmbedder {
  constructor(private readonly embedding: number[]) {}
  async embed(_jpeg: Buffer): Promise<DetectedFace[]> {
    return [
      {
        box: [0, 0, 100, 100],
        boxNorm: [0, 0, 0.5, 0.5],
        score: 0.95,
        quality: { blur: 200, yawDeg: 0, sizePx: 100 },
        embedding: [...this.embedding],
      },
    ];
  }
}

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

test("voice enrollment over WS: remember -> consent -> saved -> known arrival", async () => {
  const agent = new MockAgentBrain([
    { say: null, positions: [], actions: [{ tool: "remember_person", ref: "P1", name: "Ravi" }] },
    { say: null, positions: [], actions: [{ tool: "confirm_consent", name: "Ravi", granted: true }] },
  ]);
  // Distinct notes make the three seed frames observable (one speak each);
  // capture replies and later frames stay silent.
  const triage = new MockVisionTriage([
    { notes: [{ denomination: 500, confidence: 0.9 }], people: [] },
    { notes: [{ denomination: 100, confidence: 0.9 }], people: [] },
    { notes: [{ denomination: 50, confidence: 0.9 }], people: [] },
    { notes: [], people: [] },
  ]);
  const t = await startTestServer(new FixedEmbedder([1, 0]), agent, triage);
  try {
    const ws = await openClient(t.port);
    try {
      for (const want of ["ਪੰਜ ਸੌ ਦਾ ਨੋਟ", "ਸੌ ਦਾ ਨੋਟ", "ਪੰਜਾਹ ਦਾ ਨੋਟ"]) {
        sendFrame(ws);
        const raw = await nextMessage(ws);
        assert.equal((JSON.parse(raw) as { text: string }).text, want);
      }

      // Turn 1: name the face -> the deterministic consent question speaks.
      sendUtterance(ws, "eh Ravi hai, yaad rakh");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const cap1 = early.find((m) => m.type === "capture_now") as { reqId: string };
      sendFrame(ws, { reqId: cap1.reqId });
      const asked = await collectUntil(
        ws,
        (m) => m.type === "speak" && m.kind === "answer",
        2000
      );
      const ask = asked.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(ask?.text, "Ravi nu yaad rakhaan? Haan ya na dasso");
      assert.equal(agent.inputs.length, 1);
      assert.equal(agent.inputs[0]?.scene.people[0]?.ref, "P1");

      // Turn 2: "haan" -> enrolled with voice consent, nothing else speaks.
      sendUtterance(ws, "haan");
      const early2 = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const cap2 = early2.find((m) => m.type === "capture_now") as { reqId: string };
      sendFrame(ws, { reqId: cap2.reqId });
      const saved = await collectUntil(
        ws,
        (m) => m.type === "speak" && m.kind === "answer",
        2000
      );
      const savedSpeak = saved.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(savedSpeak?.text, "Ravi yaad ho gaya");
      // The agent's history carries the consent question, so "haan" resolves.
      assert.ok(
        agent.inputs[1]?.history.some(
          (h) => h.role === "assistant" && h.text === "Ravi nu yaad rakhaan? Haan ya na dasso"
        )
      );

      const listed = (await (await fetch(`http://127.0.0.1:${t.port}/people`)).json()) as Array<{
        name: string;
        consent_method: string;
        consent_text: string;
      }>;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].name, "Ravi");
      assert.equal(listed[0].consent_method, "voice");
      assert.equal(listed[0].consent_text, "haan");

      // Two more frames: the enrolled face is recognised (2-of-3) with a clock.
      sendFrame(ws);
      sendFrame(ws);
      const known = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "people", 2000);
      const arrival = known.find((m) => m.type === "speak" && m.kind === "people");
      assert.equal(arrival?.text, "Ravi ਆ ਗਿਆ, 11 o'clock");
      assert.equal(arrival?.priority, "P2");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance find action: capture on the current lens -> clock speak", async () => {
  const agent = new MockAgentBrain([
    { say: null, positions: [], actions: [{ tool: "find", noun: "Kainchi" }] },
  ]);
  const finder = new MockObjectFinder([{ x: 0.9, y: 0.6, distance: "near", confidence: 0.9 }]);
  const t = await startTestServer(undefined, agent, undefined, finder);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "kainchi kithe hai");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as {
        reqId: string;
        lens?: string;
      };
      assert.ok(capture?.reqId);
      assert.equal(capture.lens, undefined); // find uses the current lens
      sendFrame(ws, { reqId: capture.reqId, lens: "main", hfovDeg: 100 });
      const late = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      const answer = late.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answer?.text, "Kainchi, 1 o'clock, nede");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("utterance read captures on main; hor continues the label", async () => {
  const full = Array.from({ length: 25 }, (_, i) => `w${i + 1}`).join(" ");
  const agent = new MockAgentBrain([
    { say: "w1 w2 w3 w4 w5 w6 w7 w8 hor?", positions: [], actions: [], readText: full },
  ]);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "eh padh");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as {
        reqId: string;
        lens?: string;
      };
      assert.equal(capture?.lens, "main"); // reads use the sharper lens
      sendFrame(ws, { reqId: capture.reqId, lens: "main", hfovDeg: 66 });
      const late = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      const answer = late.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answer?.text, "w1 w2 w3 w4 w5 w6 w7 w8 hor?");

      // Continuation is a fast path: no new capture, next 20-word chunk.
      sendUtterance(ws, "hor");
      const cont = await collectFor(ws, 500);
      const chunk = cont.find((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(chunk?.text, "w21 w22 w23 w24 w25");
      assert.ok(cont.every((m) => m.type !== "capture_now"), "continuation needs no frame");
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

test("ultra-wide frames reach the cash prompt as a centre crop", async () => {
  const triage = new MockVisionTriage();
  const t = await startTestServer(undefined, undefined, triage);
  try {
    const ws = await openClient(t.port);
    try {
      const jpeg = await sharp({
        create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 100, b: 50 } },
      })
        .jpeg()
        .toBuffer();
      ws.send(
        JSON.stringify({
          type: "frame",
          jpegBase64: jpeg.toString("base64"),
          width: 100,
          height: 80,
          lens: "ultrawide",
          ts: Date.now(),
        })
      );
      await nextMessage(ws); // cash speak proves the frame was triaged
      assert.equal(triage.imgs.length, 1);
      const cropped = await sharp(triage.imgs[0]).metadata();
      assert.equal(cropped.width, 60);
      assert.equal(cropped.height, 48);

      // Main-lens frames pass through untouched.
      ws.send(
        JSON.stringify({
          type: "frame",
          jpegBase64: jpeg.toString("base64"),
          width: 100,
          height: 80,
          lens: "main",
          ts: Date.now(),
        })
      );
      await collectFor(ws, 300);
      assert.equal(triage.imgs.length, 2);
      const full = await sharp(triage.imgs[1]).metadata();
      assert.equal(full.width, 100);
      assert.equal(full.height, 80);
    } finally {
      ws.close();
    }
  } finally {
    await t.done();
  }
});

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function sendHello(ws: WebSocket, token?: string): void {
  ws.send(
    JSON.stringify({
      type: "hello",
      appVersion: "test",
      device: "test",
      ...(token !== undefined ? { token } : {}),
    })
  );
}

test("APP_TOKEN set: messages before hello are rejected with 4401", async () => {
  process.env.APP_TOKEN = "s3cret";
  const t = await startTestServer();
  try {
    const ws = await openClient(t.port);
    try {
      const closed = waitForClose(ws);
      sendFrame(ws);
      const { code } = await closed;
      assert.equal(code, 4401);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.APP_TOKEN;
    await t.done();
  }
});

test("APP_TOKEN set: wrong-token hello is rejected, right token admitted", async () => {
  process.env.APP_TOKEN = "s3cret";
  const t = await startTestServer();
  try {
    const bad = await openClient(t.port);
    try {
      const closed = waitForClose(bad);
      sendHello(bad, "wrong");
      assert.equal((await closed).code, 4401);
    } finally {
      bad.close();
    }
    const good = await openClient(t.port);
    try {
      sendHello(good, "s3cret");
      sendFrame(good);
      const raw = await nextMessage(good);
      assert.equal((JSON.parse(raw) as { type: string }).type, "speak");
    } finally {
      good.close();
    }
  } finally {
    delete process.env.APP_TOKEN;
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

// ---- Model timeout guards (overnight T1): fake slow adapters ----

const testDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function statsTimeouts(port: number): Promise<Record<string, number>> {
  const res = await fetch(`http://127.0.0.1:${port}/stats`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { timeouts: Record<string, number> }).timeouts;
}

class SlowTriage extends MockVisionTriage {
  constructor(private readonly delayMs: number) {
    super();
  }
  override async triage(img: Buffer): Promise<TriageResult> {
    await testDelay(this.delayMs);
    return super.triage(img);
  }
  override async triageScene(img: Buffer): Promise<SceneTriage> {
    await testDelay(this.delayMs);
    return super.triageScene(img);
  }
}

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

class SlowFinder extends MockObjectFinder {
  constructor(private readonly delayMs: number) {
    super([{ x: 0.5, y: 0.5, distance: "mid", confidence: 0.9 }]);
  }
  override async find(img: Buffer, noun: string): Promise<Box[]> {
    await testDelay(this.delayMs);
    return super.find(img, noun);
  }
  override async locate(img: Buffer, noun: string) {
    await testDelay(this.delayMs);
    return super.locate(img, noun);
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

test("timeout: slow proactive cash triage drops silently + counts stats", async () => {
  process.env.TRIAGE_TIMEOUT_MS = "30";
  const t = await startTestServer(undefined, undefined, new SlowTriage(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      // Window covers the late resolve at 300ms: nothing may speak, ever.
      const got = await collectFor(ws, 500);
      assert.ok(
        got.every((m) => m.type !== "speak"),
        `proactive timeout must stay silent, got: ${JSON.stringify(got)}`
      );
      assert.equal((await statsTimeouts(t.port)).triage, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.TRIAGE_TIMEOUT_MS;
    await t.done();
  }
});

test("timeout: slow proactive scene triage drops silently + counts stats", async () => {
  process.env.TRIAGE_TIMEOUT_MS = "30";
  const t = await startTestServer(undefined, undefined, new SlowTriage(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendMode(ws, true);
      await testDelay(20);
      sendSceneFrame(ws);
      const got = await collectFor(ws, 500);
      assert.ok(
        got.every((m) => m.type !== "speak"),
        `scene timeout must stay silent, got: ${JSON.stringify(got)}`
      );
      assert.equal((await statsTimeouts(t.port)).scene, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.TRIAGE_TIMEOUT_MS;
    await t.done();
  }
});

test("timeout: slow agent speaks the pa line, clears busy, discards the late result", async () => {
  process.env.AGENT_TIMEOUT_MS = "30";
  const agent = new SlowAgent(300);
  const t = await startTestServer(undefined, agent);
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "ki hai saamne");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as { reqId: string };
      sendFrame(ws, { reqId: capture.reqId });
      const turn = await collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
      // The capture frame may speak fast cash (kind cash); the answer is the line.
      const answers = turn.filter((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.text, "Pakka nahi, dobara puchho");
      assert.equal(answers[0]?.priority, "P1");
      // Past the agent's 300ms resolve: the slow call did run (input
      // recorded) but its late result was discarded: no second answer.
      const rest = await collectFor(ws, 500);
      const lateAnswers = rest.filter((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(lateAnswers.length, 0);
      assert.equal(agent.inputs.length, 1);
      assert.equal((await statsTimeouts(t.port)).agent, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.AGENT_TIMEOUT_MS;
    await t.done();
  }
});

test("timeout: agent fallback line in hi and en", async () => {
  process.env.AGENT_TIMEOUT_MS = "30";
  const agent = new SlowAgent(300);
  const t = await startTestServer(undefined, agent);
  try {
    for (const [lang, line] of [
      ["hi", "Pakka nahi, dobara poochho"],
      ["en", "Not sure, ask again"],
    ] as const) {
      const ws = await openClient(t.port);
      try {
        ws.send(JSON.stringify({ type: "settings", lang }));
        await testDelay(20);
        sendUtterance(ws, "ki hai saamne");
        const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
        const capture = early.find((m) => m.type === "capture_now") as { reqId: string };
        sendFrame(ws, { reqId: capture.reqId });
        const turn = await collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
        const answers = turn.filter((m) => m.type === "speak" && m.kind === "answer");
        assert.equal(answers.length, 1, `expected one answer for lang=${lang}`);
        assert.equal(answers[0]?.text, line);
      } finally {
        ws.close();
      }
    }
    assert.equal((await statsTimeouts(t.port)).agent, 2);
  } finally {
    delete process.env.AGENT_TIMEOUT_MS;
    await t.done();
  }
});

test("timeout: slow howmuch speaks the line, never a stale value", async () => {
  process.env.TRIAGE_TIMEOUT_MS = "30";
  const t = await startTestServer(undefined, undefined, new SlowTriage(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws); // seeds frames.get(); its proactive call times out silently
      await testDelay(100);
      sendUtterance(ws, "eh kinne da");
      const got = await collectUntil(ws, (m) => m.type === "speak", 2000);
      const speak = got.find((m) => m.type === "speak") as { text: string; priority: string };
      assert.equal(speak.text, "Pakka nahi, dobara puchho");
      assert.equal(speak.priority, "P1");
      assert.equal((await statsTimeouts(t.port)).triage, 2);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.TRIAGE_TIMEOUT_MS;
    await t.done();
  }
});

test("timeout: slow command find speaks the line", async () => {
  process.env.FIND_TIMEOUT_MS = "30";
  process.env.MOCK_STT_TEXT = "find my red packet";
  const t = await startTestServer(undefined, undefined, undefined, new SlowFinder(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws); // seeds frames.get() with the fast default triage
      await testDelay(100);
      sendAudio(ws);
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(got.find((m) => m.kind === "answer")?.text, "Pakka nahi, dobara puchho");
      assert.equal((await statsTimeouts(t.port)).find, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.FIND_TIMEOUT_MS;
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("timeout: slow command read speaks the line", async () => {
  process.env.AGENT_TIMEOUT_MS = "30";
  process.env.MOCK_STT_TEXT = "read this";
  const t = await startTestServer(undefined, undefined, undefined, undefined, new SlowAnswer(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendFrame(ws);
      await testDelay(100);
      sendAudio(ws);
      const got = await collectUntil(ws, (m) => m.type === "speak" && m.kind === "answer", 2000);
      assert.equal(got.find((m) => m.kind === "answer")?.text, "Pakka nahi, dobara puchho");
      assert.equal((await statsTimeouts(t.port)).answer, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.AGENT_TIMEOUT_MS;
    delete process.env.MOCK_STT_TEXT;
    await t.done();
  }
});

test("timeout: slow agent find action speaks the line once, skips say", async () => {
  process.env.FIND_TIMEOUT_MS = "30";
  const agent = new MockAgentBrain([
    {
      say: "stale say that must not speak",
      positions: [],
      actions: [{ tool: "find", noun: "phone" }],
    },
  ]);
  const t = await startTestServer(undefined, agent, undefined, new SlowFinder(300));
  try {
    const ws = await openClient(t.port);
    try {
      sendUtterance(ws, "find my phone");
      const early = await collectUntil(ws, (m) => m.type === "capture_now", 2000);
      const capture = early.find((m) => m.type === "capture_now") as { reqId: string };
      sendFrame(ws, { reqId: capture.reqId });
      const turn = await collectUntil(ws, (m) => m.type === "state" && m.agentBusy === false, 2000);
      const answers = turn.filter((m) => m.type === "speak" && m.kind === "answer");
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.text, "Pakka nahi, dobara puchho");
      assert.equal((await statsTimeouts(t.port)).find, 1);
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.FIND_TIMEOUT_MS;
    await t.done();
  }
});
