import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_HEARTBEAT_MS,
  GATE_PIXELS,
  GATE_SIZE,
  createGate,
  downsampleGrayPlane,
  meanAbsDiff,
  shouldSendGate,
} from "./gate.ts";

const flat = (v: number): Uint8Array => new Uint8Array(GATE_PIXELS).fill(v);

test("first frame always sends", () => {
  const r = shouldSendGate(createGate(), flat(100), 1000);
  assert.deepEqual(r, { send: true, reason: "first" });
});

test("identical frame does not send", () => {
  const g = createGate();
  shouldSendGate(g, flat(100), 1000);
  const r = shouldSendGate(g, flat(100), 2000);
  assert.deepEqual(r, { send: false, reason: "no-change" });
});

test("changed frame sends and becomes the new baseline", () => {
  const g = createGate();
  shouldSendGate(g, flat(100), 1000);
  const r = shouldSendGate(g, flat(200), 2000);
  assert.deepEqual(r, { send: true, reason: "changed" });
  const r2 = shouldSendGate(g, flat(200), 3000);
  assert.deepEqual(r2, { send: false, reason: "no-change" });
});

test("tiny noise below threshold does not send", () => {
  const g = createGate();
  shouldSendGate(g, flat(100), 1000);
  assert.equal(meanAbsDiff(flat(100), flat(105)), 5);
  const r = shouldSendGate(g, flat(105), 2000);
  assert.deepEqual(r, { send: false, reason: "no-change" });
});

test("heartbeat sends after 5 s even with no change", () => {
  const g = createGate();
  shouldSendGate(g, flat(100), 1000);
  const justBefore = shouldSendGate(g, flat(100), 1000 + GATE_HEARTBEAT_MS - 1);
  assert.deepEqual(justBefore, { send: false, reason: "no-change" });
  const due = shouldSendGate(g, flat(100), 1000 + GATE_HEARTBEAT_MS);
  assert.deepEqual(due, { send: true, reason: "heartbeat" });
});

test("wrong-sized frame throws", () => {
  assert.throws(() => shouldSendGate(createGate(), new Uint8Array(10), 1000), /1024-byte/);
  assert.throws(() => meanAbsDiff(flat(0), new Uint8Array(10)), /1024-byte/);
});

test("downsample maps each output pixel to the nearest source pixel", () => {
  // 64x64 plane where value = column index: out column x reads source column 2x.
  const w = 64;
  const h = 64;
  const src = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = x;
  const out = downsampleGrayPlane(src, w, h, w);
  assert.equal(out.length, GATE_PIXELS);
  for (let y = 0; y < GATE_SIZE; y++)
    for (let x = 0; x < GATE_SIZE; x++) assert.equal(out[y * GATE_SIZE + x], 2 * x);
});

test("downsample honors row stride padding", () => {
  // 64-wide rows stored with stride 80; value = row index.
  const w = 64;
  const h = 64;
  const stride = 80;
  const src = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * stride + x] = y;
  const out = downsampleGrayPlane(src, w, h, stride);
  assert.equal(out.length, GATE_PIXELS);
  for (let y = 0; y < GATE_SIZE; y++)
    for (let x = 0; x < GATE_SIZE; x++) assert.equal(out[y * GATE_SIZE + x], 2 * y);
});

test("downsample rejects bad plane geometry", () => {
  const src = new Uint8Array(64 * 64);
  assert.throws(() => downsampleGrayPlane(src, 64, 64, 32), /stride/);
  assert.throws(() => downsampleGrayPlane(new Uint8Array(10), 64, 64, 64), /buffer/);
  assert.throws(() => downsampleGrayPlane(src, 0, 64, 64), /dimensions/);
});
