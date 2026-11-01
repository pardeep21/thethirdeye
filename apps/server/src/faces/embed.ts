// Face embedding behind an interface. The @vladmandic/human path failed
// 3 ways (see docs/PROGRESS.md M5 Blocked) and was removed; real
// recognition comes from the local Python sidecar (apps/faces) via
// HttpFaceEmbedder. The stub finds no faces (fail-closed: strangers stay
// generic).
export interface FaceQuality {
  /** Variance of the Laplacian on the face crop (higher = sharper). */
  blur: number;
  /** Estimated yaw in degrees, or null when the detector has no landmarks. */
  yawDeg: number | null;
  /** Face size in pixels (max of box w/h). */
  sizePx: number;
}

export interface DetectedFace {
  /** Pixel box [x, y, w, h] in the source image. */
  box: [number, number, number, number];
  /** Normalised box [x, y, w, h] 0..1 from the image's top-left. */
  boxNorm: [number, number, number, number];
  /** Detector confidence 0..1. */
  score: number;
  quality: FaceQuality;
  /** L2-normalised embedding (ArcFace: 512 floats). */
  embedding: number[];
}

export interface FaceEmbedder {
  embed(jpeg: Buffer): Promise<DetectedFace[]>;
}

export class StubFaceEmbedder implements FaceEmbedder {
  async embed(_jpeg: Buffer): Promise<DetectedFace[]> {
    return [];
  }
}
