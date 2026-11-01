// Short-lived face tracks (prompt 06): per-connection identity across
// frames from IoU + embedding association. RAM only; a track and all its
// embeddings die 120 s after it was last seen (the privacy guarantee).
// Refs (P1, P2, ...) never repeat within a session.
import { toClock } from "../clock.js";
import { FACE_MATCH_THRESHOLD } from "../decision.js";
import { cosine } from "./matcher.js";
import type { DetectedFace, FaceQuality } from "./embed.js";
import type { FaceHit } from "../protocol.js";

/** Min normalised-box IoU to keep a face on its track. */
export const TRACK_IOU_MIN = 0.3;
/** Tracks (and their embeddings) die this long after last seen. RAM only. */
export const TRACK_TTL_MS = 120_000;
/** Best samples kept per track, ranked by sampleScore. */
export const TRACK_SAMPLES_MAX = 8;
/** A sample counts toward enrollment quality above this score. */
export const TRACK_SAMPLE_MIN_SCORE = 50;

export interface TrackSample {
  embedding: number[];
  quality: FaceQuality;
  score: number;
  ts: number;
}

export interface FaceTrack {
  ref: string;
  lastBoxNorm: [number, number, number, number];
  clock: number;
  firstSeen: number;
  lastSeen: number;
  knownPersonId?: string;
  knownName?: string;
  /** True when this track matched a face in the latest update. */
  matchedThisFrame: boolean;
  /** Best samples first. */
  samples: TrackSample[];
}

/** One detection with its (possibly null) stored-person match. */
export interface TrackedFace {
  face: DetectedFace;
  hit: FaceHit | null;
}

export function boxIoU(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Sample quality: big × sharp × frontal. Unknown yaw is not penalised. */
export function sampleScore(q: FaceQuality): number {
  const yawRad = q.yawDeg === null ? 0 : (q.yawDeg * Math.PI) / 180;
  return q.sizePx * Math.min(q.blur / 100, 1) * Math.cos(yawRad);
}

/** Passing samples (enrollment quality), best first. */
export function passingSamples(track: FaceTrack): TrackSample[] {
  return track.samples.filter((s) => sampleScore(s.quality) >= TRACK_SAMPLE_MIN_SCORE);
}

/**
 * Best 3-5 diverse embeddings: seeded with the best sample, then greedy
 * max-min cosine distance so the set spans angles and expressions.
 */
export function selectDiverseSamples(samples: TrackSample[], n: number): TrackSample[] {
  if (samples.length === 0 || n <= 0) return [];
  const byScore = [...samples].sort((a, b) => sampleScore(b.quality) - sampleScore(a.quality));
  const selected = [byScore[0]];
  const rest = byScore.slice(1);
  while (selected.length < n && rest.length > 0) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < rest.length; i++) {
      let minDist = Infinity;
      for (const s of selected) {
        minDist = Math.min(minDist, 1 - cosine(rest[i].embedding, s.embedding));
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestIdx = i;
      }
    }
    selected.push(...rest.splice(bestIdx, 1));
  }
  return selected;
}

function boxCentreX(box: [number, number, number, number]): number {
  return box[0] + box[2] / 2;
}

export class FaceTracker {
  private readonly tracks = new Map<string, FaceTrack>();
  private refCounter = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly threshold: number = FACE_MATCH_THRESHOLD
  ) {}

  getTrack(ref: string): FaceTrack | undefined {
    return this.tracks.get(ref);
  }

  /** Tracks matched in the latest update (the people currently visible). */
  visibleTracks(): FaceTrack[] {
    return [...this.tracks.values()]
      .filter((t) => t.matchedThisFrame)
      .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }

  /** All live tracks, by ref. Exposed for scene state (not just visible). */
  liveTracks(): FaceTrack[] {
    return [...this.tracks.values()].sort((a, b) =>
      a.ref.localeCompare(b.ref, undefined, { numeric: true })
    );
  }

  markKnown(ref: string, personId: string, name: string): void {
    const track = this.tracks.get(ref);
    if (track) {
      track.knownPersonId = personId;
      track.knownName = name;
    }
  }

  /** Forget clears identity on every live track; the faces stay generic. */
  forgetPerson(personId: string): void {
    for (const track of this.tracks.values()) {
      if (track.knownPersonId === personId) {
        track.knownPersonId = undefined;
        track.knownName = undefined;
      }
    }
  }

  update(faces: TrackedFace[], hfovDeg: number, nowMs: number = this.clock()): FaceTrack[] {
    for (const [ref, t] of this.tracks) {
      if (nowMs - t.lastSeen > TRACK_TTL_MS) this.tracks.delete(ref);
    }
    for (const t of this.tracks.values()) t.matchedThisFrame = false;
    const claimed = new Set<string>();
    for (const { face, hit } of faces) {
      const track = this.associate(face, claimed) ?? this.spawn(face, hfovDeg, nowMs);
      claimed.add(track.ref);
      track.matchedThisFrame = true;
      track.lastBoxNorm = [...face.boxNorm] as [number, number, number, number];
      track.clock = toClock(boxCentreX(face.boxNorm), hfovDeg);
      track.lastSeen = nowMs;
      if (hit?.personId && hit.name) {
        track.knownPersonId = hit.personId;
        track.knownName = hit.name;
      }
      track.samples.push({
        embedding: [...face.embedding],
        quality: { ...face.quality },
        score: face.score,
        ts: nowMs,
      });
      track.samples.sort((a, b) => sampleScore(b.quality) - sampleScore(a.quality));
      track.samples.splice(TRACK_SAMPLES_MAX);
    }
    return this.liveTracks();
  }

  private associate(face: DetectedFace, claimed: Set<string>): FaceTrack | null {
    let byIou: FaceTrack | null = null;
    let bestIou = TRACK_IOU_MIN;
    let byEmb: FaceTrack | null = null;
    let bestSim = this.threshold;
    for (const t of this.tracks.values()) {
      if (claimed.has(t.ref)) continue;
      const iou = boxIoU(face.boxNorm, t.lastBoxNorm);
      if (iou >= bestIou) {
        bestIou = iou;
        byIou = t;
      }
      const anchor = t.samples[0];
      if (anchor) {
        const sim = cosine(face.embedding, anchor.embedding);
        if (sim >= bestSim) {
          bestSim = sim;
          byEmb = t;
        }
      }
    }
    return byIou ?? byEmb;
  }

  private spawn(face: DetectedFace, hfovDeg: number, nowMs: number): FaceTrack {
    this.refCounter += 1;
    const track: FaceTrack = {
      ref: `P${this.refCounter}`,
      lastBoxNorm: [...face.boxNorm] as [number, number, number, number],
      clock: toClock(boxCentreX(face.boxNorm), hfovDeg),
      firstSeen: nowMs,
      lastSeen: nowMs,
      matchedThisFrame: false,
      samples: [],
    };
    this.tracks.set(track.ref, track);
    return track;
  }
}
