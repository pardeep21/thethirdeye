// CaptureLock: serialisation, capture_now priority, dropped stale gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureLock } from "./captureLock.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("serialises concurrent holders: second waits for first release", async () => {
  const lock = new CaptureLock();
  const first = await lock.acquire("capture");
  assert.ok(first, "first acquire holds the lock");
  let second: unknown = "pending";
  const waiting = lock.acquire("capture").then((r) => {
    second = r;
  });
  await tick();
  await tick();
  assert.equal(second, "pending", "second waits while first holds");
  first();
  await waiting;
  assert.ok(typeof second === "function", "second gets the lock after release");
  (second as () => void)();
});

test("capture_now jumps ahead of a waiting gate; the gate is dropped", async () => {
  const lock = new CaptureLock();
  const hold = await lock.acquire("gate");
  assert.ok(hold);
  const gateResult = lock.acquire("gate");
  const captureResult = lock.acquire("capture");
  // The waiting gate drops as soon as the capture arrives.
  assert.equal(await gateResult, null);
  // The capture still waits for the running holder.
  let capture: unknown = "pending";
  void captureResult.then((r) => {
    capture = r;
  });
  await tick();
  assert.equal(capture, "pending");
  hold();
  const release = await captureResult;
  assert.ok(typeof release === "function", "capture runs after the holder");
  release();
});

test("a newer gate replaces a waiting gate instead of piling up", async () => {
  const lock = new CaptureLock();
  const hold = await lock.acquire("capture");
  assert.ok(hold);
  const stale = lock.acquire("gate");
  const fresh = lock.acquire("gate");
  assert.equal(await stale, null, "stale gate dropped");
  let freshRelease: unknown = "pending";
  void fresh.then((r) => {
    freshRelease = r;
  });
  await tick();
  assert.equal(freshRelease, "pending", "fresh gate waits for the holder");
  hold();
  const release = await fresh;
  assert.ok(typeof release === "function");
  (release as () => void)();
});

test("captures stay FIFO among themselves behind the holder", async () => {
  const lock = new CaptureLock();
  const hold = await lock.acquire("gate");
  assert.ok(hold);
  const order: string[] = [];
  const c1 = lock.acquire("capture").then((r) => {
    order.push("c1");
    return r;
  });
  const c2 = lock.acquire("capture").then((r) => {
    order.push("c2");
    return r;
  });
  hold();
  const r1 = await c1;
  assert.deepEqual(order, ["c1"]);
  assert.ok(typeof r1 === "function");
  r1();
  const r2 = await c2;
  assert.deepEqual(order, ["c1", "c2"]);
  assert.ok(typeof r2 === "function");
  r2();
});
