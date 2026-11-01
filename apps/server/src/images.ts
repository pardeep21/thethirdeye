// Image shaping for model inputs. Ultra-wide frames shrink counter
// objects, so the cash-only prompt gets the centre 60% when the lens
// is ultra-wide (07): notes are held at counter distance, i.e. central.
// Kill switch: UW_CASH_CROP=0.
import sharp from "sharp";

/** Fraction of each side kept by the ultra-wide cash crop. */
export const UW_CASH_CROP_FRAC = 0.6;

export function uwCashCropFromEnv(): boolean {
  const raw = (process.env.UW_CASH_CROP ?? "1").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Centre crop of each side to `frac`, returned as a JPEG buffer. */
export async function centreCrop(jpeg: Buffer, frac = UW_CASH_CROP_FRAC): Promise<Buffer> {
  const meta = await sharp(jpeg).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w <= 0 || h <= 0) return jpeg;
  const cw = Math.max(1, Math.floor(w * frac));
  const ch = Math.max(1, Math.floor(h * frac));
  return sharp(jpeg)
    .extract({ left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch })
    .jpeg()
    .toBuffer();
}
