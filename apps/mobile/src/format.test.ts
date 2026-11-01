// Format helper tests: relative times, latency, cash-line parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLatency, parseCashLine, timeAgo, voiceChip } from "./format.ts";

test("timeAgo follows the design wording", () => {
  const now = 1_000_000;
  assert.equal(timeAgo(now, now), "Just now");
  assert.equal(timeAgo(now - 9_000, now), "Just now");
  assert.equal(timeAgo(now - 10_000, now), "10 s ago");
  assert.equal(timeAgo(now - 59_000, now), "59 s ago");
  assert.equal(timeAgo(now - 60_000, now), "1 min ago");
  assert.equal(timeAgo(now - 2 * 60_000, now), "2 min ago");
  assert.equal(timeAgo(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(timeAgo(now + 5_000, now), "Just now"); // future clamps
});

test("formatLatency shows one decimal of seconds", () => {
  assert.equal(formatLatency(1800), "1.8 s");
  assert.equal(formatLatency(250), "0.3 s");
});

test("parseCashLine maps every single-note template", () => {
  assert.equal(parseCashLine("ਪੰਜ ਸੌ ਦਾ ਨੋਟ"), 500);
  assert.equal(parseCashLine("ਵੀਹ ਦਾ ਨੋਟ"), 20);
  assert.equal(parseCashLine("ਦਸ ਦਾ ਨੋਟ"), 10);
  assert.equal(parseCashLine("ਪੰਜਾਹ ਦਾ ਨੋਟ"), 50);
  assert.equal(parseCashLine("ਸੌ ਦਾ ਨੋਟ"), 100);
  assert.equal(parseCashLine("ਦੋ ਸੌ ਦਾ ਨੋਟ"), 200);
  assert.equal(parseCashLine("पाँच सौ का नोट"), 500);
  assert.equal(parseCashLine("500 rupee note"), 500);
  assert.equal(parseCashLine("  ਸੌ ਦਾ ਨੋਟ  "), 100);
  assert.equal(parseCashLine("ਦੋ ਨੋਟ: ਸੌ, ਪੰਜਾਹ"), null);
  assert.equal(parseCashLine("ਪੱਕਾ ਨਹੀਂ, ਨੋਟ ਸਿੱਧਾ ਕਰੋ"), null);
  assert.equal(parseCashLine("hello"), null);
});

test("voiceChip labels the answer language", () => {
  assert.equal(voiceChip("pa"), "Voice: ਪੰਜਾਬੀ");
  assert.equal(voiceChip("hi"), "Voice: हिंदी");
  assert.equal(voiceChip("en"), "Voice: English");
});
