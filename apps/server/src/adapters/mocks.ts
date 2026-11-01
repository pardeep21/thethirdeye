// Mock providers: fixed answers until a real key works (MVP.md section 0).
// MockVisionTriage takes a script so tests and demos can drive sequences.
import type { Box, FaceHit, SceneTriage, TriageResult } from "../protocol.js";
import type {
  FaceMatcher,
  MatchedFace,
  NamedTriage,
  ObjectFinder,
  SpeechToText,
  VisionAnswer,
} from "./index.js";

export const DEFAULT_MOCK_TRIAGE: TriageResult = {
  notes: [{ denomination: 500, confidence: 0.9 }],
  people: [],
};

export const DEFAULT_MOCK_SCENE: SceneTriage = {
  notes: [{ denomination: 500, confidence: 0.9 }],
  people: [],
  objects: [{ label: "kursi", x: 0.5, y: 0.6, distance: "mid", salience: 2 }],
};

export class MockVisionTriage implements NamedTriage {
  readonly name = "mock";
  private i = 0;
  private si = 0;

  constructor(
    private readonly script: TriageResult[] = [DEFAULT_MOCK_TRIAGE],
    private readonly sceneScript: SceneTriage[] = [DEFAULT_MOCK_SCENE]
  ) {}

  async triage(_img: Buffer): Promise<TriageResult> {
    const r = this.script[this.i % this.script.length] ?? DEFAULT_MOCK_TRIAGE;
    this.i++;
    return structuredClone(r);
  }

  async triageScene(_img: Buffer): Promise<SceneTriage> {
    const r = this.sceneScript[this.si % this.sceneScript.length] ?? DEFAULT_MOCK_SCENE;
    this.si++;
    return structuredClone(r);
  }

  getLastUsage(): undefined {
    return undefined;
  }
}

export class MockVisionAnswer implements VisionAnswer {
  async describe(_img: Buffer, _q: string): Promise<string> {
    return "Mock counter: two packets, a phone, one bag left side.";
  }

  async read(_img: Buffer): Promise<string> {
    return "Mock label: Atta 5kg, Rs 240.";
  }
}

export class MockObjectFinder implements ObjectFinder {
  async find(_img: Buffer, _noun: string): Promise<Box[]> {
    return [{ x: 0.6, y: 0.5, w: 0.2, h: 0.2 }];
  }
}

export class MockSpeechToText implements SpeechToText {
  constructor(private readonly fixed = "ki hai saamne") {}

  async transcribe(_audio: Buffer): Promise<string> {
    return process.env.MOCK_STT_TEXT ?? this.fixed;
  }
}

export class MockFaceMatcher implements FaceMatcher {
  /** Scripted matchDetailed answers, one per call (last repeats). */
  private calls = 0;
  /** Scripted duplicate-check answer. */
  embeddingHit: FaceHit | null = null;

  constructor(private readonly script: MatchedFace[][] = []) {}

  async match(img: Buffer): Promise<FaceHit[]> {
    const detailed = await this.matchDetailed(img);
    return detailed.map((d) => d.hit).filter((h): h is FaceHit => h !== null);
  }

  async matchDetailed(_img: Buffer): Promise<MatchedFace[]> {
    const idx = Math.min(this.calls++, Math.max(0, this.script.length - 1));
    return this.script[idx] ?? [];
  }

  matchEmbedding(_embedding: number[]): FaceHit | null {
    return this.embeddingHit;
  }
}
