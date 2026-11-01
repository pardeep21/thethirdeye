// UW cash crop: centre-60% geometry on generated JPEGs, env toggle.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { UW_CASH_CROP_FRAC, centreCrop, uwCashCropFromEnv } from "./images.js";

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
