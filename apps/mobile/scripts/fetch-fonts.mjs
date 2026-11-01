#!/usr/bin/env node
// Fetch static TTFs for the design fonts (Atkinson Hyperlegible Next +
// Noto Sans Gurmukhi) into assets/fonts/. Re-run to refresh.
// A legacy UA makes the css2 API return truetype URLs instead of woff2.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "fonts");

const FAMILIES = [
  {
    css: "Atkinson+Hyperlegible+Next:ital,wght@0,400;0,600;0,700;0,800",
    files: {
      "400": "Atkinson-Regular.ttf",
      "600": "Atkinson-SemiBold.ttf",
      "700": "Atkinson-Bold.ttf",
      "800": "Atkinson-ExtraBold.ttf",
    },
  },
  {
    css: "Noto+Sans+Gurmukhi:wght@500;700",
    files: { 500: "Gurmukhi-Medium.ttf", 700: "Gurmukhi-Bold.ttf" },
  },
];

async function fetchCss(family) {
  const url = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  const res = await fetch(url, { headers: { "User-Agent": "curl/8.0" } });
  if (!res.ok) throw new Error(`css2 ${res.status} for ${family}`);
  return res.text();
}

function parseBlocks(css) {
  // Split into @font-face blocks with their weight + ttf URL.
  const blocks = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]+)}/g)) {
    const body = m[1];
    const weight = body.match(/font-weight:\s*(\d+)/)?.[1];
    const url = body.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
    const subset = body.match(/\/\*\s*([a-z-]+)\s*\*\//)?.[1];
    if (weight && url) blocks.push({ weight, url, subset });
  }
  return blocks;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const fam of FAMILIES) {
    const css = await fetchCss(fam.css);
    const blocks = parseBlocks(css);
    for (const [weight, file] of Object.entries(fam.files)) {
      // Prefer the latin block; Gurmukhi ships a gurmukhi block instead.
      const pick =
        blocks.find((b) => b.weight === weight && b.subset === "latin") ??
        blocks.find((b) => b.weight === weight && b.subset === "gurmukhi") ??
        blocks.find((b) => b.weight === weight);
      if (!pick) throw new Error(`no TTF for weight ${weight} in ${fam.css}`);
      const res = await fetch(pick.url);
      if (!res.ok) throw new Error(`download ${res.status}: ${pick.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Gurmukhi text also needs Latin coverage for mixed captions; the
      // gurmukhi-subset file carries both (Gurmukhi fonts include Latin).
      writeFileSync(join(OUT, file), buf);
      console.log(`${file} (${buf.length} bytes, ${pick.subset ?? "?"})`);
    }
  }
  console.log(`done -> ${OUT}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
