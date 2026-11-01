// TheThirdEye server: plain node:http + ws, one process.
// Frame in -> triage + faces -> decision engine -> speak out.
// Utterance in -> fast path or Spark agent (fresh frame via capture_now).
// Run: PROVIDER=mock node dist/index.js

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  isAudioMessage,
  isCommandMessage,
  isFrameMessage,
  isHelloMessage,
  isListeningMessage,
  isSettingsMessage,
  isUtteranceMessage,
  type DownMessage,
  type SpeakKind,
  type SpeakMessage,
} from "./protocol.js";
import { LatestFrameStore } from "./store.js";
import { createAdapters, providerFromEnv } from "./adapters/factory.js";
import type { AgentBrain, AgentOutput } from "./adapters/agent.js";
import { DecisionEngine, FACE_MATCH_THRESHOLD, type DecisionEvent } from "./decision.js";
import {
  renderAgentUnsure,
  renderFind,
  renderProactive,
  summarizePeople,
  type PersonBits,
} from "./phrases.js";
import { renderPositions } from "./clock.js";
import { applyAgentActions } from "./actions.js";
import { Session, sceneFromPerception, type SessionFrame } from "./session.js";
import { UtteranceStats } from "./stats.js";
import { routeIntent } from "./intent.js";
import type { FaceHit, TriageResult } from "./protocol.js";
import { PeopleStore } from "./faces/store.js";
import { StubFaceEmbedder, type FaceEmbedder } from "./faces/embed.js";
import { defaultDbPath } from "./faces/index.js";

export interface ServerHandles {
  port: number;
  close: () => Promise<void>;
}

export interface ServerOpts {
  store?: PeopleStore;
  embedder?: FaceEmbedder;
  /** Override the agent brain (tests inject a scripted mock). */
  agent?: AgentBrain;
}

/** How long an utterance waits for its capture_now frame (prompt 02: 800 ms). */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 800;
/** A stored frame older than this is too stale to show the agent. */
export const LAST_FRAME_MAX_AGE_MS = 5000;
/** HFOV fallback when a frame carries none (main lens until calibrated). */
export const DEFAULT_HFOV_DEG = 66;

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function captureTimeoutFromEnv(): number {
  const raw = process.env.CAPTURE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_CAPTURE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`CAPTURE_TIMEOUT_MS=${raw} must be a non-negative integer`);
  }
  return n;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function kindForEvent(e: DecisionEvent): SpeakKind {
  if (e.kind === "COMMAND_ANSWER") return "answer";
  if (e.kind === "NOTE_SEEN" || e.kind === "NOTE_UNSURE") return "cash";
  return "people";
}

