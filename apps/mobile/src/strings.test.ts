// Strings tests: every language carries the same keys, nothing empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GREETING, NO_NETWORK, STRINGS } from "./strings.ts";

test("all languages share identical string keys", () => {
  const keys = Object.keys(STRINGS.pa).sort();
  assert.ok(keys.length > 20);
  for (const lang of ["hi", "en"] as const) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys);
  }
});

test("no empty strings, talk title is short", () => {
  for (const lang of ["pa", "hi", "en"] as const) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      assert.ok(value.trim().length > 0, `${lang}.${key} is non-empty`);
    }
  }
  assert.equal(STRINGS.pa.talkTitle, "Gall karo");
});

test("greeting and offline lines exist per script and language", () => {
  assert.equal(GREETING.latin, "Main tiyaar haan. Gall karan layi button dabao.");
  assert.ok(GREETING.gurmukhi.includes("ਤਿਆਰ"));
  assert.ok(GREETING.devanagari.includes("तैयार"));
  assert.equal(NO_NETWORK.en, "no network");
});
