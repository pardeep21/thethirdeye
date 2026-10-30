import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestFrameStore } from "./store.js";

test("store keeps only the latest frame", () => {
  const store = new LatestFrameStore();
  assert.equal(store.get(), null);
  store.set({ jpeg: Buffer.from([1]), width: 2, height: 2, ts: 1, receivedAt: 1 });
  store.set({ jpeg: Buffer.from([2]), width: 2, height: 2, ts: 2, receivedAt: 2 });
  assert.deepEqual(store.get()?.jpeg, Buffer.from([2]));
  store.clear();
  assert.equal(store.get(), null);
});
