// StoredFaceMatcher: embed the query image, cosine-match against enrolled
// embeddings, return hits above threshold. Unknown faces yield no hits:
// strangers are described generically, never identified.
import type { FaceHit } from "../protocol.js";
import type { FaceMatcher } from "../adapters/index.js";
import { FACE_MATCH_THRESHOLD } from "../decision.js";
import type { FaceEmbedder } from "./embed.js";
import type { PeopleStore } from "./store.js";

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class StoredFaceMatcher implements FaceMatcher {
  constructor(
    private readonly store: PeopleStore,
    private readonly embedder: FaceEmbedder,
    private readonly threshold: number = FACE_MATCH_THRESHOLD
  ) {}

  async match(img: Buffer): Promise<FaceHit[]> {
    const queryFaces = await this.embedder.embed(img);
    if (queryFaces.length === 0) return [];
    const stored = this.store.allEmbeddings();
    if (stored.length === 0) return [];
    const hits: FaceHit[] = [];
    for (const q of queryFaces) {
      let best: StoredHit | null = null;
      for (const s of stored) {
        const score = cosine(q.embedding, s.embedding);
        if (!best || score > best.score) {
          best = { personId: String(s.personId), name: s.name, score };
        }
      }
      if (best && best.score >= this.threshold) hits.push(best);
    }
    return hits;
  }
}

interface StoredHit {
  personId: string;
  name: string;
  score: number;
}
