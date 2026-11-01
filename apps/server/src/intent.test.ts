// Intent router tests: one language per case where it matters, plus the
// tricky overlaps (bol vs bolo, short-only mute, empty-noun find).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBareMore, routeIntent } from "./intent.js";

test("describe across languages and scripts", () => {
  assert.equal(routeIntent("Ki hai saamne?").kind, "describe");
  assert.equal(routeIntent("what is in front").kind, "describe");
  assert.equal(routeIntent("saamne ki ae").kind, "describe");
  assert.equal(routeIntent("kya hai").kind, "describe");
  assert.equal(routeIntent("describe this").kind, "describe");
  assert.equal(routeIntent("ਕੀ ਹੈ ਸਾਹਮਣੇ").kind, "describe");
  const q = routeIntent("Ki hai saamne?");
  assert.equal(q.kind === "describe" ? q.question : "", "Ki hai saamne?");
});

test("read", () => {
  assert.equal(routeIntent("Eh padh").kind, "read");
  assert.equal(routeIntent("read this").kind, "read");
  assert.equal(routeIntent("padho").kind, "read");
  assert.equal(routeIntent("eh parh").kind, "read");
  assert.equal(routeIntent("ready").kind, "unknown"); // no substring matching
});

test("find extracts the noun", () => {
  assert.deepEqual(routeIntent("Kainchi kithe hai?"), { kind: "find", noun: "Kainchi" });
  assert.deepEqual(routeIntent("where are the scissors"), { kind: "find", noun: "Scissors" });
  assert.deepEqual(routeIntent("kainchi kahan hai"), { kind: "find", noun: "Kainchi" });
  assert.deepEqual(routeIntent("ਕੈਂਚੀ ਕਿੱਥੇ ਹੈ"), { kind: "find", noun: "ਕੈਂਚੀ" });
  assert.deepEqual(routeIntent("find my red packet"), { kind: "find", noun: "Red packet" });
});

test("find with no noun falls back to describe", () => {
  const r = routeIntent("kithe hai?");
  assert.equal(r.kind, "describe");
});

test("who", () => {
  assert.equal(routeIntent("kaun hai?").kind, "who");
  assert.equal(routeIntent("koun aaya").kind, "who");
  assert.equal(routeIntent("who is there").kind, "who");
  assert.equal(routeIntent("KAUN HAI???").kind, "who");
  assert.equal(routeIntent("ਕੌਣ ਹੈ").kind, "who");
  assert.equal(routeIntent("whole shop").kind, "unknown"); // whole != who
});

test("how much", () => {
  assert.equal(routeIntent("eh kinne da?").kind, "howmuch");
  assert.equal(routeIntent("how much is this").kind, "howmuch");
  assert.equal(routeIntent("kinne da note").kind, "howmuch");
  assert.equal(routeIntent("कितने का है").kind, "howmuch");
});

test("mute and unmute, short utterances only", () => {
  assert.equal(routeIntent("chup").kind, "mute");
  assert.equal(routeIntent("chup kar").kind, "mute");
  assert.equal(routeIntent("mute").kind, "mute");
  assert.equal(routeIntent("ਚੁੱਪ").kind, "mute");
  assert.equal(routeIntent("bol").kind, "unmute");
  assert.equal(routeIntent("unmute").kind, "unmute");
  // "bolo ki hai" is a describe request, not unmute; long "bol" sentences too.
  assert.equal(routeIntent("bolo ki hai").kind, "describe");
  assert.equal(routeIntent("eh bol ki hai saamne").kind, "describe");
});

test("cancel on short stop-words", () => {
  assert.equal(routeIntent("bas").kind, "cancel");
  assert.equal(routeIntent("band kar").kind, "cancel");
  assert.equal(routeIntent("cancel").kind, "cancel");
  assert.equal(routeIntent("ruko").kind, "cancel");
  assert.equal(routeIntent("ਬਸ").kind, "cancel");
  // "chup" stays mute (silences proactive speech); longer sentences go to the agent.
  assert.equal(routeIntent("chup").kind, "mute");
  assert.equal(routeIntent("bas, kainchi kithe hai daso menu jaldi").kind, "find");
});

test("greetings and chatter stay unknown (silent)", () => {
  assert.equal(routeIntent("hello").kind, "unknown");
  assert.equal(routeIntent("sat sri akal").kind, "unknown");
  assert.equal(routeIntent("thank you").kind, "unknown");
  assert.equal(routeIntent("").kind, "unknown");
});

test("more pages the look-around scene", () => {
  assert.equal(routeIntent("hor ki hai").kind, "more");
  assert.equal(routeIntent("Hor ki hai?").kind, "more");
  assert.equal(routeIntent("hor").kind, "more");
  assert.equal(routeIntent("what else").kind, "more");
  assert.equal(routeIntent("what else is there").kind, "more");
  assert.equal(routeIntent("tell me more").kind, "more");
  assert.equal(routeIntent("aur kya hai").kind, "more");
  assert.equal(routeIntent("ਹੋਰ ਕੀ ਹੈ").kind, "more");
  assert.equal(routeIntent("और क्या है").kind, "more");
});

test("bare hor continues a read, scene questions do not", () => {
  for (const t of ["hor", "hor sunao", "more", "aur batao", "ਹੋਰ", "और"]) {
    assert.equal(isBareMore(t), true, t);
  }
  for (const t of ["hor ki hai", "hor kya hai", "hor kaun hai", "hor kithe", "hor dikhao", "ki hai saamne"]) {
    assert.equal(isBareMore(t), false, t);
  }
});

test("more yields to find, who and read", () => {
  assert.deepEqual(routeIntent("hor, kainchi kithe hai"), { kind: "find", noun: "Kainchi" });
  assert.equal(routeIntent("hor kaun hai").kind, "who");
  assert.equal(routeIntent("hor padh").kind, "read");
});
