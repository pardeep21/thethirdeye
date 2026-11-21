// TheThirdEye server: plain node:http + ws, one process.
// Frame in -> triage + faces -> decision engine -> speak out.
// Utterance in -> fast path or Spark agent (fresh frame via capture_now).
// Run: PROVIDER=mock node dist/index.js

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  isAudioMessage,
  isCameraStateMessage,
  isCaptureFailedMessage,
  isCommandMessage,
  isFrameMessage,
  isHelloMessage,
  isListeningMessage,
  isModeMessage,
  isPingMessage,
  isSettingsMessage,
  isSpokenMessage,
  isUtteranceMessage,
  type DownMessage,
  type SceneTriage,
  type SpeakKind,
  type SpeakMessage,
  type TriageResult,
} from "./protocol.js";
import { LatestFrameStore } from "./store.js";
import { centreCrop, fitLongestSide, triageImagePxFromEnv, uwCashCropFromEnv } from "./images.js";
import { createAdapters, providerFromEnv, type NamedTriage } from "./adapters/factory.js";
import type { AgentBrain, AgentOutput } from "./adapters/agent.js";
import { DecisionEngine, type DecisionEvent } from "./decision.js";
import { SceneNarrator } from "./narration.js";
import {
  renderAgentUnsure,
  renderDidntUnderstand,
  renderFind,
  renderModelTimeout,
  renderNoCamera,
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
import { SessionStore } from "./sessionStore.js";
import { UtteranceStats } from "./stats.js";
import {
  agentTimeoutFromEnv,
  findTimeoutFromEnv,
  triageTimeoutFromEnv,
  withTimeout,
  ModelTimeoutError,
  type TimeoutStage,
} from "./timeouts.js";
import { isBareMore, matchConfirm, routeIntent } from "./intent.js";
import { PeopleStore } from "./faces/store.js";
import type { FaceEmbedder } from "./faces/embed.js";
import { checkEnrollFace } from "./faces/quality.js";
import { FaceTracker } from "./faces/tracker.js";
import type { MatchedFace, ObjectFinder, VisionAnswer } from "./adapters/index.js";
import { defaultDbPath, facesEveryNFromEnv, selectEmbedder, shouldRunFaces } from "./faces/index.js";
import { TurnGuard } from "./turnGuard.js";
import { TurnLogger, turnLogDirFromEnv, type CaptureOutcome } from "./turnLog.js";
import type { AttemptOutcome } from "./adapters/fallback.js";

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
  /** Override vision answers (tests inject a scripted mock). */
  answer?: VisionAnswer;
}

/** How long an utterance waits for its capture_now frame (R2: 2500 ms). */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 2500;
/** A stored frame older than this is too stale to show the agent. */
export const LAST_FRAME_MAX_AGE_MS = 5000;
/**
 * Vision answers need a usable image: the capture for this reqId, or a
 * last frame younger than this (R2). Older than this, describe/read/find
 * and vision agent turns answer no-camera instead of going blind.
 */
export const CAPTURE_FRESH_MS = 1500;
/** HFOV fallback when a frame carries none (main lens until calibrated). */
export const DEFAULT_HFOV_DEG = 66;
/** Tracks older than this leave the scene state (the agent's refs stay fresh). */
export const SCENE_TRACK_MAX_AGE_MS = 10_000;

