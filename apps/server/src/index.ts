// EyeSmart server: plain node:http + ws, one process.
// Frame in -> triage + faces -> decision engine -> speak out.
// Run: PROVIDER=mock node dist/index.js

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
import { createAdapters, providerFromEnv } from "./adapters/factory.js";
import { DecisionEngine } from "./decision.js";

export interface ServerHandles {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(port: number): Promise<ServerHandles> {
  const provider = providerFromEnv();
  const adapters = createAdapters(provider);
  const frames = new LatestFrameStore();
  // TODO(M3): pass the phrase builder as the engine renderer.
  const engine = new DecisionEngine();

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
      void handleMessage(String(data)).then((replies) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const reply of replies) ws.send(JSON.stringify(reply));
      });
    });
  });

  async function handleMessage(raw: string): Promise<SpeakMessage[]> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [];
    }
    if (isFrameMessage(msg)) {
      const jpeg = Buffer.from(msg.jpegBase64, "base64");
      frames.set({ jpeg, width: msg.width, height: msg.height, ts: msg.ts, receivedAt: Date.now() });
      try {
        const [result, hits] = await Promise.all([
          adapters.triage.triage(jpeg),
          adapters.faces.match(jpeg),
        ]);
        engine.onFrame(result, hits);
      } catch (err) {
        console.error("perception failed:", err instanceof Error ? err.message : err);
        return [];
      }
      return engine.takeSpeak().map((a) => ({ type: "speak", text: a.text, lang: a.lang, priority: a.priority }));
    }
    if (isAudioMessage(msg)) {
      // TODO(M4): STT + intent router.
      return [];
    }
    if (isCommandMessage(msg)) {
      if (msg.name === "mute") engine.setMuted(true);
      else if (msg.name === "unmute") engine.setMuted(false);
      else engine.cancel();
      return [];
    }
    return [];
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
