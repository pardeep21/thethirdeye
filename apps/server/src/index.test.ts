// M0 integration: frame in over WS -> mock triage -> speak out.
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

test("frame over WS yields a speak message (mock provider)", async () => {
  process.env.PROVIDER = "mock";
  const server = await startServer(0);
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, provider: "mock" });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    try {
      ws.send(
        JSON.stringify({ type: "frame", jpegBase64: Buffer.from("fake-jpeg").toString("base64"), width: 4, height: 4, ts: Date.now() })
      );
      const raw = await nextMessage(ws);
      assert.deepEqual(JSON.parse(raw), {
        type: "speak",
        text: "note 500",
        lang: "en",
        priority: "P1",
      });
    } finally {
      ws.close();
    }
  } finally {
    await server.close();
  }
});
