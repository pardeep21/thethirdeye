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

/** Default longest side for cash-triage input: the phone already sends 768px. */
export const DEFAULT_TRIAGE_IMAGE_PX = 768;

export function triageImagePxFromEnv(): number {
  const raw = process.env.TRIAGE_IMAGE_PX;
  if (raw === undefined) return DEFAULT_TRIAGE_IMAGE_PX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`TRIAGE_IMAGE_PX=${raw} must be a positive integer`);
  }
  return n;
}

/**
 * Shrink a JPEG so its longest side is at most `px` (downscale only, never
 * enlarge). Fail-open: any sharp error returns the input unchanged, so a
 * corrupt frame still reaches triage instead of killing the frame path.
 */
export async function fitLongestSide(jpeg: Buffer, px: number): Promise<Buffer> {
  try {
    return await sharp(jpeg).resize(px, px, { fit: "inside", withoutEnlargement: true }).jpeg().toBuffer();
  } catch {
    return jpeg;
  }
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
