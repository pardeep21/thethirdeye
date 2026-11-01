// Design tokens translated from docs/design/*.html (colours, radii,
// spacing, type scale). This is the ONLY file in src that may contain
// hex colour literals (enforced by theme.test.ts).
import type { SpokenScript } from "../../server/src/protocol";

export const colors = {
  bg: "#0B0C0E",
  surface: "#17191D",
  chip: "#22252B",
  line: "#2C3038",
  lineStrong: "#3A3F48",
  text: "#F5F3EE",
  muted: "#B4B9C2",
  accent: "#FFD23F",
  onAccent: "#0B0C0E",
  second: "#5CD6F0",
  onSecond: "#0B0C0E",
  success: "#4ADE80",
  successBg: "#12301E",
  successMuted: "#C9F5D9",
  danger: "#FF8A7E",
  cashBg: "#2B2614",
  secondBg: "#13292E",
  knob: "#8A909B",
  // Translucent overlays from the mockups (listening rings, quote bubble).
  ringOuter: "rgba(11,12,14,0.18)",
  ringInner: "rgba(11,12,14,0.32)",
  bubbleShade: "rgba(11,12,14,0.08)",
} as const;

export type ColorName = keyof typeof colors;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

export const radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 22,
  card: 24,
  hero: 28,
  pill: 999,
} as const;

/** Loaded font family names (assets/fonts via expo-font). */
export const fonts = {
  regular: "Atkinson-Regular",
  semiBold: "Atkinson-SemiBold",
  bold: "Atkinson-Bold",
  extraBold: "Atkinson-ExtraBold",
  gurmukhiMedium: "Gurmukhi-Medium",
  gurmukhiBold: "Gurmukhi-Bold",
} as const;

/** Pick the loaded family for a script + weight (400|500|600|700|800). */
export function fontFor(script: SpokenScript, weight: 400 | 500 | 600 | 700 | 800): string {
  if (script === "gurmukhi") return weight >= 700 ? fonts.gurmukhiBold : fonts.gurmukhiMedium;
  if (weight >= 800) return fonts.extraBold;
  if (weight >= 700) return fonts.bold;
  if (weight >= 600) return fonts.semiBold;
  return fonts.regular;
}

export const type = {
  appTitle: { size: 17, weight: 800 },
  status: { size: 14, weight: 400 },
  chip: { size: 14, weight: 600 },
  heroTitle: { size: 34, weight: 800 },
  heroTitleSmall: { size: 32, weight: 800 },
  heroSub: { size: 16, weight: 600 },
  listenTitle: { size: 32, weight: 800 },
  partial: { size: 21, weight: 600 },
  tileTitle: { size: 24, weight: 800 },
  tileSub: { size: 15, weight: 400 },
  gridTitle: { size: 22, weight: 800 },
  gridSub: { size: 14, weight: 400 },
  section: { size: 13, weight: 600 },
  caption: { size: 20, weight: 700 },
  captionSub: { size: 13, weight: 400 },
  screenTitle: { size: 30, weight: 800 },
  personName: { size: 22, weight: 800 },
  body: { size: 18, weight: 400 },
} as const;

export type TypeName = keyof typeof type;
