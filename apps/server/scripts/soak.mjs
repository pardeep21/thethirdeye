#!/usr/bin/env node
// R8 soak harness: a fake phone over WebSocket that abuses the server the
// way shop Wi-Fi and bad models do, then checks the R1-R7 guarantees:
// every utterance gets exactly one answer within 12 s, and cash answers
// always match the latest announced note (never a stale value).
//
// The phone sends frames at 2 fps, answers capture_now (sometimes late or
// with capture_failed), sends a real-phrase utterance every 5-15 s,
// randomly drops/reconnects, and sometimes pauses its ping heartbeat.
// Drops only happen between utterances: a drop mid-turn would strand the
// answer on the dead socket, which is a phone bug, not a server one.
//
// Cash parsing assumes English lines, so the harness sets lang=en on every
// connect. With the chaos provider the mock always sees a 500 note, so any
// other cash value (or a howmuch answer disagreeing with the last proactive
// cash line) is a wrong/stale value and fails the run.
//
// Two spec wordings, interpreted: the server never pings the phone, so
// "stops answering pongs" is implemented as 15 s heartbeat gaps (no pings
// up); utterance gaps are measured from the previous answer so turns never
// overlap (the server's TurnGuard would supersede an overlapped turn, and
// the 12 s check needs one turn at a time).
//
// Usage (from apps/server): node scripts/soak.mjs [--url WS] [--minutes N]
//   [--seed S] [--photos DIR]. Exit 0 on pass, 1 on any violation.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));

const PHRASES = [
  "ki hai saamne",
  "eh padh",
  "kainchi kithe hai",
  "kaun hai",
  "eh kinne da",
  "chup",
  "bol",
  "ki haal hai",
];
const MUTE_WORDS = new Set(["chup", "bol"]);
const VALID_DENOMS = new Set([10, 20, 50, 100, 200, 500]);
const UTTERANCE_TIMEOUT_MS = 12000;
const FRAME_MS = 500;
const PING_MS = 5000;
const PING_PAUSE_MS = 15000;

function parseArgs(argv) {
  const out = { minutes: 10, seed: null, url: "ws://127.0.0.1:8080", photos: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--minutes") out.minutes = Number(argv[++i]);
    else if (a === "--seed") out.seed = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--photos") out.photos = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("soak.mjs [--url WS] [--minutes N] [--seed S] [--photos DIR]");
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) throw new Error("--minutes must be > 0");
  return out;
}

function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimal JPEG SOF dimension scan (same logic as send-frames.mjs). */
function jpegDims(buf) {
  try {
    for (let i = 0; i + 9 < buf.length; i++) {
      if (buf[i] !== 0xff) continue;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      }
    }
  } catch {
    // Fall through to zeros.
  }
  return [0, 0];
}

