// Speech-out queue over expo-speech (Android TTS, on-device).
// P1 interrupts lower priorities mid-sentence; P2/P3 wait their turn.
// bargeIn() is the push-to-talk path: it stops speech the moment listening
// starts, except a cash line that just began (MVP rule: a command answer
// waits for a cash phrase in progress, which lasts <= 1.5 s).
import * as Speech from "expo-speech";
import type { SpeakLang, SpeakMessage } from "../../server/src/protocol";

const LANG_VOICE: Record<SpeakLang, string> = {
  pa: "pa-IN",
  hi: "hi-IN",
  en: "en-IN",
};

/** A cash line younger than this is left to finish on barge-in. */
export const CASH_GRACE_MS = 1500;

export class SpeakQueue {
  private queue: SpeakMessage[] = [];
  private speaking = false;
  private current: { msg: SpeakMessage; startedAt: number } | null = null;

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

  /**
   * Stop speech for barge-in. Clears the queue always; stops the current
   * utterance unless it is a cash line inside its grace window.
   */
  bargeIn(nowMs: number = Date.now()): void {
    this.queue = [];
    const cur = this.current;
    if (cur && cur.msg.kind === "cash" && nowMs - cur.startedAt <= CASH_GRACE_MS) return;
    void Speech.stop();
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) return;
    this.speaking = true;
    this.current = { msg: next, startedAt: Date.now() };
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
      this.current = null;
      this.speaking = false;
      void this.pump();
    }
  }

  async shutdown(): Promise<void> {
    this.queue = [];
    await Speech.stop();
  }
}
