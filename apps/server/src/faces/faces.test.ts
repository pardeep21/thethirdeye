// Faces tests: SQLite store (:memory:), cosine matcher with a fake embedder.
// The Python sidecar is exercised through a fake HTTP server in http.test.ts
// (no Python in CI); the live sidecar is smoke-tested manually.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PeopleStore } from "./store.js";
import { StoredFaceMatcher, cosine } from "./matcher.js";
import { StubFaceEmbedder, type DetectedFace, type FaceEmbedder } from "./embed.js";

test("cosine similarity", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 1]) - 1) < 1e-9);
  assert.ok(cosine([1, 2, 3], [1, 2, 3]) > 0.999);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1], [1, 2]), 0);
});

test("store adds, lists and removes people with embeddings only", () => {
  const store = new PeopleStore(":memory:");
  try {
    assert.deepEqual(store.listPeople(), []);
    const a = store.addPerson("Ravi", [
      [1, 0],
      [0.9, 0.1],
    ]);
    assert.equal(a.name, "Ravi");
    assert.equal(a.faces, 2);
    const b = store.addPerson("Simran", [[0, 1]]);
    assert.equal(store.listPeople().length, 2);
    const embs = store.allEmbeddings();
    assert.equal(embs.length, 3);
    assert.deepEqual(embs[0].embedding, [1, 0]);
    assert.equal(store.removePerson(b.id), true);
    assert.equal(store.removePerson(b.id), false);
    assert.equal(store.listPeople().length, 1);
    assert.equal(store.allEmbeddings().length, 2);
    assert.throws(() => store.addPerson("  ", [[1]]), /name is required/);
    assert.throws(() => store.addPerson("X", []), /at least one embedding/);
  } finally {
    store.close();
  }
});

function goodFace(embedding: number[]): DetectedFace {
  return {
    box: [0, 0, 100, 100],
    boxNorm: [0, 0, 0.5, 0.5],
    score: 0.9,
    quality: { blur: 200, yawDeg: 0, sizePx: 100 },
    embedding,
  };
}

class FakeEmbedder implements FaceEmbedder {
  constructor(private readonly faces: DetectedFace[]) {}
  async embed(_jpeg: Buffer): Promise<DetectedFace[]> {
    return structuredClone(this.faces);
  }
}

function fakeVecs(...embeddings: number[][]): FakeEmbedder {
  return new FakeEmbedder(embeddings.map(goodFace));
}

test("matcher hits above threshold, misses below, empty without faces", async () => {
  const store = new PeopleStore(":memory:");
  try {
    const person = store.addPerson("Ravi", [[1, 0]]);
    const hit = new StoredFaceMatcher(store, fakeVecs([1, 0]), 0.75);
    assert.deepEqual(await hit.match(Buffer.alloc(0)), [
      { personId: String(person.id), name: "Ravi", score: 1 },
    ]);
    const miss = new StoredFaceMatcher(store, fakeVecs([0, 1]), 0.75);
    assert.deepEqual(await miss.match(Buffer.alloc(0)), []);
    const noFace = new StoredFaceMatcher(store, fakeVecs(), 0.75);
    assert.deepEqual(await noFace.match(Buffer.alloc(0)), []);
  } finally {
    store.close();
  }
});

test("matcher picks the best person per query face", async () => {
  const store = new PeopleStore(":memory:");
  try {
    const a = store.addPerson("Ravi", [[1, 0]]);
    store.addPerson("Simran", [[0, 1]]);
    const m = new StoredFaceMatcher(store, fakeVecs([0.9, 0.1]), 0.5);
    const hits = await m.match(Buffer.alloc(0));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].personId, String(a.id));
    assert.ok(hits[0].score > 0.9);
  } finally {
    store.close();
  }
});

test("matcher requires the margin over the runner-up person", async () => {
  const store = new PeopleStore(":memory:");
  try {
    store.addPerson("Ravi", [[1, 0]]);
    store.addPerson("Simran", [[0.99, 0.1411]]);
    // Best ~0.9988, runner-up ~0.9958: gap < 0.08, so no hit (fail-closed).
    const close = new StoredFaceMatcher(store, fakeVecs([1, 0.05]), 0.45, 0.08);
    assert.deepEqual(await close.match(Buffer.alloc(0)), []);
    const relaxed = new StoredFaceMatcher(store, fakeVecs([1, 0.05]), 0.45, 0.001);
    assert.equal((await relaxed.match(Buffer.alloc(0))).length, 1);
  } finally {
    store.close();
  }
});

test("a second photo of the same person never vetoes its own match", async () => {
  const store = new PeopleStore(":memory:");
  try {
    const person = store.addPerson("Ravi", [
      [1, 0],
      [0.99, 0.1411],
    ]);
    const m = new StoredFaceMatcher(store, fakeVecs([1, 0.05]), 0.45, 0.08);
    const hits = await m.match(Buffer.alloc(0));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].personId, String(person.id));
  } finally {
    store.close();
  }
});

test("default threshold suits ArcFace similarities (~0.45)", async () => {
  const store = new PeopleStore(":memory:");
  try {
    store.addPerson("Ravi", [[1, 0]]);
    const hit = new StoredFaceMatcher(store, fakeVecs([0.5, 0.866]));
    assert.equal((await hit.match(Buffer.alloc(0))).length, 1);
    const miss = new StoredFaceMatcher(store, fakeVecs([0.4, 0.9165]));
    assert.deepEqual(await miss.match(Buffer.alloc(0)), []);
  } finally {
    store.close();
  }
});

test("stub embedder finds nothing (fail-closed)", async () => {
  assert.deepEqual(await new StubFaceEmbedder().embed(Buffer.alloc(0)), []);
});
