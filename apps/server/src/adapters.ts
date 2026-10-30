// Adapter layer, M0 slice: provider selection plus the mock vision adapter.
// M1 grows this file into src/adapters/ with the full MVP.md section 2
// interfaces (VisionTriage, VisionAnswer, ObjectFinder, SpeechToText,
// FaceMatcher) and the OpenAI-compatible provider.

import type { TriageResult } from "./protocol.js";

export type ProviderName = "mock";

export interface VisionTriage {
  triage(img: Buffer): Promise<TriageResult>;
}

/** Fixed answers until a real key works (MVP.md section 0: mock-first). */
export class MockVision implements VisionTriage {
  async triage(_img: Buffer): Promise<TriageResult> {
    return {
      notes: [{ denomination: 500, confidence: 0.9 }],
      people: [],
    };
  }
}

export function providerFromEnv(): ProviderName {
  const raw = (process.env.PROVIDER ?? "mock").toLowerCase();
  if (raw !== "mock") {
    throw new Error(`PROVIDER=${raw} is not implemented yet (M0 supports only "mock")`);
  }
  return "mock";
}

export function createVisionTriage(provider: ProviderName): VisionTriage {
  switch (provider) {
    case "mock":
      return new MockVision();
  }
}
