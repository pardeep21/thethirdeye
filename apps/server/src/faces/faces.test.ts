// Faces tests: SQLite store (:memory:), cosine matcher with a fake embedder,
// backend selection. The human backend itself is NOT loaded here (model
// downloads); it is smoke-tested manually, see docs/PROGRESS.md M5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PeopleStore } from "./store.js";
import { StoredFaceMatcher, cosine } from "./matcher.js";
import { StubFaceEmbedder, type FaceEmbedder } from "./embed.js";

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

class FakeEmbedder implements FaceEmbedder {
  constructor(private readonly faces: Array<{ embedding: number[]; score: number }>) {}
  async embed(_jpeg: Buffer): Promise<Array<{ embedding: number[]; score: number }>> {
    return this.faces.map((f) => ({ ...f, embedding: [...f.embedding] }));
  }
}

test("matcher hits above threshold, misses below, empty without faces", async () => {
  const store = new PeopleStore(":memory:");
  try {
    const person = store.addPerson("Ravi", [[1, 0]]);
    const hit = new StoredFaceMatcher(store, new FakeEmbedder([{ embedding: [1, 0], score: 0.9 }]), 0.75);
    assert.deepEqual(await hit.match(Buffer.alloc(0)), [
      { personId: String(person.id), name: "Ravi", score: 1 },
    ]);
    const miss = new StoredFaceMatcher(store, new FakeEmbedder([{ embedding: [0, 1], score: 0.9 }]), 0.75);
    assert.deepEqual(await miss.match(Buffer.alloc(0)), []);
    const noFace = new StoredFaceMatcher(store, new FakeEmbedder([]), 0.75);
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
    const m = new StoredFaceMatcher(store, new FakeEmbedder([{ embedding: [0.9, 0.1], score: 0.9 }]), 0.5);
    const hits = await m.match(Buffer.alloc(0));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].personId, String(a.id));
    assert.ok(hits[0].score > 0.9);
  } finally {
    store.close();
  }
});

test("stub embedder finds nothing (fail-closed)", async () => {
  assert.deepEqual(await new StubFaceEmbedder().embed(Buffer.alloc(0)), []);
});
