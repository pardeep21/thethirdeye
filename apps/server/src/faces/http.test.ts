// HttpFaceEmbedder tests against a fake sidecar (plain node:http): no
// Python in CI. Parsing, timeouts, bad payloads and backend selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpFaceEmbedder, sidecarBaseUrl } from "./http.js";
import { StubFaceEmbedder } from "./embed.js";
import {
  facesEveryNFromEnv,
  selectEmbedder,
  shouldRunFaces,
  sidecarHealthy,
} from "./index.js";

interface FakeSidecar {
  baseUrl: string;
  seen: string[];
  close: () => Promise<void>;
}

async function startFake(
  onDetect: (body: Record<string, unknown>, res: ServerResponse) => void
): Promise<FakeSidecar> {
  const seen: string[] = [];
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, model: "ArcFace", detector: "fake", warm: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/detect") {
        seen.push(raw);
        onDetect(JSON.parse(raw) as Record<string, unknown>, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function goodFace(label: number[]) {
  return {
    box: [10, 20, 100, 100],
    boxNorm: [0.1, 0.2, 0.5, 0.5],
    score: 0.98,
    quality: { blur: 150, yawDeg: -5, sizePx: 100 },
    embedding: label,
  };
}

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.warn = orig) };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("embed parses multi-face results and posts base64", async () => {
  const fake = await startFake((_body, res) =>
    sendJson(res, 200, { faces: [goodFace([0.1, 0.2]), goodFace([0.3, 0.4])], ms: 12 })
  );
  try {
    const faces = await new HttpFaceEmbedder({ baseUrl: fake.baseUrl }).embed(Buffer.from("jpeg"));
    assert.equal(faces.length, 2);
    assert.deepEqual(faces[0]?.embedding, [0.1, 0.2]);
    assert.deepEqual(faces[1]?.box, [10, 20, 100, 100]);
    assert.equal(faces[0]?.quality.yawDeg, -5);
    const sent = JSON.parse(fake.seen[0] ?? "{}") as Record<string, unknown>;
    assert.equal(sent.imageBase64, Buffer.from("jpeg").toString("base64"));
  } finally {
    await fake.close();
  }
});

test("slow sidecar times out to no faces", async () => {
  const fake = await startFake((_body, res) => {
    setTimeout(() => sendJson(res, 200, { faces: [], ms: 500 }), 300);
  });
  const warn = captureWarn();
  try {
    const faces = await new HttpFaceEmbedder({ baseUrl: fake.baseUrl, timeoutMs: 30 }).embed(
      Buffer.alloc(0)
    );
    assert.deepEqual(faces, []);
    assert.ok(warn.lines.some((l) => l.includes("sidecar unreachable")), warn.lines.join(" | "));
  } finally {
    warn.restore();
    await fake.close();
  }
});

test("HTTP error, bad JSON and malformed faces fail closed", async () => {
  const err = await startFake((_body, res) => {
    res.writeHead(500);
    res.end();
  });
  const bad = await startFake((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not json{");
  });
  const mixed = await startFake((_body, res) =>
    sendJson(res, 200, { faces: [goodFace([0.5]), { box: "nope" }, null], ms: 3 })
  );
  const warn = captureWarn();
  try {
    assert.deepEqual(await new HttpFaceEmbedder({ baseUrl: err.baseUrl }).embed(Buffer.alloc(0)), []);
    assert.deepEqual(await new HttpFaceEmbedder({ baseUrl: bad.baseUrl }).embed(Buffer.alloc(0)), []);
    const faces = await new HttpFaceEmbedder({ baseUrl: mixed.baseUrl }).embed(Buffer.alloc(0));
    assert.equal(faces.length, 1);
    assert.deepEqual(faces[0]?.embedding, [0.5]);
    assert.ok(warn.lines.some((l) => l.includes("HTTP 500")), warn.lines.join(" | "));
    assert.ok(warn.lines.some((l) => l.includes("invalid JSON")), warn.lines.join(" | "));
    assert.ok(warn.lines.some((l) => l.includes("dropped 2 malformed")), warn.lines.join(" | "));
  } finally {
    warn.restore();
    await err.close();
    await bad.close();
    await mixed.close();
  }
});

test("sidecarHealthy answers true up, false down", async () => {
  const fake = await startFake((_body, res) => sendJson(res, 200, { faces: [], ms: 1 }));
  try {
    assert.equal(await sidecarHealthy(fake.baseUrl, 500), true);
  } finally {
    await fake.close();
  }
  assert.equal(await sidecarHealthy(fake.baseUrl, 200), false);
});

test("selectEmbedder honours FACES and probes the sidecar", async () => {
  const fake = await startFake((_body, res) => sendJson(res, 200, { faces: [], ms: 1 }));
  const warn = captureWarn();
  try {
    const port = new URL(fake.baseUrl).port;
    process.env.FACES_PORT = port;
    try {
      process.env.FACES = "stub";
      assert.ok((await selectEmbedder()) instanceof StubFaceEmbedder);
      delete process.env.FACES;
      assert.ok((await selectEmbedder()) instanceof HttpFaceEmbedder);
    } finally {
      delete process.env.FACES_PORT;
      delete process.env.FACES;
    }
  } finally {
    warn.restore();
    await fake.close();
  }
  // Sidecar gone: warn once and fall back to the stub.
  const warn2 = captureWarn();
  try {
    process.env.FACES_PORT = new URL(fake.baseUrl).port;
    try {
      assert.ok((await selectEmbedder()) instanceof StubFaceEmbedder);
      assert.ok(warn2.lines.some((l) => l.includes("not answering")), warn2.lines.join(" | "));
    } finally {
      delete process.env.FACES_PORT;
    }
  } finally {
    warn2.restore();
  }
});

test("facesEveryNFromEnv defaults to 1 and rejects junk", () => {
  withEnv({ FACES_EVERY_N: undefined }, () => assert.equal(facesEveryNFromEnv(), 1));
  withEnv({ FACES_EVERY_N: "2" }, () => assert.equal(facesEveryNFromEnv(), 2));
  withEnv({ FACES_EVERY_N: "0" }, () => assert.throws(() => facesEveryNFromEnv(), /positive integer/));
  withEnv({ FACES_EVERY_N: "nope" }, () => assert.throws(() => facesEveryNFromEnv(), /positive integer/));
});

test("shouldRunFaces gates frames 0, N, 2N", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((f) => shouldRunFaces(f, 1)), [true, true, true, true, true]);
  assert.deepEqual([0, 1, 2, 3, 4].map((f) => shouldRunFaces(f, 2)), [true, false, true, false, true]);
});

test("sidecarBaseUrl honours FACES_HOST and FACES_PORT", () => {
  withEnv({ FACES_HOST: undefined, FACES_PORT: undefined }, () =>
    assert.equal(sidecarBaseUrl(), "http://127.0.0.1:8765")
  );
  withEnv({ FACES_HOST: "faces", FACES_PORT: undefined }, () =>
    assert.equal(sidecarBaseUrl(), "http://faces:8765")
  );
  withEnv({ FACES_HOST: undefined, FACES_PORT: "9999" }, () =>
    assert.equal(sidecarBaseUrl(), "http://127.0.0.1:9999")
  );
});
