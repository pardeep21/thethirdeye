// Phrase builder tests: every MVP.md section 1 line reproduced verbatim,
// plus en/hi locks and edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAgentUnsure, renderClock, renderFind, renderProactive, summarizePeople } from "./phrases.js";
import type { ProactiveEvent } from "./decision.js";

function noteSeen(...denominations: Array<10 | 20 | 50 | 100 | 200 | 500>): ProactiveEvent {
  return { kind: "NOTE_SEEN", denominations, confidences: denominations.map(() => 0.9) };
}

test("clock words keep o'clock in code-mix", () => {
  assert.equal(renderClock(2, "pa"), "2 o'clock");
  assert.equal(renderClock(12, "hi"), "12 o'clock");
  assert.equal(renderClock(10, "en"), "10 o'clock");
});

test("agent unsure fallback", () => {
  assert.equal(renderAgentUnsure("pa"), "pakka nahi, dobara bolo");
  assert.equal(renderAgentUnsure("hi"), "pakka nahi, dobara bolo");
  assert.equal(renderAgentUnsure("en"), "not sure, say it again");
});

test("pa cash lines match MVP.md verbatim", () => {
  assert.equal(renderProactive(noteSeen(500)).text, "ਪੰਜ ਸੌ ਦਾ ਨੋਟ");
  assert.equal(renderProactive(noteSeen(20)).text, "ਵੀਹ ਦਾ ਨੋਟ");
  assert.equal(renderProactive(noteSeen(100, 50)).text, "ਦੋ ਨੋਟ: ਸੌ, ਪੰਜਾਹ");
  assert.equal(renderProactive({ kind: "NOTE_UNSURE" }).text, "ਪੱਕਾ ਨਹੀਂ, ਨੋਟ ਸਿੱਧਾ ਕਰੋ");
});

test("pa cash covers all six denominations", () => {
  const got = [10, 20, 50, 100, 200, 500].map(
    (d) => renderProactive(noteSeen(d as 10)).text
  );
  assert.deepEqual(got, [
    "ਦਸ ਦਾ ਨੋਟ",
    "ਵੀਹ ਦਾ ਨੋਟ",
    "ਪੰਜਾਹ ਦਾ ਨੋਟ",
    "ਸੌ ਦਾ ਨੋਟ",
    "ਦੋ ਸੌ ਦਾ ਨੋਟ",
    "ਪੰਜ ਸੌ ਦਾ ਨੋਟ",
  ]);
});

test("en/hi cash lines", () => {
  assert.equal(renderProactive(noteSeen(500), "en").text, "500 rupee note");
  assert.equal(renderProactive(noteSeen(100, 50), "en").text, "Two notes: 100, 50");
  assert.equal(renderProactive({ kind: "NOTE_UNSURE" }, "en").text, "Not sure, straighten the note");
  assert.equal(renderProactive(noteSeen(500), "hi").text, "पाँच सौ का नोट");
  assert.equal(renderProactive(noteSeen(20), "hi").text, "बीस का नोट");
  assert.equal(renderProactive(noteSeen(100, 50), "hi").text, "दो नोट: सौ, पचास");
  assert.equal(renderProactive({ kind: "NOTE_UNSURE" }, "hi").text, "पक्का नहीं, नोट सीधा करो");
});

test("rendered lang echoes the requested lang, pa by default", () => {
  assert.equal(renderProactive(noteSeen(10)).lang, "pa");
  assert.equal(renderProactive(noteSeen(10), "hi").lang, "hi");
  assert.equal(renderProactive(noteSeen(10), "en").lang, "en");
});

test("known arrival matches MVP.md verbatim", () => {
  assert.equal(
    renderProactive({ kind: "KNOWN_ARRIVED", personId: "p1", name: "ਰਵੀ" }).text,
    "ਰਵੀ ਆ ਗਿਆ"
  );
  assert.equal(
    renderProactive({ kind: "KNOWN_ARRIVED", personId: "p1", name: "Ravi" }, "en").text,
    "Ravi is here"
  );
  assert.equal(
    renderProactive({ kind: "KNOWN_ARRIVED", personId: "p1", name: "Ravi" }, "hi").text,
    "Ravi आ गया"
  );
});

test("unknown arrival matches MVP.md verbatim", () => {
  const ev: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "centre", distance: "near", gender: "man", age_range: "30" }],
  };
  assert.equal(renderProactive(ev).text, "Ik banda, around 30, counter te");
  assert.equal(renderProactive(ev, "en").text, "A man, around 30, at the counter");
  assert.equal(renderProactive(ev, "hi").text, "Ek aadmi, lagbhag 30, counter par");
});

test("unknown arrival omits missing age, defaults missing gender", () => {
  const ev: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "right", distance: "far" }],
  };
  assert.equal(renderProactive(ev).text, "Ik banda, right side door");
  const woman: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "left", distance: "near", gender: "woman", age_range: "40s" }],
  };
  assert.equal(renderProactive(woman).text, "Ik aurat, around 40s, left side");
});

test("multi-person proactive arrival", () => {
  const ev: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 2,
    people: [
      { position: "centre", distance: "near" },
      { position: "right", distance: "near" },
    ],
  };
  assert.equal(renderProactive(ev).text, "Do log, counter te");
  assert.equal(renderProactive(ev, "en").text, "2 people, at the counter");
});

test("kaun hai summary matches MVP.md verbatim", () => {
  assert.equal(
    summarizePeople([
      { name: "Ravi", position: "left", distance: "near" },
      { gender: "woman", position: "centre", distance: "far" },
    ]),
    "Do log: Ravi left side, ik aurat door kol"
  );
});

test("summarizePeople edge cases", () => {
  assert.equal(summarizePeople([]), "Koi nahi");
  assert.equal(summarizePeople([], "en"), "Nobody here");
  assert.equal(
    summarizePeople([{ name: "Ravi", position: "centre", distance: "near" }]),
    "Ravi counter te"
  );
  assert.equal(
    summarizePeople([{ position: "right", distance: "far", gender: "man", age_range: "30" }]),
    "Ik banda, around 30, right side door"
  );
  assert.equal(
    summarizePeople(
      [
        { name: "Ravi", position: "left", distance: "near" },
        { gender: "woman", position: "centre", distance: "far" },
      ],
      "en"
    ),
    "2 people: Ravi left side, a woman near the door"
  );
});

test("find answers match MVP.md verbatim", () => {
  assert.equal(renderFind("Kainchi", { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }), "Kainchi, right side, neeche");
  assert.equal(renderFind("Kainchi", null), "Nahi labhi");
  assert.equal(renderFind("Scissors", { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, "en"), "Scissors, right side, low down");
  assert.equal(renderFind("Scissors", null, "en"), "Couldn't find it");
  assert.equal(renderFind("Kainchi", null, "hi"), "Nahi mila");
});

test("find answers cover centre and high positions", () => {
  assert.equal(renderFind("Phone", { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), "Phone, saamne");
  assert.equal(renderFind("Phone", { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), "Phone, left side, uppar");
  assert.equal(renderFind("Phone", { x: 0.4, y: 0.1, w: 0.2, h: 0.1 }, "en"), "Phone, in front, up high");
});
