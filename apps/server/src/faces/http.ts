// HttpFaceEmbedder: the FaceEmbedder seam backed by the local Python
// sidecar (apps/faces). Any failure (timeout, bad JSON, sidecar down)
// resolves to "no faces" and logs once per call: the frame path never
// crashes and strangers stay generic (fail-closed).
import type { DetectedFace, FaceEmbedder } from "./embed.js";

/** Sidecar call budget: slower than this counts as "no faces". */
export const SIDECAR_TIMEOUT_MS = 1500;

export function sidecarBaseUrl(): string {
  const host = process.env.FACES_HOST ?? "127.0.0.1";
  const port = process.env.FACES_PORT ?? "8765";
  return `http://${host}:${port}`;
}

export interface HttpFaceEmbedderOpts {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isNum4(v: unknown): v is [number, number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function parseFace(v: unknown): DetectedFace | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isNum4(r.box) || !isNum4(r.boxNorm)) return null;
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) return null;
  if (typeof r.quality !== "object" || r.quality === null) return null;
  const q = r.quality as Record<string, unknown>;
  if (typeof q.blur !== "number" || !Number.isFinite(q.blur)) return null;
  if (q.yawDeg !== null && (typeof q.yawDeg !== "number" || !Number.isFinite(q.yawDeg))) return null;
  if (typeof q.sizePx !== "number" || !Number.isFinite(q.sizePx)) return null;
  if (
    !Array.isArray(r.embedding) ||
    r.embedding.length === 0 ||
    !r.embedding.every((n) => typeof n === "number" && Number.isFinite(n as number))
  ) {
    return null;
  }
  return {
    box: r.box,
    boxNorm: r.boxNorm,
    score: r.score,
    quality: { blur: q.blur, yawDeg: q.yawDeg, sizePx: q.sizePx },
    embedding: (r.embedding as number[]).slice(),
  };
}

export class HttpFaceEmbedder implements FaceEmbedder {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFaceEmbedderOpts = {}) {
    this.baseUrl = opts.baseUrl ?? sidecarBaseUrl();
    this.timeoutMs = opts.timeoutMs ?? SIDECAR_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(jpeg: Buffer): Promise<DetectedFace[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64: jpeg.toString("base64") }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.warn(`faces sidecar unreachable: ${err instanceof Error ? err.message : err}`);
      return [];
    }
    if (!res.ok) {
      console.warn(`faces sidecar /detect -> HTTP ${res.status}`);
      return [];
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      console.warn("faces sidecar /detect -> invalid JSON");
      return [];
    }
    const faces = (body as Record<string, unknown> | null)?.faces;
    if (!Array.isArray(faces)) {
      console.warn("faces sidecar /detect -> missing faces array");
      return [];
    }
    const out: DetectedFace[] = [];
    for (const f of faces) {
      const parsed = parseFace(f);
      if (parsed) out.push(parsed);
    }
    if (out.length !== faces.length) {
      console.warn(`faces sidecar /detect -> dropped ${faces.length - out.length} malformed face(s)`);
    }
    return out;
  }
}
