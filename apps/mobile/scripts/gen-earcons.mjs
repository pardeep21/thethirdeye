// Generates the 4 bundled earcon blips (16-bit mono WAVs, all < 150 ms).
// Run: node scripts/gen-earcons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "earcons");

/** Sine blip with 5 ms raised-cosine fades to avoid clicks. */
function tone(freqHz, ms, gain = 0.5) {
  const n = Math.floor((RATE * ms) / 1000);
  const out = new Float64Array(n);
  const fade = Math.floor(RATE * 0.005);
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= n - fade) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fade);
    out[i] = gain * env * Math.sin((2 * Math.PI * freqHz * i) / RATE);
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function silence(ms) {
  return new Float64Array(Math.floor((RATE * ms) / 1000));
}

function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const BLIPS = {
  ack: tone(880, 80), // listen start: bright blip
  thinking: concat(tone(660, 55), silence(15), tone(990, 55)), // rising two-tone
  error: concat(tone(220, 70, 0.45), tone(174, 70, 0.45)), // low double buzz
  saved: tone(1320, 90), // high confirm chirp
};

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(BLIPS)) {
  const ms = (samples.length / RATE) * 1000;
  if (ms >= 150) throw new Error(`${name} is ${ms.toFixed(0)} ms, must be < 150 ms`);
  const file = join(OUT, `${name}.wav`);
  writeFileSync(file, toWav(samples));
  console.log(`${name}.wav ${ms.toFixed(0)} ms`);
}
