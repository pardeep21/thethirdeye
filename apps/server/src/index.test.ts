// Integration: frame in over WS -> mock triage -> speak out;
// audio in -> mock STT -> intent -> answer out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./index.js";

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
  process.env.PROVIDER = "mock";
  const server = await startServer(0);
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, provider: "mock" });

    const ws = await openClient(server.port);
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
    await server.close();
  }
});

test("audio describe command yields the mock answer", async () => {
  process.env.PROVIDER = "mock";
  process.env.MOCK_STT_TEXT = "ki hai saamne";
  const server = await startServer(0);
  try {
    const ws = await openClient(server.port);
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
    await server.close();
  }
});

test("audio who command with no perception yet says Koi nahi", async () => {
  process.env.PROVIDER = "mock";
  process.env.MOCK_STT_TEXT = "kaun hai";
  const server = await startServer(0);
  try {
    const ws = await openClient(server.port);
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
    await server.close();
  }
});

test("audio how-much command forces a fresh note read", async () => {
  process.env.PROVIDER = "mock";
  process.env.MOCK_STT_TEXT = "eh kinne da";
  const server = await startServer(0);
  try {
    const ws = await openClient(server.port);
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
    await server.close();
  }
});
