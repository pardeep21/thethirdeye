// Intent router: keyword classification of transcribed push-to-talk commands
// in Punjabi/Hindi/English (Roman, Gurmukhi, Devanagari). Token-exact
// matching (script-agnostic); mute/unmute/cancel only fire on short utterances so
// "eh bol ki hai" stays a describe. Unknown -> silent (logged by the caller).

export type Intent =
  | { kind: "describe"; question: string }
  | { kind: "read" }
  | { kind: "find"; noun: string }
  | { kind: "who" }
  | { kind: "howmuch" }
  | { kind: "more" }
  | { kind: "mute" }
  | { kind: "unmute" }
  | { kind: "cancel" }
  | { kind: "unknown" };

const MUTE = ["chup", "mute", "quiet", "silent", "ਚੁੱਪ", "चुप"];
const UNMUTE = ["unmute", "bol", "speak", "ਬੋਲ", "बोल"];
const CANCEL = [
  "cancel",
  "bas",
  "band kar",
  "band",
  "stop",
  "ruk",
  "ruko",
  "ਬਸ",
  "ਰੁਕੋ",
  "बस",
  "रुको",
];
const READ = ["padh", "padho", "parh", "read", "ਪੜ੍ਹ", "पढ़"];
const FIND_WHERE = [
  "kithe",
  "kitthe",
  "kithhe",
  "kidhar",
  "kiddhar",
  "where",
  "find",
  "locate",
  "kahan",
  "labh",
  "labho",
  "dhoond",
  "dhoondho",
  "ਕਿੱਥੇ",
  "कहाँ",
];
const WHO = ["kaun", "koun", "who", "ਕੌਣ", "कौन"];
const HOWMUCH = ["kinne", "kine", "how much", "ਕਿੰਨੇ", "कितने"];
const MORE = ["hor", "more", "else", "aur kya", "kya aur", "aur bata", "aur batao", "ਹੋਰ", "और"];
const DESCRIBE = [
  "describe",
  "saamne",
  "samne",
  "dikha",
  "dikhao",
  "show",
  "what",
  "ki hai",
  "ki ae",
  "ke hai",
  "kya hai",
  "what is",
  "what are",
  "ਕੀ ਹੈ",
  "ਕੀ ਐ",
  "सामने",
  "क्या है",
  "ਦਿਖਾ",
  "दिखा",
];

const FIND_STOP = new Set<string>([
  ...FIND_WHERE,
  "hai",
  "hain",
  "han",
  "he",
  "is",
  "are",
  "was",
  "the",
  "a",
  "an",
  "my",
  "mine",
  "mera",
  "meri",
  "mere",
  "ko",
  "ka",
  "ke",
  "ki",
  "da",
  "de",
  "di",
  "nu",
  "ne",
  "te",
  "toh",
  "eh",
  "oh",
  "yeh",
  "ye",
  "woh",
  "wo",
  "kya",
  "what",
  "mein",
  "main",
  "menu",
  "mennu",
  "please",
  "das",
  "daso",
  "dasso",
  "bata",
  "batao",
  "dikha",
  "dikhao",
  "dikhado",
  "zara",
  "jara",
  "hor",
  "more",
  "else",
  "aur",
  "hai?",
  // Gurmukhi + Devanagari auxiliaries.
  "ਹੈ",
  "ਹਨ",
  "ਕੀ",
  "ਇਹ",
  "ਉਹ",
  "ਮੇਰਾ",
  "ਮੇਰੀ",
  "ਨੂੰ",
  "ਦਾ",
  "ਦੇ",
  "ਦੀ",
  "ਤੇ",
  "ਨੇ",
  "ਤੋਂ",
  "ਦੱਸ",
  "ਦੱਸੋ",
  "है",
  "हैं",
  "क्या",
  "यह",
  "ये",
  "वह",
  "वो",
  "मेरा",
  "मेरी",
  "को",
  "का",
  "के",
  "की",
  "बताओ",
  "बताइए",
  "जरा",
  "ਹੋਰ",
  "और",
]);

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[?!.,'’‘"।|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Bare "hor"/"more" with no scene question attached: continues a label
 * read when one has unspoken words, else falls through to scene paging.
 * "hor ki hai" is NOT bare (it asks what else is in view).
 */
export function isBareMore(text: string): boolean {
  const norm = normalize(text);
  const has = (w: string): boolean => norm.includes(` ${w} `);
  const hasAny = (ws: string[]): boolean => ws.some(has);
  return hasAny(MORE) && !hasAny(FIND_WHERE) && !hasAny(WHO) && !hasAny(DESCRIBE);
}

export function routeIntent(text: string): Intent {
  const norm = normalize(text);
  const words = norm.trim().split(" ").filter(Boolean);
  const has = (w: string): boolean => norm.includes(` ${w} `);
  const hasAny = (ws: string[]): boolean => ws.some(has);

  if (words.length <= 3) {
    if (hasAny(UNMUTE)) return { kind: "unmute" };
    if (hasAny(MUTE)) return { kind: "mute" };
    if (hasAny(CANCEL)) return { kind: "cancel" };
  }
  if (hasAny(READ)) return { kind: "read" };
  // "Hor ki hai?" pages the look-around scene, but a where-word or kaun
  // next to "hor" keeps its own meaning ("hor kaun hai" is a who).
  if (hasAny(MORE) && !hasAny(FIND_WHERE) && !hasAny(WHO)) return { kind: "more" };
  if (hasAny(FIND_WHERE)) {
    const noun = words.filter((w) => !FIND_STOP.has(w)).join(" ");
    if (noun) return { kind: "find", noun: capitalize(noun) };
    return { kind: "describe", question: text };
  }
  if (hasAny(WHO)) return { kind: "who" };
  if (hasAny(HOWMUCH)) return { kind: "howmuch" };
  if (hasAny(DESCRIBE)) return { kind: "describe", question: text };
  return { kind: "unknown" };
}
