// Faces wiring: SQLite path from THETHIRDEYE_DB (default ./thethirdeye.db),
// embedder selection (sidecar when its /health answers, else the stub),
// and the every-N-frames gate for slow machines.
import { join } from "node:path";
import type { FaceMatcher } from "../adapters/index.js";
import { HttpFaceEmbedder, sidecarBaseUrl } from "./http.js";
import { StubFaceEmbedder, type FaceEmbedder } from "./embed.js";
import { StoredFaceMatcher } from "./matcher.js";
import { PeopleStore } from "./store.js";

export function defaultDbPath(): string {
  return process.env.THETHIRDEYE_DB ?? join(process.cwd(), "thethirdeye.db");
}

export function createFaceMatcher(store: PeopleStore, embedder?: FaceEmbedder): FaceMatcher {
  return new StoredFaceMatcher(store, embedder ?? new StubFaceEmbedder());
}

/** Health probe: true when the sidecar answers ok within the budget. */
export async function sidecarHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown> | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Embedder selection. FACES=stub forces the stub; otherwise the sidecar
 * wins when its /health answers, else the stub with a warning (the
 * server always boots, even mid-demo without Python running).
 */
export async function selectEmbedder(): Promise<FaceEmbedder> {
  if ((process.env.FACES ?? "").toLowerCase() === "stub") return new StubFaceEmbedder();
  const baseUrl = sidecarBaseUrl();
  if (await sidecarHealthy(baseUrl, 1000)) return new HttpFaceEmbedder({ baseUrl });
  console.warn(`faces sidecar not answering at ${baseUrl}; face recognition is off (stub)`);
  return new StubFaceEmbedder();
}

/** Run face detection every Nth frame (FACES_EVERY_N, default 1 = every frame). */
export function facesEveryNFromEnv(): number {
  const raw = process.env.FACES_EVERY_N;
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`FACES_EVERY_N=${raw} must be a positive integer`);
  return n;
}

/** True for frames 0, N, 2N, ... (frame counter starts at 0). */
export function shouldRunFaces(frameNo: number, everyN: number): boolean {
  return frameNo % everyN === 0;
}
