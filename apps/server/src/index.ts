// EyeSmart server, M0 skeleton: plain node:http + ws, one process.
// Frame in -> mock triage -> speak out. Run: PROVIDER=mock node dist/index.js

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  isAudioMessage,
  isCommandMessage,
  isFrameMessage,
  type SpeakMessage,
} from "./protocol.js";
import { LatestFrameStore } from "./store.js";
import { createVisionTriage, providerFromEnv } from "./adapters.js";

export interface ServerHandles {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(port: number): Promise<ServerHandles> {
  const provider = providerFromEnv();
  const vision = createVisionTriage(provider);
  const frames = new LatestFrameStore();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, provider }));
      return;
    }
    if (req.method === "GET" && req.url === "/frame/latest") {
      const f = frames.get();
      if (!f) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no frame yet" }));
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(f.jpeg);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data) => {
      void handleMessage(String(data)).then((reply) => {
        if (reply && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      });
    });
  });

  // TODO(M2): replace this inline rule with the decision engine (stability,
  // dedupe, priority queue). M0 speaks on every confident frame so the
  // camera -> gate -> WS -> mock -> earbud path can be verified end to end.
  async function handleMessage(raw: string): Promise<SpeakMessage | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (isFrameMessage(msg)) {
      const jpeg = Buffer.from(msg.jpegBase64, "base64");
      frames.set({ jpeg, width: msg.width, height: msg.height, ts: msg.ts, receivedAt: Date.now() });
      const result = await vision.triage(jpeg);
      const note = result.notes[0];
      if (note && note.denomination !== null && note.confidence >= 0.5) {
        return { type: "speak", text: "panj sau da note", lang: "pa", priority: "P1" };
      }
      return null;
    }
    if (isAudioMessage(msg)) {
      // TODO(M4): STT + intent router.
      return null;
    }
    if (isCommandMessage(msg)) {
      // TODO(M2): mute/unmute/cancel via the decision engine.
      return null;
    }
    return null;
  }

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() => http.close((err) => (err ? reject(err) : resolve())));
      }),
  };
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8080);
  startServer(port)
    .then((h) => console.log(`eyesmart server on :${h.port} (PROVIDER=${process.env.PROVIDER ?? "mock"})`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
