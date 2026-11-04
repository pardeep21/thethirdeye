// UW cash crop: centre-60% geometry on generated JPEGs, env toggle.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  DEFAULT_TRIAGE_IMAGE_PX,
  UW_CASH_CROP_FRAC,
  centreCrop,
  fitLongestSide,
  triageImagePxFromEnv,
  uwCashCropFromEnv,
} from "./images.js";

async function solidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .toBuffer();
}

test("centreCrop keeps the middle 60% of each side", async () => {
  const out = await centreCrop(await solidJpeg(100, 80));
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, Math.floor(100 * UW_CASH_CROP_FRAC));
  assert.equal(meta.height, Math.floor(80 * UW_CASH_CROP_FRAC));
  assert.equal(meta.format, "jpeg");
});

test("fitLongestSide downscales to the budget, never enlarges, fails open", async () => {
  const big = await fitLongestSide(await solidJpeg(100, 80), 50);
  const bigMeta = await sharp(big).metadata();
  assert.equal(bigMeta.width, 50);
  assert.equal(bigMeta.height, 40);
  assert.equal(bigMeta.format, "jpeg");

  const small = await solidJpeg(100, 80);
  const kept = await fitLongestSide(small, 768);
  const keptMeta = await sharp(kept).metadata();
  assert.equal(keptMeta.width, 100);
  assert.equal(keptMeta.height, 80);

  const junk = Buffer.from("not-a-jpeg");
  assert.deepEqual(await fitLongestSide(junk, 50), junk);
});

test("triageImagePx defaults 768, TRIAGE_IMAGE_PX overrides, rejects junk", () => {
  const saved = process.env.TRIAGE_IMAGE_PX;
  try {
    delete process.env.TRIAGE_IMAGE_PX;
    assert.equal(triageImagePxFromEnv(), DEFAULT_TRIAGE_IMAGE_PX);
    process.env.TRIAGE_IMAGE_PX = "512";
    assert.equal(triageImagePxFromEnv(), 512);
    process.env.TRIAGE_IMAGE_PX = "0";
    assert.throws(() => triageImagePxFromEnv(), /TRIAGE_IMAGE_PX=0/);
    process.env.TRIAGE_IMAGE_PX = "big";
    assert.throws(() => triageImagePxFromEnv(), /TRIAGE_IMAGE_PX=big/);
  } finally {
    if (saved === undefined) delete process.env.TRIAGE_IMAGE_PX;
    else process.env.TRIAGE_IMAGE_PX = saved;
  }
});

test("uwCashCrop defaults on, UW_CASH_CROP=0 disables", () => {
  const saved = process.env.UW_CASH_CROP;
  try {
    delete process.env.UW_CASH_CROP;
    assert.equal(uwCashCropFromEnv(), true);
    process.env.UW_CASH_CROP = "0";
    assert.equal(uwCashCropFromEnv(), false);
    process.env.UW_CASH_CROP = "off";
    assert.equal(uwCashCropFromEnv(), false);
    process.env.UW_CASH_CROP = "1";
    assert.equal(uwCashCropFromEnv(), true);
  } finally {
    if (saved === undefined) delete process.env.UW_CASH_CROP;
    else process.env.UW_CASH_CROP = saved;
  }
});
