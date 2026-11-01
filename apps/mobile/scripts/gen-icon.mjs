#!/usr/bin/env node
// Generate the app icon (design option A: yellow eye outline + sound-wave
// pupil on near-black), the Android adaptive foreground, launcher mipmaps,
// splash logos, and the app.json source assets. Re-run to regenerate.
// Usage (from apps/mobile): node scripts/gen-icon.mjs
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const RES = join(APP, "android", "app", "src", "main", "res");
const ASSETS = join(APP, "assets");

const BG = "#0B0C0E";
const FG = "#FFD23F";

const EYE = `<path d="M12 50 Q50 16 88 50 Q50 84 12 50 Z" fill="none" stroke="${FG}" stroke-width="5" stroke-linejoin="round"/>`;
const BARS =
  `<rect x="40" y="44" width="4.5" height="12" rx="2.25" fill="${FG}"/>` +
  `<rect x="47.75" y="38" width="4.5" height="24" rx="2.25" fill="${FG}"/>` +
  `<rect x="55.5" y="44" width="4.5" height="12" rx="2.25" fill="${FG}"/>`;

// Full-bleed dark rounded square with the eye (legacy launcher + icon.png).
function iconSvg(px, rounded) {
  const bg = rounded
    ? `<rect x="0" y="0" width="100" height="100" rx="22" fill="${BG}"/>`
    : `<rect x="0" y="0" width="100" height="100" fill="${BG}"/>`;
  return `<svg width="${px}" height="${px}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${bg}${EYE}${BARS}</svg>`;
}

// Transparent canvas with the eye scaled to `frac` of the width, centered
// (adaptive foreground safe zone + splash mark).
function markSvg(px, frac) {
  const w = 100 * frac;
  const x = (100 - w) / 2;
  return `<svg width="${px}" height="${px}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${x} ${x}) scale(${frac})">${EYE}${BARS}</g></svg>`;
}

async function png(svg, path) {
  await sharp(Buffer.from(svg)).png().toFile(path);
  console.log(path);
}

async function main() {
  mkdirSync(join(ASSETS), { recursive: true });

  // app.json source assets (also the prebuild source of truth).
  await png(iconSvg(1024, true), join(ASSETS, "icon.png"));
  await png(markSvg(1024, 0.66), join(ASSETS, "adaptive-icon.png"));
  await png(markSvg(1024, 0.55), join(ASSETS, "splash-icon.png"));

  // Legacy launcher mipmaps (48/72/96/144/192) + round variants.
  const mipmaps = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, px] of Object.entries(mipmaps)) {
    const dir = join(RES, `mipmap-${density}`);
    rmSync(join(dir, "ic_launcher.webp"), { force: true });
    rmSync(join(dir, "ic_launcher_round.webp"), { force: true });
    await png(iconSvg(px, true), join(dir, "ic_launcher.png"));
    // Round: full-bleed art masked to a circle.
    const square = await sharp(Buffer.from(iconSvg(px, false))).png().toBuffer();
    const mask = Buffer.from(
      `<svg width="${px}" height="${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="white"/></svg>`
    );
    const round = await sharp(square)
      .composite([{ input: await sharp(mask).png().toBuffer(), blend: "dest-in" }])
      .png()
      .toBuffer();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "ic_launcher_round.png"), round);
    console.log(join(dir, "ic_launcher_round.png"));
    // Adaptive foreground: 108dp full-bleed, art inside the 72dp safe zone.
    const fgPx = Math.round(px * 2.25);
    await png(markSvg(fgPx, 0.62), join(dir, "ic_launcher_foreground.png"));
  }

  // Adaptive icon XML (API 26+; the S23 uses this, not the legacy PNGs).
  const anydpi = join(RES, "mipmap-anydpi-v26");
  mkdirSync(anydpi, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  writeFileSync(join(anydpi, "ic_launcher.xml"), adaptive);
  writeFileSync(join(anydpi, "ic_launcher_round.xml"), adaptive);
  console.log("mipmap-anydpi-v26/ic_launcher.xml (+round)");

  // Splash mark (288dp, transparent; the layer-list centers it on dark).
  const splash = { mdpi: 288, hdpi: 432, xhdpi: 576, xxhdpi: 864, xxxhdpi: 1152 };
  for (const [density, px] of Object.entries(splash)) {
    await png(markSvg(px, 0.72), join(RES, `drawable-${density}`, "splashscreen_logo.png"));
  }
  console.log("done");
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
