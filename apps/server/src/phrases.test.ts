// Phrase builder tests: every MVP.md section 1 line reproduced verbatim,
// plus en/hi locks and edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderAgentUnsure,
  renderClock,
  renderConsentDenied,
  renderEnrollAsk,
  renderEnrollDuplicate,
  renderEnrollGone,
  renderEnrollKnown,
  renderEnrollNoFace,
  renderEnrollQuality,
  renderEnrollSaved,
  renderEnrollWhich,
  renderFind,
  renderFindLocated,
  renderForgot,
  renderForgetAsk,
  renderForgetUnknown,
  renderForgetWhich,
  renderModelTimeout,
  renderOkay,
  renderProactive,
  renderReadMore,
  renderRenamed,
  summarizePeople,
} from "./phrases.js";
import type { ProactiveEvent } from "./decision.js";

function noteSeen(...denominations: Array<10 | 20 | 50 | 100 | 200 | 500>): ProactiveEvent {
  return { kind: "NOTE_SEEN", denominations, confidences: denominations.map(() => 0.9) };
}

test("clock words are vje/baje/o'clock per language", () => {
  assert.equal(renderClock(2, "pa"), "2 vje");
  assert.equal(renderClock(12, "hi"), "12 baje");
  assert.equal(renderClock(10, "en"), "10 o'clock");
  assert.equal(renderClock(9), "9 vje");
});

test("agent unsure fallback", () => {
  assert.equal(renderAgentUnsure("pa"), "pakka nahi, dobara bolo");
  assert.equal(renderAgentUnsure("hi"), "pakka nahi, dobara bolo");
  assert.equal(renderAgentUnsure("en"), "not sure, say it again");
});

test("model timeout line is deterministic in all 3 langs", () => {
  assert.equal(renderModelTimeout("pa"), "Pakka nahi, dobara puchho");
  assert.equal(renderModelTimeout("hi"), "Pakka nahi, dobara poochho");
  assert.equal(renderModelTimeout("en"), "Not sure, ask again");
  assert.equal(renderModelTimeout(), "Pakka nahi, dobara puchho");
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

test("scene summary matches the spec shape", () => {
  const ev: ProactiveEvent = {
    kind: "SCENE_SUMMARY",
    items: [
      { kind: "object", label: "kursi", clock: 12 },
      { kind: "object", label: "darwaza", clock: 2 },
      { kind: "person", gender: "man", clock: 10 },
    ],
  };
  assert.equal(
    renderProactive(ev).text,
    "Saamne kursi hai 12 vje, darwaza hai 2 vje, 10 vje ik banda hai"
  );
  assert.equal(
    renderProactive(ev, "en").text,
    "In front: kursi 12 o'clock, darwaza 2 o'clock, a man 10 o'clock"
  );
  assert.equal(
    renderProactive(ev, "hi").text,
    "Saamne kursi hai 12 baje, darwaza hai 2 baje, 10 baje ek aadmi hai"
  );
  const woman: ProactiveEvent = {
    kind: "SCENE_SUMMARY",
    items: [{ kind: "person", gender: "woman", clock: 3 }],
  };
  assert.equal(renderProactive(woman).text, "Saamne 3 vje ik aurat hai");
});

test("empty scene summary says nothing notable", () => {
  assert.equal(renderProactive({ kind: "SCENE_SUMMARY", items: [] }).text, "Kujh khaas nahi");
  assert.equal(renderProactive({ kind: "SCENE_SUMMARY", items: [] }, "hi").text, "Kuch khaas nahi");
  assert.equal(renderProactive({ kind: "SCENE_SUMMARY", items: [] }, "en").text, "Nothing notable");
});

test("scene updates lead with Hor/Aur/Also", () => {
  const ev: ProactiveEvent = {
    kind: "SCENE_UPDATE",
    items: [
      { kind: "object", label: "phone", clock: 3 },
      { kind: "object", label: "thaila", clock: 4 },
    ],
  };
  assert.equal(renderProactive(ev).text, "Hor phone hai 3 vje, thaila hai 4 vje");
  assert.equal(renderProactive(ev, "en").text, "Also: phone 3 o'clock, thaila 4 o'clock");
  const single: ProactiveEvent = {
    kind: "SCENE_UPDATE",
    items: [{ kind: "object", label: "phone", clock: 3 }],
  };
  assert.equal(renderProactive(single, "hi").text, "Aur phone hai 3 baje");
});

test("person lines use clock hours when x and hfov are available", () => {
  const ev: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "centre", distance: "near", gender: "man", age_range: "30", x: 0.8 }],
  };
  assert.equal(renderProactive(ev, "pa", 100).text, "Ik banda, around 30, 1 vje");
  assert.equal(renderProactive(ev, "en", 100).text, "A man, around 30, 1 o'clock");
  const multi: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 2,
    people: [
      { position: "left", distance: "near", x: 0.2 },
      { position: "right", distance: "near", x: 0.9 },
    ],
  };
  assert.equal(renderProactive(multi, "pa", 100).text, "Do log, 11 vje");
});

