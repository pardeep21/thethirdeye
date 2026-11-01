import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAudioMessage,
  isCaptureNowMessage,
  isCommandMessage,
  isEarconMessage,
  isFrameMessage,
  isHelloMessage,
  isListeningMessage,
  isSettingsMessage,
  isSpeakMessage,
  isStateMessage,
  isUtteranceMessage,
} from "./protocol.js";

test("speak guard accepts a valid message and rejects junk", () => {
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P1" }), true);
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "xx", priority: "P1" }), false);
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P9" }), false);
  assert.equal(isSpeakMessage(null), false);
  assert.equal(isSpeakMessage("speak"), false);
});

test("speak guard accepts v2 id/kind and rejects bad kinds", () => {
  assert.equal(
    isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P1", id: "a1", kind: "cash" }),
    true
  );
  assert.equal(
    isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P1", kind: "jingle" }),
    false
  );
  assert.equal(
    isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P1", id: 7 }),
    false
  );
});

test("frame guard checks required fields", () => {
  assert.equal(
    isFrameMessage({ type: "frame", jpegBase64: "eA==", width: 1, height: 1, ts: 1 }),
    true
  );
  assert.equal(isFrameMessage({ type: "frame", width: 1, height: 1, ts: 1 }), false);
  assert.equal(isFrameMessage({ type: "frame", jpegBase64: "eA==", width: "1", height: 1, ts: 1 }), false);
});

test("frame guard accepts v2 lens/hfovDeg/reqId and rejects bad lens", () => {
  assert.equal(
    isFrameMessage({
      type: "frame",
      jpegBase64: "eA==",
      width: 1,
      height: 1,
      ts: 1,
      lens: "ultrawide",
      hfovDeg: 100,
      reqId: "r1",
    }),
    true
  );
  assert.equal(
    isFrameMessage({ type: "frame", jpegBase64: "eA==", width: 1, height: 1, ts: 1, lens: "zoom" }),
    false
  );
});

test("audio and command guards", () => {
  assert.equal(
    isAudioMessage({ type: "audio", audioBase64: "eA==", encoding: "m4a", sampleRate: 44100, ts: 1 }),
    true
  );
  assert.equal(
    isAudioMessage({ type: "audio", audioBase64: "eA==", encoding: "wav", sampleRate: 44100, ts: 1 }),
    false
  );
  assert.equal(isAudioMessage({ type: "audio", sampleRate: 16000, ts: 1 }), false);
  assert.equal(isCommandMessage({ type: "command", name: "mute" }), true);
  assert.equal(isCommandMessage({ type: "command", name: "dance" }), false);
});

test("settings guard", () => {
  assert.equal(isSettingsMessage({ type: "settings", lang: "hi" }), true);
  assert.equal(isSettingsMessage({ type: "settings", lang: "pa", script: "latin" }), true);
  assert.equal(isSettingsMessage({ type: "settings", lang: "pa", script: "roman" }), false);
  assert.equal(isSettingsMessage({ type: "settings", lang: "fr" }), false);
  assert.equal(isSettingsMessage({ type: "settings" }), false);
});

test("hello/utterance/listening guards", () => {
  assert.equal(isHelloMessage({ type: "hello", appVersion: "0.1.0", device: "s23" }), true);
  assert.equal(isHelloMessage({ type: "hello", appVersion: "0.1.0" }), false);
  assert.equal(
    isUtteranceMessage({ type: "utterance", text: "ki hai", lang: "pa-IN", ts: 1 }),
    true
  );
  assert.equal(
    isUtteranceMessage({ type: "utterance", text: "ki hai", lang: "pa-IN", confidence: 0.9, ts: 1 }),
    true
  );
  assert.equal(isUtteranceMessage({ type: "utterance", text: "ki hai", lang: "fr-FR", ts: 1 }), false);
  assert.equal(isUtteranceMessage({ type: "utterance", lang: "pa-IN", ts: 1 }), false);
  assert.equal(isListeningMessage({ type: "listening", state: "start" }), true);
  assert.equal(isListeningMessage({ type: "listening", state: "stop" }), true);
  assert.equal(isListeningMessage({ type: "listening", state: "maybe" }), false);
});

test("earcon/capture_now/state guards", () => {
  assert.equal(isEarconMessage({ type: "earcon", name: "ack" }), true);
  assert.equal(isEarconMessage({ type: "earcon", name: "fanfare" }), false);
  assert.equal(isCaptureNowMessage({ type: "capture_now", reqId: "r1" }), true);
  assert.equal(isCaptureNowMessage({ type: "capture_now", reqId: "r1", lens: "main" }), true);
  assert.equal(isCaptureNowMessage({ type: "capture_now" }), false);
  assert.equal(
    isStateMessage({ type: "state", lookAround: false, muted: false, agentBusy: true, lang: "pa" }),
    true
  );
  assert.equal(
    isStateMessage({ type: "state", lookAround: false, muted: false, agentBusy: true }),
    false
  );
});
