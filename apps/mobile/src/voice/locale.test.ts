import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFor, pickRecognitionLocale, resolveRecognitionLocale } from "./locale.ts";

const ALL = ["pa-IN", "hi-IN", "en-IN", "en-US"];

test("settings language maps to its locale when supported", () => {
  assert.equal(pickRecognitionLocale("pa", ALL), "pa-IN");
  assert.equal(pickRecognitionLocale("hi", ALL), "hi-IN");
  assert.equal(pickRecognitionLocale("en", ALL), "en-IN");
});

test("unsupported primary falls back in pa/hi/en order", () => {
  assert.equal(pickRecognitionLocale("pa", ["hi-IN", "en-IN"]), "hi-IN");
  assert.equal(pickRecognitionLocale("pa", ["en-IN"]), "en-IN");
  assert.equal(pickRecognitionLocale("hi", ["pa-IN", "en-IN"]), "pa-IN");
  assert.equal(pickRecognitionLocale("en", ["pa-IN", "hi-IN"]), "pa-IN");
});

test("primary is tried first even when a fallback is also present", () => {
  assert.deepEqual(candidatesFor("hi"), ["hi-IN", "pa-IN", "en-IN"]);
  assert.deepEqual(candidatesFor("pa"), ["pa-IN", "hi-IN", "en-IN"]);
  assert.deepEqual(candidatesFor("en"), ["en-IN", "pa-IN", "hi-IN"]);
});

test("locale tags match case-insensitively with _ or - separators", () => {
  assert.equal(pickRecognitionLocale("pa", ["PA_in"]), "pa-IN");
  assert.equal(pickRecognitionLocale("hi", ["Hi-IN"]), "hi-IN");
});

test("bare language tag satisfies its locale", () => {
  assert.equal(pickRecognitionLocale("pa", ["pa"]), "pa-IN");
});

test("other region variants do not satisfy the locale", () => {
  assert.equal(pickRecognitionLocale("en", ["en-US"]), "en-IN");
});

test("explicit override wins over support and fallback chain", () => {
  assert.equal(resolveRecognitionLocale("pa", ["hi-IN", "en-IN"], "en-IN"), "en-IN");
  assert.equal(resolveRecognitionLocale("pa", ["hi-IN", "en-IN"], "hi-IN"), "hi-IN");
  assert.equal(resolveRecognitionLocale("pa", ["hi-IN", "en-IN"], null), "hi-IN");
  assert.equal(resolveRecognitionLocale("en", [], "hi-IN"), "hi-IN");
});

test("empty supported list returns the primary so the recognizer attempts it", () => {
  assert.equal(pickRecognitionLocale("pa", []), "pa-IN");
  assert.equal(pickRecognitionLocale("en", []), "en-IN");
});