test("person lines keep rough words without coordinates", () => {
  const ev: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "centre", distance: "near", gender: "man", age_range: "30" }],
  };
  assert.equal(renderProactive(ev, "pa", 100).text, "Ik banda, around 30, counter te");
  const noHfov: ProactiveEvent = {
    kind: "PERSON_ARRIVED",
    count: 1,
    people: [{ position: "right", distance: "far", x: 0.9 }],
  };
  assert.equal(renderProactive(noHfov).text, "Ik banda, right side door");
});

test("known arrival carries the clock when the track has one", () => {
  assert.equal(
    renderProactive({ kind: "KNOWN_ARRIVED", personId: "p1", name: "Ravi", clock: 2 }).text,
    "Ravi ਆ ਗਿਆ, 2 vje"
  );
  assert.equal(
    renderProactive({ kind: "KNOWN_ARRIVED", personId: "p1", name: "Ravi", clock: 2 }, "en").text,
    "Ravi is here, 2 o'clock"
  );
});

test("kaun hai prefers track clocks and tolerates missing positions", () => {
  assert.equal(summarizePeople([{ name: "Ravi", clock: 2, distance: "near" }]), "Ravi 2 vje");
  assert.equal(
    summarizePeople([
      { name: "Ravi", clock: 2, distance: "near" },
      { gender: "woman", clock: 10, distance: "far" },
    ]),
    "Do log: Ravi 2 vje, ik aurat 10 vje"
  );
  // A bad clock falls back to the rough words instead of crashing.
  assert.equal(
    summarizePeople([{ name: "Ravi", clock: 99, distance: "near" }]),
    "Ravi counter te"
  );
});

test("enrollment and forget phrases", () => {
  assert.equal(renderEnrollAsk("Ravi"), "Ravi nu yaad rakhaan? Haan ya na dasso");
  assert.equal(renderEnrollAsk("Ravi", "en"), "Ravi, save? Say yes or no");
  assert.equal(renderEnrollSaved("Ravi"), "Ravi yaad ho gaya");
  assert.equal(renderEnrollKnown("Ravi"), "Ravi pehlan ton yaad hai");
  assert.equal(renderEnrollDuplicate("Ravi", "Raj"), "Eh taan Raj hai. Ravi naa rakhaan?");
  assert.equal(renderEnrollNoFace(), "Saamne koi chehra nahi");
  assert.equal(renderEnrollGone(), "Oh banda hun nahi dikhda");
  assert.equal(renderEnrollWhich(), "Kaun wala? Clock dasso");
  assert.equal(renderEnrollQuality(), "Chehra saaf dikhao, phir dasso");
  assert.equal(renderConsentDenied("Ravi"), "Theek hai, Ravi nahi yaad kita");
  assert.equal(renderForgetAsk("Ravi"), "Ravi nu bhul jaan?");
  assert.equal(renderForgot("Ravi"), "Ravi bhul gaya");
  assert.equal(renderForgetUnknown("Ravi"), "Ravi taan yaad hi nahi si");
  assert.equal(renderForgetWhich(), "Naam poora dasso");
  assert.equal(renderRenamed("Ravi"), "Naa Ravi kar ditta");
});

test("find locate rendering: clock + nearness, maybe, miss", () => {
  assert.equal(
    renderFindLocated("Kainchi", { x: 0.9, distance: "near", confidence: 0.9 }, 100),
    "Kainchi, 1 vje, nede"
  );
  assert.equal(
    renderFindLocated("Kainchi", { x: 0.1, distance: "far", confidence: 0.8 }, 100, "en"),
    "Kainchi, 11 o'clock, far"
  );
  assert.equal(
    renderFindLocated("Kainchi", { x: 0.9, distance: "near", confidence: 0.5 }, 100),
    "Shayad Kainchi, 1 vje"
  );
  assert.equal(
    renderFindLocated("Kainchi", { x: 0.9, distance: "near", confidence: 0.2 }, 100, "en"),
    "Maybe Kainchi, 1 o'clock"
  );
  assert.equal(renderFindLocated("Kainchi", null, 100), "Nahi labhi");
  assert.equal(renderFindLocated("Kainchi", null, 100, "hi"), "Nahi mila");
  assert.equal(renderFindLocated("Kainchi", null, 100, "en"), "Couldn't find it");
});

test("read-more tail", () => {
  assert.equal(renderReadMore("pa"), "hor?");
  assert.equal(renderReadMore("hi"), "aur?");
  assert.equal(renderReadMore("en"), "more?");
});

test("kaun hai answers use clocks when available", () => {
  assert.equal(
    summarizePeople([{ name: "Ravi", position: "left", distance: "near", x: 0.9 }], "pa", 100),
    "Ravi 1 vje"
  );
  assert.equal(
    summarizePeople([{ position: "centre", distance: "far", gender: "woman", x: 0.1 }], "pa", 100),
    "Ik aurat, 11 vje"
  );
  assert.equal(
    summarizePeople([{ name: "Ravi", position: "left", distance: "near" }]),
    "Ravi left side"
  );
});

test("look-around off answers Theek hai", () => {
  assert.equal(renderOkay("pa"), "Theek hai");
  assert.equal(renderOkay("hi"), "Theek hai");
  assert.equal(renderOkay("en"), "Okay");
  assert.equal(renderOkay(), "Theek hai");
});