const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Shared WS token (empty/unset = open server for local dev). */
export function appTokenFromEnv(): string | undefined {
  const raw = process.env.APP_TOKEN;
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

/** WS close code for rejected auth (application range 4000-4999). */
export const WS_CLOSE_AUTH = 4401;

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
  const stats = new UtteranceStats();
  const turnLogger = new TurnLogger({ dir: turnLogDirFromEnv() });
  const adapters = createAdapters(provider, {
    store: people,
    embedder,
    onModelAttempt: (prov, outcome, details) => {
      stats.recordAttempt(prov, outcome, details.stage);
      if (details.turnId !== undefined) {
        turnLogger.recordAttempt(details.turnId, {
          provider: prov,
          stage: details.stage,
          ms: details.ms,
          outcome,
        });
      }
    },
  });
  const facesEveryN = facesEveryNFromEnv();
  const uwCrop = uwCashCropFromEnv();
  const triagePx = triageImagePxFromEnv();
  const agent = opts?.agent ?? adapters.agent;
  const triage = opts?.triage ?? adapters.triage;
  const finder = opts?.finder ?? adapters.finder;
  const answer = opts?.answer ?? adapters.answer;
  const frames = new LatestFrameStore();
  const captureTimeoutMs = captureTimeoutFromEnv();
  // Parked sessions by hello device string: a reconnect within 60 s
  // resumes conversation context instead of starting blank (R5).
  const sessions = new SessionStore();
  let speakSeq = 0;
  let utterSeq = 0;
  // R7 turn ids are server-unique (spoken receipts join by turnId across
  // reconnects, so per-connection counters would collide).
  let turnSeq = 0;
  const nextTurnId = (): string => `t${++turnSeq}`;
  let connSeq = 0;

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
    // One session + engine + narrator per WS client. The session is parked
    // by device on close, so a quick reconnect resumes it (R5); the engine,
    // narrator and tracker are always fresh per connection.
    let session = new Session();
    let deviceKey: string | null = null;
    const engine = new DecisionEngine((e) =>
      renderProactive(e, session.lang, session.lastFrame?.hfovDeg)
    );
    const narrator = new SceneNarrator();
    const tracker = new FaceTracker();
    const pendingCaptures = new Map<string, (f: SessionFrame | "failed") => void>();
    // Connection diagnostics: frames + user turns served, logged on close
    // (reconnects start a fresh session, so this shows wipe frequency).
    let frameCount = 0;
    let utterCount = 0;
    console.log(`client connected (session ${session.id})`);
    let frameNo = 0;
    // Frame backpressure: one triage call in flight per session, plus a
    // single latest-pending slot. A newer frame replaces an older waiting
    // one, so stale frames are never triaged and results stay in order.
    let triageBusy = false;
    interface PendingFrame {
      jpeg: Buffer;
      hfovDeg: number;
      ts: number;
      receivedAt: number;
      lens: "main" | "ultrawide" | undefined;
    }
    let pendingFrame: PendingFrame | null = null;
    // WS auth: when APP_TOKEN is set, the first message must be a hello
    // carrying it; anything else (or a wrong token) closes the socket.
    const appToken = appTokenFromEnv();
    let authed = appToken === undefined;

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
        peopleRev: people.revision(),
      });
    };

    const connId = `c${++connSeq}`;

    /**
     * One traced model call for a turn. Fallback chains record each member
     * attempt themselves (via onModelAttempt above); single-provider calls
     * record one outer attempt here, so every model call lands exactly once
     * in both /stats and the turn record.
     */
    async function modelCall<T>(stage: TimeoutStage, turnId: string, fn: () => Promise<T>): Promise<T> {
      const before = turnLogger.attemptCount(turnId, stage);
      const start = Date.now();
      try {
        const out = await fn();
        if (turnLogger.attemptCount(turnId, stage) === before) {
          const ms = Date.now() - start;
          stats.recordAttempt(provider, "ok", stage);
          turnLogger.recordAttempt(turnId, { provider, stage, ms, outcome: "ok" });
        }
        return out;
      } catch (err) {
        if (turnLogger.attemptCount(turnId, stage) === before) {
          const ms = Date.now() - start;
          const outcome: AttemptOutcome = err instanceof ModelTimeoutError ? "timeout" : "error";
          stats.recordAttempt(provider, outcome, stage);
          turnLogger.recordAttempt(turnId, { provider, stage, ms, outcome });
        }
        throw err;
      }
    }

    /** Attempt sink for model calls nested in action dispatch (find). */
    function noteAttempt(
      turnId: string,
      stage: TimeoutStage,
      ms: number,
      outcome: AttemptOutcome
    ): void {
      stats.recordAttempt(provider, outcome, stage);
      turnLogger.recordAttempt(turnId, { provider, stage, ms, outcome });
    }

    /** Finish a traced turn: write/flush the log line and feed /stats. */
    function finishTurnLogging(
      turnId: string,
      opts: { rescued: boolean; rescueReason?: string; superseded?: boolean }
    ): void {
      const rec = turnLogger.finish(turnId, opts);
      if (!rec) return;
      stats.recordTurn({ capture: rec.capture, attempts: rec.attempts, rescued: rec.rescued });
      // A receipt that beat the finish line: sample its latency now, since
      // no later onSpoken call will fire for this turn.
      if (rec.spoken) stats.recordSpoken(rec.spoken.latencyMs, rec.spoken.outcome);
    }

    const drain = (): SpeakMessage[] =>
      engine.takeSpeak().map((a) => ({
        type: "speak",
        id: `spk-${++speakSeq}`,
        text: a.text,
        lang: a.lang,
        priority: a.priority,
        kind: kindForEvent(a.event),
        ...(a.turnId !== undefined ? { turnId: a.turnId } : {}),
      }));

    const sendDrained = (): void => {
      for (const s of drain()) send(s);
    };

    // TurnGuard: every user turn ends audible. One instance per connection
    // so a newer turn supersedes an in-flight older one (barge-in).
    const guard = new TurnGuard();

    /**
     * Queue a P1 answer for this turn. Empty/whitespace text counts as
     * nothing to say (no queue, no mark). Superseded turns stay silent.
     */
    function answerTurn(turnId: string, text: string): void {
      if (!text.trim()) return;
      if (guard.isSuperseded(turnId)) return;
      engine.answer(text, session.lang, undefined, turnId);
      turnLogger.setText(turnId, text);
      guard.markSpoken(turnId);
    }

    /** Intentional ack earcon: counts as heard for mute/unmute/cancel. */
    function ackTurn(turnId: string): void {
      if (guard.isSuperseded(turnId)) return;
      send({ type: "earcon", name: "ack" });
      guard.markSpoken(turnId);
    }

    /** One /stats count + one log line per model timeout. */
    function noteTimeout(stage: TimeoutStage, timeoutMs: number): void {
      stats.recordTimeout(stage);
      console.log(`model timeout stage=${stage} timeoutMs=${timeoutMs}`);
    }

    /**
     * Runs a command-turn model call. On timeout speaks the deterministic
     * P1 line, clears agentBusy, pushes state, and returns null; other
     * errors propagate exactly as before.
     */
    async function tryCommandModel<T>(
      stage: TimeoutStage,
      turnId: string,
      ms: number,
      call: () => Promise<T>
    ): Promise<T | null> {
      try {
        return await modelCall(stage, turnId, () => withTimeout(call(), ms, stage));
      } catch (err) {
        if (!(err instanceof ModelTimeoutError)) throw err;
        noteTimeout(stage, err.timeoutMs);
        const line = renderModelTimeout(session.lang);
        engine.answer(line, session.lang, undefined, turnId);
        turnLogger.setText(turnId, line);
        session.agentBusy = false;
        pushState();
        return null;
      }
    }

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
     * (notes at counter distance sit central; fail-open to full frame),
     * then fit to TRIAGE_IMAGE_PX longest side (downscale only).
     */
    async function cashInput(jpeg: Buffer, lens: "main" | "ultrawide" | undefined): Promise<Buffer> {
      let out = jpeg;
      if (uwCrop && lens === "ultrawide") {
        try {
          out = await centreCrop(out);
        } catch (err) {
          console.error("uw crop failed, using full frame:", err instanceof Error ? err.message : err);
        }
      }
      return fitLongestSide(out, triagePx);
    }

    /** Fresh cash read; shared by the howmuch fast path and cash_check. */
    async function cashRead(turnId: string): Promise<string> {
      const frame = frames.get();
      if (!frame) return renderProactive({ kind: "NOTE_UNSURE" }, session.lang).text;
      let fresh;
      try {
        const input = await cashInput(frame.jpeg, frame.lens);
        fresh = await modelCall("triage", turnId, () =>
          withTimeout(triage.triage(input, undefined, turnId), triageTimeoutFromEnv(), "triage")
        );
      } catch (err) {
        if (!(err instanceof ModelTimeoutError)) throw err;
        // Command context: deterministic line, never a stale value.
        noteTimeout("triage", err.timeoutMs);
        return renderModelTimeout(session.lang);
      }
      const top = fresh.notes[0];
      if (top && top.denomination !== null && top.confidence >= 0.5) {
        return renderProactive(
          { kind: "NOTE_SEEN", denominations: [top.denomination], confidences: [top.confidence] },
          session.lang
        ).text;
      }
      return renderProactive({ kind: "NOTE_UNSURE" }, session.lang).text;
    }

    /**
     * Wait for the capture_now reply: the frame, "failed" when the phone
     * reports capture_failed for this reqId, or null on timeout.
     */
    function waitForCapture(reqId: string): Promise<SessionFrame | "failed" | null> {
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
      tSpeak: number,
      capture: CaptureOutcome
    ): void {
      const usage = agent.getLastUsage?.();
      const cost = agent.getLastCostUsd?.();
      console.log(
        `utterance_rx → frame_rx=${tFrame - tRx}ms → model_start=${tModelStart - tFrame}ms → ` +
          `model_end=${tModelEnd - tModelStart}ms → speak_tx=${tSpeak - tModelEnd}ms ` +
          `total=${tSpeak - tRx}ms capture=${capture} ` +
          `tokens=${usage ? `${usage.promptTokens}/${usage.completionTokens}` : "n/a"} ` +
          `cost=${cost === null || cost === undefined ? "n/a" : `$${cost.toFixed(6)}`}`
      );
    }

    async function failAgentTurn(
      turnId: string,
      tRx: number,
      tFrame: number,
      tModelStart: number,
      text: string,
      err: unknown,
      capture: CaptureOutcome
    ): Promise<void> {
      if (guard.isSuperseded(turnId)) return;
      const timedOut = err instanceof ModelTimeoutError;
      if (timedOut) noteTimeout(err.stage, err.timeoutMs);
      else console.error("agent failed:", err instanceof Error ? err.message : err);
      send({ type: "earcon", name: "error" });
      const fallback = timedOut ? renderModelTimeout(session.lang) : renderAgentUnsure(session.lang);
      engine.answer(fallback, session.lang, undefined, turnId);
      turnLogger.setText(turnId, fallback);
      turnLogger.setCapture(turnId, capture);
      guard.markSpoken(turnId);
      sendDrained();
      session.pushTurn({ role: "user", text });
      session.pushTurn({ role: "assistant", text: fallback });
      session.agentBusy = false;
      pushState();
      const tEnd = Date.now();
      stats.record({ frameWaitMs: tFrame - tRx, modelMs: tEnd - tModelStart, totalMs: tEnd - tRx });
      logTimings(tRx, tFrame, tModelStart, tEnd, tEnd, capture);
    }

    async function handleUtterance(text: string): Promise<void> {
      const turnId = nextTurnId();
      guard.begin(turnId);
      turnLogger.begin(turnId, { kind: "utterance", owner: connId });
      let rescueReason = "silent";
      let didBusy = false;
      let didPush = false;
      try {
        console.log(`heard: ${text}`);
        utterCount++;
        const tRx = Date.now();

        // Fast path: trivial commands never reach the LLM.
        const intent = routeIntent(text);
        turnLogger.setIntent(turnId, intent.kind);
        if (intent.kind === "mute") {
          engine.setMuted(true);
          session.muted = true;
          pushState();
          ackTurn(turnId);
          console.log(`utterance fast-path (mute) total=${Date.now() - tRx}ms`);
          return;
        }
        if (intent.kind === "unmute") {
          engine.setMuted(false);
          session.muted = false;
          pushState();
          ackTurn(turnId);
          console.log(`utterance fast-path (unmute) total=${Date.now() - tRx}ms`);
          return;
        }
        if (intent.kind === "cancel") {
          engine.cancel();
          if (session.lookAround) {
            setLookAround(false);
            ackTurn(turnId);
            answerTurn(turnId, renderOkay(session.lang));
            sendDrained();
          } else {
            ackTurn(turnId);
          }
          console.log(`utterance fast-path (cancel) total=${Date.now() - tRx}ms`);
          return;
        }
        // Fast path: a bare yes/no answers a pending consent/confirm
        // question directly. The agent path is too slow and flaky for a
        // one-word answer (timeouts, truncated JSON), and the stored
        // pending name cannot mismatch the way a model echo can.
        const confirm = matchConfirm(text);
        if (confirm !== null) {
          const pending = session.pendingAction;
          if (
            pending !== null &&
            (pending.kind === "consent" ||
              pending.kind === "duplicate-confirm" ||
              pending.kind === "forget-confirm")
          ) {
            engine.cancel();
            const said = await applyAgentActions(
              [{ tool: "confirm_consent", name: pending.name, granted: confirm === "yes" }],
              {
                session,
                engine,
                send,
                cashCheck: () => cashRead(turnId),
                narrator,
                people: { store: people, tracker, faces: adapters.faces },
                utterance: text,
                find: { finder },
                onTimeout: (stage, ms) => noteTimeout(stage, ms),
                onSpoke: (line) => {
                  guard.markSpoken(turnId);
                  if (line !== undefined) turnLogger.setText(turnId, line);
                },
                isCancelled: () => guard.isSuperseded(turnId),
                turnId,
                onAttempt: (stage, ms, outcome) => noteAttempt(turnId, stage, ms, outcome),
              }
            );
            if (guard.isSuperseded(turnId)) return;
            // State first: a mutation bumps peopleRev, so the phone
            // refetches the people count while the answer speaks.
            pushState();
            sendDrained();
            session.pushTurn({ role: "user", text });
            session.pushTurn({ role: "assistant", text: said ?? "" });
            didPush = true;
            console.log(`utterance fast-path (confirm) total=${Date.now() - tRx}ms`);
            return;
          }
        }
        if (intent.kind === "howmuch") {
          engine.cancel();
          const frame = frames.get();
          turnLogger.setCapture(
            turnId,
            frame !== null && Date.now() - frame.receivedAt < CAPTURE_FRESH_MS ? "ok" : "stale_fallback"
          );
          const line = await cashRead(turnId);
          if (guard.isSuperseded(turnId)) return;
          answerTurn(turnId, line);
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
            answerTurn(turnId, cont);
            sendDrained();
            console.log(`utterance fast-path (read-more) total=${Date.now() - tRx}ms`);
            return;
          }
          if (session.lookAround && narrator.hasScene()) {
            engine.cancel();
            answerTurn(turnId, answerMoreText());
            sendDrained();
            console.log(`utterance fast-path (more) total=${Date.now() - tRx}ms`);
            return;
          }
        }

        // R6: the phone reports its camera liveness. A vision question
        // while the camera is down answers no-camera immediately instead
        // of waiting out the capture timeout for a frame that won't come.
        const needsVision =
          intent.kind === "describe" ||
          intent.kind === "read" ||
          intent.kind === "find" ||
          intent.kind === "who";
        if (needsVision && session.cameraState !== "ok") {
          session.agentBusy = true;
          didBusy = true;
          pushState();
          turnLogger.setCapture(turnId, "camera_off");
          const line = renderNoCamera(session.lang);
          answerTurn(turnId, line);
          sendDrained();
          session.pushTurn({ role: "user", text });
          session.pushTurn({ role: "assistant", text: line });
          didPush = true;
          const tShort = Date.now();
          stats.record({ frameWaitMs: 0, modelMs: 0, totalMs: tShort - tRx });
          logTimings(tRx, tShort, tShort, tShort, tShort, "camera_off");
          session.agentBusy = false;
          pushState();
          return;
        }

        // Agent path: fresh frame, then one model call with memory + scene.
        session.agentBusy = true;
        didBusy = true;
        pushState();
        send({ type: "earcon", name: "thinking" });
        const reqId = `u${++utterSeq}`;
        // Reads use the sharper main lens even in look-around.
        send(
          intent.kind === "read"
            ? { type: "capture_now", reqId, lens: "main", turnId }
            : { type: "capture_now", reqId, turnId }
        );
        const waited = await waitForCapture(reqId);
        if (guard.isSuperseded(turnId)) return;
        const tFrame = Date.now();

        // R2: vision questions need a usable image (this capture, or a
        // last frame younger than 1500 ms). Chat may go without one.
        const isVision = needsVision;
        const lastAge =
          session.lastFrame === null ? Infinity : tFrame - session.lastFrame.receivedAt;
        const freshFallback =
          session.lastFrame !== null && lastAge < CAPTURE_FRESH_MS ? session.lastFrame : null;

        let image: { jpeg: Buffer; hfovDeg: number } | undefined;
        let usedHfov = DEFAULT_HFOV_DEG;
        let captureStatus: CaptureOutcome;
        if (waited !== null && waited !== "failed") {
          image = { jpeg: waited.jpeg, hfovDeg: waited.hfovDeg };
          usedHfov = waited.hfovDeg;
          captureStatus = "ok";
        } else if (waited === "failed") {
          captureStatus = "failed";
          const fallback =
            freshFallback ??
            (!isVision && session.lastFrame !== null && lastAge < LAST_FRAME_MAX_AGE_MS
              ? session.lastFrame
              : null);
          if (fallback) {
            image = { jpeg: fallback.jpeg, hfovDeg: fallback.hfovDeg };
            usedHfov = fallback.hfovDeg;
          }
        } else if (freshFallback) {
          image = { jpeg: freshFallback.jpeg, hfovDeg: freshFallback.hfovDeg };
          usedHfov = freshFallback.hfovDeg;
          captureStatus = "late";
        } else {
          captureStatus = "stale_fallback";
          if (!isVision && session.lastFrame !== null && lastAge < LAST_FRAME_MAX_AGE_MS) {
            image = { jpeg: session.lastFrame.jpeg, hfovDeg: session.lastFrame.hfovDeg };
            usedHfov = session.lastFrame.hfovDeg;
          }
        }

        // A vision turn without a usable image never goes to the model
        // blind: it answers no-camera and skips the call entirely.
        if (isVision && !image) {
          turnLogger.setCapture(turnId, captureStatus);
          const line = renderNoCamera(session.lang);
          answerTurn(turnId, line);
          sendDrained();
          session.pushTurn({ role: "user", text });
          session.pushTurn({ role: "assistant", text: line });
          didPush = true;
          const tSpeak = Date.now();
          stats.record({
            frameWaitMs: tFrame - tRx,
            modelMs: 0,
            totalMs: tSpeak - tRx,
          });
          logTimings(tRx, tFrame, tFrame, tFrame, tSpeak, captureStatus);
          session.agentBusy = false;
          pushState();
          return;
        }

        const tModelStart = Date.now();
        turnLogger.setCapture(turnId, captureStatus);
        let output: AgentOutput;
        try {
          // A late respond resolves into the void: the race already settled,
          // so it is discarded and can never double-speak.
          output = await modelCall("agent", turnId, () =>
            withTimeout(
              agent.respond({
                history: [...session.history],
                utterance: text,
                image,
                scene: session.sceneState,
                lang: session.lang,
                script: session.script,
                turnId,
              }),
              agentTimeoutFromEnv(),
              "agent"
            )
          );
        } catch (err) {
          await failAgentTurn(turnId, tRx, tFrame, tModelStart, text, err, captureStatus);
          return;
        }
        if (guard.isSuperseded(turnId)) return;
        const tModelEnd = Date.now();

        const peopleSaid = await applyAgentActions(output.actions, {
          session,
          engine,
          send,
          cashCheck: () => cashRead(turnId),
          narrator,
          people: { store: people, tracker, faces: adapters.faces },
          utterance: text,
          find: { finder, frame: image },
          onTimeout: (stage, ms) => noteTimeout(stage, ms),
          onSpoke: (line) => {
            guard.markSpoken(turnId);
            if (line !== undefined) turnLogger.setText(turnId, line);
          },
          isCancelled: () => guard.isSuperseded(turnId),
          turnId,
          onAttempt: (stage, ms, outcome) => noteAttempt(turnId, stage, ms, outcome),
        });
        if (guard.isSuperseded(turnId)) return;
        // A label read: the model spoke chunk 0, "hor" pages from chunk 1.
        if (output.readText !== undefined && output.readText.trim()) {
          session.lastRead = { text: output.readText.trim(), page: 1, ts: Date.now() };
        }
        const rendered =
          output.say === null ? null : renderPositions(output.say, output.positions, usedHfov, session.lang);
        // People tools speak their own deterministic line; the model's say
        // would double-speak the consent question, so it is skipped then.
        // Empty/whitespace renders count as nothing: the guard rescues below.
        if (!peopleSaid && rendered?.trim()) answerTurn(turnId, rendered);
        else if (peopleSaid?.trim()) guard.markSpoken(turnId);
        else rescueReason = "null-say";
        sendDrained();
        const willRescue = !guard.isSpoken(turnId) && !guard.isSuperseded(turnId);
        session.pushTurn({ role: "user", text });
        session.pushTurn({
          role: "assistant",
          text: willRescue ? renderAgentUnsure(session.lang) : (peopleSaid ?? rendered ?? ""),
        });
        didPush = true;
        const tSpeak = Date.now();
        stats.record({
          frameWaitMs: tFrame - tRx,
          modelMs: tModelEnd - tModelStart,
          totalMs: tSpeak - tRx,
        });
        logTimings(tRx, tFrame, tModelStart, tModelEnd, tSpeak, captureStatus);
        if (!willRescue) {
          session.agentBusy = false;
          pushState();
        }
        // When silent, busy/idle is left to the rescue below so the fallback
        // speaks before the idle state (tests collect until idle).
      } catch (err) {
        console.error("utterance failed:", err instanceof Error ? err.message : err);
        rescueReason = "error";
      } finally {
        const rescued = guard.finish(turnId, rescueReason, () => {
          // Generic fallback only: never a stale model answer or cash value.
          const fallback = renderAgentUnsure(session.lang);
          engine.answer(fallback, session.lang, undefined, turnId);
          turnLogger.setText(turnId, fallback);
          sendDrained();
          stats.recordSilentRescue();
          if (!didPush) {
            session.pushTurn({ role: "user", text });
            session.pushTurn({ role: "assistant", text: fallback });
          }
          if (didBusy && session.agentBusy) {
            session.agentBusy = false;
            pushState();
          }
        });
        finishTurnLogging(turnId, {
          rescued,
          rescueReason,
          superseded: guard.isSuperseded(turnId),
        });
      }
    }

    async function handleCommand(transcript: string): Promise<void> {
      const turnId = nextTurnId();
      guard.begin(turnId);
      turnLogger.begin(turnId, { kind: "command", owner: connId });
      let rescueReason = "silent";
      // Reason-specific fallback; the generic unsure never repeats stale output.
      let rescueLine: (() => string) | null = null;
      try {
        const intent = routeIntent(transcript);
        turnLogger.setIntent(turnId, intent.kind);
        const frame = frames.get();
        // R2: command vision needs a usable (<1500 ms) frame, same as agent turns.
        const usableFrame =
          frame !== null && Date.now() - frame.receivedAt < CAPTURE_FRESH_MS ? frame : null;
        switch (intent.kind) {
          case "mute":
            engine.setMuted(true);
            session.muted = true;
            pushState();
            ackTurn(turnId);
            return;
          case "unmute":
            engine.setMuted(false);
            session.muted = false;
            pushState();
            ackTurn(turnId);
            return;
          case "cancel":
            engine.cancel();
            if (session.lookAround) {
              setLookAround(false);
              answerTurn(turnId, renderOkay(session.lang));
            }
            ackTurn(turnId);
            return;
          case "more": {
            engine.cancel();
            if (guard.isSuperseded(turnId)) return;
            answerTurn(turnId, readContinuation(transcript) ?? answerMoreText());
            return;
          }
          case "unknown":
            console.log(`unparseable command, answering: ${transcript}`);
            answerTurn(turnId, renderDidntUnderstand(session.lang));
            return;
          case "describe": {
            turnLogger.setCapture(turnId, usableFrame ? "ok" : "stale_fallback");
            if (!usableFrame) {
              console.log("describe with no usable frame; answering no-camera");
              answerTurn(turnId, renderNoCamera(session.lang));
              return;
            }
            engine.cancel();
            rescueReason = "error";
            rescueLine = () => renderAgentUnsure(session.lang);
            const said = await tryCommandModel("answer", turnId, agentTimeoutFromEnv(), () =>
              answer.describe(usableFrame.jpeg, transcript)
            );
            if (guard.isSuperseded(turnId)) return;
            if (said === null) {
              guard.markSpoken(turnId); // timeout line already queued
              return;
            }
            // Blank model text counts as nothing: the guard rescues below.
            if (said.trim()) answerTurn(turnId, said);
            else rescueReason = "empty-model";
            return;
          }
          case "read": {
            turnLogger.setCapture(turnId, usableFrame ? "ok" : "stale_fallback");
            if (!usableFrame) {
              console.log("read with no usable frame; answering no-camera");
              answerTurn(turnId, renderNoCamera(session.lang));
              return;
            }
            engine.cancel();
            rescueReason = "error";
            rescueLine = () => renderAgentUnsure(session.lang);
            const raw = await tryCommandModel("answer", turnId, agentTimeoutFromEnv(), () =>
              answer.read(usableFrame.jpeg)
            );
            if (guard.isSuperseded(turnId)) return;
            if (raw === null) {
              guard.markSpoken(turnId); // timeout line already queued
              return;
            }
            const full = raw.trim();
            const first = readChunk(full, 0);
            if (!first) {
              answerTurn(turnId, renderAgentUnsure(session.lang));
              return;
            }
            session.lastRead = { text: full, page: 1, ts: Date.now() };
            answerTurn(
              turnId,
              first.hasMore ? `${first.chunk} ${renderReadMore(session.lang)}` : first.chunk
            );
            return;
          }
          case "find": {
            engine.cancel();
            turnLogger.setCapture(turnId, usableFrame ? "ok" : "stale_fallback");
            if (!usableFrame) {
              console.log("find with no usable frame; answering no-camera");
              answerTurn(turnId, renderNoCamera(session.lang));
              return;
            }
            rescueReason = "error";
            rescueLine = () => renderAgentUnsure(session.lang);
            const boxes = await tryCommandModel("find", turnId, findTimeoutFromEnv(), () =>
              finder.find(usableFrame.jpeg, intent.noun)
            );
            if (guard.isSuperseded(turnId)) return;
            if (boxes === null) {
              guard.markSpoken(turnId); // timeout line already queued
              return;
            }
            answerTurn(turnId, renderFind(intent.noun, boxes[0] ?? null, session.lang));
            return;
          }
          case "who": {
            engine.cancel();
            if (guard.isSuperseded(turnId)) return;
            answerTurn(
              turnId,
              summarizePeople(whoParts(), session.lang, session.lastFrame?.hfovDeg)
            );
            return;
          }
          case "howmuch": {
            engine.cancel();
            rescueReason = "error";
            rescueLine = () => renderAgentUnsure(session.lang);
            turnLogger.setCapture(turnId, usableFrame ? "ok" : "stale_fallback");
            const line = await cashRead(turnId);
            if (guard.isSuperseded(turnId)) return;
            answerTurn(turnId, line);
            return;
          }
        }
      } catch (err) {
        console.error("command failed:", err instanceof Error ? err.message : err);
        rescueReason = "error";
        rescueLine = () => renderAgentUnsure(session.lang);
      } finally {
        const rescued = guard.finish(turnId, rescueReason, () => {
          const line = (rescueLine ?? (() => renderAgentUnsure(session.lang)))();
          engine.answer(line, session.lang, undefined, turnId);
          turnLogger.setText(turnId, line);
          stats.recordSilentRescue();
          // No drain here: the audio branch drains after handleCommand.
        });
        finishTurnLogging(turnId, {
          rescued,
          rescueReason,
          superseded: guard.isSuperseded(turnId),
        });
      }
    }

    /**
     * Triage one frame: look-around frames take the scene prompt (cash +
     * people with coordinates + objects); otherwise the fast cash-only
     * prompt. Faces run every Nth frame (FACES_EVERY_N; slow machines
     * skip). Always called serially via the backpressure pump above.
     */
    async function processFrame(f: PendingFrame): Promise<SpeakMessage[]> {
      // Provisional R7 turn: logged only when this frame speaks.
      const turnId = nextTurnId();
      turnLogger.begin(turnId, { kind: "proactive", owner: connId });
      try {
        const runFaces = shouldRunFaces(frameNo++, facesEveryN);
        const startedAt = Date.now();
        let triageCall: Promise<TriageResult | SceneTriage>;
        if (session.lookAround) {
          triageCall = modelCall("scene", turnId, () =>
            withTimeout(triage.triageScene(f.jpeg, undefined, turnId), triageTimeoutFromEnv(), "scene")
          );
        } else {
          const input = await cashInput(f.jpeg, f.lens);
          triageCall = modelCall("triage", turnId, () =>
            withTimeout(triage.triage(input, undefined, turnId), triageTimeoutFromEnv(), "triage")
          );
        }
        const [result, matched] = await Promise.all([
          triageCall,
          runFaces ? adapters.faces.matchDetailed(f.jpeg) : Promise.resolve([] as MatchedFace[]),
        ]);
        stats.recordTriage(Date.now() - startedAt);
        // Stamp with the frame's arrival time, not completion time, so the
        // stability rule and the re-arm/dedupe windows track what the
        // camera saw when, even when triage takes seconds.
        const frameMs = f.receivedAt;
        const tracks = runFaces ? tracker.update(matched, f.hfovDeg, frameMs) : tracker.liveTracks();
        const fresh = tracks.filter((t) => frameMs - t.lastSeen <= SCENE_TRACK_MAX_AGE_MS);
        session.sceneState = sceneFromPerception(result, fresh, session.lookAround, f.hfovDeg);
        engine.onFrame(result, fresh, frameMs, turnId);
        for (const ev of narrator.onScene(result, f.hfovDeg)) engine.announceScene(ev, undefined, turnId);
      } catch (err) {
        turnLogger.discard(turnId);
        if (err instanceof ModelTimeoutError) {
          // Proactive timeout: drop silently, never speak stale or fake.
          // (Not recorded in triageMs: a timeout budget is not a sample.)
          noteTimeout(err.stage, err.timeoutMs);
          return [];
        }
        console.error("perception failed:", err instanceof Error ? err.message : err);
        return [];
      }
      const drained = drain();
      const mine = drained.filter((s) => s.turnId === turnId);
      if (mine.length === 0) {
        turnLogger.discard(turnId);
      } else {
        turnLogger.setIntent(turnId, mine.map((s) => s.kind ?? "proactive").join("+"));
        turnLogger.setText(turnId, mine[mine.length - 1]!.text);
        finishTurnLogging(turnId, { rescued: false });
      }
      return drained;
    }

    async function handleMessage(raw: string): Promise<SpeakMessage[]> {
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return [];
      }
      if (isHelloMessage(msg)) {
        if (appToken !== undefined) {
          if (msg.token !== appToken) {
            console.log("rejecting hello without a valid APP_TOKEN");
            ws.close(WS_CLOSE_AUTH, "missing or invalid app token");
            return [];
          }
          authed = true;
        }
        deviceKey = msg.device;
        const prev = sessions.resume(msg.device, Date.now());
        if (prev) {
          session = prev;
          // The old connection may have died mid-turn; never resume busy.
          session.agentBusy = false;
          // The engine/narrator are fresh per connection: sync them to the
          // resumed session so mute and look-around stay in effect.
          engine.setMuted(session.muted);
          narrator.setActive(session.lookAround);
          console.log(`session resumed device=${msg.device} session=${session.id}`);
          pushState();
        }
        return [];
      }
      if (!authed) {
        console.log("rejecting message before hello auth");
        ws.close(WS_CLOSE_AUTH, "missing or invalid app token");
        return [];
      }
      if (isPingMessage(msg)) {
        send({ type: "pong", t: msg.t });
        return [];
      }
      if (isFrameMessage(msg)) {
        frameCount++;
        const jpeg = Buffer.from(msg.jpegBase64, "base64");
        const hfovDeg = msg.hfovDeg ?? DEFAULT_HFOV_DEG;
        const receivedAt = Date.now();
        frames.set({ jpeg, width: msg.width, height: msg.height, ts: msg.ts, receivedAt, lens: msg.lens });
        const sessionFrame: SessionFrame = { jpeg, hfovDeg, ts: msg.ts, receivedAt };
        session.lastFrame = sessionFrame;
        if (msg.reqId) pendingCaptures.get(msg.reqId)?.(sessionFrame);
        pendingFrame = { jpeg, hfovDeg, ts: msg.ts, receivedAt, lens: msg.lens };
        if (triageBusy) return [];
        triageBusy = true;
        const out: SpeakMessage[] = [];
        try {
          while (pendingFrame !== null) {
            const next = pendingFrame;
            pendingFrame = null;
            out.push(...(await processFrame(next)));
          }
        } finally {
          triageBusy = false;
        }
        return out;
      }
      if (isCaptureFailedMessage(msg)) {
        pendingCaptures.get(msg.reqId)?.("failed");
        return [];
      }
      if (isCameraStateMessage(msg)) {
        session.cameraState = msg.state;
        return [];
      }
      if (isSpokenMessage(msg)) {
        const res = turnLogger.onSpoken(msg);
        if (res.status === "attached" && res.latencyMs !== undefined) {
          stats.recordSpoken(res.latencyMs, msg.outcome);
        } else if (res.status === "unknown") {
          // Orphan receipt (flushed turn, old server): no latency sample,
          // but a watchdog still counts.
          stats.recordSpoken(null, msg.outcome);
        }
        return [];
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
          return drain();
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
        send({ type: "earcon", name: "ack" });
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
    ws.on("close", (code: number) => {
      console.log(
        `client disconnected (session ${session.id} code=${code}): ${frameCount} frames, ${utterCount} utterances`
      );
      // No more spoken receipts will arrive: write this connection's
      // pending turns now instead of waiting out the flush timeout.
      turnLogger.flushOwner(connId);
      // Park by device so a quick reconnect resumes context (R5). Never
      // authed / never said hello => nothing worth keeping.
      if (deviceKey !== null) sessions.keep(deviceKey, session, Date.now());
    });
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        turnLogger.close();
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
