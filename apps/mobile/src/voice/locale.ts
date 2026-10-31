// Recognition locale choice (pure, no RN imports): map the Settings answer
// language to a BCP-47 speech-recognition locale, falling back in pa/hi/en
// order when the device does not support it.

export type AnswerLang = "pa" | "hi" | "en";
export type RecogLocale = "pa-IN" | "hi-IN" | "en-IN";

/** Fallback order when the primary locale is unsupported. */
export const RECOG_FALLBACK_ORDER: RecogLocale[] = ["pa-IN", "hi-IN", "en-IN"];

const PRIMARY: Record<AnswerLang, RecogLocale> = {
  pa: "pa-IN",
  hi: "hi-IN",
  en: "en-IN",
};

/** Primary locale first, then the remaining fallbacks in pa/hi/en order. */
export function candidatesFor(lang: AnswerLang): RecogLocale[] {
  const primary = PRIMARY[lang];
  return [primary, ...RECOG_FALLBACK_ORDER.filter((l) => l !== primary)];
}

function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** True when a device-reported tag satisfies the wanted locale. */
function satisfies(want: RecogLocale, haveRaw: string): boolean {
  const have = normalize(haveRaw);
  if (have === normalize(want)) return true;
  // A bare language tag ("pa") satisfies any region of that language.
  return have === want.split("-")[0];
}

/**
 * Pick the best recognition locale. Returns the primary even when nothing
 * matches, so the recognizer still attempts the user's language (the OS
 * falls back to its default service rather than failing hard).
 */
export function pickRecognitionLocale(lang: AnswerLang, supported: string[]): RecogLocale {
  const candidates = candidatesFor(lang);
  for (const c of candidates) {
    if (supported.some((s) => satisfies(c, s))) return c;
  }
  return candidates[0];
}