function photosFromDir(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** Synthetic solid-colour frames, generated in memory (never written). */
async function syntheticFrames() {
  const { default: sharp } = await import("sharp");
  const colours = [
    { r: 120, g: 120, b: 120 },
    { r: 180, g: 60, b: 60 },
    { r: 60, g: 140, b: 60 },
    { r: 60, g: 80, b: 180 },
  ];
  const out = [];
  for (const c of colours) {
    const buf = await sharp({ create: { width: 320, height: 240, channels: 3, background: c } })
      .jpeg({ quality: 70 })
      .toBuffer();
    out.push({ jpegBase64: buf.toString("base64"), width: 320, height: 240, bytes: buf.length });
  }
  return out;
}

async function loadFrames(photosDir) {
  const files = photosFromDir(photosDir);
  if (files.length > 0) {
    const frames = files.map((f) => {
      const buf = readFileSync(f);
      const [width, height] = jpegDims(buf);
      return { jpegBase64: buf.toString("base64"), width, height, bytes: buf.length };
    });
    console.log(`frames: ${frames.length} photos from ${photosDir}`);
    return frames;
  }
  try {
    const frames = await syntheticFrames();
    console.log(`frames: ${photosDir} is empty, using ${frames.length} synthetic frames (in-memory)`);
    return frames;
  } catch (err) {
    console.log(`frames: no photos and no sharp (${err.message}), using placeholder bytes`);
    return [{ jpegBase64: Buffer.from("soak-synthetic").toString("base64"), width: 4, height: 4, bytes: 14 }];
  }
}

/** English cash lines carry digits ("500 rupee note"); unsure lines carry none. */
function cashDenoms(text) {
  const found = [];
  for (const m of text.matchAll(/\d+/g)) found.push(Number(m[0]));
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.seed === null ? (Date.now() ^ (process.pid * 2654435761)) >>> 0 : hashSeed(args.seed);
  const rng = mulberry32(seed);
  console.log(`soak: url=${args.url} minutes=${args.minutes} seed=${args.seed ?? seed}`);
  const frames = await loadFrames(args.photos ?? join(HERE, "..", "..", "eval", "data", "notes"));
  const deadline = Date.now() + args.minutes * 60 * 1000;

  const stats = {
    utterances: 0,
    answered: 0,
    timeouts: [],
    lateAnswers: 0,
    strayAnswers: 0,
    speaksByTurn: new Map(),
    doubleTurns: [],
    cashSpeaks: 0,
    howmuchAnswers: 0,
    staleCash: [],
    invalidDenoms: [],
    captures: { immediate: 0, delayed: 0, failed: 0 },
    captureLateMs: [],
    drops: 0,
    reconnects: 0,
    pingPauses: 0,
    proactiveByKind: new Map(),
    answerMs: [],
    earconAcks: 0,
  };
  let lastCashDenoms = null;
  let pending = null; // { text, sentAt, muteWord }
  let ws = null;
  let frameIdx = 0;
  let framesSent = 0;
  let pingPausedUntil = 0;
  let stopped = false;
  let utteranceTimer = null;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  function sendFrame(reqId) {
    const f = frames[frameIdx++ % frames.length];
    send({
      type: "frame",
      jpegBase64: f.jpegBase64,
      width: f.width,
      height: f.height,
      lens: "main",
      hfovDeg: 66,
      ...(reqId !== undefined ? { reqId } : {}),
      ts: Date.now(),
    });
    framesSent++;
  }

  function noteSpeakTurn(turnId) {
    if (!turnId) return;
    const n = (stats.speaksByTurn.get(turnId) ?? 0) + 1;
    stats.speaksByTurn.set(turnId, n);
    if (n === 2) stats.doubleTurns.push(turnId);
  }

  function checkCash(text, where) {
    for (const d of cashDenoms(text)) {
      if (!VALID_DENOMS.has(d)) stats.invalidDenoms.push(`${where}: ${d} in ${JSON.stringify(text)}`);
    }
  }

  function onSpeak(msg) {
    noteSpeakTurn(msg.turnId);
    if (msg.turnId) {
      const startedAt = Date.now();
      send({ type: "spoken", turnId: msg.turnId, startedAt, endedAt: startedAt + 500, outcome: "done" });
    }
    if (msg.kind === "cash") {
      stats.cashSpeaks++;
      checkCash(msg.text, "proactive cash");
      const denoms = cashDenoms(msg.text).filter((d) => VALID_DENOMS.has(d));
      if (denoms.length > 0) lastCashDenoms = denoms;
      return;
    }
    if (msg.kind === "answer") {
      if (pending && Date.now() - pending.sentAt <= UTTERANCE_TIMEOUT_MS) {
        const ms = Date.now() - pending.sentAt;
        const text = pending.text;
        pending = null;
        scheduleGap();
        stats.answerMs.push(ms);
        stats.answered++;
        if (/kinne/i.test(text)) {
          stats.howmuchAnswers++;
          checkCash(msg.text, "howmuch answer");
          const denoms = cashDenoms(msg.text).filter((d) => VALID_DENOMS.has(d));
          if (denoms.length > 0 && lastCashDenoms !== null) {
            for (const d of denoms) {
              if (!lastCashDenoms.includes(d)) {
                stats.staleCash.push(
                  `howmuch answered ${d} after newer note ${lastCashDenoms.join(",")}: ${JSON.stringify(msg.text)}`
                );
              }
            }
          }
          if (denoms.length > 0) lastCashDenoms = denoms;
        }
      } else if (pending) {
        stats.lateAnswers++;
        pending = null;
      } else {
        stats.strayAnswers++;
      }
      return;
    }
    stats.proactiveByKind.set(msg.kind ?? "?", (stats.proactiveByKind.get(msg.kind ?? "?") ?? 0) + 1);
  }

  function onEarcon(msg) {
    if (msg.name === "ack") {
      if (pending && pending.muteWord && Date.now() - pending.sentAt <= UTTERANCE_TIMEOUT_MS) {
        stats.answerMs.push(Date.now() - pending.sentAt);
        stats.answered++;
        stats.earconAcks++;
        pending = null;
        scheduleGap();
      }
    }
  }

  function onCaptureNow(msg) {
    const r = rng();
    if (r < 0.1) {
      stats.captures.failed++;
      send({ type: "capture_failed", reqId: msg.reqId, reason: "soak: takePhoto returned null" });
    } else if (r < 0.3) {
      const delayMs = Math.floor(rng() * 3001);
      stats.captures.delayed++;
      stats.captureLateMs.push(delayMs);
      setTimeout(() => {
        if (!stopped) sendFrame(msg.reqId);
      }, delayMs);
    } else {
      stats.captures.immediate++;
      sendFrame(msg.reqId);
    }
  }

  function connect() {
    return new Promise((resolve) => {
      const sock = new WebSocket(args.url);
      ws = sock;
      const failTimer = setTimeout(() => {
        try {
          sock.close();
        } catch {
          // Ignore close errors on a failed connect.
        }
        resolve(false);
      }, 5000);
      sock.on("open", () => {
        clearTimeout(failTimer);
        send({ type: "hello", appVersion: "soak", device: "soak-phone" });
        send({ type: "settings", lang: "en" });
        send({ type: "camera_state", state: "ok" });
        resolve(true);
      });
      sock.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.type === "speak") onSpeak(msg);
        else if (msg.type === "earcon") onEarcon(msg);
        else if (msg.type === "capture_now") onCaptureNow(msg);
      });
      sock.on("close", () => {
        if (ws === sock) ws = null;
        if (!stopped) {
          stats.drops++;
          setTimeout(async () => {
            if (stopped) return;
            if (await connect()) stats.reconnects++;
          }, 1000 + Math.floor(rng() * 2000));
        }
      });
    });
  }

  // Answer-driven pacing: exactly one utterance is ever in flight, and
  // the next goes up 5-15 s after the previous resolves, so turns never
  // overlap (no barge-in supersede can strand an answer).
  function scheduleGap() {
    if (stopped) return;
    utteranceTimer = setTimeout(() => void sendUtterance(), 5000 + Math.floor(rng() * 10001));
  }

  async function sendUtterance() {
    utteranceTimer = null;
    if (stopped || Date.now() > deadline) return;
    if (deadline - Date.now() < UTTERANCE_TIMEOUT_MS + 1000) return; // no full window left
    if (!ws || ws.readyState !== WebSocket.OPEN || pending) {
      utteranceTimer = setTimeout(() => void sendUtterance(), 1000); // wait for socket
      return;
    }
    const text = PHRASES[Math.floor(rng() * PHRASES.length)];
    pending = { text, sentAt: Date.now(), muteWord: MUTE_WORDS.has(text.trim().toLowerCase()) };
    stats.utterances++;
    send({ type: "utterance", text, lang: "pa-IN", ts: Date.now() });
    const myPending = pending;
    setTimeout(() => {
      if (pending !== myPending) return; // already answered (gap scheduled)
      stats.timeouts.push(`${text} (no answer within ${UTTERANCE_TIMEOUT_MS / 1000} s)`);
      pending = null;
      scheduleGap();
    }, UTTERANCE_TIMEOUT_MS);
  }

  if (!(await connect())) throw new Error(`connect failed: ${args.url} (is the server up?)`);
  console.log("connected");
  const frameTimer = setInterval(() => {
    if (!stopped && ws && ws.readyState === WebSocket.OPEN) sendFrame();
  }, FRAME_MS);
  const pingTimer = setInterval(() => {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() < pingPausedUntil) return;
    if (rng() < 0.08) {
      pingPausedUntil = Date.now() + PING_PAUSE_MS;
      stats.pingPauses++;
      return;
    }
    send({ type: "ping", t: Date.now() });
  }, PING_MS);
  const dropTimer = setInterval(() => {
    if (stopped || pending || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (rng() < 0.02) {
      try {
        ws.close();
      } catch {
        // Ignore close errors on a deliberate drop.
      }
    }
  }, 1000);

  utteranceTimer = setTimeout(() => void sendUtterance(), 2000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  // Drain: the last utterance (if any) already had its full window because
  // sends stop 13 s before the deadline.
  stopped = true;
  clearInterval(frameTimer);
  clearInterval(pingTimer);
  clearInterval(dropTimer);
  if (utteranceTimer) clearTimeout(utteranceTimer);
  try {
    ws?.close();
  } catch {
    // Ignore close errors on shutdown.
  }

  const violations = [
    ...stats.timeouts.map((t) => `missing answer: ${t}`),
    ...stats.doubleTurns.map((t) => `turn ${t} got two answers`),
    ...stats.staleCash.map((s) => `stale cash: ${s}`),
    ...stats.invalidDenoms.map((s) => `invalid denomination: ${s}`),
  ];
  const avg = stats.answerMs.length
    ? Math.round(stats.answerMs.reduce((a, b) => a + b, 0) / stats.answerMs.length)
    : 0;
  const max = stats.answerMs.length ? Math.max(...stats.answerMs) : 0;
  console.log("---- soak summary ----");
  console.log(`frames sent: ${framesSent}`);
  console.log(`utterances: ${stats.utterances} answered: ${stats.answered} timeouts: ${stats.timeouts.length}`);
  console.log(`answer latency: avg=${avg}ms max=${max}ms (budget ${UTTERANCE_TIMEOUT_MS}ms)`);
  console.log(`late answers (after timeout): ${stats.lateAnswers} stray answers: ${stats.strayAnswers}`);
  console.log(`turns with two answers: ${stats.doubleTurns.length}`);
  console.log(`cash speaks: ${stats.cashSpeaks} howmuch answers: ${stats.howmuchAnswers}`);
  console.log(`stale cash: ${stats.staleCash.length} invalid denominations: ${stats.invalidDenoms.length}`);
  console.log(
    `captures: immediate=${stats.captures.immediate} delayed=${stats.captures.delayed} failed=${stats.captures.failed}`
  );
  console.log(`drops: ${stats.drops} reconnects: ${stats.reconnects} ping pauses: ${stats.pingPauses}`);
  console.log(
    `proactive by kind: ${[...stats.proactiveByKind.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`
  );
  if (violations.length > 0) {
    console.log(`FAIL: ${violations.length} violation(s)`);
    for (const v of violations.slice(0, 20)) console.log(`  - ${v}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
