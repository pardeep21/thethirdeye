// Theme tests: token shape plus the no-hex-outside-theme.ts guard.
// New colours go in theme.ts; this test fails the suite otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { colors, fontFor, radius, space, type } from "./theme.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...srcFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test("theme carries the full design palette", () => {
  for (const key of [
    "bg",
    "surface",
    "chip",
    "line",
    "text",
    "muted",
    "accent",
    "onAccent",
    "second",
    "onSecond",
    "success",
    "danger",
  ] as const) {
    assert.match(colors[key], /^#[0-9a-fA-F]{6}$/, `colors.${key} is a hex token`);
  }
  assert.equal(colors.bg, "#0B0C0E");
  assert.equal(colors.accent, "#FFD23F");
  assert.equal(space.lg, 16);
  assert.equal(radius.hero, 28);
  assert.deepEqual(type.heroTitle, { size: 34, weight: 800 });
});

test("fontFor maps scripts and weights to loaded families", () => {
  assert.equal(fontFor("latin", 400), "Atkinson-Regular");
  assert.equal(fontFor("latin", 800), "Atkinson-ExtraBold");
  assert.equal(fontFor("devanagari", 700), "Atkinson-Bold");
  assert.equal(fontFor("gurmukhi", 400), "Gurmukhi-Medium");
  assert.equal(fontFor("gurmukhi", 800), "Gurmukhi-Bold");
});

test("no hex colour literals outside theme.ts (tests excluded)", () => {
  const offenders: string[] = [];
  for (const file of srcFiles(HERE)) {
    if (file.endsWith("theme.ts") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
