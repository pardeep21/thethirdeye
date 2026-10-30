// Speech-out queue over expo-speech (Android TTS, on-device).
// P1 interrupts lower priorities mid-sentence; P2/P3 wait their turn.
import * as Speech from "expo-speech";
import type { SpeakLang, SpeakMessage } from "../../server/src/protocol";

const LANG_VOICE: Record<SpeakLang, string> = {
  pa: "pa-IN",
  hi: "hi-IN",
  en: "en-IN",
};

export class SpeakQueue {
  private queue: SpeakMessage[] = [];
  private speaking = false;

  enqueue(msg: SpeakMessage): void {
    if (msg.priority === "P1") {
      // Drop everything queued and stop the current utterance; the pump
      // picks up the P1 next via onStopped.
      this.queue = [msg];
      void Speech.stop();
    } else {
      this.queue.push(msg);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) return;
    this.speaking = true;
    try {
      await new Promise<void>((resolve) => {
        Speech.speak(next.text, {
          language: LANG_VOICE[next.lang],
          onDone: () => resolve(),
          onStopped: () => resolve(),
          onError: () => resolve(),
        });
      });
    } finally {
      this.speaking = false;
      void this.pump();
    }
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    await Speech.stop();
  }
}
