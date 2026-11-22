#!/usr/bin/env node
// Soak runner: builds are done by the npm script; this starts the server
// with PROVIDER=chaos on a free port (in-memory DB, stub faces, no turn
// logs), runs soak.mjs against it, then stops the server. Extra args pass
// through to soak.mjs (e.g. --minutes 10 --seed 7); --seed also fixes
// CHAOS_SEED so a failure reproduces end to end.
// Usage (from apps/server): node scripts/run-soak.mjs [--minutes N] [--seed S]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { minutes: "10", seed: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--minutes" && i + 1 < argv.length) {
      out.minutes = argv[++i];
      out.passthrough.push("--minutes", out.minutes);
    } else if (a === "--seed" && i + 1 < argv.length) {
      out.seed = argv[++i];
      out.passthrough.push("--seed", out.seed);
    } else {
      out.passthrough.push(a);
    }
  }
  return out;
}

function waitForPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for the server port")), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const m = /thethirdeye server on :(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.seed ?? String((Date.now() ^ (process.pid * 2654435761)) >>> 0);
  const server = spawn(process.execPath, [join(HERE, "..", "dist", "index.js")], {
    cwd: join(HERE, ".."),
    env: {
      ...process.env,
      PROVIDER: "chaos",
      PORT: "0",
      FACES: "stub",
      TURN_LOG_DIR: "",
      THETHIRDEYE_DB: ":memory:",
      CHAOS_SEED: process.env.CHAOS_SEED ?? seed,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const fail = (msg) => {
    try {
      server.kill();
    } catch {
      // Ignore kill errors on a failed start.
    }
    console.error(`run-soak: ${msg}`);
    process.exit(2);
  };
  server.on("error", (err) => fail(`server spawn failed: ${err.message}`));
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${String(d)}`));
  let port;
  try {
    port = await waitForPort(server, 20000);
  } catch (err) {
    fail(err.message);
    return;
  }
  console.log(`run-soak: server on :${port} (PROVIDER=chaos CHAOS_SEED=${process.env.CHAOS_SEED ?? seed})`);
  const soakArgs = [...args.passthrough];
  if (!soakArgs.includes("--seed")) soakArgs.push("--seed", seed);
  const soak = spawn(process.execPath, [join(HERE, "soak.mjs"), "--url", `ws://127.0.0.1:${port}`, ...soakArgs], {
    cwd: join(HERE, ".."),
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => soak.on("close", resolve));
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        server.kill("SIGKILL");
      } catch {
        // Ignore kill errors on shutdown.
      }
      resolve();
    }, 5000);
    server.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      server.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  process.exit(code ?? 1);
}

main().catch((err) => {
  console.error(`run-soak: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
