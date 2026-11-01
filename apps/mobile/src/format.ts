// Pure UI formatting helpers (no RN imports, unit-tested).
import type { SpeakLang } from "../../server/src/protocol";

/** "Just now" / "10 s ago" / "1 min ago" / "2 h ago" (design wording). */
export function timeAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 10) return "Just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

/** Answer latency for the status bar, e.g. "1.8 s". */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// Exact single-note templates from the server phrase builder
// (apps/server/src/phrases.ts): map a cash line back to its rupees so the
// Cash tile can show "Last: ₹500". Multi-note lines return null.
const CASH_LINE_TO_RUPEES: Record<string, number> = {
  "ਦਸ ਦਾ ਨੋਟ": 10,
  "ਵੀਹ ਦਾ ਨੋਟ": 20,
  "ਪੰਜਾਹ ਦਾ ਨੋਟ": 50,
  "ਸੌ ਦਾ ਨੋਟ": 100,
  "ਦੋ ਸੌ ਦਾ ਨੋਟ": 200,
  "ਪੰਜ ਸੌ ਦਾ ਨੋਟ": 500,
  "दस का नोट": 10,
  "बीस का नोट": 20,
  "पचास का नोट": 50,
  "सौ का नोट": 100,
  "दो सौ का नोट": 200,
  "पाँच सौ का नोट": 500,
  "10 rupee note": 10,
  "20 rupee note": 20,
  "50 rupee note": 50,
  "100 rupee note": 100,
  "200 rupee note": 200,
  "500 rupee note": 500,
};

export function parseCashLine(text: string): number | null {
  return CASH_LINE_TO_RUPEES[text.trim()] ?? null;
}

/** Voice chip label for the current answer language. */
export function voiceChip(lang: SpeakLang): string {
  if (lang === "hi") return "Voice: हिंदी";
  if (lang === "en") return "Voice: English";
  return "Voice: ਪੰਜਾਬੀ";
}
