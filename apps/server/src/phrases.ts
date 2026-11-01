// Phrase builder (MVP.md section 1): short proactive templates.
// Cash lines are Gurmukhi; people lines are Roman code-mix (both exactly as
// specified); English and Hindi variants included. Free-form describe/read
// answers come from the model, not from here.
import type { Box, Denomination, SpeakLang } from "./protocol.js";
import type { ProactiveEvent, RenderedPhrase } from "./decision.js";

const PA_NUMBERS: Record<Denomination, string> = {
  10: "ਦਸ",
  20: "ਵੀਹ",
  50: "ਪੰਜਾਹ",
  100: "ਸੌ",
  200: "ਦੋ ਸੌ",
  500: "ਪੰਜ ਸੌ",
};

const HI_NUMBERS: Record<Denomination, string> = {
  10: "दस",
  20: "बीस",
  50: "पचास",
  100: "सौ",
  200: "दो सौ",
  500: "पाँच सौ",
};

const COUNT_WORDS = ["", "Ik", "Do", "Tin", "Chaar", "Panj"];

function countWord(n: number, lang: SpeakLang): string {
  if (lang === "en") return String(n);
  return COUNT_WORDS[n] ?? String(n);
}

interface Place {
  position: "left" | "centre" | "right";
  distance: "near" | "far";
}

/** Rough position words. Centre+near is the counter; far is the door side. */
function where(p: Place, lang: SpeakLang): string {
  if (p.position === "centre") {
    if (p.distance === "near") return lang === "en" ? "at the counter" : lang === "hi" ? "counter par" : "counter te";
    return lang === "en" ? "near the door" : lang === "hi" ? "darwaze ke paas" : "door kol";
  }
  const side = p.position === "left" ? "left side" : "right side";
  if (p.distance === "near") return side;
  return lang === "en" ? `${side}, far` : `${side} door`;
}

function renderNoteSeen(denominations: Denomination[], lang: SpeakLang): string {
  if (denominations.length === 1) {
    const d = denominations[0];
    if (lang === "en") return `${d} rupee note`;
    if (lang === "hi") return `${HI_NUMBERS[d]} का नोट`;
    return `${PA_NUMBERS[d]} ਦਾ ਨੋਟ`;
  }
  if (lang === "en") {
    const head = denominations.length === 2 ? "Two notes" : `${denominations.length} notes`;
    return `${head}: ${denominations.join(", ")}`;
  }
  if (lang === "hi") {
    const head = denominations.length === 2 ? "दो नोट" : `${denominations.length} नोट`;
    return `${head}: ${denominations.map((d) => HI_NUMBERS[d]).join(", ")}`;
  }
  const head = denominations.length === 2 ? "ਦੋ ਨੋਟ" : `${denominations.length} ਨੋਟ`;
  return `${head}: ${denominations.map((d) => PA_NUMBERS[d]).join(", ")}`;
}

interface UnknownBits extends Place {
  gender?: "man" | "woman";
  age_range?: string;
}

function singleUnknown(p: UnknownBits, lang: SpeakLang): string {
  const who = p.gender === "woman" ? (lang === "en" ? "woman" : lang === "hi" ? "aurat" : "aurat") : lang === "en" ? "man" : lang === "hi" ? "aadmi" : "banda";
  const age = p.age_range ? (lang === "hi" ? `, lagbhag ${p.age_range}` : `, around ${p.age_range}`) : "";
  if (lang === "en") return `A ${who}${age}, ${where(p, lang)}`;
  if (lang === "hi") return `Ek ${who}${age}, ${where(p, lang)}`;
  return `Ik ${who}${age}, ${where(p, lang)}`;
}

export function renderProactive(event: ProactiveEvent, lang: SpeakLang = "pa"): RenderedPhrase {
  switch (event.kind) {
    case "NOTE_SEEN":
      return { text: renderNoteSeen(event.denominations, lang), lang };
    case "NOTE_UNSURE":
      if (lang === "en") return { text: "Not sure, straighten the note", lang };
      if (lang === "hi") return { text: "पक्का नहीं, नोट सीधा करो", lang };
      return { text: "ਪੱਕਾ ਨਹੀਂ, ਨੋਟ ਸਿੱਧਾ ਕਰੋ", lang };
    case "KNOWN_ARRIVED":
      if (lang === "en") return { text: `${event.name} is here`, lang };
      if (lang === "hi") return { text: `${event.name} आ गया`, lang };
      return { text: `${event.name} ਆ ਗਿਆ`, lang };
    case "PERSON_ARRIVED": {
      if (event.count <= 1) {
        const first: UnknownBits = event.people[0] ?? { position: "centre", distance: "near" };
        return { text: singleUnknown(first, lang), lang };
      }
      const first: Place = event.people[0] ?? { position: "centre", distance: "near" };
      if (lang === "en") return { text: `${event.count} people, ${where(first, lang)}`, lang };
      return { text: `${countWord(event.count, lang)} log, ${where(first, lang)}`, lang };
    }
  }
}

export interface PersonBits extends Place {
  name?: string;
  gender?: "man" | "woman";
  age_range?: string;
}

/** "kaun hai?" answer: one line summarising everyone in front. Used by M4. */
export function summarizePeople(items: PersonBits[], lang: SpeakLang = "pa"): string {
  if (items.length === 0) return lang === "en" ? "Nobody here" : "Koi nahi";
  if (items.length === 1) {
    const p = items[0];
    if (p.name) {
      if (lang === "en") return `${p.name} is here, ${where(p, lang)}`;
      return `${p.name} ${where(p, lang)}`;
    }
    return singleUnknown(p, lang);
  }
  const parts = items.map((p) => {
    if (p.name) return `${p.name} ${where(p, lang)}`;
    if (lang === "en") return `a ${p.gender === "woman" ? "woman" : "man"} ${where(p, lang)}`;
    if (lang === "hi") return `ek ${p.gender === "woman" ? "aurat" : "aadmi"} ${where(p, lang)}`;
    return `ik ${p.gender === "woman" ? "aurat" : "banda"} ${where(p, lang)}`;
  });
  if (lang === "en") return `${items.length} people: ${parts.join(", ")}`;
  return `${countWord(items.length, lang)} log: ${parts.join(", ")}`;
}

/** Clock position words. Code-mix keeps "o'clock" (DEV-PLAN section 2). */
export function renderClock(hour: number, _lang: SpeakLang = "pa"): string {
  return `${hour} o'clock`;
}

/** Agent fallback when it cannot answer (bad model JSON, no usable view). */
export function renderAgentUnsure(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "not sure, say it again";
  return "pakka nahi, dobara bolo";
}

/** "find X" answer from a box (or a miss). Used when SAM wiring lands. */
export function renderFind(noun: string, box: Box | null, lang: SpeakLang = "pa"): string {
  if (!box) {
    if (lang === "en") return "Couldn't find it";
    if (lang === "hi") return "Nahi mila";
    return "Nahi labhi";
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const horiz = cx < 1 / 3 ? "left side" : cx > 2 / 3 ? "right side" : lang === "en" ? "in front" : "saamne";
  let vert = "";
  if (cy > 0.66) vert = lang === "en" ? "low down" : "neeche";
  else if (cy < 0.33) vert = lang === "en" ? "up high" : "uppar";
  return vert ? `${noun}, ${horiz}, ${vert}` : `${noun}, ${horiz}`;
}
