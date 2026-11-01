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
  isModeMessage,
  isSettingsMessage,
  isUtteranceMessage,
  type DownMessage,
  type SpeakKind,
  type SpeakMessage,
} from "./protocol.js";
import { LatestFrameStore } from "./store.js";
import { centreCrop, uwCashCropFromEnv } from "./images.js";
import { createAdapters, providerFromEnv, type NamedTriage } from "./adapters/factory.js";
import type { AgentBrain, AgentOutput } from "./adapters/agent.js";
import { DecisionEngine, type DecisionEvent } from "./decision.js";
import { SceneNarrator } from "./narration.js";
import {
  renderAgentUnsure,
  renderFind,
  renderOkay,
  renderProactive,
  renderReadMore,
  summarizePeople,
  type PersonBits,
} from "./phrases.js";
import { renderPositions } from "./clock.js";
import { applyAgentActions } from "./actions.js";
import {
  READ_FRESH_MS,
  Session,
  readChunk,
  sceneFromPerception,
  type SessionFrame,
} from "./session.js";
import { UtteranceStats } from "./stats.js";
import { isBareMore, routeIntent } from "./intent.js";
import { PeopleStore } from "./faces/store.js";
import type { FaceEmbedder } from "./faces/embed.js";
import { checkEnrollFace } from "./faces/quality.js";
import { FaceTracker } from "./faces/tracker.js";
import type { MatchedFace, ObjectFinder } from "./adapters/index.js";
import { defaultDbPath, facesEveryNFromEnv, selectEmbedder, shouldRunFaces } from "./faces/index.js";

export interface ServerHandles {
  port: number;
  close: () => Promise<void>;
}

export interface ServerOpts {
  store?: PeopleStore;
  embedder?: FaceEmbedder;
  /** Override the agent brain (tests inject a scripted mock). */
  agent?: AgentBrain;
  /** Override vision triage (tests inject a scripted scene mock). */
  triage?: NamedTriage;
  /** Override the object finder (tests inject a scripted mock). */
  finder?: ObjectFinder;
}

/** How long an utterance waits for its capture_now frame (prompt 02: 800 ms). */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 800;
/** A stored frame older than this is too stale to show the agent. */
export const LAST_FRAME_MAX_AGE_MS = 5000;
/** HFOV fallback when a frame carries none (main lens until calibrated). */
export const DEFAULT_HFOV_DEG = 66;
/** Tracks older than this leave the scene state (the agent's refs stay fresh). */
export const SCENE_TRACK_MAX_AGE_MS = 10_000;

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
  if (e.kind === "SCENE_SUMMARY" || e.kind === "SCENE_UPDATE") return "scene";
  return "people";
}

