// Integration: frame in over WS -> mock triage -> speak out;
// audio in -> mock STT -> intent -> answer out; REST people enrollment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./index.js";
import { PeopleStore } from "./faces/store.js";
import type { FaceEmbedder } from "./faces/embed.js";

class FixedEmbedder implements FaceEmbedder {
  constructor(private readonly embedding: number[]) {}
  async embed(_jpeg: Buffer): Promise<Array<{ embedding: number[]; score: number }>> {
    return [{ embedding: [...this.embedding], score: 0.95 }];
  }
}

async function startTestServer(embedder?: FaceEmbedder): Promise<{
  port: number;
  done: () => Promise<void>;
}> {
  process.env.PROVIDER = "mock";
  const store = new PeopleStore(":memory:");
  const server = await startServer(0, { store, embedder });
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

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

function sendFrame(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "frame",
      jpegBase64: Buffer.from("fake-jpeg").toString("base64"),
      width: 4,
      height: 4,
      ts: Date.now(),
    })
  );
}

function sendAudio(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "audio",
      pcm16Base64: Buffer.from("fake-pcm").toString("base64"),
      sampleRate: 16000,
      ts: Date.now(),
    })
  );
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
        text: "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
        lang: "pa",
        priority: "P1",
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
        text: "Mock counter: two packets, a phone, one bag left side.",
        lang: "pa",
        priority: "P1",
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
        text: "Koi nahi",
        lang: "pa",
        priority: "P1",
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
        text: "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
        lang: "pa",
        priority: "P1",
      });
    } finally {
      ws.close();
    }
  } finally {
    delete process.env.MOCK_STT_TEXT;
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
