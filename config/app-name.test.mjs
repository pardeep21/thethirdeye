// Consistency check: apps/mobile/app.json must mirror config/app-name.ts.
// Run at repo root via `npm test` (node --test config/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_DISPLAY_NAME, APP_PKG_SCOPE, APP_ID } from "./app-name.ts";

test("mobile app.json mirrors config/app-name.ts", () => {
  const url = new URL("../apps/mobile/app.json", import.meta.url);
  const appJson = JSON.parse(readFileSync(url, "utf8"));
  const expo = appJson.expo;
  assert.equal(expo.name, APP_DISPLAY_NAME);
  assert.equal(expo.slug, APP_DISPLAY_NAME.toLowerCase());
  assert.equal(expo.android.package, APP_ID);
  assert.equal(expo.ios.bundleIdentifier, APP_ID);
});

test("workspace packages use the configured scope", () => {
  for (const ws of ["eval", "server", "mobile"]) {
    const url = new URL(`../apps/${ws}/package.json`, import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8"));
    assert.equal(pkg.name, `${APP_PKG_SCOPE}/${ws}`);
  }
});
