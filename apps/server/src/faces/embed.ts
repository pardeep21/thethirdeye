// Face embedding behind an interface. Only the stub ships: the
// @vladmandic/human path failed 3 ways (see docs/PROGRESS.md M5 Blocked) and
// was removed. To revive real recognition, implement FaceEmbedder (e.g. the
// Snapbook pipeline, MVP.md Q4) and return it from faces/index.ts.
// The stub finds no faces (fail-closed: strangers stay generic).
export interface FaceEmbedding {
  embedding: number[];
  score: number;
}

export interface FaceEmbedder {
  embed(jpeg: Buffer): Promise<FaceEmbedding[]>;
}

export class StubFaceEmbedder implements FaceEmbedder {
  async embed(_jpeg: Buffer): Promise<FaceEmbedding[]> {
    return [];
  }
}
