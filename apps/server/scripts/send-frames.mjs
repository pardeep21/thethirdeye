#!/usr/bin/env node
// End-to-end smoke: send real JPEGs as WS frame messages to a running server
// (PROVIDER=mock) and print the speak replies. Exits 0 on >= 1 speak.
// Usage (from apps/server):
//   node scripts/send-frames.mjs [ws://127.0.0.1:8080] [photo1.jpg ...]
// With no photos, uses ../eval/data/notes/*.jpg.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));

function defaultPhotos() {
  const dir = join(HERE, "..", "..", "eval", "data", "notes");
  try {
    return readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** Minimal JPEG SOF dimension scan; [0, 0] when unparseable. */
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

function sendFrame(ws, file) {
  const buf = readFileSync(file);
  const [width, height] = jpegDims(buf);
  ws.send(
    JSON.stringify({ type: "frame", jpegBase64: buf.toString("base64"), width, height, ts: Date.now() })
  );
  console.log(`sent ${file} (${width}x${height}, ${buf.length} bytes)`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("ws://") || a.startsWith("wss://")) ?? "ws://127.0.0.1:8080";
  const files = args.filter((a) => !a.startsWith("ws"));
  const photos = files.length ? files : defaultPhotos();
  if (!photos.length) {
    console.error("no photos: pass JPEG paths or add files to apps/eval/data/notes/");
    process.exit(2);
  }
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout: ${url} (is the server up?)`)), 5000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", reject);
  });
  console.log(`connected: ${url}`);
  let speaks = 0;
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "speak") {
      speaks++;
      console.log(`speak [${msg.priority}] (${msg.lang}): ${msg.text}`);
    } else {
      console.log(`other: ${String(data).slice(0, 200)}`);
    }
  });
  for (const photo of photos) {
    sendFrame(ws, photo);
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 3000));
  ws.close();
  console.log(speaks ? `OK: ${speaks} speak message(s)` : "FAIL: no speak messages received");
  process.exit(speaks ? 0 : 1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
