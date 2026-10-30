// Mock providers: fixed answers until a real key works (MVP.md section 0).
// MockVisionTriage takes a script so tests and demos can drive sequences.
import type { Box, FaceHit, TriageResult } from "../protocol.js";
import type {
  FaceMatcher,
  NamedTriage,
  ObjectFinder,
  SpeechToText,
  VisionAnswer,
} from "./index.js";

export const DEFAULT_MOCK_TRIAGE: TriageResult = {
  notes: [{ denomination: 500, confidence: 0.9 }],
  people: [],
};

export class MockVisionTriage implements NamedTriage {
  readonly name = "mock";
  private i = 0;

  constructor(private readonly script: TriageResult[] = [DEFAULT_MOCK_TRIAGE]) {}

  async triage(_img: Buffer): Promise<TriageResult> {
    const r = this.script[this.i % this.script.length] ?? DEFAULT_MOCK_TRIAGE;
    this.i++;
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
  async match(_img: Buffer): Promise<FaceHit[]> {
    return [];
  }
}
