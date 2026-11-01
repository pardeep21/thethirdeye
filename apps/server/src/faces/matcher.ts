// StoredFaceMatcher: embed the query image, cosine-match against enrolled
// embeddings, return hits above threshold. Unknown faces yield no hits:
// strangers are described generically, never identified.
import type { FaceHit } from "../protocol.js";
import type { FaceMatcher, MatchedFace } from "../adapters/index.js";
import { FACE_MATCH_MARGIN, FACE_MATCH_THRESHOLD } from "../decision.js";
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
    private readonly threshold: number = FACE_MATCH_THRESHOLD,
    private readonly margin: number = FACE_MATCH_MARGIN
  ) {}

  async match(img: Buffer): Promise<FaceHit[]> {
    const detailed = await this.matchDetailed(img);
    return detailed.map((d) => d.hit).filter((h): h is FaceHit => h !== null);
  }

  async matchDetailed(img: Buffer): Promise<MatchedFace[]> {
    const queryFaces = await this.embedder.embed(img);
    return queryFaces.map((face) => ({ face, hit: this.matchOne(face.embedding) }));
  }

  matchEmbedding(embedding: number[]): FaceHit | null {
    return this.matchOne(embedding);
  }

  /** One embedding against the store (also used for duplicate checks). */
  matchOne(embedding: number[]): FaceHit | null {
    const stored = this.store.allEmbeddings();
    if (stored.length === 0) return null;
    // Best score per enrolled person; the winner must clear the
    // threshold and the runner-up person by the margin. Comparing
    // persons (not raw embeddings) keeps a second photo of the same
    // person from vetoing its own match.
    const perPerson = new Map<number, StoredHit>();
    for (const s of stored) {
      const score = cosine(embedding, s.embedding);
      const prev = perPerson.get(s.personId);
      if (!prev || score > prev.score) {
        perPerson.set(s.personId, { personId: String(s.personId), name: s.name, score });
      }
    }
    const ranked = [...perPerson.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (
      best &&
      best.score >= this.threshold &&
      (runnerUp === undefined || best.score - runnerUp.score >= this.margin)
    ) {
      return best;
    }
    return null;
  }
}

interface StoredHit {
  personId: string;
  name: string;
  score: number;
}