export async function startServer(port: number, opts?: ServerOpts): Promise<ServerHandles> {
  const provider = providerFromEnv();
  const ownStore = !opts?.store;
  const people = opts?.store ?? new PeopleStore(defaultDbPath());
  const embedder = opts?.embedder ?? (await selectEmbedder());
  const adapters = createAdapters(provider, { store: people, embedder });
  const facesEveryN = facesEveryNFromEnv();
  const uwCrop = uwCashCropFromEnv();
  const agent = opts?.agent ?? adapters.agent;
  const triage = opts?.triage ?? adapters.triage;
  const finder = opts?.finder ?? adapters.finder;
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
      const checked = checkEnrollFace(faces, i + 1);
      if ("error" in checked) {
        return { status: 400, json: { error: checked.error } };
      }
      embeddings.push(checked.face.embedding);
    }
    return {
      status: 201,
      json: people.addPerson(rec.name as string, embeddings, { method: "form", ts: Date.now() }),
    };
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
    // One session + engine + narrator per WS client; all die with the connection.
    const session = new Session();
    const engine = new DecisionEngine((e) =>
      renderProactive(e, session.lang, session.lastFrame?.hfovDeg)
    );
    const narrator = new SceneNarrator();
    const tracker = new FaceTracker();
    const pendingCaptures = new Map<string, (f: SessionFrame) => void>();
    let frameNo = 0;

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
      return session.sceneState.people.map((p) => ({
        name: p.knownName,
        clock: p.clock,
        distance: p.distance,
        gender: p.gender,
      }));
    }

    /** Single place that flips look-around: session, narrator, then the phone. */
    function setLookAround(on: boolean): void {
      session.lookAround = on;
      session.sceneState.lookAround = on;
      narrator.setActive(on);
      pushState();
    }

    /**
     * Bare "hor" continues a fresh label read with unspoken words, else
     * null (the caller falls through to scene paging or the agent).
     */
    function readContinuation(text: string): string | null {
      const last = session.lastRead;
      if (!last || !isBareMore(text) || Date.now() - last.ts > READ_FRESH_MS) return null;
      const next = readChunk(last.text, last.page);
      if (!next) return null;
      last.page++;
      return next.hasMore ? `${next.chunk} ${renderReadMore(session.lang)}` : next.chunk;
    }

    /** "Hor ki hai?": the next unmentioned scene page, or nothing notable. */
    function answerMoreText(): string {
      const items = narrator.requestMore();
      if (items.length === 0) {
        return renderProactive({ kind: "SCENE_SUMMARY", items: [] }, session.lang).text;
      }
      return renderProactive({ kind: "SCENE_UPDATE", items }, session.lang).text;
    }

    /**
     * Cash-prompt input: the centre 60% when the lens is ultra-wide
     * (notes at counter distance sit central; fail-open to full frame).
     */
    async function cashInput(jpeg: Buffer, lens: "main" | "ultrawide" | undefined): Promise<Buffer> {
      if (!uwCrop || lens !== "ultrawide") return jpeg;
      try {
        return await centreCrop(jpeg);
      } catch (err) {
        console.error("uw crop failed, using full frame:", err instanceof Error ? err.message : err);
        return jpeg;
      }
    }

    /** Fresh cash read; shared by the howmuch fast path and cash_check. */
    async function cashRead(): Promise<string> {
      const frame = frames.get();
      if (!frame) return renderProactive({ kind: "NOTE_UNSURE" }, session.lang).text;
      const fresh = await triage.triage(await cashInput(frame.jpeg, frame.lens));
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
        if (session.lookAround) {
          setLookAround(false);
          engine.answer(renderOkay(session.lang), session.lang);
          sendDrained();
        }
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
      // Bare "hor" continues a fresh label read; "hor ki hai?" pages
      // the scene when look-around has one; otherwise the agent answers
      // from a fresh frame like any other question.
      if (intent.kind === "more") {
        const cont = readContinuation(text);
        if (cont) {
          engine.cancel();
          engine.answer(cont, session.lang);
          sendDrained();
          console.log(`utterance fast-path (read-more) total=${Date.now() - tRx}ms`);
          return;
        }
        if (session.lookAround && narrator.hasScene()) {
          engine.cancel();
          engine.answer(answerMoreText(), session.lang);
          sendDrained();
          console.log(`utterance fast-path (more) total=${Date.now() - tRx}ms`);
          return;
        }
      }

      // Agent path: fresh frame, then one model call with memory + scene.
      session.agentBusy = true;
      pushState();
      send({ type: "earcon", name: "thinking" });
      const reqId = `u${++utterSeq}`;
      // Reads use the sharper main lens even in look-around.
      send(intent.kind === "read" ? { type: "capture_now", reqId, lens: "main" } : { type: "capture_now", reqId });
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

      const peopleSaid = await applyAgentActions(output.actions, {
        session,
        engine,
        send,
        cashCheck: cashRead,
        narrator,
        people: { store: people, tracker, faces: adapters.faces },
        utterance: text,
        find: { finder, frame: image },
      });
      // A label read: the model spoke chunk 0, "hor" pages from chunk 1.
      if (output.readText !== undefined && output.readText.trim()) {
        session.lastRead = { text: output.readText.trim(), page: 1, ts: Date.now() };
      }
      const rendered =
        output.say === null ? null : renderPositions(output.say, output.positions, usedHfov, session.lang);
      // People tools speak their own deterministic line; the model's say
      // would double-speak the consent question, so it is skipped then.
      if (!peopleSaid && rendered) engine.answer(rendered, session.lang);
      sendDrained();
      session.pushTurn({ role: "user", text });
      session.pushTurn({ role: "assistant", text: peopleSaid ?? rendered ?? "" });
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
          if (session.lookAround) {
            setLookAround(false);
            engine.answer(renderOkay(session.lang), session.lang);
          }
          return;
        case "more": {
          engine.cancel();
          engine.answer(readContinuation(transcript) ?? answerMoreText(), session.lang);
          return;
        }
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
          const full = (await adapters.answer.read(frame.jpeg)).trim();
          const first = readChunk(full, 0);
          if (!first) {
            engine.answer(renderAgentUnsure(session.lang), session.lang);
            return;
          }
          session.lastRead = { text: full, page: 1, ts: Date.now() };
          engine.answer(
            first.hasMore ? `${first.chunk} ${renderReadMore(session.lang)}` : first.chunk,
            session.lang
          );
          return;
        }
        case "find": {
          engine.cancel();
          const box = frame ? ((await finder.find(frame.jpeg, intent.noun))[0] ?? null) : null;
          engine.answer(renderFind(intent.noun, box, session.lang), session.lang);
          return;
        }
        case "who": {
          engine.cancel();
          engine.answer(
            summarizePeople(whoParts(), session.lang, session.lastFrame?.hfovDeg),
            session.lang
          );
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
        frames.set({ jpeg, width: msg.width, height: msg.height, ts: msg.ts, receivedAt: Date.now(), lens: msg.lens });
        const sessionFrame: SessionFrame = { jpeg, hfovDeg, ts: msg.ts, receivedAt: Date.now() };
        session.lastFrame = sessionFrame;
        if (msg.reqId) pendingCaptures.get(msg.reqId)?.(sessionFrame);
        try {
          // Look-around frames take the scene prompt (cash + people with
          // coordinates + objects); otherwise the fast cash-only prompt.
          // Faces run every Nth frame (FACES_EVERY_N; slow machines skip).
          const runFaces = shouldRunFaces(frameNo++, facesEveryN);
          const [result, matched] = await Promise.all([
            session.lookAround
              ? triage.triageScene(jpeg)
              : triage.triage(await cashInput(jpeg, msg.lens)),
            runFaces ? adapters.faces.matchDetailed(jpeg) : Promise.resolve([] as MatchedFace[]),
          ]);
          const nowMs = Date.now();
          const tracks = runFaces ? tracker.update(matched, hfovDeg, nowMs) : tracker.liveTracks();
          const fresh = tracks.filter((t) => nowMs - t.lastSeen <= SCENE_TRACK_MAX_AGE_MS);
          session.sceneState = sceneFromPerception(result, fresh, session.lookAround, hfovDeg);
          engine.onFrame(result, fresh, nowMs);
          for (const ev of narrator.onScene(result, hfovDeg)) engine.announceScene(ev);
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
      if (isModeMessage(msg)) {
        setLookAround(msg.lookAround);
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
