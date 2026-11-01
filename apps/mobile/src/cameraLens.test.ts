// One-shot capture lens decisions: the request wins, else current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCaptureLens } from "./cameraLens.ts";

test("requested lens wins and flags the switch", () => {
  assert.deepEqual(resolveCaptureLens("main", "ultrawide"), { lens: "main", switched: true });
  assert.deepEqual(resolveCaptureLens("ultrawide", "main"), { lens: "ultrawide", switched: true });
});

test("matching request or none keeps the current lens", () => {
  assert.deepEqual(resolveCaptureLens("main", "main"), { lens: "main", switched: false });
  assert.deepEqual(resolveCaptureLens(undefined, "ultrawide"), { lens: "ultrawide", switched: false });
  assert.deepEqual(resolveCaptureLens(undefined, "main"), { lens: "main", switched: false });
});
