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
import { DecisionEngine, FACE_MATCH_THRESHOLD } from "./decision.js";
import { renderFind, renderProactive, summarizePeople, type PersonBits } from "./phrases.js";
import { routeIntent } from "./intent.js";
import type { FaceHit, TriageResult } from "./protocol.js";

export interface ServerHandles {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(port: number): Promise<ServerHandles> {
  const provider = providerFromEnv();
  const adapters = createAdapters(provider);
  const frames = new LatestFrameStore();
  // TODO(M6): language comes from the phone settings screen; pa until then.
  const engine = new DecisionEngine((e) => renderProactive(e, "pa"));
  let lastPerception: { triage: TriageResult; faces: FaceHit[] } | null = null;

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

  const drain = (): SpeakMessage[] =>
    engine
      .takeSpeak()
      .map((a) => ({ type: "speak", text: a.text, lang: a.lang, priority: a.priority }));

  function whoParts(): PersonBits[] {
    if (!lastPerception) return [];
    const known = lastPerception.faces.filter(
      (h) => h.personId && h.name && h.score >= FACE_MATCH_THRESHOLD
    );
    const parts: PersonBits[] = known.map((h, i) => {
      const p = lastPerception?.triage.people[i];
      return { name: h.name ?? undefined, position: p?.position ?? "centre", distance: p?.distance ?? "near" };
    });
    for (const p of lastPerception.triage.people.slice(known.length)) {
      parts.push({ position: p.position, distance: p.distance, gender: p.gender });
    }
    return parts;
  }

  async function handleCommand(transcript: string): Promise<void> {
    const intent = routeIntent(transcript);
    const frame = frames.get();
    switch (intent.kind) {
      case "mute":
        engine.setMuted(true);
        return;
      case "unmute":
        engine.setMuted(false);
        return;
      case "unknown":
        console.log(`ignoring unparseable command: ${transcript}`);
        return;
      case "describe": {
        if (!frame) {
          console.log("describe with no frame yet; staying silent");
          return;
        }
        engine.cancel();
        engine.answer(await adapters.answer.describe(frame.jpeg, transcript), "pa");
        return;
      }
      case "read": {
        if (!frame) {
          console.log("read with no frame yet; staying silent");
          return;
        }
        engine.cancel();
        engine.answer(await adapters.answer.read(frame.jpeg), "pa");
        return;
      }
      case "find": {
        engine.cancel();
        const box = frame ? ((await adapters.finder.find(frame.jpeg, intent.noun))[0] ?? null) : null;
        engine.answer(renderFind(intent.noun, box, "pa"), "pa");
        return;
      }
      case "who": {
        engine.cancel();
        engine.answer(summarizePeople(whoParts(), "pa"), "pa");
        return;
      }
      case "howmuch": {
        engine.cancel();
        if (!frame) {
          engine.answer(renderProactive({ kind: "NOTE_UNSURE" }, "pa").text, "pa");
          return;
        }
        const fresh = await adapters.triage.triage(frame.jpeg);
        const top = fresh.notes[0];
        if (top && top.denomination !== null && top.confidence >= 0.5) {
          engine.answer(
            renderProactive(
              { kind: "NOTE_SEEN", denominations: [top.denomination], confidences: [top.confidence] },
              "pa"
            ).text,
            "pa"
          );
        } else {
          engine.answer(renderProactive({ kind: "NOTE_UNSURE" }, "pa").text, "pa");
        }
        return;
      }
    }
  }

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
        lastPerception = { triage: result, faces: hits };
        engine.onFrame(result, hits);
      } catch (err) {
        console.error("perception failed:", err instanceof Error ? err.message : err);
        return [];
      }
      return drain();
    }
    if (isAudioMessage(msg)) {
      try {
        const pcm = Buffer.from(msg.pcm16Base64, "base64");
        const transcript = await adapters.stt.transcribe(pcm);
        if (transcript.trim()) {
          console.log(`heard: ${transcript}`);
          await handleCommand(transcript);
        }
      } catch (err) {
        console.error("command failed:", err instanceof Error ? err.message : err);
        return [];
      }
      return drain();
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
