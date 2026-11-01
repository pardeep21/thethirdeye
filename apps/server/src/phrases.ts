// Phrase builder (MVP.md section 1): short proactive templates.
// Cash lines are Gurmukhi; people lines are Roman code-mix (both exactly as
// specified); English and Hindi variants included. Free-form describe/read
// answers come from the model, not from here.
import type { Box, Denomination, SpeakLang } from "./protocol.js";
import type { ProactiveEvent, RenderedPhrase, ScenePhraseItem } from "./decision.js";
import { distanceWord, renderClock, toClock, type PositionDistance } from "./clock.js";

/** Re-exported so people-line callers keep one phrases import. */
export { renderClock };

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
  position?: "left" | "centre" | "right";
  distance: "near" | "mid" | "far";
  /** Normalised x from scene triage; with hfovDeg this renders a clock hour. */
  x?: number;
  /** Pre-rendered clock hour from a face track (preferred over x). */
  clock?: number;
}

/**
 * Position words: a track clock hour when present, else calibrated x +
 * hfovDeg, else the rough words (centre+near is the counter; far is the
 * door side). Mid counts as far wording: it is not at the counter.
 */
function where(p: Place, lang: SpeakLang, hfovDeg?: number): string {
  if (
    typeof p.clock === "number" &&
    Number.isFinite(p.clock) &&
    p.clock >= 1 &&
    p.clock <= 12
  ) {
    return renderClock(p.clock, lang);
  }
  if (typeof p.x === "number" && Number.isFinite(p.x) && typeof hfovDeg === "number") {
    return renderClock(toClock(p.x, hfovDeg), lang);
  }
  const position = p.position ?? "centre";
  if (position === "centre") {
    if (p.distance === "near") return lang === "en" ? "at the counter" : lang === "hi" ? "counter par" : "counter te";
    return lang === "en" ? "near the door" : lang === "hi" ? "darwaze ke paas" : "door kol";
  }
  const side = position === "left" ? "left side" : "right side";
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

function singleUnknown(p: UnknownBits, lang: SpeakLang, hfovDeg?: number): string {
  const who = p.gender === "woman" ? (lang === "en" ? "woman" : lang === "hi" ? "aurat" : "aurat") : lang === "en" ? "man" : lang === "hi" ? "aadmi" : "banda";
  const age = p.age_range ? (lang === "hi" ? `, lagbhag ${p.age_range}` : `, around ${p.age_range}`) : "";
  if (lang === "en") return `A ${who}${age}, ${where(p, lang, hfovDeg)}`;
  if (lang === "hi") return `Ek ${who}${age}, ${where(p, lang, hfovDeg)}`;
  return `Ik ${who}${age}, ${where(p, lang, hfovDeg)}`;
}

function sceneItemText(item: ScenePhraseItem, lang: SpeakLang): string {
  const clock = renderClock(item.clock, lang);
  if (item.kind === "person") {
    const who =
      item.gender === "woman"
        ? lang === "en"
          ? "woman"
          : lang === "hi"
            ? "aurat"
            : "aurat"
        : lang === "en"
          ? "man"
          : lang === "hi"
            ? "aadmi"
            : "banda";
    if (lang === "en") return `a ${who} ${clock}`;
    if (lang === "hi") return `ek ${who} ${clock}`;
    return `ik ${who} ${clock}`;
  }
  return `${item.label} ${clock}`;
}

export function renderProactive(
  event: ProactiveEvent,
  lang: SpeakLang = "pa",
  hfovDeg?: number
): RenderedPhrase {
  switch (event.kind) {
    case "NOTE_SEEN":
      return { text: renderNoteSeen(event.denominations, lang), lang };
    case "NOTE_UNSURE":
      if (lang === "en") return { text: "Not sure, straighten the note", lang };
      if (lang === "hi") return { text: "पक्का नहीं, नोट सीधा करो", lang };
      return { text: "ਪੱਕਾ ਨਹੀਂ, ਨੋਟ ਸਿੱਧਾ ਕਰੋ", lang };
    case "KNOWN_ARRIVED": {
      const at = event.clock === undefined ? "" : `, ${renderClock(event.clock, lang)}`;
      if (lang === "en") return { text: `${event.name} is here${at}`, lang };
      if (lang === "hi") return { text: `${event.name} आ गया${at}`, lang };
      return { text: `${event.name} ਆ ਗਿਆ${at}`, lang };
    }
    case "PERSON_ARRIVED": {
      if (event.count <= 1) {
        const first: UnknownBits = event.people[0] ?? { position: "centre", distance: "near" };
        return { text: singleUnknown(first, lang, hfovDeg), lang };
      }
      const first: Place = event.people[0] ?? { position: "centre", distance: "near" };
      if (lang === "en") return { text: `${event.count} people, ${where(first, lang, hfovDeg)}`, lang };
      return { text: `${countWord(event.count, lang)} log, ${where(first, lang, hfovDeg)}`, lang };
    }
    case "SCENE_SUMMARY": {
      if (event.items.length === 0) {
        if (lang === "en") return { text: "Nothing notable", lang };
        if (lang === "hi") return { text: "Kuch khaas nahi", lang };
        return { text: "Kujh khaas nahi", lang };
      }
      const head = lang === "en" ? "In front" : "Saamne";
      return { text: `${head}: ${event.items.map((i) => sceneItemText(i, lang)).join(", ")}`, lang };
    }
    case "SCENE_UPDATE": {
      const head = lang === "en" ? "Also" : lang === "hi" ? "Aur" : "Hor";
      return { text: `${head}: ${event.items.map((i) => sceneItemText(i, lang)).join(", ")}`, lang };
    }
  }
}

/** "Bas"/"band kar" with look-around on: the mode switches off with one word. */
export function renderOkay(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "Okay";
  return "Theek hai";
}

export interface PersonBits extends Place {
  name?: string;
  gender?: "man" | "woman";
  age_range?: string;
}

/** "kaun hai?" answer: one line summarising everyone in front. Used by M4. */
export function summarizePeople(items: PersonBits[], lang: SpeakLang = "pa", hfovDeg?: number): string {
  if (items.length === 0) return lang === "en" ? "Nobody here" : "Koi nahi";
  if (items.length === 1) {
    const p = items[0];
    if (p.name) {
      if (lang === "en") return `${p.name} is here, ${where(p, lang, hfovDeg)}`;
      return `${p.name} ${where(p, lang, hfovDeg)}`;
    }
    return singleUnknown(p, lang, hfovDeg);
  }
  const parts = items.map((p) => {
    if (p.name) return `${p.name} ${where(p, lang, hfovDeg)}`;
    if (lang === "en") return `a ${p.gender === "woman" ? "woman" : "man"} ${where(p, lang, hfovDeg)}`;
    if (lang === "hi") return `ek ${p.gender === "woman" ? "aurat" : "aadmi"} ${where(p, lang, hfovDeg)}`;
    return `ik ${p.gender === "woman" ? "aurat" : "banda"} ${where(p, lang, hfovDeg)}`;
  });
  if (lang === "en") return `${items.length} people: ${parts.join(", ")}`;
  return `${countWord(items.length, lang)} log: ${parts.join(", ")}`;
}

/** Locate confidence below this hedges with "Shayad" instead of asserting. */
export const FIND_MAYBE_CONFIDENCE = 0.6;

export interface LocatedPhrase {
  x: number;
  distance: PositionDistance;
  confidence: number;
}

/** Agent `find` answer from a Spark locate (or a miss). */
export function renderFindLocated(
  noun: string,
  loc: LocatedPhrase | null,
  hfovDeg: number,
  lang: SpeakLang = "pa"
): string {
  if (!loc) {
    if (lang === "en") return "Couldn't find it";
    if (lang === "hi") return "Nahi mila";
    return "Nahi labhi";
  }
  const clock = renderClock(toClock(loc.x, hfovDeg), lang);
  if (loc.confidence < FIND_MAYBE_CONFIDENCE) {
    if (lang === "en") return `Maybe ${noun}, ${clock}`;
    return `Shayad ${noun}, ${clock}`;
  }
  const near =
    loc.distance === "near"
      ? lang === "en"
        ? "close by"
        : lang === "hi"
          ? "paas"
          : "nede"
      : distanceWord(loc.distance, lang);
  return `${noun}, ${clock}, ${near}`;
}

/** "hor?"/"aur?"/"more?" tail after a label-read chunk with more remaining. */
export function renderReadMore(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "more?";
  if (lang === "hi") return "aur?";
  return "hor?";
}

/** Agent fallback when it cannot answer (bad model JSON, no usable view). */
export function renderAgentUnsure(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "not sure, say it again";
  return "pakka nahi, dobara bolo";
}

/** Voice enrollment: the consent question. Spoken after remember_person. */
export function renderEnrollAsk(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `${name}, save? Say yes or no`;
  if (lang === "hi") return `${name} ko yaad rakhoon? Haan ya na`;
  return `${name} nu yaad rakhaan? Haan ya na dasso`;
}

/** Voice enrollment succeeded. */
export function renderEnrollSaved(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `${name} saved`;
  if (lang === "hi") return `${name} yaad ho gaya`;
  return `${name} yaad ho gaya`;
}

/** That face is already enrolled under this name. */
export function renderEnrollKnown(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `${name} is already saved`;
  if (lang === "hi") return `${name} pehle se yaad hai`;
  return `${name} pehlan ton yaad hai`;
}

/** That face is enrolled under a different name; asks to rename. */
export function renderEnrollDuplicate(name: string, existing: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `That's already ${existing}. Rename to ${name}?`;
  if (lang === "hi") return `Ye to ${existing} hai. ${name} naam rakhoon?`;
  return `Eh taan ${existing} hai. ${name} naa rakhaan?`;
}

/** Remember asked with no face in front. */
export function renderEnrollNoFace(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "No face in front";
  if (lang === "hi") return "Saamne koi chehra nahi";
  return "Saamne koi chehra nahi";
}

/** The named track left before consent completed. */
export function renderEnrollGone(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "That person is gone";
  if (lang === "hi") return "Vo ab nahi dikh raha";
  return "Oh banda hun nahi dikhda";
}

/** Several unknown faces: the user picks one by clock. */
export function renderEnrollWhich(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "Which one? Tell me the clock";
  if (lang === "hi") return "Kaun sa? Clock batao";
  return "Kaun wala? Clock dasso";
}

/** Track samples are too few or too poor to enroll from. */
export function renderEnrollQuality(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "Show the face clearly, then tell me";
  if (lang === "hi") return "Chehra saaf dikhao, phir bolo";
  return "Chehra saaf dikhao, phir dasso";
}

/** The user declined the consent question. */
export function renderConsentDenied(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `Okay, didn't save ${name}`;
  if (lang === "hi") return `Theek hai, ${name} nahi yaad kiya`;
  return `Theek hai, ${name} nahi yaad kita`;
}

/** Forget asked: confirm before deleting the enrollment. */
export function renderForgetAsk(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `Forget ${name}?`;
  if (lang === "hi") return `${name} ko bhool jaon?`;
  return `${name} nu bhul jaan?`;
}

/** Enrollment deleted. */
export function renderForgot(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `Forgot ${name}`;
  if (lang === "hi") return `${name} bhool gaya`;
  return `${name} bhul gaya`;
}

/** Forget asked for a name nobody enrolled. */
export function renderForgetUnknown(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `I didn't know ${name}`;
  if (lang === "hi") return `${name} to yaad hi nahi tha`;
  return `${name} taan yaad hi nahi si`;
}

/** Forget matched several people: the user narrows it down. */
export function renderForgetWhich(lang: SpeakLang = "pa"): string {
  if (lang === "en") return "Say the full name";
  if (lang === "hi") return "Poora naam bolo";
  return "Naam poora dasso";
}

/** Duplicate-confirm granted: the enrollment was renamed. */
export function renderRenamed(name: string, lang: SpeakLang = "pa"): string {
  if (lang === "en") return `Renamed to ${name}`;
  if (lang === "hi") return `Naam ${name} kar diya`;
  return `Naa ${name} kar ditta`;
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
