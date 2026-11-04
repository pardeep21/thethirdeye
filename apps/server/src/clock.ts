// Clock positions (DEV-PLAN.md section 2): the model never writes clock
// hours itself. It returns normalised x/y coordinates and the server
// renders the words deterministically from the camera's field of view.
import type { SpeakLang } from "./protocol.js";

/** Clock position words in the user's own language: vje/baje/o'clock. */
export function renderClock(hour: number, lang: SpeakLang = "pa"): string {
  if (lang === "hi") return `${hour} baje`;
  if (lang === "en") return `${hour} o'clock`;
  return `${hour} vje`;
}

export type PositionDistance = "near" | "mid" | "far";

export interface AgentPosition {
  /** Normalised 0..1 from the image's top-left. */
  x: number;
  y: number;
  distance?: PositionDistance;
}

/**
 * Map a normalised x-coordinate to a clock hour 1..12.
 * angle = (x - 0.5) * hfovDeg; hour = 12 + round(angle / 30), wrapped.
 * x is clamped to 0..1 so model overshoot still yields a valid hour.
 */
export function toClock(x: number, hfovDeg: number): number {
  const xc = Math.min(1, Math.max(0, x));
  const angle = (xc - 0.5) * hfovDeg;
  const hour = 12 + Math.round(angle / 30);
  return ((((hour - 1) % 12) + 12) % 12) + 1;
}

export function distanceWord(d: PositionDistance, lang: SpeakLang): string {
  if (lang === "en") return d === "near" ? "near" : d === "mid" ? "in the middle" : "far";
  if (lang === "hi") return d === "near" ? "paas" : d === "mid" ? "beech mein" : "door";
  return d === "near" ? "kol" : d === "mid" ? "vich" : "door";
}

/**
 * Replace {pos:N} placeholders with clock words ("2 vje", plus a
 * distance word when the position carries one). Unknown indices are
 * dropped gracefully and leftover whitespace is collapsed.
 */
export function renderPositions(
  say: string,
  positions: AgentPosition[],
  hfovDeg: number,
  lang: SpeakLang
): string {
  const out = say.replace(/\{pos:(\d+)\}/g, (_m, g: string) => {
    const p = positions[Number(g)];
    if (!p) return "";
    const clock = renderClock(toClock(p.x, hfovDeg), lang);
    return p.distance ? `${clock}, ${distanceWord(p.distance, lang)}` : clock;
  });
  return out.replace(/\s{2,}/g, " ").trim();
}
