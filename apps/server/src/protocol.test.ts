import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAudioMessage,
  isCommandMessage,
  isFrameMessage,
  isSpeakMessage,
} from "./protocol.js";

test("speak guard accepts a valid message and rejects junk", () => {
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P1" }), true);
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "xx", priority: "P1" }), false);
  assert.equal(isSpeakMessage({ type: "speak", text: "hi", lang: "pa", priority: "P9" }), false);
  assert.equal(isSpeakMessage(null), false);
  assert.equal(isSpeakMessage("speak"), false);
});

test("frame guard checks required fields", () => {
  assert.equal(
    isFrameMessage({ type: "frame", jpegBase64: "eA==", width: 1, height: 1, ts: 1 }),
    true
  );
  assert.equal(isFrameMessage({ type: "frame", width: 1, height: 1, ts: 1 }), false);
  assert.equal(isFrameMessage({ type: "frame", jpegBase64: "eA==", width: "1", height: 1, ts: 1 }), false);
});

test("audio and command guards", () => {
  assert.equal(isAudioMessage({ type: "audio", pcm16Base64: "eA==", sampleRate: 16000, ts: 1 }), true);
  assert.equal(isAudioMessage({ type: "audio", sampleRate: 16000, ts: 1 }), false);
  assert.equal(isCommandMessage({ type: "command", name: "mute" }), true);
  assert.equal(isCommandMessage({ type: "command", name: "dance" }), false);
});