export async function startServer(port: number, opts?: ServerOpts): Promise<ServerHandles> {
  const provider = providerFromEnv();
  const ownStore = !opts?.store;
  const people = opts?.store ?? new PeopleStore(defaultDbPath());
  const embedder = opts?.embedder ?? new StubFaceEmbedder();
  const adapters = createAdapters(provider, { store: people });
  const agent = opts?.agent ?? adapters.agent;
  const frames = new LatestFrameStore();
  const stats = new UtteranceStats();
  const captureTimeoutMs = captureTimeoutFromEnv();
  let speakSeq = 0;
  let utterSeq = 0;

  async function handleEnroll(body: unknown): Promise<{ status: number; json: unknown }> {
    const rec = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (rec.consent !== true) {
      return { status: 400, json: { error: "consent is required: this person must agree to be recognised" } };
    }
    if (typeof rec.name !== "string" || !rec.name.trim()) {
      return { status: 400, json: { error: "name is required" } };
    }
    if (!Array.isArray(rec.photos) || rec.photos.length === 0) {
      return { status: 400, json: { error: "at least one photo (base64 JPEG) is required" } };
    }
    if (rec.photos.length > 10 || rec.photos.some((p) => typeof p !== "string")) {
      return { status: 400, json: { error: "photos must be an array of 1-10 base64 strings" } };
    }
    const embeddings: number[][] = [];
    for (let i = 0; i < rec.photos.length; i++) {
      let faces;
      try {
        faces = await embedder.embed(Buffer.from(rec.photos[i] as string, "base64"));
      } catch (err) {
        return { status: 500, json: { error: `face embedding failed: ${err instanceof Error ? err.message : err}` } };
      }
      if (faces.length === 0) {
        return { status: 400, json: { error: `no face found in photo ${i + 1}; please retake it` } };
      }
      embeddings.push(faces[0].embedding);
    }
    return { status: 201, json: people.addPerson(rec.name as string, embeddings) };
  }

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, provider });
        return;
      }
      if (req.method === "GET" && path === "/stats") {
        sendJson(res, 200, stats.snapshot());
        return;
      }
      if (req.method === "GET" && path === "/frame/latest") {
        const f = frames.get();
        if (!f) {
          sendJson(res, 404, { error: "no frame yet" });
          return;
        }
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(f.jpeg);
        return;
      }
      if (req.method === "GET" && path === "/people") {
        sendJson(res, 200, people.listPeople());
        return;
      }
      if (req.method === "POST" && path === "/people") {
        try {
          const out = await handleEnroll(await readJsonBody(req));
          sendJson(res, out.status, out.json);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      const del = req.method === "DELETE" && /^\/people\/(\d+)$/.exec(path);
      if (del) {
        if (people.removePerson(Number(del[1]))) sendJson(res, 200, { deleted: true });
        else sendJson(res, 404, { error: "no such person" });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws: WebSocket) => {
    // One session + engine per WS client; both die with the connection.
    const session = new Session();
    const engine = new DecisionEngine((e) => renderProactive(e, session.lang));
    let lastPerception: { triage: TriageResult; faces: FaceHit[] } | null = null;
    const pendingCaptures = new Map<string, (f: SessionFrame) => void>();

    const send = (msg: DownMessage): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(msg));
    };

    const pushState = (): void => {
      send({
        type: "state",
        lookAround: session.lookAround,
        muted: session.muted,
        agentBusy: session.agentBusy,
        lang: session.lang,
      });
    };

    const drain = (): SpeakMessage[] =>
      engine.takeSpeak().map((a) => ({
        type: "speak",
        id: `spk-${++speakSeq}`,
        text: a.text,
        lang: a.lang,
        priority: a.priority,
        kind: kindForEvent(a.event),
      }));

    const sendDrained = (): void => {
      for (const s of drain()) send(s);
    };

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

    /** Fresh cash read; shared by the howmuch fast path and cash_check. */
    async function cashRead(): Promise<string> {
      const frame = frames.get();
      if (!frame) return renderProactive({ kind: "NOTE_UNSURE" }, session.lang).text;
      const fresh = await adapters.triage.triage(frame.jpeg);
      const top = fresh.notes[0];
      if (top && top.denomination !== null && top.confidence >= 0.5) {
        return renderProactive(
          { kind: "NOTE_SEEN", denominations: [top.denomination], confidences: [top.confidence] },
          session.lang
        ).text;
      }
      return renderProactive({ kind: "NOTE_UNSURE" }, session.lang).text;
    }

    function waitForCapture(reqId: string): Promise<SessionFrame | null> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCaptures.delete(reqId);
          resolve(null);
        }, captureTimeoutMs);
        pendingCaptures.set(reqId, (f) => {
          clearTimeout(timer);
          pendingCaptures.delete(reqId);
          resolve(f);
        });
      });
    }

    function logTimings(
      tRx: number,
      tFrame: number,
      tModelStart: number,
      tModelEnd: number,
      tSpeak: number
    ): void {
      const usage = agent.getLastUsage?.();
      const cost = agent.getLastCostUsd?.();
      console.log(
        `utterance_rx → frame_rx=${tFrame - tRx}ms → model_start=${tModelStart - tFrame}ms → ` +
          `model_end=${tModelEnd - tModelStart}ms → speak_tx=${tSpeak - tModelEnd}ms ` +
          `total=${tSpeak - tRx}ms tokens=${usage ? `${usage.promptTokens}/${usage.completionTokens}` : "n/a"} ` +
          `cost=${cost === null || cost === undefined ? "n/a" : `$${cost.toFixed(6)}`}`
      );
    }

    async function failAgentTurn(
      tRx: number,
      tFrame: number,
      tModelStart: number,
      text: string,
      err: unknown
    ): Promise<void> {
      console.error("agent failed:", err instanceof Error ? err.message : err);
      send({ type: "earcon", name: "error" });
      const fallback = renderAgentUnsure(session.lang);
      engine.answer(fallback, session.lang);
      sendDrained();
      session.pushTurn({ role: "user", text });
      session.pushTurn({ role: "assistant", text: fallback });
      session.agentBusy = false;
      pushState();
      const tEnd = Date.now();
      stats.record({ frameWaitMs: tFrame - tRx, modelMs: tEnd - tModelStart, totalMs: tEnd - tRx });
      logTimings(tRx, tFrame, tModelStart, tEnd, tEnd);
    }

    async function handleUtterance(text: string): Promise<void> {
      console.log(`heard: ${text}`);
      const tRx = Date.now();

      // Fast path: trivial commands never reach the LLM.
      const intent = routeIntent(text);
      if (intent.kind === "mute") {
        engine.setMuted(true);
        session.muted = true;
        pushState();
        console.log(`utterance fast-path (mute) total=${Date.now() - tRx}ms`);
        return;
      }
      if (intent.kind === "unmute") {
        engine.setMuted(false);
        session.muted = false;
        pushState();
        console.log(`utterance fast-path (unmute) total=${Date.now() - tRx}ms`);
        return;
      }
      if (intent.kind === "cancel") {
        engine.cancel();
        console.log(`utterance fast-path (cancel) total=${Date.now() - tRx}ms`);
        return;
      }
      if (intent.kind === "howmuch") {
        engine.cancel();
        engine.answer(await cashRead(), session.lang);
        sendDrained();
        console.log(`utterance fast-path (howmuch) total=${Date.now() - tRx}ms`);
        return;
      }

      // Agent path: fresh frame, then one model call with memory + scene.
      session.agentBusy = true;
      pushState();
      send({ type: "earcon", name: "thinking" });
      const reqId = `u${++utterSeq}`;
      send({ type: "capture_now", reqId });
      const capture = await waitForCapture(reqId);
      const tFrame = Date.now();

      let image: { jpeg: Buffer; hfovDeg: number } | undefined;
      let usedHfov = DEFAULT_HFOV_DEG;
      if (capture) {
        image = { jpeg: capture.jpeg, hfovDeg: capture.hfovDeg };
        usedHfov = capture.hfovDeg;
      } else if (session.lastFrame && Date.now() - session.lastFrame.receivedAt < LAST_FRAME_MAX_AGE_MS) {
        image = { jpeg: session.lastFrame.jpeg, hfovDeg: session.lastFrame.hfovDeg };
        usedHfov = session.lastFrame.hfovDeg;
      }

      const tModelStart = Date.now();
      let output: AgentOutput;
      try {
        output = await agent.respond({
          history: [...session.history],
          utterance: text,
          image,
          scene: session.sceneState,
          lang: session.lang,
          script: session.script,
        });
      } catch (err) {
        await failAgentTurn(tRx, tFrame, tModelStart, text, err);
        return;
      }
      const tModelEnd = Date.now();

      await applyAgentActions(output.actions, { session, engine, send, cashCheck: cashRead });
      const rendered =
        output.say === null ? null : renderPositions(output.say, output.positions, usedHfov, session.lang);
      if (rendered) engine.answer(rendered, session.lang);
      sendDrained();
      session.pushTurn({ role: "user", text });
      session.pushTurn({ role: "assistant", text: rendered ?? "" });
      session.agentBusy = false;
      pushState();
      const tSpeak = Date.now();
      stats.record({
        frameWaitMs: tFrame - tRx,
        modelMs: tModelEnd - tModelStart,
        totalMs: tSpeak - tRx,
      });
      logTimings(tRx, tFrame, tModelStart, tModelEnd, tSpeak);
    }

    async function handleCommand(transcript: string): Promise<void> {
      const intent = routeIntent(transcript);
      const frame = frames.get();
      switch (intent.kind) {
        case "mute":
          engine.setMuted(true);
          session.muted = true;
          return;
        case "unmute":
          engine.setMuted(false);
          session.muted = false;
          return;
        case "cancel":
          engine.cancel();
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
          engine.answer(await adapters.answer.describe(frame.jpeg, transcript), session.lang);
          return;
        }
        case "read": {
          if (!frame) {
            console.log("read with no frame yet; staying silent");
            return;
          }
          engine.cancel();
          engine.answer(await adapters.answer.read(frame.jpeg), session.lang);
          return;
        }
        case "find": {
          engine.cancel();
          const box = frame ? ((await adapters.finder.find(frame.jpeg, intent.noun))[0] ?? null) : null;
          engine.answer(renderFind(intent.noun, box, session.lang), session.lang);
          return;
        }
        case "who": {
          engine.cancel();
          engine.answer(summarizePeople(whoParts(), session.lang), session.lang);
          return;
        }
        case "howmuch": {
          engine.cancel();
          engine.answer(await cashRead(), session.lang);
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
        const hfovDeg = msg.hfovDeg ?? DEFAULT_HFOV_DEG;
        frames.set({ jpeg, width: msg.width, height: msg.height, ts: msg.ts, receivedAt: Date.now() });
        const sessionFrame: SessionFrame = { jpeg, hfovDeg, ts: msg.ts, receivedAt: Date.now() };
        session.lastFrame = sessionFrame;
        if (msg.reqId) pendingCaptures.get(msg.reqId)?.(sessionFrame);
        try {
          const [result, hits] = await Promise.all([
            adapters.triage.triage(jpeg),
            adapters.faces.match(jpeg),
          ]);
          lastPerception = { triage: result, faces: hits };
          session.sceneState = sceneFromPerception(result, hits, session.lookAround);
          engine.onFrame(result, hits);
        } catch (err) {
          console.error("perception failed:", err instanceof Error ? err.message : err);
          return [];
        }
        return drain();
      }
      if (isAudioMessage(msg)) {
        try {
          const pcm = Buffer.from(msg.audioBase64, "base64");
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
        if (msg.name === "mute") {
          engine.setMuted(true);
          session.muted = true;
          pushState();
        } else if (msg.name === "unmute") {
          engine.setMuted(false);
          session.muted = false;
          pushState();
        } else engine.cancel();
        return [];
      }
      if (isHelloMessage(msg)) {
        return [];
      }
      if (isUtteranceMessage(msg)) {
        await handleUtterance(msg.text);
        return [];
      }
      if (isListeningMessage(msg)) {
        console.log(`listening: ${msg.state}`);
        if (msg.state === "start") engine.cancel();
        return [];
      }
      if (isSettingsMessage(msg)) {
        session.lang = msg.lang;
        if (msg.script !== undefined) session.script = msg.script;
        return [];
      }
      return [];
    }

    ws.on("message", (data) => {
      void handleMessage(String(data)).then((replies) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const reply of replies) send(reply);
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close(() =>
          http.close((err) => {
            if (ownStore) {
              try {
                people.close();
              } catch {
                // Ignore close errors on the owned store.
              }
            }
            if (err) reject(err);
            else resolve();
          })
        );
      }),
  };
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8080);
  startServer(port)
    .then((h) => console.log(`thethirdeye server on :${h.port} (PROVIDER=${process.env.PROVIDER ?? "mock"})`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
